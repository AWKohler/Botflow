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
import { chatSessions, projectMembers } from '@/db/schema';

const purge = vi.hoisted(() => ({ fn: vi.fn(async (projectId: string) => { void projectId; return { stoppedAgents: 0 }; }) }));
vi.mock('@/lib/agent/opencode/setup', async (orig) => ({
  ...(await orig<typeof import('@/lib/agent/opencode/setup')>()),
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

describe('belt and braces', () => {
  test('any member row means shared, even if shared_at was never set (older deployment)', async () => {
    const { withPersonalSandboxCredential } = await import('./sandbox-credentials');
    const p = await createProject({ userId: OWNER });
    // Written directly, as an older deployment would: no shared_at.
    await currentTestDb().insert(projectMembers).values({
      projectId: p.id, invitedEmail: 'x@example.test', invitedBy: OWNER, status: 'pending',
    });
    const fn = vi.fn(async () => {});
    expect(await withPersonalSandboxCredential(p.id, fn)).toEqual({ ok: false, reason: 'shared' });
    expect(fn).not.toHaveBeenCalled();
    expect((await row(p.id)).sharedAt).toBeInstanceOf(Date);
  });

  test('turns killed by a purge are marked dead and their tokens revoked', async () => {
    const { secureProjectForSharing } = await import('./sandbox-credentials');
    const { setTurnRecord, getTurnRecord } = await import('@/lib/agent/claude-code/turn-registry');
    const p = await createProject({ userId: OWNER, sandboxCredentials: 'present' });
    const [oc] = await currentTestDb().insert(chatSessions).values({ projectId: p.id, createdBy: OWNER }).returning();
    const [cc] = await currentTestDb().insert(chatSessions).values({ projectId: p.id, createdBy: OWNER }).returning();
    await setTurnRecord(p.id, { turnId: 't1', threadId: oc.id, backend: 'opencode', eventFile: '/tmp/x', startedAt: Date.now() });
    await setTurnRecord(p.id, { turnId: 't2', threadId: cc.id, backend: 'claude-code', eventFile: '/tmp/y', startedAt: Date.now() });
    purge.fn.mockResolvedValue({ stoppedAgents: 1 });
    await secureProjectForSharing(p.id);
    expect((await getTurnRecord(p.id, oc.id))?.dead).toBe(true);
    // Claude Code turns hold no personal credential and are left alone.
    expect((await getTurnRecord(p.id, cc.id))?.dead).toBeFalsy();
  });
});

describe('compare-and-set: correctness does not depend on the lock', () => {
  test('a writer whose lease expired is still in flight — the share admits nobody until it ends', async () => {
    const { secureProjectForSharing, withPersonalSandboxCredential, SandboxCredentialWriteInProgress } = await import(
      './sandbox-credentials'
    );
    const { fakeRedis } = await import('@/test/redis-fake');
    const p = await createProject({ userId: OWNER });
    purge.fn.mockResolvedValue({ stoppedAgents: 0 });
    let duringWrite: unknown;
    await withPersonalSandboxCredential(p.id, async () => {
      // The lease expires mid-write: the lock vanishes and a share runs now.
      await fakeRedis.del(`sandbox-credential-lock:${p.id}`);
      duringWrite = await secureProjectForSharing(p.id).catch((e) => e);
    });
    expect(duringWrite).toBeInstanceOf(SandboxCredentialWriteInProgress);
    expect(purge.fn).not.toHaveBeenCalled();
    // Shared already (sticky): no new writer can claim.
    expect((await row(p.id)).sharedAt).toBeInstanceOf(Date);
    // The writer finished and released its window: now the share purges.
    expect((await row(p.id)).credentialWriteUntil).toBeNull();
    expect(await secureProjectForSharing(p.id)).toEqual({ stoppedAgents: 0 });
    expect(purge.fn).toHaveBeenCalledTimes(1);
  });

  test('a writer that died without releasing blocks admission only until its window passes', async () => {
    const { secureProjectForSharing, SandboxCredentialWriteInProgress } = await import('./sandbox-credentials');
    const p = await createProject({ userId: OWNER, sandboxCredentials: 'present', credentialWriteUntil: new Date(Date.now() + 60_000) });
    await expect(secureProjectForSharing(p.id)).rejects.toBeInstanceOf(SandboxCredentialWriteInProgress);
    await currentTestDb().update(projects).set({ credentialWriteUntil: new Date(Date.now() - 1000) }).where(eq(projects.id, p.id));
    purge.fn.mockResolvedValue({ stoppedAgents: 0 });
    await secureProjectForSharing(p.id);
    expect(purge.fn).toHaveBeenCalledTimes(1);
  });

  test('the claim itself refuses once shared_at is set (the WHERE shared_at IS NULL)', async () => {
    const { claimSandboxForCredential } = await import('./sandbox-credentials');
    const p = await createProject({ userId: OWNER });
    await currentTestDb().update(projects).set({ sharedAt: new Date() }).where(eq(projects.id, p.id));
    expect(await claimSandboxForCredential(p.id)).toBe('shared');
    const r = await row(p.id);
    expect(r.sandboxCredentials).toBe('none');
    expect(r.credentialWriteUntil).toBeNull();
  });

  test('an unshared project is claimed with an in-flight window', async () => {
    const { claimSandboxForCredential } = await import('./sandbox-credentials');
    const p = await createProject({ userId: OWNER });
    const claim = await claimSandboxForCredential(p.id);
    if (typeof claim === 'string') throw new Error(`expected a claim, got ${claim}`);
    const r = await row(p.id);
    expect(r.sandboxCredentials).toBe('present');
    expect(r.credentialWriteUntil?.getTime()).toBe(claim.until.getTime());
    expect(claim.until.getTime()).toBeGreaterThan(Date.now() + 300_000);
  });
});

describe('the in-flight window is released only when the write definitely ended', () => {
  test('an ambiguous failure (e.g. transport error) keeps the window — no admission', async () => {
    const { secureProjectForSharing, withPersonalSandboxCredential, SandboxCredentialWriteInProgress } = await import(
      './sandbox-credentials'
    );
    const p = await createProject({ userId: OWNER });
    await expect(
      withPersonalSandboxCredential(p.id, async () => {
        throw new Error('socket hang up');
      }),
    ).rejects.toThrow('socket hang up');
    expect((await row(p.id)).credentialWriteUntil).toBeInstanceOf(Date);
    await expect(secureProjectForSharing(p.id)).rejects.toBeInstanceOf(SandboxCredentialWriteInProgress);
  });

  test.each([['shared'], ['expired']])('a definite refusal (%s) releases it', async (kind) => {
    const { withPersonalSandboxCredential } = await import('./sandbox-credentials');
    const { SandboxSharedError, SandboxCredentialWriteExpired } = await import('@/lib/agent/opencode/setup');
    const p = await createProject({ userId: OWNER });
    await expect(
      withPersonalSandboxCredential(p.id, async () => {
        throw kind === 'shared' ? new SandboxSharedError() : new SandboxCredentialWriteExpired();
      }),
    ).rejects.toBeTruthy();
    expect((await row(p.id)).credentialWriteUntil).toBeNull();
  });

  test('the writer is told its window, to pass to the sandbox as a deadline', async () => {
    const { withPersonalSandboxCredential } = await import('./sandbox-credentials');
    const p = await createProject({ userId: OWNER });
    let seen: Date | null = null;
    await withPersonalSandboxCredential(p.id, async (claim) => {
      seen = claim.until;
      expect((await row(p.id)).credentialWriteUntil?.getTime()).toBe(claim.until.getTime());
    });
    expect(seen).toBeInstanceOf(Date);
  });
});

describe('an unresolved earlier write is never replaced', () => {
  test('A fails ambiguously → retry B is refused (busy) → sharing still refuses until A\'s window passes', async () => {
    const { secureProjectForSharing, withPersonalSandboxCredential, SandboxCredentialWriteInProgress } = await import(
      './sandbox-credentials'
    );
    const p = await createProject({ userId: OWNER });
    await expect(
      withPersonalSandboxCredential(p.id, async () => {
        throw new Error('socket hang up');
      }),
    ).rejects.toThrow();
    const windowA = (await row(p.id)).credentialWriteUntil;
    const b = vi.fn(async () => 'written');
    expect(await withPersonalSandboxCredential(p.id, b)).toEqual({ ok: false, reason: 'busy' });
    expect(b).not.toHaveBeenCalled();
    expect((await row(p.id)).credentialWriteUntil?.getTime()).toBe(windowA?.getTime());
    await expect(secureProjectForSharing(p.id)).rejects.toBeInstanceOf(SandboxCredentialWriteInProgress);
  });

  test('overlapping claims (lease expired): the second claim is refused while the first is in flight', async () => {
    const { claimSandboxForCredential, withPersonalSandboxCredential } = await import('./sandbox-credentials');
    const { fakeRedis } = await import('@/test/redis-fake');
    const p = await createProject({ userId: OWNER });
    let second: unknown;
    await withPersonalSandboxCredential(p.id, async () => {
      await fakeRedis.del(`sandbox-credential-lock:${p.id}`);
      second = await claimSandboxForCredential(p.id);
    });
    expect(second).toBe('busy');
  });

  test('once the earlier window has passed, a new write may claim', async () => {
    const { claimSandboxForCredential } = await import('./sandbox-credentials');
    const p = await createProject({ userId: OWNER, sandboxCredentials: 'present', credentialWriteUntil: new Date(Date.now() - 1000) });
    expect(typeof (await claimSandboxForCredential(p.id))).toBe('object');
  });
});

describe('read mode (post-turn rotation sync)', () => {
  test('opens no write window and never blocks sharing', async () => {
    const { withPersonalSandboxCredential, secureProjectForSharing } = await import('./sandbox-credentials');
    const p = await createProject({ userId: OWNER });
    expect(await withPersonalSandboxCredential(p.id, async () => 'read', { mode: 'read' })).toEqual({ ok: true, value: 'read' });
    const r = await row(p.id);
    expect(r.credentialWriteUntil).toBeNull();
    expect(r.sandboxCredentials).toBe('none');
    await expect(secureProjectForSharing(p.id)).resolves.toEqual({ stoppedAgents: 0 });
  });

  test('a read that outlives its lease while a share admits someone returns nothing to adopt', async () => {
    const { withPersonalSandboxCredential, secureProjectForSharing } = await import('./sandbox-credentials');
    const { fakeRedis } = await import('@/test/redis-fake');
    const p = await createProject({ userId: OWNER });
    const res = await withPersonalSandboxCredential(
      p.id,
      async () => {
        // Lease expires mid-read; a share completes and a member is let in,
        // who plants a token the stalled read then returns.
        await fakeRedis.del(`sandbox-credential-lock:${p.id}`);
        await secureProjectForSharing(p.id);
        await currentTestDb().insert(projectMembers).values({
          projectId: p.id, userId: 'user_editor', invitedEmail: 'e@example.test', invitedBy: OWNER, status: 'active',
        });
        return { type: 'oauth', access: 'planted', refresh: 'planted' };
      },
      { mode: 'read' },
    );
    expect(res).toEqual({ ok: false, reason: 'shared' });
  });

  test('still refuses on a shared project', async () => {
    const { withPersonalSandboxCredential } = await import('./sandbox-credentials');
    const p = await createProject({ userId: OWNER, sharedAt: new Date() });
    const fn = vi.fn(async () => {});
    expect(await withPersonalSandboxCredential(p.id, fn, { mode: 'read' })).toEqual({ ok: false, reason: 'shared' });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('the write window outlives every route that can write a credential', () => {
  test('every route that can start an OpenCode turn has maxDuration below the window', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { CREDENTIAL_WRITE_WINDOW_SECONDS } = await import('./sandbox-credentials');
    const appDir = path.resolve(__dirname, '../app');
    const routes: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name === 'route.ts') routes.push(full);
      }
    };
    walk(appDir);
    const starters = routes.filter((f) => /\b(startOpenCodeTurn|drainThreadQueue)\b/.test(fs.readFileSync(f, 'utf8')));
    expect(starters.length).toBeGreaterThanOrEqual(4);
    for (const f of starters) {
      const m = fs.readFileSync(f, 'utf8').match(/export const maxDuration = (\d+)/);
      expect(m, `${path.relative(appDir, f)} must declare maxDuration`).not.toBeNull();
      // A minute of margin: the write's own sandbox deadline is window − 60s.
      expect(Number(m![1]), path.relative(appDir, f)).toBeLessThanOrEqual(CREDENTIAL_WRITE_WINDOW_SECONDS - 60);
    }
  });
});
