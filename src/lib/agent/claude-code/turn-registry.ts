/**
 * Per-THREAD registry of the current in-sandbox agent turn (Claude Code OR
 * OpenCode — the `backend` field says which bridge/translator the turn
 * belongs to). Each thread runs its own agent process in the project's shared
 * sandbox (docs/features/multi-agent-threads.md), so several records per
 * project can be live at once.
 *
 * The bridge runs detached inside the sandbox, so it outlives the serverless
 * route that spawned it (maxDuration kills the stream, not the agent). This
 * record is how later requests find that turn again:
 *
 *   - the reattach route tails the turn's event file to re-stream it,
 *   - the turn-status route tells the client whether reattaching is worth it,
 *   - the thread's next turn kills that thread's previous bridge (and
 *     revokes its tool token) before spawning a new one, so two agents never
 *     race inside ONE thread. Other threads' agents are left alone.
 *
 * Lifecycle: written at spawn → endedNormally set when end_turn is observed
 * (by whichever stream sees it first) → dead set when a reattach discovers
 * the bridge exited without end_turn, or the user stops the agent. The
 * record is overwritten wholesale by the next turn's spawn.
 */
import { redis } from "@/lib/redis";

const KEY_PREFIX = "claude-code:turn:";
// Generous — a turn record only needs to outlive recovery attempts on the
// turn it describes, and it's overwritten by the next spawn anyway.
const TTL_SECONDS = 60 * 60 * 6;

export interface ClaudeCodeTurnRecord {
  turnId: string;
  /** Thread this turn belongs to. */
  threadId: string;
  /** Clerk id of the user whose prompt spawned this turn. Under sharing, the
   *  shared-turn guard uses this to refuse spawns that would kill ANOTHER
   *  collaborator's live bridge (src/lib/sharing.ts). Absent on old records. */
  userId?: string;
  /** Which in-sandbox agent ran this turn. Reattach picks the matching
   *  translator. Absent on records written before OpenCode existed —
   *  treat as "claude-code". */
  backend?: "claude-code" | "opencode";
  /** Id of the user message that spawned this turn. Mount-time recovery uses
   *  it to match the record to the transcript's trailing user message — an
   *  exact-identity check, unlike startedAt which can't distinguish quick
   *  back-to-back turns. Absent on records written before this field. */
  userMessageId?: string;
  /** Absolute path (in the sandbox) of the NDJSON event tee file. */
  eventFile: string;
  /** Epoch ms when the bridge was spawned. */
  startedAt: number;
  /** The turn's tool-callback bearer token, so a later request (next turn's
   *  spawn, or the stop route) can revoke it when it kills the bridge. */
  toolToken?: string;
  /** The turn's LLM-proxy token (bfap_) — same revocation rail: killing the
   *  bridge must also cut off its inference access. */
  llmProxyToken?: string;
  /** True once an end_turn event has been observed for this turn. */
  endedNormally?: boolean;
  /** Epoch ms when end_turn was observed. */
  endedAt?: number;
  /** True when the bridge is known dead without end_turn (crash/kill). A dead
   *  record tells the client to stop reattaching and fall back to a fresh
   *  continuation turn. */
  dead?: boolean;
}

function key(projectId: string, threadId: string): string {
  return `${KEY_PREFIX}${projectId}:${threadId}`;
}

function parseRecord(raw: string | ClaudeCodeTurnRecord | null | undefined): ClaudeCodeTurnRecord | null {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw) as ClaudeCodeTurnRecord;
  } catch {
    return null;
  }
}

export async function getTurnRecord(
  projectId: string,
  threadId: string,
): Promise<ClaudeCodeTurnRecord | null> {
  return parseRecord(await redis.get<string | ClaudeCodeTurnRecord>(key(projectId, threadId)));
}

/** Batched read for the threads status poll — one Redis round-trip. */
export async function getTurnRecords(
  projectId: string,
  threadIds: string[],
): Promise<Map<string, ClaudeCodeTurnRecord>> {
  const out = new Map<string, ClaudeCodeTurnRecord>();
  if (threadIds.length === 0) return out;
  const raws = await redis.mget<(string | ClaudeCodeTurnRecord | null)[]>(
    ...threadIds.map((t) => key(projectId, t)),
  );
  threadIds.forEach((t, i) => {
    const record = parseRecord(raws?.[i]);
    if (record) out.set(t, record);
  });
  return out;
}

export async function setTurnRecord(
  projectId: string,
  record: ClaudeCodeTurnRecord,
): Promise<void> {
  await redis.setex(key(projectId, record.threadId), TTL_SECONDS, JSON.stringify(record));
}

/** A record whose bridge may still be working: not ended, not known dead, and
 *  younger than the record TTL (a crashed bridge nobody reattached to never
 *  gets marked dead, so age is the backstop). */
export function isTurnLive(record: ClaudeCodeTurnRecord | null | undefined): boolean {
  if (!record || record.endedNormally || record.dead) return false;
  return Date.now() - record.startedAt < TTL_SECONDS * 1000;
}

/** Merge a partial update into the current record. No-op when the record is
 *  gone or now describes a DIFFERENT turn (a new spawn overwrote it — the
 *  update belongs to the dead turn and must not corrupt the live one). */
async function updateTurnRecord(
  projectId: string,
  threadId: string,
  turnId: string,
  patch: Partial<ClaudeCodeTurnRecord>,
): Promise<void> {
  const current = await getTurnRecord(projectId, threadId);
  if (!current || current.turnId !== turnId) return;
  await setTurnRecord(projectId, { ...current, ...patch });
}

export async function markTurnEnded(
  projectId: string,
  threadId: string,
  turnId: string,
): Promise<void> {
  await updateTurnRecord(projectId, threadId, turnId, {
    endedNormally: true,
    endedAt: Date.now(),
  });
}

export async function markTurnDead(
  projectId: string,
  threadId: string,
  turnId: string,
): Promise<void> {
  await updateTurnRecord(projectId, threadId, turnId, { dead: true });
}
