/**
 * Persists the most recent OpenCode session ID per project so we can resume it
 * on the next turn. Sessions live for 7 days — long enough for a user to come
 * back to a project the following week without losing context, short enough
 * that abandoned sessions don't accumulate.
 *
 * Note: this is just the *pointer* to the session. The session contents
 * (transcript, tool history) live inside the sandbox under
 * `~/.local/share/opencode/` and persist with the sandbox's filesystem.
 */
import { redis } from "@/lib/redis";

const KEY_PREFIX = "opencode:session:";
const TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export async function getOpenCodeSessionId(projectId: string): Promise<string | null> {
  const value = await redis.get<string>(`${KEY_PREFIX}${projectId}`);
  return value ?? null;
}

export async function setOpenCodeSessionId(
  projectId: string,
  sessionId: string,
): Promise<void> {
  await redis.setex(`${KEY_PREFIX}${projectId}`, TTL_SECONDS, sessionId);
}

export async function clearOpenCodeSessionId(projectId: string): Promise<void> {
  await redis.del(`${KEY_PREFIX}${projectId}`);
}
