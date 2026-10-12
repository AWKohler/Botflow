/**
 * POST /api/internal/agent/turn-finished
 *   Authorization: Bearer <turn tool token>
 *
 * Called by an in-sandbox bridge (Claude Code or OpenCode) when its turn ends
 * — normally, with an error, or on SIGTERM. Saves the turn's assistant reply
 * and the agent's session pointer server-side (threads nobody is watching
 * still keep their history and resume correctly), records the outcome on the
 * thread (drives its status dot), and starts the thread's next queued
 * message, if any.
 *
 * The token binding names the project, thread, turn, backend and segment;
 * nothing in the body is trusted. Idempotent: the reply is upserted under the
 * turn's deterministic message id, the same row the browser writes.
 */
import { NextResponse } from "next/server";
import { getOrCreatePersistentSandbox } from "@/lib/vercel-sandbox";
import { resolveToolToken } from "@/lib/agent/claude-code/tool-token";
import { buildReadTurnScript, turnEventFile } from "@/lib/agent/claude-code/bridge-control";
import { getTurnRecord, markTurnDead, markTurnEnded } from "@/lib/agent/claude-code/turn-registry";
import { assembleTurnMessage, saveAssistantMessage } from "@/lib/agent/turn-persistence";
import { getThread, noteTurnEnded } from "@/lib/agent/threads";
import { drainThreadQueue } from "@/lib/agent/thread-queue";
import { setClaudeCodeSessionId } from "@/lib/agent/claude-code/session-store";
import { setOpenCodeSessionId } from "@/lib/agent/opencode/session-store";
import { enforce, identifierFor } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Draining the queue can start the next turn (sandbox setup + spawn).
export const maxDuration = 300;

/** The bridges' SIGTERM message: a user stop or a superseding turn, not a failure. */
const STOPPED_PREFIX = "Turn stopped";

export async function POST(req: Request) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!match) {
    return NextResponse.json({ ok: false, error: "Missing bearer token" }, { status: 401 });
  }
  const binding = await resolveToolToken(match[1]);
  if (!binding) {
    return NextResponse.json({ ok: false, error: "Invalid or expired token" }, { status: 401 });
  }
  const { projectId, threadId, turnId } = binding;
  if (!threadId || !turnId) {
    return NextResponse.json({ ok: false, error: "Token is not bound to a thread turn" }, { status: 400 });
  }
  const blocked = await enforce(identifierFor(binding.userId, req), "toolCallback");
  if (blocked) return blocked;

  const thread = await getThread(projectId, threadId);
  if (!thread) {
    // Thread deleted while its agent was finishing — nothing to save into.
    return NextResponse.json({ ok: true, saved: false });
  }

  let ndjson = "";
  try {
    const sandbox = await getOrCreatePersistentSandbox(projectId);
    const cmd = await sandbox.runCommand({ cmd: "sh", args: ["-c", buildReadTurnScript(turnEventFile(turnId))] });
    ndjson = await cmd.stdout();
  } catch (err) {
    console.error("[turn-finished] could not read the event file:", err);
    return NextResponse.json({ ok: false, error: "Could not read turn events" }, { status: 502 });
  }

  const backend = binding.backend ?? "claude-code";
  const { message, sawEndTurn, sessionId, errorText } = await assembleTurnMessage(ndjson, backend, turnId);
  if (message && message.parts.length > 0) {
    await saveAssistantMessage(threadId, binding.segmentId ?? thread.currentSegmentId ?? null, message);
  }

  // Only the thread's CURRENT turn updates its live record and status; a
  // late notify from a superseded turn just saves its partial reply.
  const record = await getTurnRecord(projectId, threadId);
  if (record?.turnId === turnId) {
    if (sawEndTurn) await markTurnEnded(projectId, threadId, turnId);
    else await markTurnDead(projectId, threadId, turnId);
    const failure = errorText && !errorText.startsWith(STOPPED_PREFIX) ? errorText.slice(0, 500) : null;
    await noteTurnEnded(threadId, failure);
    // The resume pointer — the live route also saves it, but a turn started
    // by the queue drain (or whose route died early) has no live route.
    if (sessionId) {
      const save = backend === "opencode" ? setOpenCodeSessionId : setClaudeCodeSessionId;
      await save(threadId, sessionId).catch(() => {});
    }
  }

  // Start the next queued message now that this thread's agent is free. A
  // stopped turn drains too — the queue is the user's explicit intent.
  const drain = await drainThreadQueue({
    projectId,
    threadId,
    origin: new URL(req.url).origin,
  }).catch((err) => {
    console.error("[turn-finished] queue drain failed:", err);
    return null;
  });

  return NextResponse.json({ ok: true, saved: Boolean(message), drain });
}
