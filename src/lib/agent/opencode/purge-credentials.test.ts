/**
 * The credential purge and the fenced Codex write/read run shell scripts in
 * the project sandbox. These tests run those exact scripts locally against
 * real processes and files, with the sandbox replaced by a local-shell
 * adapter.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandboxState = vi.hoisted(() => ({
  home: '',
  pathOverride: null as null | string,
  unreachable: false,
  override: null as null | { exitCode: number; stdout: string },
}));

vi.mock('@/lib/vercel-sandbox', () => ({
  getOrCreatePersistentSandbox: async () => {
    if (sandboxState.unreachable) throw new Error('sandbox host unreachable');
    return {
    runCommand: async ({ args }: { cmd: string; args: string[] }) => {
      if (sandboxState.override) {
        const { exitCode, stdout } = sandboxState.override;
        return { exitCode, stdout: async () => stdout, stderr: async () => '' };
      }
      const env = {
        ...process.env,
        HOME: sandboxState.home,
        ...(sandboxState.pathOverride ? { PATH: sandboxState.pathOverride } : {}),
      };
      try {
        const out = execFileSync('/bin/sh', args, { encoding: 'utf8', env });
        return { exitCode: 0, stdout: async () => out, stderr: async () => '' };
      } catch (e) {
        const err = e as { status: number; stdout: string };
        return { exitCode: err.status, stdout: async () => err.stdout ?? '', stderr: async () => '' };
      }
    },
    };
  },
}));
vi.mock('@/lib/agent/claude-code/setup', () => ({
  resolveSandboxPaths: async () => ({ home: sandboxState.home }),
}));

function hasProcTools(): boolean {
  try {
    execFileSync('sh', ['-c', 'command -v pgrep && command -v pkill'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const children: ChildProcess[] = [];
let authPath = '';
let markerPath = '';
/** resolveOpenCodePaths caches by project id — use a fresh one per test. */
let projectId = '';

beforeEach(() => {
  sandboxState.override = null;
  sandboxState.pathOverride = null;
  sandboxState.unreachable = false;
  projectId = randomUUID();
  sandboxState.home = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-purge-'));
  const dataDir = path.join(sandboxState.home, '.local/share/opencode');
  fs.mkdirSync(dataDir, { recursive: true });
  authPath = path.join(dataDir, 'auth.json');
  markerPath = path.join(sandboxState.home, '.botflow/sandbox-shared');
  fs.writeFileSync(authPath, JSON.stringify({ openai: { type: 'oauth', access: 'real', refresh: 'real' } }));
});

afterEach(() => {
  for (const c of children.splice(0)) {
    try { c.kill('SIGKILL'); } catch { /* gone */ }
  }
  fs.rmSync(sandboxState.home, { recursive: true, force: true });
});

/** Start a long-lived process whose command line contains
 *  ~/.botflow/opencode/ — like the real bridge: `node <ocDir>/opencode-bridge.mjs`. */
function startFakeBridge(): ChildProcess {
  const dir = path.join(sandboxState.home, '.botflow/opencode');
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'opencode-bridge.mjs');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n');
  const child = spawn(process.execPath, [script], { stdio: 'ignore' });
  children.push(child);
  return child;
}

/** A PATH holding only the basic tools the scripts need, optionally with a
 *  fake pgrep that fails with exit status 2. */
function restrictedPath(opts: { brokenPgrep?: boolean; mvSharesSandbox?: boolean }): string {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-bin-'));
  const tools = ['rm', 'touch', 'mkdir', 'sleep', 'grep', 'printf', 'cat', 'tr', 'wc', 'chmod', 'base64'];
  if (!opts.mvSharesSandbox) tools.push('mv');
  if (!opts.mvSharesSandbox && !opts.brokenPgrep) tools.push('pgrep', 'pkill');
  for (const tool of tools) {
    const real = execFileSync('sh', ['-c', `command -v ${tool} || true`], { encoding: 'utf8' }).trim();
    if (real.startsWith('/')) fs.symlinkSync(real, path.join(bin, tool));
  }
  if (opts.mvSharesSandbox) {
    // A purge lands exactly between the write's two marker checks.
    const realMv = execFileSync('sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(bin, 'mv'), `#!/bin/sh\nmkdir -p "$HOME/.botflow" && touch "$HOME/.botflow/sandbox-shared"\nexec ${realMv} "$@"\n`);
    fs.chmodSync(path.join(bin, 'mv'), 0o755);
  }
  if (opts.brokenPgrep) {
    for (const tool of ['pgrep', 'pkill']) {
      fs.writeFileSync(path.join(bin, tool), '#!/bin/sh\nexit 2\n');
      fs.chmodSync(path.join(bin, tool), 0o755);
    }
  }
  return bin;
}

describe.skipIf(!hasProcTools())('purgeOpenCodeCredentials (real script, local shell)', () => {
  test('sets the fence, deletes the auth store, kills OpenCode processes, counts bridges', async () => {
    const { purgeOpenCodeCredentials } = await import('./setup');
    const a = startFakeBridge();
    const b = startFakeBridge();
    await vi.waitFor(
      () => {
        // "$HOME" stays unexpanded in this shell's own command line, so the
        // pattern can't match it — and it only sees this test's processes.
        const n = execFileSync('sh', ['-c', 'pgrep -f "$HOME/.botflow/opencode/opencode-bridge" | wc -l'], {
          encoding: 'utf8',
          env: { ...process.env, HOME: sandboxState.home },
        });
        expect(Number(n.trim())).toBeGreaterThanOrEqual(2);
      },
      { timeout: 10_000, interval: 100 },
    );
    const res = await purgeOpenCodeCredentials(projectId);
    expect(res.stoppedAgents).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(authPath)).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(true);
    await vi.waitFor(() => {
      for (const c of [a, b]) expect(c.exitCode !== null || c.signalCode !== null).toBe(true);
    });
  });

  test('kills a Codex write shell stalled mid-write (and its children)', async () => {
    const { purgeOpenCodeCredentials } = await import('./setup');
    // Same tag a real write shell carries; `sleep` stands in for the stall.
    const writer = spawn('/bin/sh', ['-c', ': BOTFLOW_CRED_WRITER; sleep 300; true'], {
      stdio: 'ignore',
      env: { ...process.env, HOME: sandboxState.home },
    });
    children.push(writer);
    await vi.waitFor(
      () => {
        const n = execFileSync('sh', ['-c', "pgrep -f '[B]OTFLOW_CRED_WRITER' | wc -l"], { encoding: 'utf8' });
        expect(Number(n.trim())).toBeGreaterThanOrEqual(1);
      },
      { timeout: 10_000, interval: 100 },
    );
    await purgeOpenCodeCredentials(projectId);
    await vi.waitFor(() => expect(writer.exitCode !== null || writer.signalCode !== null).toBe(true));
  });

  test('a sandbox with nothing running reports zero and succeeds', async () => {
    const { purgeOpenCodeCredentials } = await import('./setup');
    expect(await purgeOpenCodeCredentials(projectId)).toEqual({ stoppedAgents: 0 });
    expect(fs.existsSync(authPath)).toBe(false);
  });

  test('without pgrep/pkill it refuses instead of assuming nothing runs', async () => {
    const { purgeOpenCodeCredentials } = await import('./setup');
    sandboxState.pathOverride = restrictedPath({ mvSharesSandbox: false });
    fs.rmSync(path.join(sandboxState.pathOverride, 'pgrep'));
    fs.rmSync(path.join(sandboxState.pathOverride, 'pkill'));
    await expect(purgeOpenCodeCredentials(projectId)).rejects.toThrow(/not verified/);
  });

  test('a failing pgrep (exit 2) is an error, not "no processes"', async () => {
    const { purgeOpenCodeCredentials } = await import('./setup');
    sandboxState.pathOverride = restrictedPath({ brokenPgrep: true });
    await expect(purgeOpenCodeCredentials(projectId)).rejects.toThrow(/not verified/);
  });
});

describe('fenced Codex write and read (real script, local shell)', () => {
  const codex = { accessToken: 'acc', refreshToken: 'ref', expiresAt: 123 };

  test('writes the token file when the sandbox was never shared', async () => {
    const { writeOpenCodeAuth } = await import('./setup');
    fs.rmSync(authPath);
    await writeOpenCodeAuth(projectId, { codex });
    const written = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    expect(written.openai).toEqual({ type: 'oauth', access: 'acc', refresh: 'ref', expires: 123 });
    expect(fs.statSync(authPath).mode & 0o077).toBe(0);
  });

  test('refuses, writing nothing, once the sandbox has been shared', async () => {
    const { writeOpenCodeAuth, SandboxSharedError } = await import('./setup');
    fs.rmSync(authPath);
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, '');
    await expect(writeOpenCodeAuth(projectId, { codex })).rejects.toBeInstanceOf(SandboxSharedError);
    expect(fs.existsSync(authPath)).toBe(false);
    expect(fs.readdirSync(path.dirname(authPath))).toEqual([]);
  });

  test('an unreachable sandbox is a definite "nothing written"', async () => {
    const { writeOpenCodeAuth, SandboxCredentialNotDispatched, SandboxCredentialRefused } = await import('./setup');
    sandboxState.unreachable = true;
    const err = await writeOpenCodeAuth(projectId, { codex }).catch((e) => e);
    expect(err).toBeInstanceOf(SandboxCredentialNotDispatched);
    expect(err).toBeInstanceOf(SandboxCredentialRefused);
  });

  test('a write that reaches the sandbox after its deadline writes nothing', async () => {
    const { writeOpenCodeAuth, SandboxCredentialWriteExpired } = await import('./setup');
    fs.rmSync(authPath);
    await expect(
      writeOpenCodeAuth(projectId, { codex }, { notAfter: new Date(Date.now() - 1000) }),
    ).rejects.toBeInstanceOf(SandboxCredentialWriteExpired);
    expect(fs.readdirSync(path.dirname(authPath))).toEqual([]);
  });

  test('a write within its deadline succeeds', async () => {
    const { writeOpenCodeAuth } = await import('./setup');
    fs.rmSync(authPath);
    await writeOpenCodeAuth(projectId, { codex }, { notAfter: new Date(Date.now() + 60_000) });
    expect(fs.existsSync(authPath)).toBe(true);
  });

  test('a share landing between the two marker checks leaves no token behind', async () => {
    const { writeOpenCodeAuth, SandboxSharedError } = await import('./setup');
    fs.rmSync(authPath);
    sandboxState.pathOverride = restrictedPath({ mvSharesSandbox: true });
    await expect(writeOpenCodeAuth(projectId, { codex })).rejects.toBeInstanceOf(SandboxSharedError);
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(fs.readdirSync(path.dirname(authPath))).toEqual([]);
  });

  test('reading back adopts nothing once the sandbox has been shared', async () => {
    const { readOpenCodeAuth } = await import('./setup');
    expect(await readOpenCodeAuth(projectId)).toMatchObject({ openai: { access: 'real' } });
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, '');
    expect(await readOpenCodeAuth(projectId)).toBeNull();
  });
});

describe('purgeOpenCodeCredentials fails closed on unexpected output', () => {
  test.each([
    [{ exitCode: 3, stdout: 'BOTFLOW_PURGE_PROCS_LEFT' }],
    [{ exitCode: 4, stdout: 'BOTFLOW_PURGE_FILE_LEFT' }],
    [{ exitCode: 0, stdout: '' }],
    [{ exitCode: 1, stdout: 'BOTFLOW_PURGED 0' }],
  ])('%o → throws', async (override) => {
    const { purgeOpenCodeCredentials } = await import('./setup');
    sandboxState.override = override;
    await expect(purgeOpenCodeCredentials(projectId)).rejects.toThrow(/not verified/);
  });
});
