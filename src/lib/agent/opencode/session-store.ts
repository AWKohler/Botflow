/**
 * Persists the most recent OpenCode session ID per THREAD so the thread's next
 * turn resumes it. Sessions live for 7 days — long enough for a user to come
 * back to a project the following week without losing context, short enough
 * that abandoned sessions don't accumulate.
 *
 * Note: this is just the *pointer* to the session. The session contents
 * (transcript, tool history) live inside the sandbox under
 * `~/.local/share/opencode/` and persist with the sandbox's filesystem.
 */
import { redis } from "@/lib/redis";

// Keyed by thread id (globally unique). The pre-threads per-project keys
// ("opencode:session:<projectId>") are no longer read; a thread without a
// session pointer starts fresh with the prior-conversation preamble.
const KEY_PREFIX = "opencode:thread-session:";
const TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export async function getOpenCodeSessionId(threadId: string): Promise<string | null> {
  const value = await redis.get<string>(`${KEY_PREFIX}${threadId}`);
  return value ?? null;
}

export async function setOpenCodeSessionId(
  threadId: string,
  sessionId: string,
): Promise<void> {
  await redis.setex(`${KEY_PREFIX}${threadId}`, TTL_SECONDS, sessionId);
}

export async function clearOpenCodeSessionId(threadId: string): Promise<void> {
  await redis.del(`${KEY_PREFIX}${threadId}`);
}
