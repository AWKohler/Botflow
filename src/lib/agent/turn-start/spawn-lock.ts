/**
 * Short per-thread spawn lock. The sandbox's "is this thread's bridge alive?"
 * check can't see a bridge that was spawned a moment ago but hasn't written
 * its pidfile yet, so two near-simultaneous sends to one thread could both
 * pass it. Holding this lock from the check until the turn is registered
 * closes that window. The TTL is the backstop if a starter throws.
 */
import { redis } from "@/lib/redis";

const TTL_SECONDS = 30;
const key = (threadId: string) => `thread-spawn-lock:${threadId}`;

export async function acquireThreadSpawnLock(threadId: string): Promise<boolean> {
  const res = await redis.set(key(threadId), "1", { nx: true, ex: TTL_SECONDS });
  return res === "OK";
}

export async function releaseThreadSpawnLock(threadId: string): Promise<void> {
  await redis.del(key(threadId)).catch(() => {});
}
