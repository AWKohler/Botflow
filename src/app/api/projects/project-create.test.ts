/**
 * POST /api/projects: plan limits, entitlement gates, and the managed-Convex
 * kill switch are enforced server-side (the UI hiding a button is not a gate).
 */
import { describe, expect, test, vi } from 'vitest';
import { projects } from '@/db/schema';
import { createUser, signInAs } from '@/test/auth';
import { currentTestDb, setupTestDb } from '@/test/db';
import { createProject } from '@/test/factories';
import { callRoute } from '@/test/route';
import { POST } from './route';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_ALLOW_PERSISTENT_EXP = 'true';
});

setupTestDb();

const create = (body: Record<string, unknown>) =>
  callRoute(POST, { method: 'POST', path: '/api/projects', body: { name: 'New app', ...body } });

async function count(userId: string) {
  return (await currentTestDb().select().from(projects)).filter((p) => p.userId === userId).length;
}

describe('project count limit', () => {
  test('free user at the limit (3) is refused', async () => {
    await createUser({ id: 'free' });
    await signInAs('free');
    for (let i = 0; i < 3; i++) await createProject({ userId: 'free' });
    const res = await create({ platform: 'sandboxed-web' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await count('free')).toBe(3);
  });

  test("reaped (soft-deleted) projects don't count against the limit", async () => {
    await createUser({ id: 'free' });
    await signInAs('free');
    for (let i = 0; i < 3; i++) await createProject({ userId: 'free', deletedAt: new Date() });
    expect((await create({ platform: 'sandboxed-web' })).status).toBe(201);
  });

  test('beta users are exempt', async () => {
    await createUser({ id: 'beta', publicMetadata: { isBeta: true } });
    await signInAs('beta');
    for (let i = 0; i < 25; i++) await createProject({ userId: 'beta' });
    expect((await create({ platform: 'sandboxed-web' })).status).toBe(201);
  });

  // KNOWN GAP: count-then-insert is not atomic. A burst of parallel creates
  // all read the same count and all pass — each new project can cost a VM.
  test.fails('parallel creates cannot overshoot the limit', async () => {
    await createUser({ id: 'free' });
    await signInAs('free');
    await createProject({ userId: 'free' });
    await createProject({ userId: 'free' });
    await Promise.all(Array.from({ length: 5 }, () => create({ platform: 'sandboxed-web' })));
    expect(await count('free')).toBeLessThanOrEqual(3);
  });
});

describe('entitlements', () => {
  test('free (non-beta) user cannot create a Swift project', async () => {
    await createUser({ id: 'free' });
    await signInAs('free');
    expect((await create({ platform: 'swift' })).status).toBe(403);
    expect(await count('free')).toBe(0);
  });

  test('pro user can', async () => {
    await createUser({ id: 'pro', publicMetadata: { plan: 'pro' } });
    await signInAs('pro');
    const res = await create({ platform: 'swift' });
    expect(res.status).toBe(201);
    expect((await res.json()).platform).toBe('swift');
  });

  test('managed Convex refused while NEXT_PUBLIC_DISABLE_MANAGED_CONVEX=true', async () => {
    vi.stubEnv('NEXT_PUBLIC_DISABLE_MANAGED_CONVEX', 'true');
    await createUser({ id: 'u' });
    await signInAs('u');
    const res = await create({ platform: 'sandboxed-web', backendType: 'platform' });
    expect(res.status).toBe(403);
    expect(await count('u')).toBe(0);
    vi.unstubAllEnvs();
  });

  test.each([undefined, 'bogus', 'PLATFORM'])('backendType %j never silently becomes managed Convex', async (bt) => {
    await createUser({ id: 'u' });
    await signInAs('u');
    const res = await create({ platform: 'sandboxed-web', backendType: bt });
    expect(res.status).toBe(201);
    expect((await res.json()).backendType).toBe('none');
  });

  test('client cannot choose the owner', async () => {
    await createUser({ id: 'u' });
    await signInAs('u');
    const res = await create({ platform: 'sandboxed-web', userId: 'someone_else' });
    expect((await res.json()).userId).toBe('u');
  });
});
