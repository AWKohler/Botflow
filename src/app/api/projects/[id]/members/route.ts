/**
 * GET  /api/projects/[id]/members — list members (owner + any active member).
 * POST /api/projects/[id]/members — invite by email (owner-only, Pro/Max,
 *      SHARING_ENABLED). Existing verified Clerk users are added instantly
 *      (Docs behavior); unknown emails become pending rows claimed at signup.
 * See docs/features/project-sharing-plan.md §4.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projectMembers } from "@/db/schema";
import { requireProjectAccess } from "@/lib/project-access";
import { SHARING_ENABLED } from "@/lib/feature-flags";
import { getUserTier } from "@/lib/tier";
import { getEmailForClerkUser } from "@/lib/email";
import {
  findClerkUserByVerifiedEmail,
  inviteExpired,
  normalizeEmail,
  sendInviteEmail,
} from "@/lib/sharing";
import { enforce, identifierFor } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!SHARING_ENABLED) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const access = await requireProjectAccess(id, userId);
  if (!access) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const db = getDb();
  const rows = await db
    .select()
    .from(projectMembers)
    .where(eq(projectMembers.projectId, id));
  const live = rows.filter((m) => m.status !== "revoked" && !inviteExpired(m));

  // Decorate active members with Clerk identity for the share sheet.
  const memberIds = live.map((m) => m.userId).filter((v): v is string => Boolean(v));
  const identity = new Map<string, { name: string; imageUrl?: string }>();
  if (memberIds.length > 0) {
    const client = await clerkClient();
    const { data } = await client.users.getUserList({ userId: memberIds, limit: 100 });
    for (const u of data) {
      identity.set(u.id, {
        name: u.fullName ?? u.primaryEmailAddress?.emailAddress ?? "Member",
        imageUrl: u.imageUrl,
      });
    }
  }

  return NextResponse.json({
    role: access.role,
    editorsCanPush: access.project.editorsCanPush,
    shareOwnerCredits: access.project.shareOwnerCredits,
    shareOwnerOauth: access.project.shareOwnerOauth,
    members: live.map((m) => ({
      id: m.id,
      userId: m.userId,
      email: m.invitedEmail,
      status: m.status,
      role: m.role,
      tokenCapPct: m.tokenCapPct,
      name: (m.userId && identity.get(m.userId)?.name) || m.invitedEmail,
      imageUrl: m.userId ? identity.get(m.userId)?.imageUrl : undefined,
    })),
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!SHARING_ENABLED) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Anti-abuse: invites ride the oauthStart bucket (10/min) — plenty for a
  // human sharing a project, hostile to enumeration.
  const blocked = await enforce(identifierFor(userId, req), "oauthStart");
  if (blocked) return blocked;

  const { id } = await params;
  const access = await requireProjectAccess(id, userId, "owner");
  if (!access) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const tier = await getUserTier(userId);
  if (tier !== "pro" && tier !== "max") {
    return NextResponse.json(
      { error: "Sharing requires a Pro or Max plan.", upgrade: true },
      { status: 402 },
    );
  }

  const body = (await req.json().catch(() => null)) as { email?: string } | null;
  const email = body?.email ? normalizeEmail(body.email) : "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "A valid email address is required." }, { status: 400 });
  }

  // Inviting yourself is a no-op — the owner already has access.
  const ownerEmail = await getEmailForClerkUser(userId);
  if (ownerEmail && normalizeEmail(ownerEmail.email) === email) {
    return NextResponse.json({ error: "That's you — you already own this project." }, { status: 400 });
  }

  const db = getDb();
  const existing = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, id), eq(projectMembers.invitedEmail, email)))
    .limit(1);
  if (existing[0] && existing[0].status === "active") {
    return NextResponse.json({ error: "That person already has access." }, { status: 409 });
  }
  if (existing[0] && existing[0].status === "pending" && !inviteExpired(existing[0])) {
    return NextResponse.json({ error: "An invite to that email is already pending." }, { status: 409 });
  }

  const clerkUser = await findClerkUserByVerifiedEmail(email);
  const values = {
    userId: clerkUser?.userId ?? null,
    status: clerkUser ? ("active" as const) : ("pending" as const),
    role: "editor" as const,
    invitedBy: userId,
    invitedAt: new Date(),
    acceptedAt: clerkUser ? new Date() : null,
    revokedAt: null,
  };

  // Re-invite of a revoked/expired row flips it back; else insert fresh.
  if (existing[0]) {
    await db.update(projectMembers).set(values).where(eq(projectMembers.id, existing[0].id));
  } else {
    await db.insert(projectMembers).values({ projectId: id, invitedEmail: email, ...values });
  }

  void sendInviteEmail({
    to: email,
    inviterName: ownerEmail?.name ?? "A Botflow user",
    projectName: access.project.name,
    projectId: id,
    existingUser: Boolean(clerkUser),
  });

  return NextResponse.json({
    ok: true,
    status: values.status,
    message: clerkUser
      ? "Added — they have access now."
      : "Invite sent — they'll get access when they sign up with that email.",
  });
}
