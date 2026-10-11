/**
 * POST /api/internal/agent/turn-finished
 *   Authorization: Bearer <turn tool token>
 *
 * Called by an in-sandbox bridge (Claude Code or OpenCode) when its turn ends
 * — normally, with an error, or on SIGTERM. Saves the turn's assistant reply
 * server-side, so threads nobody is watching still keep their history, and
 * records the outcome on the thread (drives its status dot).
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
import { enforce, identifierFor } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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

  const { message, sawEndTurn, errorText } = await assembleTurnMessage(
    ndjson,
    binding.backend ?? "claude-code",
    turnId,
  );
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
  }

  return NextResponse.json({ ok: true, saved: Boolean(message) });
}
