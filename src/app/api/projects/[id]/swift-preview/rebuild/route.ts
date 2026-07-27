import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireProjectAccess } from "@/lib/project-access";
import { tarSandboxProject } from "@/lib/vercel-sandbox";
import { materializeSwiftBuildConfig } from "@/lib/sandbox-env";
import { uploadBuild } from "@/lib/sim-platform";
import {
  hasSwiftPreviewSession,
  ownsSwiftPreviewSession,
  recordSwiftPreviewSession,
} from "@/lib/swift-preview-store";
import { canUseSwift, swiftProjectForbidden } from "@/lib/swift-access";
import { enforce, identifierFor } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const blocked = await enforce(identifierFor(userId, req), "deploy");
  if (blocked) return blocked;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, userId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { project } = access;
  if (project.platform !== "swift") {
    return NextResponse.json(
      { error: "Project platform must be 'swift'." },
      { status: 400 },
    );
  }
  // Beta-only runtime. Gates legacy swift projects owned by non-beta users.
  if (await swiftProjectForbidden(project)) {
    return NextResponse.json(
      { error: "Swift projects are currently in private beta." },
      { status: 403 },
    );
  }

  // Simulator streaming is a per-ACTOR entitlement even on shared projects:
  // editors need their own Pro/Max plan to use the sim; device builds stay
  // open to free editors (sharing decision 2026-07-06).
  if (access.role !== "owner" && !(await canUseSwift(userId))) {
    return NextResponse.json(
      { error: "The iOS simulator requires a Pro or Max plan. You can still build to your own device." },
      { status: 403 },
    );
  }

  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId || !/^[0-9a-fA-F-]{36}$/.test(sessionId)) {
    return NextResponse.json({ error: "sessionId query param is required" }, { status: 400 });
  }
  // Ownership store is in-memory; wiped on Next.js hot-reload. Two cases:
  //  - store HAS an entry for this sessionId → strict check
  //  - store has NO entry → trust caller (already Clerk-auth'd + project-owner'd)
  //    and re-bind so future rebuilds keep working.
  if (hasSwiftPreviewSession(sessionId)) {
    if (!ownsSwiftPreviewSession(sessionId, userId, projectId)) {
      return NextResponse.json(
        { error: "Session does not belong to this project" },
        { status: 403 },
      );
    }
  } else {
    recordSwiftPreviewSession(sessionId, userId, projectId);
  }

  try {
    await materializeSwiftBuildConfig(projectId);
    const tarball = await tarSandboxProject(projectId, { excludeConvex: true });
    await uploadBuild(sessionId, tarball);
    return NextResponse.json({ ok: true, tarBytes: tarball.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Rebuild failed";
    console.error("[swift-preview/rebuild]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
