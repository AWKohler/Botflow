/**
 * Upstash Redis client — single shared instance for the whole app.
 * Import `redis` for raw key-value ops, `ratelimit` helpers live in rate-limit.ts.
 *
 * When UPSTASH env vars are absent (e.g. local dev without Redis), a no-op
 * stub is returned so the app still boots. Rate limiting and caching are
 * simply skipped — usage limits won't be enforced until Redis is configured.
 */

import { Redis } from '@upstash/redis';

/** No-op stub returned when env vars are missing */
const noopRedis = {
  get: async () => null,
  set: async () => 'OK' as const,
  setex: async () => 'OK' as const,
  del: async () => 0,
  incr: async () => 0,
  incrby: async () => 0,
  expire: async () => 1,
  // Claiming the key "exists" makes ensureMonthlySeeded skip its Neon seed —
  // no DB touch in no-op mode, and gets return null → limits degrade to
  // unenforced, exactly the documented no-Redis behavior.
  exists: async () => 1,
  // List ops used by workspace-control's browser-log ring buffer. Returning
  // empty / OK lets the feature degrade silently when Redis isn't configured
  // (local dev) — the agent's getBrowserLog tool just shows "no logs yet".
  lpush: async () => 0,
  ltrim: async () => 'OK' as const,
  lrange: async () => [] as string[],
} as unknown as Redis;

// Singleton — Next.js module cache keeps this alive across hot reloads in dev
let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (_redis) return _redis;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[redis] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — using no-op fallback (limits not enforced)');
    }
    return noopRedis;
  }

  _redis = new Redis({ url, token });
  return _redis;
}

export const redis = getRedis();
