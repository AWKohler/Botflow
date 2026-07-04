/**
 * POST /api/agent/claude-code/stop  { projectId }
 *
 * Kill the project's detached Claude Code bridge. Wired to the Stop button:
 * before this existed, Stop only aborted the client stream — the bridge (and
 * the claude subprocess) kept working in the sandbox, editing files the user
 * had just asked it to stop editing.
 *
 * Also revokes the turn's tool-callback token and marks the turn dead so the
 * recovery path won't try to reattach to it.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { getOrCreatePersistentSandbox } from "@/lib/vercel-sandbox";
import { buildKillBridgeScript } from "@/lib/agent/claude-code/bridge-control";
import { getTurnRecord, markTurnDead } from "@/lib/agent/claude-code/turn-registry";
import { revokeToolToken } from "@/lib/agent/claude-code/tool-token";
import { enforce, identifierFor } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const blocked = await enforce(identifierFor(userId, req), "pollHeavy");
  if (blocked) return blocked;

  let body: { projectId?: string };
  try {
    body = (await req.json()) as { projectId?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const projectId = body.projectId;
  if (!projectId) {
    return NextResponse.json({ ok: false, error: "projectId required" }, { status: 400 });
  }

  const db = getDb();
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project) {
    return NextResponse.json({ ok: false, error: "Project not found" }, { status: 404 });
  }

  const record = await getTurnRecord(projectId);
  try {
    const sandbox = await getOrCreatePersistentSandbox(projectId);
    await sandbox.runCommand({ cmd: "sh", args: ["-c", buildKillBridgeScript()] });
  } catch {
    // Sandbox unreachable/expired — the bridge is gone with it.
  }
  if (record) {
    if (record.toolToken) revokeToolToken(record.toolToken).catch(() => {});
    await markTurnDead(projectId, record.turnId).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}
