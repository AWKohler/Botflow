/** Without a real Redis the credential lock refuses instead of "granting"
 *  every request like the no-op fallback would. */
import { describe, expect, test, vi } from 'vitest';
import { setupTestDb } from '@/test/db';
import { createProject } from '@/test/factories';

vi.mock('@/lib/redis', async () => {
  const { fakeRedis } = await import('@/test/redis-fake');
  return { redis: fakeRedis, getRedis: () => fakeRedis, REDIS_CONFIGURED: false };
});
vi.mock('@/lib/agent/opencode/setup', () => ({ purgeOpenCodeCredentials: vi.fn() }));

setupTestDb();

describe('sandbox credential lock without Redis', () => {
  test('sharing and credential writes both fail closed', async () => {
    const { secureProjectForSharing, withPersonalSandboxCredential } = await import('./sandbox-credentials');
    const p = await createProject({ userId: 'user_owner' });
    await expect(secureProjectForSharing(p.id)).rejects.toThrow(/need Redis/);
    const fn = vi.fn(async () => {});
    await expect(withPersonalSandboxCredential(p.id, fn)).rejects.toThrow(/need Redis/);
    expect(fn).not.toHaveBeenCalled();
  });
});
