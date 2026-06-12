import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import {
  startSandboxDevServer,
  stopSandboxDevServer,
} from "@/lib/workspace-control";
import { refreshAuthSiteUrl } from "@/lib/convex-auth-setup";
import { swiftRuntimeForbidden } from "@/lib/swift-access";
import { enforce, identifierFor } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function authorizedProject(projectId: string, userId: string) {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project || project.userId !== userId) return null;
  if (project.platform !== "swift" && project.platform !== "sandboxed-web") return null;
  // Swift's runtime is beta-only; deny non-beta owners of legacy swift projects.
  if (await swiftRuntimeForbidden(project.platform, userId)) return null;
  return project;
}

// POST: start (or restart) the dev server. Used by the workspace Play button
// and by the `startDevServer` agent tool.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Starting/restarting the dev server (optional pnpm install + boot) is heavy
  // sandbox compute — cap to prevent restart thrashing.
  const blocked = await enforce(identifierFor(userId, req), "expensive");
  if (blocked) return blocked;

  const { id } = await params;
  const project = await authorizedProject(id, userId);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { port?: number; installFirst?: boolean };
  const result = await startSandboxDevServer(project.id, {
    port: body.port ?? 5173,
    installFirst: body.installFirst ?? false,
  });

  if (result.ok) {
    // Keep SITE_URL in sync with the current sandbox domain so Convex Auth
    // magic links always point at the right frontend. Non-fatal if it fails.
    if (result.previewUrl) {
      void refreshAuthSiteUrl(project.id, result.previewUrl).catch(() => {});
    }
    return NextResponse.json({
      previewUrl: result.previewUrl,
      port: result.port,
      responseHeaders: result.responseHeaders,
    });
  }

  // Pick a useful status code based on what failed.
  const status = result.message.startsWith("Port") ? 409
    : result.installStderr || result.installStdout ? 500
    : result.log ? 504
    : 500;
  const errorCode = result.message.startsWith("Port") ? "no_port_route" : undefined;

  return NextResponse.json(
    {
      ...(errorCode ? { error: errorCode } : {}),
      message: result.message,
      ...(result.log ? { log: result.log } : {}),
      ...(result.previewUrl ? { previewUrl: result.previewUrl } : {}),
      ...(result.installStderr ? { stderr: result.installStderr } : {}),
      ...(result.installStdout ? { stdout: result.installStdout } : {}),
    },
    { status },
  );
}

// DELETE: stop the dev server. Used by the workspace Stop button (future) and
// by the `stopDevServer` agent tool.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const blocked = await enforce(identifierFor(userId, req), "expensive");
  if (blocked) return blocked;

  const { id } = await params;
  const project = await authorizedProject(id, userId);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const result = await stopSandboxDevServer(project.id);
  if (result.ok) {
    return NextResponse.json({
      ok: true,
      message: result.message,
      alreadyStopped: Boolean(result.alreadyStopped),
    });
  }
  return NextResponse.json({ ok: false, message: result.message }, { status: 500 });
}
