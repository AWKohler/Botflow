/**
 * Executes the generated bridge-control shell scripts for real (sh + sleep
 * processes standing in for bridges) against a temp run dir: one live turn
 * per thread (refuse, never kill), the running-count admission ceiling, and
 * the stop script.
 *
 * Run: node --import tsx --test src/lib/agent/claude-code/bridge-control.test.ts
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BRIDGE_RUN_DIR,
  buildKillBridgeScript,
  buildPrepareTurnScript,
  parseCapacityRefusal,
  parseThreadBusy,
  threadPidFile,
  turnEventFile,
} from "./bridge-control";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const T3 = "33333333-3333-4333-8333-333333333333";

const root = mkdtempSync(path.join(tmpdir(), "bridge-control-"));
const children: ChildProcess[] = [];
after(() => {
  for (const c of children) c.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

/** Point the script at the temp dir instead of /tmp/botflow-cc. */
function relocate(script: string): string {
  return script.split(BRIDGE_RUN_DIR).join(root);
}
// Async on purpose: a sync exec blocks the event loop, so a killed `sleep`
// stays an unreaped zombie and `kill -0` keeps seeing it alive.
async function run(script: string): Promise<string> {
  const { stdout } = await promisify(execFile)("sh", ["-c", relocate(script)], { encoding: "utf8" });
  return stdout;
}
function fakeBridge(threadId: string): ChildProcess {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  children.push(child);
  const pidFile = relocate(threadPidFile(threadId));
  mkdirSync(path.dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, String(child.pid));
  return child;
}
function alive(child: ChildProcess): boolean {
  try {
    process.kill(child.pid!, 0);
    return true;
  } catch {
    return false;
  }
}
const waitExit = (child: ChildProcess) =>
  new Promise<void>((resolve) => (child.exitCode !== null || child.signalCode ? resolve() : child.once("exit", () => resolve())));

describe("bridge-control scripts", () => {
  test("prepare refuses while the same thread's bridge is alive — and never kills it", async () => {
    const b1 = fakeBridge(T1);
    const eventFile = turnEventFile("busy1");
    const out = await run(buildPrepareTurnScript(T1, eventFile, { maxRunning: 6, agentReserveMb: 1, floorMb: 1 }));
    assert.equal(parseThreadBusy(out), true);
    assert.equal(alive(b1), true, "the live turn keeps running");
    assert.ok(!existsSync(relocate(eventFile)), "no event file when busy");
    await run(buildKillBridgeScript(T1));
    await waitExit(b1);
  });

  test("prepare admits after the thread's bridge exited, clearing the stale pidfile", async () => {
    const b2 = fakeBridge(T2); // another thread keeps running throughout
    const stale = fakeBridge(T1);
    stale.kill("SIGKILL");
    await waitExit(stale);
    const eventFile = turnEventFile("abc123");
    const out = await run(buildPrepareTurnScript(T1, eventFile, { maxRunning: 6, agentReserveMb: 1, floorMb: 1 }));
    assert.equal(parseThreadBusy(out), false);
    assert.equal(parseCapacityRefusal(out), null);
    assert.equal(alive(b2), true, "T2's bridge is untouched");
    assert.ok(existsSync(relocate(eventFile)), "event file pre-created");
    assert.ok(!existsSync(relocate(threadPidFile(T1))), "stale T1 pidfile cleared");
  });

  test("admission refuses at the running ceiling, counting other threads only", async () => {
    fakeBridge(T3); // T2 (from above) + T3 alive → 2 running
    const eventFile = turnEventFile("full1");
    const refused = parseCapacityRefusal(
      await run(buildPrepareTurnScript(T1, eventFile, { maxRunning: 2, agentReserveMb: 1, floorMb: 1 })),
    );
    assert.deepEqual(refused?.running, 2);
    assert.ok(!existsSync(relocate(eventFile)), "no event file when refused");

    // A thread whose own bridge is alive is busy, not over capacity.
    const own = await run(buildPrepareTurnScript(T3, turnEventFile("t3b"), { maxRunning: 2, agentReserveMb: 1, floorMb: 1 }));
    assert.equal(parseThreadBusy(own), true);
  });

  test("kill script stops one thread's bridge", async () => {
    const b = fakeBridge(T2);
    await run(buildKillBridgeScript(T2));
    await waitExit(b);
    assert.equal(alive(b), false);
  });

  test("thread ids are validated before reaching a shell", () => {
    assert.throws(() => buildKillBridgeScript("x; rm -rf /"), /invalid thread id/);
  });
});
