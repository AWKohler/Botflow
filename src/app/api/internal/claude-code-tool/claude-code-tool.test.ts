/**
 * Claude Code tool callback: the in-sandbox agent's only route back into the
 * platform. The bearer tool token binds (user, project); access is re-checked
 * live on every call so revoking a member kills their running agent's reach.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { projectMembers } from '@/db/schema';
import { mintToolToken, revokeToolToken } from '@/lib/agent/claude-code/tool-token';
import { currentTestDb, setupTestDb, snapshotDb } from '@/test/db';
import { addMember, createProject } from '@/test/factories';
import { callRoute } from '@/test/route';
import { POST } from './route';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SHARING_ENABLED = 'true';
});

setupTestDb();
afterEach(() => vi.useRealTimers());

function call(token: string | null, body: unknown) {
  return callRoute(POST as never, {
    method: 'POST',
    path: '/api/internal/claude-code-tool',
    body,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe('token auth', () => {
  test.each([
    ['no header', null],
    ['unknown token', 'not-a-real-token'],
  ])('%s → 401', async (_l, token) => {
    const before = await snapshotDb();
    expect((await call(token, { tool: 'git_status' })).status).toBe(401);
    expect(await snapshotDb()).toEqual(before);
  });

  test('revoked token → 401', async () => {
    const p = await createProject({ userId: 'owner' });
    const token = await mintToolToken({ userId: 'owner', projectId: p.id });
    await revokeToolToken(token);
    expect((await call(token, { tool: 'git_status' })).status).toBe(401);
  });

  test('token expires after 30 idle minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const p = await createProject({ userId: 'owner' });
    const token = await mintToolToken({ userId: 'owner', projectId: p.id });
    vi.setSystemTime(Date.now() + 30 * 60_000 + 1);
    expect((await call(token, { tool: 'git_status' })).status).toBe(401);
  });

  test('tokens are unguessable (256 bits, url-safe, unique)', async () => {
    const tokens = await Promise.all(
      Array.from({ length: 200 }, () => mintToolToken({ userId: 'u', projectId: 'p' })),
    );
    expect(new Set(tokens).size).toBe(200);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('live access re-check', () => {
  test("a member revoked mid-turn: their agent's token stops working", async () => {
    const p = await createProject({ userId: 'owner' });
    const m = await addMember(p.id, 'editor');
    const token = await mintToolToken({ userId: 'editor', projectId: p.id });
    await currentTestDb().update(projectMembers).set({ status: 'revoked' }).where(eq(projectMembers.id, m.id));
    expect((await call(token, { tool: 'git_status' })).status).toBe(404);
  });

  test('a token bound to a deleted project → 404', async () => {
    const token = await mintToolToken({ userId: 'owner', projectId: '00000000-0000-4000-8000-000000000123' });
    expect((await call(token, { tool: 'git_status' })).status).toBe(404);
  });
});

describe('editor restrictions', () => {
  async function editorToken(flags: { editorsCanPush?: boolean } = {}) {
    const p = await createProject({ userId: 'owner', ...flags });
    await addMember(p.id, 'editor');
    return mintToolToken({ userId: 'editor', projectId: p.id });
  }

  test.each(['initialize_stripe_payments', 'setup_oauth_provider'])(
    'owner-only integration tool %s is refused for editors',
    async (tool) => {
      const token = await editorToken();
      const before = await snapshotDb();
      const body = (await (await call(token, { tool, input: { provider: 'google' } })).json()) as {
        ok: boolean;
        content: string;
      };
      expect(body.ok).toBe(false);
      expect(body.content).toMatch(/owner/i);
      expect(await snapshotDb()).toEqual(before);
    },
  );

  test.each(['git_commit', 'git_push', 'git_pull', 'git_resolve_conflict', 'git_abort_merge', 'open_pull_request'])(
    '%s is refused for editors unless the owner enabled push',
    async (tool) => {
      const token = await editorToken({ editorsCanPush: false });
      const body = (await (await call(token, { tool, input: {} })).json()) as { ok: boolean; content: string };
      expect(body.ok).toBe(false);
      expect(body.content).toMatch(/push/i);
    },
  );
});

describe('input validation', () => {
  test('missing tool → 400', async () => {
    const p = await createProject({ userId: 'owner' });
    const token = await mintToolToken({ userId: 'owner', projectId: p.id });
    expect((await call(token, { input: {} })).status).toBe(400);
  });

  test('non-JSON body → 400', async () => {
    const p = await createProject({ userId: 'owner' });
    const token = await mintToolToken({ userId: 'owner', projectId: p.id });
    const res = await callRoute(POST as never, {
      method: 'POST',
      body: '{nope',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });

  test('unknown tool is rejected without side effects', async () => {
    const p = await createProject({ userId: 'owner' });
    const token = await mintToolToken({ userId: 'owner', projectId: p.id });
    const before = await snapshotDb();
    const res = await call(token, { tool: '__proto__', input: {} });
    const body = (await res.json()) as { ok?: boolean };
    expect(res.status === 400 || body.ok === false).toBe(true);
    expect(await snapshotDb()).toEqual(before);
  });
});
