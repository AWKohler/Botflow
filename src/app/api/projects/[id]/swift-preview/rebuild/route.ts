import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { tarSandboxProject } from "@/lib/vercel-sandbox";
import { materializeSwiftConvexConfig, materializeSwiftRevenueCatConfig } from "@/lib/sandbox-env";
import { uploadBuild } from "@/lib/sim-platform";
import {
  hasSwiftPreviewSession,
  ownsSwiftPreviewSession,
  recordSwiftPreviewSession,
} from "@/lib/swift-preview-store";
import { swiftRuntimeForbidden } from "@/lib/swift-access";

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

  const { id: projectId } = await params;
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project || project.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (project.platform !== "swift") {
    return NextResponse.json(
      { error: "Project platform must be 'swift'." },
      { status: 400 },
    );
  }
  // Beta-only runtime. Gates legacy swift projects owned by non-beta users.
  if (await swiftRuntimeForbidden(project.platform, userId)) {
    return NextResponse.json(
      { error: "Swift projects are currently in private beta." },
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
    await materializeSwiftConvexConfig(projectId);
    await materializeSwiftRevenueCatConfig(projectId);
    const tarball = await tarSandboxProject(projectId, { excludeConvex: true });
    await uploadBuild(sessionId, tarball);
    return NextResponse.json({ ok: true, tarBytes: tarball.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Rebuild failed";
    console.error("[swift-preview/rebuild]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
