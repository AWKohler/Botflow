/**
 * DELETE /api/projects/[id]: tears down what the platform owns. What the user
 * owns (a Convex project in their own Convex account) is deleted only when
 * they ask for it, and only through their own Convex connection.
 */
import { eq } from 'drizzle-orm';
import { http, HttpResponse } from 'msw';
import { describe, expect, test, vi } from 'vitest';
import { projectEnvVars, projectMembers, projects } from '@/db/schema';
import { signInAs } from '@/test/auth';
import { currentTestDb, setupTestDb } from '@/test/db';
import { addMember, createProject } from '@/test/factories';
import { server } from '@/test/network';
import { callRoute } from '@/test/route';

const calls = vi.hoisted(() => ({
  convexToken: 'team:acme|jwt' as string | null,
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

vi.mock('@/lib/user-credentials', async (orig) => {
  const real = await orig<typeof import('@/lib/user-credentials')>();
  return {
    ...real,
    getUserCredentials: async (userId: string) => ({
      ...(await real.getUserCredentials(userId)),
      convexOAuthAccessToken: calls.convexToken,
      convexTeamId: calls.convexToken ? 'acme' : null,
    }),
  };
});

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
  calls.convexToken = 'team:acme|jwt';
  calls.convexDeleted.length = 0;
  calls.sandboxDeleted.length = 0;
  calls.convexFails = false;
  calls.sandboxFails = false;
}

async function del(id: string, search?: Record<string, string>) {
  return callRoute(DELETE, { method: 'DELETE', params: { id }, search });
}

/**
 * The user's Convex team, as the Convex Management API shows it to their team
 * token. `fail` makes one endpoint answer with that status.
 */
function fakeConvexTeam(opts: { projects?: Array<{ id: number; slug: string }>; fail?: { path: RegExp; status: number } } = {}) {
  const team = { projects: [...(opts.projects ?? [])], deleted: [] as number[], calls: [] as string[] };
  const failing = (path: string) => (opts.fail && opts.fail.path.test(path) ? opts.fail.status : 0);
  server.use(
    http.get('https://api.convex.dev/v1/token_details', ({ request }) => {
      team.calls.push('token_details');
      if (request.headers.get('authorization') !== 'Bearer team:acme|jwt') return new HttpResponse(null, { status: 401 });
      const status = failing('token_details');
      return status ? new HttpResponse(null, { status }) : HttpResponse.json({ type: 'teamToken', teamId: 42 });
    }),
    http.get('https://api.convex.dev/v1/teams/42/list_projects', () => {
      team.calls.push('list_projects');
      const status = failing('list_projects');
      return status ? new HttpResponse(null, { status }) : HttpResponse.json(team.projects);
    }),
    http.post('https://api.convex.dev/v1/projects/:id/delete', ({ params }) => {
      team.calls.push(`delete ${params.id}`);
      const status = failing('delete');
      if (status) return new HttpResponse(null, { status });
      team.deleted.push(Number(params.id));
      team.projects = team.projects.filter((p) => p.id !== Number(params.id));
      return HttpResponse.json({});
    }),
  );
  return team;
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
    expect(body.cleanup).toEqual({
      sandbox: 'deleted',
      convex: 'detached',
      userConvexProject: { slug: 'slug', dashboardUrl: 'https://dashboard.convex.dev/t/acme/slug', deleted: false },
    });
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

describe("DELETE /api/projects/[id]?deleteConvexProject=true (the user's own Convex project)", () => {
  async function byocProject(slug = 'bf-streakpal') {
    return createProject({ userId: 'owner', backendType: 'user', convexProjectId: slug });
  }

  test('deletes it in the Convex team the user connected, and the Botflow project', async () => {
    reset();
    const team = fakeConvexTeam({ projects: [{ id: 7, slug: 'other-app' }, { id: 9, slug: 'bf-streakpal' }] });
    const p = await byocProject();
    await signInAs('owner');
    const res = await del(p.id, { deleteConvexProject: 'true' });
    expect(res.status).toBe(200);
    const { cleanup } = await res.json();
    expect(cleanup.convex).toBe('deleted');
    expect(cleanup.userConvexProject).toMatchObject({ slug: 'bf-streakpal', deleted: true });
    expect(team.deleted).toEqual([9]);
    expect(team.projects.map((x) => x.slug)).toEqual(['other-app']);
    expect(calls.convexDeleted).toEqual([]); // never through the platform token
    expect(await exists(p.id)).toBe(false);
  });

  test('without the flag (the default, and older clients) it is kept and Convex is not called', async () => {
    reset();
    const team = fakeConvexTeam({ projects: [{ id: 9, slug: 'bf-streakpal' }] });
    const p = await byocProject();
    await signInAs('owner');
    const { cleanup } = await (await del(p.id)).json();
    expect(cleanup.convex).toBe('detached');
    expect(cleanup.userConvexProject.deleted).toBe(false);
    expect(team.calls).toEqual([]);
  });

  test('a Convex project another Botflow project still uses is kept', async () => {
    reset();
    const team = fakeConvexTeam({ projects: [{ id: 9, slug: 'bf-streakpal' }] });
    const p = await byocProject();
    await byocProject();
    await signInAs('owner');
    const { cleanup } = await (await del(p.id, { deleteConvexProject: 'true' })).json();
    expect(cleanup.userConvexProject).toMatchObject({ deleted: false, error: expect.stringMatching(/Another of your Botflow projects/) });
    expect(team.calls).toEqual([]);
    expect(await exists(p.id)).toBe(false);
  });

  test('a project that is not in the connected team is never touched, and the user is pointed at their team', async () => {
    reset();
    const team = fakeConvexTeam({ projects: [{ id: 7, slug: 'other-app' }] });
    const p = await byocProject();
    await signInAs('owner');
    const { cleanup } = await (await del(p.id, { deleteConvexProject: 'true' })).json();
    expect(cleanup.convex).toBe('detached');
    expect(cleanup.userConvexProject).toMatchObject({
      deleted: false,
      dashboardUrl: 'https://dashboard.convex.dev/t/acme',
      error: expect.stringMatching(/not in the Convex team/),
    });
    expect(team.deleted).toEqual([]);
  });

  test.each([
    ['Convex is no longer connected', () => { calls.convexToken = null; }, {}, /no longer connected/],
    ['Convex rejects the token', () => { calls.convexToken = 'team:acme|revoked'; }, {}, /did not accept/],
    ['Convex fails to delete', () => undefined, { fail: { path: /delete/, status: 500 } }, /could not be reached/],
    ['Convex refuses the delete', () => undefined, { fail: { path: /delete/, status: 403 } }, /refused/],
  ])('when %s: the project is still deleted, the Convex project is kept, and the user is told why', async (_label, arrange, teamOpts, message) => {
    reset();
    fakeConvexTeam({ projects: [{ id: 9, slug: 'bf-streakpal' }], ...teamOpts });
    arrange();
    const p = await byocProject();
    await signInAs('owner');
    const res = await del(p.id, { deleteConvexProject: 'true' });
    expect(res.status).toBe(200);
    const { cleanup } = await res.json();
    expect(cleanup.convex).toBe('detached');
    expect(cleanup.userConvexProject).toMatchObject({ slug: 'bf-streakpal', deleted: false, error: expect.stringMatching(message) });
    expect(await exists(p.id)).toBe(false);
  });

  test('the flag never deletes a platform-managed backend twice or a missing one', async () => {
    reset();
    const team = fakeConvexTeam();
    const platform = await createProject({ userId: 'owner', backendType: 'platform', convexProjectId: '12345' });
    const none = await createProject({ userId: 'owner', backendType: 'none', convexProjectId: null });
    await signInAs('owner');
    await del(platform.id, { deleteConvexProject: 'true' });
    await del(none.id, { deleteConvexProject: 'true' });
    expect(calls.convexDeleted).toEqual(['12345']);
    expect(team.calls).toEqual([]);
  });

  test("an editor's request deletes nothing, in Botflow or in Convex", async () => {
    reset();
    const team = fakeConvexTeam({ projects: [{ id: 9, slug: 'bf-streakpal' }] });
    const p = await byocProject();
    await addMember(p.id, 'editor');
    await signInAs('editor');
    expect((await del(p.id, { deleteConvexProject: 'true' })).status).toBe(404);
    expect(team.calls).toEqual([]);
    expect(await exists(p.id)).toBe(true);
  });
});
