/**
 * Sharing hardening, part 1: untrusted snapshot HTML, the public description,
 * and keeping the owner's personal credentials out of a sandbox before it is
 * shared.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { projectMembers, projects } from '@/db/schema';
import { createUser, signInAs } from '@/test/auth';
import { currentTestDb, setupTestDb } from '@/test/db';
import { addMember, createProject } from '@/test/factories';
import { callRoute } from '@/test/route';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SHARING_ENABLED = 'true';
});

const prepare = vi.hoisted(() => ({ fn: vi.fn(async () => {}) }));
vi.mock('@/lib/sharing-guard', () => ({
  prepareProjectForSharing: (...args: unknown[]) => prepare.fn(...(args as [])),
}));
vi.mock('@/lib/email', async (orig) => ({
  ...(await orig<typeof import('@/lib/email')>()),
  sendEmail: vi.fn(async () => ({ ok: true })),
}));

setupTestDb();

const OWNER = 'user_owner';
const EDITOR = 'user_editor';

const projectRoute = () => import('./[id]/route');
const membersRoute = () => import('./[id]/members/route');

beforeEach(() => {
  prepare.fn.mockReset();
  prepare.fn.mockImplementation(async () => {});
});

describe('PATCH /api/projects/[id]', () => {
  test('snapshot and thumbnail URLs are not writable by anyone', async () => {
    const p = await createProject({ userId: OWNER, htmlSnapshotUrl: 'https://utfs.io/f/real', thumbnailUrl: 'https://utfs.io/f/t' });
    await addMember(p.id, EDITOR);
    for (const who of [OWNER, EDITOR]) {
      await signInAs(who);
      const { PATCH } = await projectRoute();
      await callRoute(PATCH, {
        method: 'PATCH',
        params: { id: p.id },
        body: { htmlSnapshotUrl: 'https://evil.test/x.html', thumbnailUrl: 'https://evil.test/x.png', model: 'gpt-6-luna' },
      });
    }
    const [row] = await currentTestDb().select().from(projects).where(eq(projects.id, p.id));
    expect(row.htmlSnapshotUrl).toBe('https://utfs.io/f/real');
    expect(row.thumbnailUrl).toBe('https://utfs.io/f/t');
  });

  test('an editor cannot change the public description; the owner can', async () => {
    const p = await createProject({ userId: OWNER, publicDescription: 'original' });
    await addMember(p.id, EDITOR);
    const { PATCH } = await projectRoute();

    await signInAs(EDITOR);
    const denied = await callRoute(PATCH, { method: 'PATCH', params: { id: p.id }, body: { publicDescription: 'defaced' } });
    expect(denied.status).toBe(403);

    await signInAs(OWNER);
    const ok = await callRoute(PATCH, { method: 'PATCH', params: { id: p.id }, body: { publicDescription: 'updated' } });
    expect(ok.status).toBe(200);
    const [row] = await currentTestDb().select().from(projects).where(eq(projects.id, p.id));
    expect(row.publicDescription).toBe('updated');
  });
});

describe('GET /api/projects/[id] hasCollaborators', () => {
  test('false for a private project, true once someone is invited', async () => {
    const p = await createProject({ userId: OWNER });
    await signInAs(OWNER);
    const { GET } = await projectRoute();
    expect((await (await callRoute(GET, { params: { id: p.id } })).json()).hasCollaborators).toBe(false);
    await addMember(p.id, EDITOR, { status: 'pending', userId: null });
    expect((await (await callRoute(GET, { params: { id: p.id } })).json()).hasCollaborators).toBe(true);
  });

  test('an expired pending invite or a revoked member does not count', async () => {
    const p = await createProject({ userId: OWNER });
    await addMember(p.id, 'user_a', { status: 'pending', userId: null, invitedAt: new Date(Date.now() - 15 * 24 * 3600 * 1000) });
    await addMember(p.id, 'user_b', { status: 'revoked' });
    await signInAs(OWNER);
    const { GET } = await projectRoute();
    expect((await (await callRoute(GET, { params: { id: p.id } })).json()).hasCollaborators).toBe(false);
  });
});

describe('first invite prepares the sandbox before anyone gets access', () => {
  test('the sandbox is scrubbed before the first member row is written', async () => {
    const p = await createProject({ userId: OWNER });
    await signInAs(OWNER, { plan: 'pro' });
    await createUser({ id: EDITOR, email: 'editor@example.test' });
    prepare.fn.mockImplementation(async () => {
      const rows = await currentTestDb().select().from(projectMembers).where(eq(projectMembers.projectId, p.id));
      expect(rows).toHaveLength(0);
    });
    const { POST } = await membersRoute();
    const res = await callRoute(POST, { method: 'POST', params: { id: p.id }, body: { email: 'editor@example.test' } });
    expect(res.status).toBe(200);
    expect(prepare.fn).toHaveBeenCalledTimes(1);
  });

  test('if the sandbox cannot be scrubbed, nobody is invited', async () => {
    const p = await createProject({ userId: OWNER });
    await signInAs(OWNER, { plan: 'pro' });
    prepare.fn.mockRejectedValue(new Error('sandbox unreachable'));
    const { POST } = await membersRoute();
    const res = await callRoute(POST, { method: 'POST', params: { id: p.id }, body: { email: 'someone@example.test' } });
    expect(res.status).toBe(503);
    const rows = await currentTestDb().select().from(projectMembers).where(eq(projectMembers.projectId, p.id));
    expect(rows).toHaveLength(0);
  });

  test('an already-shared project is not scrubbed again', async () => {
    const p = await createProject({ userId: OWNER });
    await addMember(p.id, EDITOR);
    await signInAs(OWNER, { plan: 'pro' });
    const { POST } = await membersRoute();
    const res = await callRoute(POST, { method: 'POST', params: { id: p.id }, body: { email: 'second@example.test' } });
    expect(res.status).toBe(200);
    expect(prepare.fn).not.toHaveBeenCalled();
  });
});
