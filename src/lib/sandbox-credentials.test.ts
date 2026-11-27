/**
 * Personal credentials vs shared sandboxes (src/lib/sandbox-credentials.ts):
 * the sticky shared marker, fail-closed purge, and the lock that keeps a
 * Codex credential write from interleaving with a share.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { projects } from '@/db/schema';
import { currentTestDb, setupTestDb } from '@/test/db';
import { createProject } from '@/test/factories';

const purge = vi.hoisted(() => ({ fn: vi.fn(async (projectId: string) => { void projectId; return { stoppedAgents: 0 }; }) }));
vi.mock('@/lib/agent/opencode/setup', () => ({
  purgeOpenCodeCredentials: (projectId: string) => purge.fn(projectId),
}));

setupTestDb();

const OWNER = 'user_owner';

async function row(id: string) {
  const [r] = await currentTestDb().select().from(projects).where(eq(projects.id, id));
  return r;
}

beforeEach(() => {
  purge.fn.mockReset();
  purge.fn.mockImplementation(async () => ({ stoppedAgents: 0 }));
});

describe('secureProjectForSharing', () => {
  test('a known-clean sandbox is not touched; the project becomes shared', async () => {
    const { secureProjectForSharing } = await import('./sandbox-credentials');
    const p = await createProject({ userId: OWNER });
    expect(p.sandboxCredentials).toBe('none');
    const res = await secureProjectForSharing(p.id);
    expect(res).toEqual({ stoppedAgents: 0 });
    expect(purge.fn).not.toHaveBeenCalled();
    expect((await row(p.id)).sharedAt).toBeInstanceOf(Date);
  });

  test.each([['present'], [null]])('sandbox credentials %s → purged, then marked none', async (state) => {
    const { secureProjectForSharing } = await import('./sandbox-credentials');
    const p = await createProject({ userId: OWNER, sandboxCredentials: state });
    purge.fn.mockResolvedValue({ stoppedAgents: 2 });
    expect(await secureProjectForSharing(p.id)).toEqual({ stoppedAgents: 2 });
    expect(purge.fn).toHaveBeenCalledWith(p.id);
    expect((await row(p.id)).sandboxCredentials).toBe('none');
  });

  test('a failed purge throws and leaves the sandbox marked unsafe', async () => {
    const { secureProjectForSharing } = await import('./sandbox-credentials');
    const p = await createProject({ userId: OWNER, sandboxCredentials: 'present' });
    purge.fn.mockRejectedValue(new Error('not verified'));
    await expect(secureProjectForSharing(p.id)).rejects.toThrow('not verified');
    const r = await row(p.id);
    expect(r.sandboxCredentials).toBe('present');
    // Sticky even on failure: the project never goes back to using personal credentials.
    expect(r.sharedAt).toBeInstanceOf(Date);
  });

  test('a non-sandbox project has nothing to purge', async () => {
    const { secureProjectForSharing } = await import('./sandbox-credentials');
    const p = await createProject({ userId: OWNER, platform: 'web', sandboxCredentials: 'present' });
    await secureProjectForSharing(p.id);
    expect(purge.fn).not.toHaveBeenCalled();
    expect((await row(p.id)).sandboxCredentials).toBe('none');
  });
});

describe('withPersonalSandboxCredential', () => {
  test('never-shared project: runs, and marks the sandbox as holding a credential first', async () => {
    const { withPersonalSandboxCredential } = await import('./sandbox-credentials');
    const p = await createProject({ userId: OWNER });
    const res = await withPersonalSandboxCredential(p.id, async () => {
      expect((await row(p.id)).sandboxCredentials).toBe('present');
      return 'written';
    });
    expect(res).toEqual({ ok: true, value: 'written' });
  });

  test('a project that was ever shared never runs it — even with no members left', async () => {
    const { withPersonalSandboxCredential } = await import('./sandbox-credentials');
    const p = await createProject({ userId: OWNER, sharedAt: new Date('2026-01-01') });
    const fn = vi.fn(async () => 'written');
    expect(await withPersonalSandboxCredential(p.id, fn)).toEqual({ ok: false, reason: 'shared' });
    expect(fn).not.toHaveBeenCalled();
    expect((await row(p.id)).sandboxCredentials).toBe('none');
  });

  test('a credential write in progress finishes before a share purges; the next write is refused', async () => {
    const { secureProjectForSharing, withPersonalSandboxCredential } = await import('./sandbox-credentials');
    const p = await createProject({ userId: OWNER });
    const order: string[] = [];
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((r) => { releaseWrite = r; });
    purge.fn.mockImplementation(async () => { order.push('purge'); return { stoppedAgents: 1 }; });

    const write = withPersonalSandboxCredential(p.id, async () => {
      order.push('write-start');
      await writeGate;
      order.push('write-end');
    });
    await vi.waitFor(() => expect(order).toContain('write-start'));
    const share = secureProjectForSharing(p.id);
    await new Promise((r) => setTimeout(r, 300));
    expect(order).toEqual(['write-start']); // the share is waiting on the lock
    releaseWrite();
    await write;
    expect(await share).toEqual({ stoppedAgents: 1 });
    expect(order).toEqual(['write-start', 'write-end', 'purge']);

    const late = vi.fn(async () => {});
    expect(await withPersonalSandboxCredential(p.id, late)).toEqual({ ok: false, reason: 'shared' });
    expect(late).not.toHaveBeenCalled();
  });

  test('gives up with a typed error when the lock stays held', async () => {
    const { withPersonalSandboxCredential, SandboxCredentialLockTimeout } = await import('./sandbox-credentials');
    const p = await createProject({ userId: OWNER });
    let release!: () => void;
    const held = withPersonalSandboxCredential(p.id, () => new Promise<void>((r) => { release = r; }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(withPersonalSandboxCredential(p.id, async () => {}, { waitMs: 300 })).rejects.toBeInstanceOf(
      SandboxCredentialLockTimeout,
    );
    release();
    await held;
  });
});
