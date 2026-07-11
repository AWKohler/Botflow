/**
 * DELETE /api/projects/[id]/members/[memberId] — revoke (owner) or leave
 *        (the member removing themself).
 * PATCH  /api/projects/[id]/members/[memberId] — owner updates tokenCapPct.
 * Revocation is immediate: requireProjectAccess reads live rows, so the
 * next request from a revoked member 404s. In-flight agent turns finish
 * (turn identity was bound at spawn — plan §4).
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projectMembers } from "@/db/schema";
import { requireProjectAccess } from "@/lib/project-access";
import { SHARING_ENABLED } from "@/lib/feature-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function loadMember(projectId: string, memberId: string) {
  const db = getDb();
  const [m] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.id, memberId), eq(projectMembers.projectId, projectId)))
    .limit(1);
  return m ?? null;
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> },
) {
  if (!SHARING_ENABLED) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, memberId } = await params;

  const access = await requireProjectAccess(id, userId);
  if (!access) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const member = await loadMember(id, memberId);
  if (!member || member.status === "revoked") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Owners revoke anyone; a member may only remove THEMSELF (leave).
  const isSelf = member.userId === userId;
  if (access.role !== "owner" && !isSelf) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const db = getDb();
  await db
    .update(projectMembers)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(eq(projectMembers.id, memberId));

  return NextResponse.json({ ok: true, left: isSelf && access.role !== "owner" });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> },
) {
  if (!SHARING_ENABLED) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, memberId } = await params;

  const access = await requireProjectAccess(id, userId, "owner");
  if (!access) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const member = await loadMember(id, memberId);
  if (!member || member.status === "revoked") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as { tokenCapPct?: number } | null;
  const cap = body?.tokenCapPct;
  if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 1 || cap > 100) {
    return NextResponse.json({ error: "tokenCapPct must be 1–100." }, { status: 400 });
  }

  const db = getDb();
  await db
    .update(projectMembers)
    .set({ tokenCapPct: Math.round(cap) })
    .where(eq(projectMembers.id, memberId));

  return NextResponse.json({ ok: true, tokenCapPct: Math.round(cap) });
}
