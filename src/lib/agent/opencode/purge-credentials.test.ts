/**
 * purgeOpenCodeCredentials runs a shell script in the project sandbox. These
 * tests run that exact script locally against real processes and files, with
 * the sandbox replaced by a thin local-shell adapter.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandboxState = vi.hoisted(() => ({ home: '', override: null as null | { exitCode: number; stdout: string } }));

vi.mock('@/lib/vercel-sandbox', () => ({
  getOrCreatePersistentSandbox: async () => ({
    runCommand: async ({ args }: { cmd: string; args: string[] }) => {
      if (sandboxState.override) {
        const { exitCode, stdout } = sandboxState.override;
        return { exitCode, stdout: async () => stdout, stderr: async () => '' };
      }
      try {
        const out = execFileSync('sh', args, { encoding: 'utf8', env: { ...process.env } });
        return { exitCode: 0, stdout: async () => out, stderr: async () => '' };
      } catch (e) {
        const err = e as { status: number; stdout: string };
        return { exitCode: err.status, stdout: async () => err.stdout ?? '', stderr: async () => '' };
      }
    },
  }),
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

beforeEach(() => {
  sandboxState.override = null;
  sandboxState.home = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-purge-'));
  const dataDir = path.join(sandboxState.home, '.local/share/opencode');
  fs.mkdirSync(dataDir, { recursive: true });
  authPath = path.join(dataDir, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify({ openai: { type: 'oauth', access: 'real', refresh: 'real' } }));
});

afterEach(() => {
  for (const c of children.splice(0)) {
    try { c.kill('SIGKILL'); } catch { /* gone */ }
  }
  fs.rmSync(sandboxState.home, { recursive: true, force: true });
});

/** Start a long-lived process whose command line contains
 *  ~/.botflow/opencode/ — like the real bridge: `node <ocDir>/bridge.mjs`. */
function startFakeOpenCode(): ChildProcess {
  const dir = path.join(sandboxState.home, '.botflow/opencode');
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'opencode-bridge.mjs');
  fs.writeFileSync(script, 'setInterval(() => {}, 1000);\n');
  const child = spawn(process.execPath, [script], { stdio: 'ignore' });
  children.push(child);
  return child;
}

describe.skipIf(!hasProcTools())('purgeOpenCodeCredentials (real script, local shell)', () => {
  test('deletes the auth store, kills OpenCode processes, reports how many', async () => {
    const { purgeOpenCodeCredentials } = await import('./setup');
    const a = startFakeOpenCode();
    const b = startFakeOpenCode();
    // Wait until both are visible to pgrep (exec can lag under parallel load).
    await vi.waitFor(
      () => {
        // Bracketed so the pattern can't match this pgrep's own shell.
        const n = execFileSync('sh', ['-c', `pgrep -f '[/]\\.botflow/opencode/opencode-bridge' | wc -l`], { encoding: 'utf8' });
        expect(Number(n.trim())).toBeGreaterThanOrEqual(2);
      },
      { timeout: 10_000, interval: 100 },
    );
    const res = await purgeOpenCodeCredentials('p1');
    expect(res.stoppedAgents).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(authPath)).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    for (const c of [a, b]) expect(c.exitCode !== null || c.signalCode !== null).toBe(true);
  });

  test('a sandbox with nothing to clean reports zero and succeeds', async () => {
    const { purgeOpenCodeCredentials } = await import('./setup');
    fs.rmSync(authPath);
    expect(await purgeOpenCodeCredentials('p1')).toEqual({ stoppedAgents: 0 });
  });
});

describe('purgeOpenCodeCredentials fails closed', () => {
  test.each([
    [{ exitCode: 3, stdout: 'BOTFLOW_PURGE_PROCS_LEFT' }],
    [{ exitCode: 4, stdout: 'BOTFLOW_PURGE_FILE_LEFT' }],
    [{ exitCode: 0, stdout: '' }],
    [{ exitCode: 127, stdout: 'sh: pgrep: not found' }],
  ])('%o → throws', async (override) => {
    const { purgeOpenCodeCredentials } = await import('./setup');
    sandboxState.override = override;
    await expect(purgeOpenCodeCredentials('p1')).rejects.toThrow(/not verified/);
  });
});
