/**
 * Reaper cron end-to-end over a mixed population of projects: auth, dry-run
 * safety, paid-owner exemption, and what each action actually tears down.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, test, vi } from 'vitest';
import { projects } from '@/db/schema';
import { createUser } from '@/test/auth';
import { currentTestDb, setupTestDb, snapshotDb } from '@/test/db';
import { createProject } from '@/test/factories';
import { callRoute } from '@/test/route';

const effects = vi.hoisted(() => {
  process.env.CRON_SECRET = 'cron-secret';
  return { sandboxes: [] as string[], convex: [] as string[], emails: [] as string[] };
});

vi.mock('@/lib/vercel-sandbox', async (orig) => ({
  ...(await orig<typeof import('@/lib/vercel-sandbox')>()),
  deletePersistentSandbox: async (id: string) => void effects.sandboxes.push(id),
}));
vi.mock('@/lib/convex-platform', async (orig) => ({
  ...(await orig<typeof import('@/lib/convex-platform')>()),
  deleteConvexBackend: async (id: string) => void effects.convex.push(id),
}));
vi.mock('@/lib/reaper/emails', () => ({
  sendWarn90Email: async (o: { projectId: string }) => void effects.emails.push(`warn90:${o.projectId}`),
  sendWarn104Email: async (o: { projectId: string }) => void effects.emails.push(`warn104:${o.projectId}`),
  sendRestoredEmail: async () => {},
}));

const { GET } = await import('./route');

setupTestDb();

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

function reset() {
  effects.sandboxes.length = 0;
  effects.convex.length = 0;
  effects.emails.length = 0;
}

function run(search: Record<string, string> = {}, auth = 'Bearer cron-secret') {
  return callRoute(GET as never, { path: '/api/cron/sandbox-reaper', search, headers: { authorization: auth } });
}

async function stage(id: string) {
  const [row] = await currentTestDb().select().from(projects).where(eq(projects.id, id));
  return row;
}

async function population() {
  await createUser({ id: 'free_user' });
  await createUser({ id: 'paid_user', publicMetadata: { plan: 'pro' } });
  const idle = (d: number) => ({ lastSandboxActivityAt: daysAgo(d), lastOpened: daysAgo(d), createdAt: daysAgo(d) });
  return {
    fresh: await createProject({ userId: 'free_user', ...idle(10) }),
    warn: await createProject({ userId: 'free_user', ...idle(95) }),
    archive: await createProject({ userId: 'free_user', ...idle(120) }),
    live: await createProject({ userId: 'free_user', ...idle(300), convexCallsLast30d: 42 }),
    paid: await createProject({ userId: 'paid_user', ...idle(800), reapStage: 'archived' }),
    doomed: await createProject({
      userId: 'free_user',
      ...idle(400),
      reapStage: 'archived',
      backendType: 'platform',
      convexProjectId: 'cvx_1',
    }),
    byocDoomed: await createProject({
      userId: 'free_user',
      ...idle(400),
      reapStage: 'archived',
      backendType: 'user',
      convexProjectId: 'their-team',
      convexCallsLast30d: 0,
    }),
  };
}

describe('sandbox reaper cron', () => {
  test.each([
    ['missing', ''],
    ['wrong', 'Bearer nope'],
    ['bare secret without Bearer', 'cron-secret'],
  ])('%s secret → 401, nothing touched', async (_l, auth) => {
    reset();
    await population();
    const before = await snapshotDb();
    expect((await run({}, auth)).status).toBe(401);
    expect(await snapshotDb()).toEqual(before);
    expect(effects).toEqual({ sandboxes: [], convex: [], emails: [] });
  });

  test('dryRun reports decisions but changes nothing', async () => {
    reset();
    await population();
    const before = await snapshotDb();
    const res = await run({ dryRun: '1' });
    const { stats } = (await res.json()) as { stats: Record<string, number> };
    expect(stats).toMatchObject({ warned90: 1, archived: 1, hardDeleted: 2 });
    expect(await snapshotDb()).toEqual(before);
    expect(effects).toEqual({ sandboxes: [], convex: [], emails: [] });
  });

  test('real run: each project gets exactly its action', async () => {
    reset();
    const p = await population();
    expect((await run()).status).toBe(200);

    expect((await stage(p.fresh.id)).reapStage).toBe('active');
    expect((await stage(p.live.id)).reapStage).toBe('active');
    expect((await stage(p.paid.id)).reapStage).toBe('archived'); // paid: untouched
    expect((await stage(p.warn.id)).reapStage).toBe('warned_90d');
    expect((await stage(p.archive.id)).reapStage).toBe('archived');

    // Hard delete is a soft-delete of the row (appeal trail).
    const doomed = await stage(p.doomed.id);
    expect(doomed.reapStage).toBe('deleted');
    expect(doomed.deletedAt).toBeInstanceOf(Date);

    // Managed Convex torn down; BYOC Convex (user's own account) never.
    expect(effects.convex).toEqual(['cvx_1']);
    expect(effects.sandboxes.sort()).toEqual([p.archive.id, p.byocDoomed.id, p.doomed.id].sort());
    expect(effects.emails.sort()).toEqual([`warn104:${p.archive.id}`, `warn90:${p.warn.id}`].sort());
  });

  test('second run the same day sends nothing new', async () => {
    reset();
    await population();
    await run();
    reset();
    await run();
    expect(effects.emails).toEqual([]);
    expect(effects.convex).toEqual([]);
  });
});
