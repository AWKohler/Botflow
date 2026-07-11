/**
 * GET /api/projects/[id]/sandbox/preview-state
 *
 * Lightweight polling endpoint the SandboxedWebWorkspace hits every ~2 seconds
 * while the preview tab is active. Returns:
 *
 *   - refreshAt: timestamp of the latest `refreshPreview` request (or null).
 *     The client bumps `previewReloadKey` when this changes, remounting the
 *     iframe.
 *
 *   - devServer: snapshot of the dev server's externally-visible state:
 *     { running, previewUrl, port, updatedAt } | null
 *     When `running` flips true (or previewUrl changes), the client wires the
 *     iframe to the new URL. When it flips false, the client clears the
 *     preview pane to a "Dev server is stopped" empty state.
 *
 * Whoever started/stopped the dev server (Play button or agent tool) is the
 * one who wrote the state to Redis — the workspace just reflects it.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireProjectAccess } from "@/lib/project-access";
import {
  getDevServerState,
  getPreviewRefreshAt,
  verifyDevServerReachable,
} from "@/lib/workspace-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const access = await requireProjectAccess(id, userId);
  if (!access || access.project.platform !== "sandboxed-web") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { project } = access;

  const [refreshAt, cachedState] = await Promise.all([
    getPreviewRefreshAt(project.id),
    getDevServerState(project.id),
  ]);

  // If the sandbox stopped listening (Vercel would serve its 502 page), this
  // flips the published state to stopped so the client unmounts the iframe
  // instead of ever rendering the error page. Throttled internally.
  const devServer = await verifyDevServerReachable(project.id, cachedState);

  return NextResponse.json({ refreshAt, devServer });
}
