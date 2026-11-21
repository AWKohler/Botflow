/**
 * DELETE /api/projects/[id]: tears down what the platform owns, and never
 * what the user owns (BYOC Convex lives in the user's own account).
 */
import { eq } from 'drizzle-orm';
import { describe, expect, test, vi } from 'vitest';
import { projectEnvVars, projectMembers, projects } from '@/db/schema';
import { signInAs } from '@/test/auth';
import { currentTestDb, setupTestDb } from '@/test/db';
import { addMember, createProject } from '@/test/factories';
import { callRoute } from '@/test/route';

const calls = vi.hoisted(() => ({
  convexDeleted: [] as string[],
  convexFails: false,
  sandboxDeleted: [] as string[],
  sandboxFails: false,
}));

vi.mock('@/lib/convex-platform', async (orig) => ({
  ...(await orig<typeof import('@/lib/convex-platform')>()),
  deleteConvexBackend: async (id: string) => {
    calls.convexDeleted.push(id);
    if (calls.convexFails) throw new Error('convex api down');
  },
}));

vi.mock('@/lib/vercel-sandbox', async (orig) => ({
  ...(await orig<typeof import('@/lib/vercel-sandbox')>()),
  deletePersistentSandbox: async (id: string) => {
    calls.sandboxDeleted.push(id);
    if (calls.sandboxFails) throw new Error('sandbox api down');
  },
}));

const { DELETE } = await import('./[id]/route');

setupTestDb();

function reset() {
  calls.convexDeleted.length = 0;
  calls.sandboxDeleted.length = 0;
  calls.convexFails = false;
  calls.sandboxFails = false;
}

async function del(id: string) {
  return callRoute(DELETE, { method: 'DELETE', params: { id } });
}

async function exists(id: string) {
  return (await currentTestDb().select().from(projects).where(eq(projects.id, id))).length > 0;
}

describe('DELETE /api/projects/[id]', () => {
  test('platform-managed Convex backend is deleted', async () => {
    reset();
    const p = await createProject({ userId: 'owner', backendType: 'platform', convexProjectId: '12345' });
    await signInAs('owner');
    expect((await del(p.id)).status).toBe(200);
    expect(calls.convexDeleted).toEqual(['12345']);
    expect(await exists(p.id)).toBe(false);
  });

  test("BYOC Convex (user's own account) is detached, never deleted", async () => {
    reset();
    const p = await createProject({ userId: 'owner', backendType: 'user', convexProjectId: 'my-team-slug' });
    await signInAs('owner');
    expect((await del(p.id)).status).toBe(200);
    expect(calls.convexDeleted).toEqual([]);
    expect(await exists(p.id)).toBe(false);
  });

  test('no backend → no Convex call', async () => {
    reset();
    const p = await createProject({ userId: 'owner', backendType: 'none', convexProjectId: 'stale' });
    await signInAs('owner');
    await del(p.id);
    expect(calls.convexDeleted).toEqual([]);
  });

  test('Convex API failure does not block deleting the project', async () => {
    reset();
    calls.convexFails = true;
    const p = await createProject({ userId: 'owner', backendType: 'platform', convexProjectId: '1' });
    await signInAs('owner');
    expect((await del(p.id)).status).toBe(200);
    expect(await exists(p.id)).toBe(false);
  });

  test('child rows cascade; other projects untouched', async () => {
    reset();
    const p = await createProject({ userId: 'owner' });
    const keep = await createProject({ userId: 'owner' });
    await addMember(p.id, 'editor');
    await currentTestDb().insert(projectEnvVars).values([
      { projectId: p.id, key: 'A', value: '1' },
      { projectId: keep.id, key: 'B', value: '2' },
    ]);
    await signInAs('owner');
    await del(p.id);
    const db = currentTestDb();
    expect(await db.select().from(projectMembers)).toEqual([]);
    expect((await db.select().from(projectEnvVars)).map((r) => r.key)).toEqual(['B']);
    expect(await exists(keep.id)).toBe(true);
  });

  test("an editor cannot delete, and nothing external is torn down", async () => {
    reset();
    const p = await createProject({ userId: 'owner', backendType: 'platform', convexProjectId: '1' });
    await addMember(p.id, 'editor');
    await signInAs('editor');
    expect((await del(p.id)).status).toBe(404);
    expect(calls.convexDeleted).toEqual([]);
    expect(await exists(p.id)).toBe(true);
  });

  test('the persistent sandbox is released', async () => {
    reset();
    const p = await createProject({ userId: 'owner', platform: 'sandboxed-web' });
    await signInAs('owner');
    await del(p.id);
    expect(calls.sandboxDeleted).toEqual([p.id]);
  });

  test('reports what was cleaned up', async () => {
    reset();
    const p = await createProject({ userId: 'owner', platform: 'sandboxed-web', backendType: 'user', convexProjectId: 'slug' });
    await signInAs('owner');
    const body = await (await del(p.id)).json();
    expect(body.cleanup).toEqual({ sandbox: 'deleted', convex: 'detached' });
  });

  test('a failed sandbox release is reported, and the project is still deleted', async () => {
    reset();
    calls.sandboxFails = true;
    const p = await createProject({ userId: 'owner', platform: 'swift' });
    await signInAs('owner');
    const res = await del(p.id);
    expect(res.status).toBe(200);
    expect((await res.json()).cleanup.sandbox).toBe('failed');
    expect(await exists(p.id)).toBe(false);
  });

  test('non-sandbox (legacy web) projects make no sandbox call', async () => {
    reset();
    const p = await createProject({ userId: 'owner', platform: 'web' });
    await signInAs('owner');
    const body = await (await del(p.id)).json();
    expect(calls.sandboxDeleted).toEqual([]);
    expect(body.cleanup.sandbox).toBe('none');
  });
});

