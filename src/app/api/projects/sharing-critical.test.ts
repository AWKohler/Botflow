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

const prepare = vi.hoisted(() => ({ fn: vi.fn(async (projectId: string) => { void projectId; return { stoppedAgents: 0 }; }) }));
vi.mock('@/lib/agent/opencode/setup', async (orig) => ({
  ...(await orig<typeof import('@/lib/agent/opencode/setup')>()),
  purgeOpenCodeCredentials: (projectId: string) => prepare.fn(projectId),
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
  prepare.fn.mockImplementation(async () => ({ stoppedAgents: 0 }));
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

describe('GET /api/projects/[id] codexBlocked', () => {
  test('false for a never-shared project', async () => {
    const p = await createProject({ userId: OWNER });
    await signInAs(OWNER);
    const { GET } = await projectRoute();
    expect((await (await callRoute(GET, { params: { id: p.id } })).json()).codexBlocked).toBe(false);
  });

  test('stays true after the last member leaves (sticky)', async () => {
    const p = await createProject({ userId: OWNER });
    await signInAs(OWNER, { plan: 'pro' });
    const { POST } = await membersRoute();
    expect((await callRoute(POST, { method: 'POST', params: { id: p.id }, body: { email: 'x@example.test' } })).status).toBe(200);
    await currentTestDb().update(projectMembers).set({ status: 'revoked' }).where(eq(projectMembers.projectId, p.id));
    const { GET } = await projectRoute();
    expect((await (await callRoute(GET, { params: { id: p.id } })).json()).codexBlocked).toBe(true);
  });
});

describe('first invite secures the sandbox before anyone gets access', () => {
  test('a sandbox that may hold a credential is purged before the member row is written', async () => {
    const p = await createProject({ userId: OWNER, sandboxCredentials: 'present' });
    await signInAs(OWNER, { plan: 'pro' });
    await createUser({ id: EDITOR, email: 'editor@example.test' });
    prepare.fn.mockImplementation(async () => {
      const rows = await currentTestDb().select().from(projectMembers).where(eq(projectMembers.projectId, p.id));
      expect(rows).toHaveLength(0);
      return { stoppedAgents: 1 };
    });
    const { POST } = await membersRoute();
    const res = await callRoute(POST, { method: 'POST', params: { id: p.id }, body: { email: 'editor@example.test' } });
    expect(res.status).toBe(200);
    expect((await res.json()).stoppedAgents).toBe(1);
    expect(prepare.fn).toHaveBeenCalledTimes(1);
    const [row] = await currentTestDb().select().from(projects).where(eq(projects.id, p.id));
    expect(row.sharedAt).toBeInstanceOf(Date);
    expect(row.sandboxCredentials).toBe('none');
  });

  test('if the sandbox cannot be verified clean, nobody is invited', async () => {
    const p = await createProject({ userId: OWNER, sandboxCredentials: 'present' });
    await signInAs(OWNER, { plan: 'pro' });
    prepare.fn.mockRejectedValue(new Error('sandbox unreachable'));
    const { POST } = await membersRoute();
    const res = await callRoute(POST, { method: 'POST', params: { id: p.id }, body: { email: 'someone@example.test' } });
    expect(res.status).toBe(503);
    const rows = await currentTestDb().select().from(projectMembers).where(eq(projectMembers.projectId, p.id));
    expect(rows).toHaveLength(0);
  });

  test('a sandbox known to be clean is not woken', async () => {
    const p = await createProject({ userId: OWNER });
    await signInAs(OWNER, { plan: 'pro' });
    const { POST } = await membersRoute();
    const res = await callRoute(POST, { method: 'POST', params: { id: p.id }, body: { email: 'second@example.test' } });
    expect(res.status).toBe(200);
    expect(prepare.fn).not.toHaveBeenCalled();
  });
});

describe('projects shared before credential tracking', () => {
  test("a member's first access purges the sandbox once", async () => {
    const p = await createProject({ userId: OWNER, sandboxCredentials: null, sharedAt: new Date('2026-07-01') });
    await addMember(p.id, EDITOR);
    await signInAs(EDITOR);
    const { GET } = await projectRoute();
    expect((await callRoute(GET, { params: { id: p.id } })).status).toBe(200);
    expect((await callRoute(GET, { params: { id: p.id } })).status).toBe(200);
    expect(prepare.fn).toHaveBeenCalledTimes(1);
  });

  test('no verified purge → the member is kept out', async () => {
    const p = await createProject({ userId: OWNER, sandboxCredentials: null, sharedAt: new Date('2026-07-01') });
    await addMember(p.id, EDITOR);
    prepare.fn.mockRejectedValue(new Error('sandbox unreachable'));
    await signInAs(EDITOR);
    const { GET } = await projectRoute();
    expect((await callRoute(GET, { params: { id: p.id } })).status).toBe(404);
  });

  test('the owner is never blocked by it', async () => {
    const p = await createProject({ userId: OWNER, sandboxCredentials: null, sharedAt: new Date('2026-07-01') });
    prepare.fn.mockRejectedValue(new Error('sandbox unreachable'));
    await signInAs(OWNER);
    const { GET } = await projectRoute();
    expect((await callRoute(GET, { params: { id: p.id } })).status).toBe(200);
  });
});

describe('every iframe that renders HTML from a string is fully sandboxed', () => {
  test('srcDoc iframes in components use SNAPSHOT_IFRAME_SANDBOX', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    // Static marketing mockups render our own constant HTML.
    const ALLOWED = new Set(['src/components/landing/WorkspaceMockup.tsx']);
    const root = path.resolve(__dirname, '../../../..');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) files.push(full);
      }
    };
    walk(path.join(root, 'src'));
    const offenders: string[] = [];
    for (const f of files) {
      const rel = path.relative(root, f);
      if (ALLOWED.has(rel)) continue;
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/<iframe\b[^>]*?\bsrc[dD]oc\b[\s\S]*?>/g)) {
        if (!/sandbox=(\{SNAPSHOT_IFRAME_SANDBOX\}|"\$\{SNAPSHOT_IFRAME_SANDBOX\}")/.test(m[0])) {
          offenders.push(`${rel}: ${m[0].slice(0, 80)}`);
        }
      }
      if (/\.srcdoc\s*=/.test(src)) offenders.push(`${rel}: assigns .srcdoc directly`);
    }
    expect(offenders).toEqual([]);
  });
});
