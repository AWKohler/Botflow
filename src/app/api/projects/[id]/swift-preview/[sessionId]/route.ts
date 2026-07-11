import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireProjectAccess } from "@/lib/project-access";
import { releaseSession } from "@/lib/sim-platform";
import {
  dropSwiftPreviewSession,
  hasSwiftPreviewSession,
  ownsSwiftPreviewSession,
} from "@/lib/swift-preview-store";
import { swiftRuntimeForbidden } from "@/lib/swift-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; sessionId: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: projectId, sessionId } = await params;
  const access = await requireProjectAccess(projectId, userId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { project } = access;
  // Beta-only runtime. Gates legacy swift projects owned by non-beta users.
  if (await swiftRuntimeForbidden(project.platform, userId)) {
    return NextResponse.json(
      { error: "Swift projects are currently in private beta." },
      { status: 403 },
    );
  }
  // If the store has a positive entry that disagrees, refuse.
  // Otherwise (store wiped on hot-reload, or this session was started in another
  // process), allow the release — the caller is Clerk-auth'd + project-owner'd
  // and the sessionId is unguessable, so this is safe and idempotent.
  if (hasSwiftPreviewSession(sessionId) && !ownsSwiftPreviewSession(sessionId, userId, projectId)) {
    return new NextResponse(null, { status: 204 });
  }

  try {
    await releaseSession(sessionId);
  } catch (error) {
    console.warn(
      "[swift-preview/release]",
      error instanceof Error ? error.message : error,
    );
  }
  dropSwiftPreviewSession(sessionId);
  return new NextResponse(null, { status: 204 });
}
