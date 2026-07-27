/**
 * Tiny Redis JSON cache for panel API responses. The panel's aggregate queries
 * fan out over several tables plus the Clerk API — cheap enough for an admin
 * page, but not something a hard-refreshing admin should re-run every second.
 * `?refresh=1` on any panel route bypasses the cache.
 */

import { redis } from '@/lib/redis';

export async function panelCached<T>(
  key: string,
  ttlSecs: number,
  refresh: boolean,
  compute: () => Promise<T>,
): Promise<T> {
  const cacheKey = `panel:cache:${key}`;
  if (!refresh) {
    try {
      const hit = await redis.get<T>(cacheKey);
      if (hit != null) return hit;
    } catch {
      // Redis down → compute directly.
    }
  }
  const value = await compute();
  await redis.setex(cacheKey, ttlSecs, value as never).catch(() => {});
  return value;
}
