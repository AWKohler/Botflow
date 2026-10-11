/**
 * POST /api/agent/claude-code/stop  { projectId, threadId }
 *
 * Kill ONE thread's detached in-sandbox agent bridge — Claude Code or
 * OpenCode; both write the thread's pidfile and handle SIGTERM (CC interrupts
 * the claude subprocess, OpenCode aborts the session and nukes its server
 * process group). Wired to the Stop button: before this existed, Stop only
 * aborted the client stream — the bridge kept working in the sandbox,
 * editing files the user had just asked it to stop editing.
 *
 * Also revokes the turn's tool-callback token and marks the turn dead so the
 * recovery path won't try to reattach to it.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth/server";
import { requireProjectAccess } from "@/lib/project-access";
import { getThread } from "@/lib/agent/threads";
import { stopThreadAgent } from "@/lib/agent/stop-thread";
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

  let body: { projectId?: string; threadId?: string };
  try {
    body = (await req.json()) as { projectId?: string; threadId?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const { projectId, threadId } = body;
  if (!projectId || !threadId) {
    return NextResponse.json({ ok: false, error: "projectId and threadId required" }, { status: 400 });
  }

  const access = await requireProjectAccess(projectId, userId);
  if (!access) {
    return NextResponse.json({ ok: false, error: "Project not found" }, { status: 404 });
  }

  if (!(await getThread(projectId, threadId))) {
    return NextResponse.json({ ok: false, error: "Thread not found" }, { status: 404 });
  }

  await stopThreadAgent(projectId, threadId);

  return NextResponse.json({ ok: true });
}
