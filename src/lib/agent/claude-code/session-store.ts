/**
 * Persists the most recent Claude Code session ID per THREAD so we can pass
 * it back as `resume` on the thread's next turn. Sessions live for 7 days —
 * long enough for a user to come back to a project the following week without
 * losing context, short enough that abandoned sessions don't accumulate.
 *
 * Note: this is just the *pointer* to the session. The session contents
 * (transcript, tool history) live inside the sandbox at
 * `~/.claude/projects/...` and persist with the sandbox's filesystem.
 */
import { redis } from "@/lib/redis";

// Keyed by thread id (globally unique). The pre-threads per-project keys
// ("claude-code:session:<projectId>") are no longer read; a thread without a
// session pointer starts fresh with the prior-conversation preamble.
const KEY_PREFIX = "claude-code:thread-session:";
const TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export async function getClaudeCodeSessionId(threadId: string): Promise<string | null> {
  const value = await redis.get<string>(`${KEY_PREFIX}${threadId}`);
  return value ?? null;
}

export async function setClaudeCodeSessionId(
  threadId: string,
  sessionId: string,
): Promise<void> {
  await redis.setex(`${KEY_PREFIX}${threadId}`, TTL_SECONDS, sessionId);
}

export async function clearClaudeCodeSessionId(threadId: string): Promise<void> {
  await redis.del(`${KEY_PREFIX}${threadId}`);
}
