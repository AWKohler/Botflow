/**
 * Per-turn bearer tokens used by the Claude Code bridge script when calling
 * back into our server for tools whose execution must stay server-side
 * (e.g. Convex deploy — uses platform-managed keys).
 *
 * Flow:
 *   1. /api/agent/claude-code mints a token + stores binding in Redis
 *   2. Token is passed to the bridge via BOTFLOW_TOOL_TOKEN env var
 *   3. Bridge POSTs to /api/internal/claude-code-tool with the token
 *   4. /api/internal/claude-code-tool resolves the binding to a userId+projectId
 *      and runs the requested tool under that user's context
 *
 * Tokens are scoped per turn, TTL'd in Redis so abandoned ones expire on
 * their own. We don't single-use them — a single turn can deploy Convex
 * multiple times if the model wants to.
 */
import { randomBytes } from "node:crypto";
import { redis } from "@/lib/redis";

const KEY_PREFIX = "claude-code:tool-token:";
const TTL_SECONDS = 60 * 30; // 30 minutes — generous to cover long turns

export interface ToolTokenBinding {
  userId: string;
  projectId: string;
}

export async function mintToolToken(binding: ToolTokenBinding): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await redis.setex(`${KEY_PREFIX}${token}`, TTL_SECONDS, JSON.stringify(binding));
  return token;
}

export async function resolveToolToken(token: string): Promise<ToolTokenBinding | null> {
  if (!token) return null;
  const raw = await redis.get<string | ToolTokenBinding>(`${KEY_PREFIX}${token}`);
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw) as ToolTokenBinding;
  } catch {
    return null;
  }
}

export async function revokeToolToken(token: string): Promise<void> {
  await redis.del(`${KEY_PREFIX}${token}`);
}

/**
 * Sliding expiration: refresh the token's TTL back to full on each successful
 * tool call. The bridge runs detached and can legitimately outlive the route
 * that spawned it by a long stretch (multi-window turns, 20-minute modal
 * waits) — a fixed TTL would cut off its tool access mid-turn. Abandoned
 * tokens still expire TTL_SECONDS after their last use, and the next turn's
 * spawn (and the stop route) revoke the previous turn's token explicitly.
 */
export async function touchToolToken(token: string): Promise<void> {
  try {
    await redis.expire(`${KEY_PREFIX}${token}`, TTL_SECONDS);
  } catch {
    /* best-effort — worst case the token expires on its original clock */
  }
}
