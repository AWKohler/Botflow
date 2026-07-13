/**
 * PATCH /api/projects/[id]/sharing-settings — owner-only share-sheet
 * switches: editorsCanPush, shareOwnerOauth.
 *
 * shareOwnerOauth is accepted only while the platform-wide escape hatch
 * SHARING_ALLOW_OWNER_OAUTH=true is set (TOS caution, plan §5.1); credential
 * resolution re-checks BOTH at turn time, so the column alone never grants
 * anything.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { requireProjectAccess } from "@/lib/project-access";
import { SHARING_ENABLED } from "@/lib/feature-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!SHARING_ENABLED) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const access = await requireProjectAccess(id, userId, "owner");
  if (!access) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as {
    editorsCanPush?: boolean;
    editorsManageBackend?: boolean;
    shareOwnerCredits?: boolean;
    shareOwnerOauth?: boolean;
  } | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const updates: Partial<{
    editorsCanPush: boolean;
    editorsManageBackend: boolean;
    shareOwnerCredits: boolean;
    shareOwnerOauth: boolean;
    updatedAt: Date;
  }> = {};
  if (typeof body.editorsCanPush === "boolean") updates.editorsCanPush = body.editorsCanPush;
  if (typeof body.editorsManageBackend === "boolean") updates.editorsManageBackend = body.editorsManageBackend;
  if (typeof body.shareOwnerCredits === "boolean") {
    updates.shareOwnerCredits = body.shareOwnerCredits;
    // The OAuth/BYOK switch is nested under owner-credits: turning the
    // parent off always turns the child off too.
    if (!body.shareOwnerCredits) updates.shareOwnerOauth = false;
  }
  if (typeof body.shareOwnerOauth === "boolean") {
    const parentOn = updates.shareOwnerCredits ?? access.project.shareOwnerCredits;
    if (body.shareOwnerOauth && !parentOn) {
      return NextResponse.json(
        { error: "Enable credit sharing first — subscription/key sharing rides on it." },
        { status: 400 },
      );
    }
    // Stored freely; ACTUAL owner-credential use is enforced at credential
    // resolution time, where the SHARING_ALLOW_OWNER_OAUTH platform kill
    // switch can still veto it (TOS escape hatch, plan §5.1).
    if (updates.shareOwnerOauth === undefined) updates.shareOwnerOauth = body.shareOwnerOauth;
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }

  updates.updatedAt = new Date();
  const db = getDb();
  await db.update(projects).set(updates).where(eq(projects.id, id));

  return NextResponse.json({
    ok: true,
    editorsCanPush: updates.editorsCanPush ?? access.project.editorsCanPush,
    editorsManageBackend: updates.editorsManageBackend ?? access.project.editorsManageBackend,
    shareOwnerCredits: updates.shareOwnerCredits ?? access.project.shareOwnerCredits,
    shareOwnerOauth: updates.shareOwnerOauth ?? access.project.shareOwnerOauth,
  });
}
