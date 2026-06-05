import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { tarSandboxProject } from "@/lib/vercel-sandbox";
import { materializeSwiftConvexConfig } from "@/lib/sandbox-env";
import {
  createSession,
  releaseSession,
  sessionWsUrl,
  uploadBuild,
} from "@/lib/sim-platform";
import { recordSwiftPreviewSession } from "@/lib/swift-preview-store";
import { swiftRuntimeForbidden } from "@/lib/swift-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(
  _req: NextRequest,
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

  let sessionId: string | null = null;
  try {
    const session = await createSession({ awaitBuild: true });
    sessionId = session.sessionId;
    recordSwiftPreviewSession(sessionId, userId, projectId);

    // Bake the project's Convex deployment URL into ConvexConfig.swift before
    // tarring (no-op for no-backend / unprovisioned / non-Swift projects), and
    // drop the /convex TS backend from the simulator upload — the Mac doesn't
    // build it.
    await materializeSwiftConvexConfig(projectId);
    const tarball = await tarSandboxProject(projectId, { excludeConvex: true });
    await uploadBuild(sessionId, tarball);

    return NextResponse.json({
      sessionId,
      wsUrl: sessionWsUrl(sessionId, session.streamToken),
      tarBytes: tarball.length,
    });
  } catch (error) {
    if (sessionId) {
      // Best-effort cleanup — we don't want a stranded session holding a slot.
      await releaseSession(sessionId).catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : "Failed to start preview";
    console.error("[swift-preview/start]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
