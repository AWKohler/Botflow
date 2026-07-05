/**
 * POST /api/projects/[id]/browser-log
 *   Ingest a batch of browser-console entries from the SandboxedWebWorkspace.
 *   The client buffers iframe postMessage events and flushes them here every
 *   ~500ms (or when the buffer hits 50 entries). Entries are pushed into a
 *   Redis ring buffer that the agent's `getBrowserLog` tool reads from.
 *
 * DELETE /api/projects/[id]/browser-log
 *   Clear the ring buffer. Called on chat-reset and on agent-backend switch
 *   so a fresh conversation segment doesn't inherit stale browser logs.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireProjectAccess } from "@/lib/project-access";
import {
  clearBrowserLog,
  pushBrowserLogEntries,
  type BrowserLogEntry,
} from "@/lib/workspace-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ENTRIES_PER_BATCH = 100;

async function authorizedProject(projectId: string, userId: string) {
  const access = await requireProjectAccess(projectId, userId);
  if (!access) return null;
  const { project } = access;
  if (project.platform !== "sandboxed-web") return null;
  return project;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const project = await authorizedProject(id, userId);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { entries?: unknown };
  try {
    body = (await req.json()) as { entries?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = Array.isArray(body.entries) ? body.entries : [];
  if (raw.length === 0) return new NextResponse(null, { status: 204 });
  if (raw.length > MAX_ENTRIES_PER_BATCH) {
    return NextResponse.json(
      { error: `Too many entries in one batch (max ${MAX_ENTRIES_PER_BATCH})` },
      { status: 413 },
    );
  }

  // Coerce to BrowserLogEntry; pushBrowserLogEntries handles sanitization.
  const entries: BrowserLogEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.message !== "string" || o.message.length === 0) continue;
    entries.push({
      timestamp: typeof o.timestamp === "number" ? o.timestamp : Date.now(),
      level: o.level === "error" || o.level === "warn" ? o.level : "log",
      message: o.message,
      type: o.type === "error" || o.type === "hmr" ? o.type : "console",
    });
  }

  await pushBrowserLogEntries(project.id, entries);
  return new NextResponse(null, { status: 204 });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const project = await authorizedProject(id, userId);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await clearBrowserLog(project.id);
  return new NextResponse(null, { status: 204 });
}
