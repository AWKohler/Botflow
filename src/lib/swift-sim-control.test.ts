/**
 * Unit tests for the simulator build-result channel: diagnostic sanitization
 * (caps, errors-first ordering) and the tool-facing outcome formatter that
 * both agents' startSimulator tools return to the model.
 *
 * Run with: node --import tsx --test src/lib/swift-sim-control.test.ts
 *
 * Note: runs with Upstash env UNSET so getRedis() returns the no-op stub —
 * the waitForSimulatorBuild timeout test exercises the "no build result ever
 * appears" path without a real Redis.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeBuildDiagnostics,
  formatBuildWaitOutcome,
  waitForSimulatorBuild,
  type SimBuildDiagnosticSummary,
} from './swift-sim-control';

const diag = (
  severity: 'error' | 'warning',
  message = 'msg',
): SimBuildDiagnosticSummary => ({
  severity,
  file: '/Sources/App.swift',
  line: 1,
  column: 1,
  message,
});

describe('sanitizeBuildDiagnostics', () => {
  test('drops malformed entries and keeps valid ones', () => {
    const out = sanitizeBuildDiagnostics([
      null,
      42,
      { severity: 'note', message: 'nope' },
      { severity: 'error' }, // no message
      { severity: 'error', message: 'real', file: 3, line: 'x' },
    ]);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], {
      severity: 'error',
      file: null,
      line: null,
      column: null,
      message: 'real',
    });
  });

  test('non-array input yields empty', () => {
    assert.deepEqual(sanitizeBuildDiagnostics(undefined), []);
    assert.deepEqual(sanitizeBuildDiagnostics('x'), []);
  });

  test('caps at 80 with errors surviving over warnings', () => {
    const input = [
      ...Array.from({ length: 70 }, (_, i) => diag('warning', `w${i}`)),
      ...Array.from({ length: 30 }, (_, i) => diag('error', `e${i}`)),
    ];
    const out = sanitizeBuildDiagnostics(input);
    assert.equal(out.length, 80);
    assert.equal(out.filter((d) => d.severity === 'error').length, 30);
    // Errors first in the returned order.
    assert.ok(out.slice(0, 30).every((d) => d.severity === 'error'));
  });

  test('truncates oversized messages', () => {
    const out = sanitizeBuildDiagnostics([diag('error', 'x'.repeat(10_000))]);
    assert.equal(out[0].message.length, 600);
  });
});

describe('formatBuildWaitOutcome', () => {
  test('workspace-closed when never picked up', () => {
    const r = formatBuildWaitOutcome({
      pickedUp: false,
      completed: false,
      diagnostics: [],
      finalized: false,
      timedOut: false,
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 'workspace-closed');
  });

  test('timeout when picked up but never terminal', () => {
    const r = formatBuildWaitOutcome({
      pickedUp: true,
      completed: false,
      diagnostics: [],
      finalized: false,
      timedOut: true,
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 'timeout');
    assert.match(r.message, /get_simulator_status/);
  });

  test('build-failed carries errors and warnings split', () => {
    const r = formatBuildWaitOutcome({
      pickedUp: true,
      completed: true,
      state: 'failed',
      diagnostics: [diag('error', 'boom'), diag('warning', 'meh')],
      finalized: true,
      exitCode: 65,
      failureMessage: 'Build failed',
      timedOut: false,
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 'build-failed');
    assert.equal(r.errors?.length, 1);
    assert.equal(r.warnings?.length, 1);
    assert.match(r.message, /1 error/);
  });

  test('build-failed with zero diagnostics points at project-level issues', () => {
    const r = formatBuildWaitOutcome({
      pickedUp: true,
      completed: true,
      state: 'failed',
      diagnostics: [],
      finalized: false,
      timedOut: false,
    });
    assert.equal(r.status, 'build-failed');
    assert.match(r.message, /No structured diagnostics/);
  });

  test('build-succeeded is ok and only includes warnings when present', () => {
    const clean = formatBuildWaitOutcome({
      pickedUp: true,
      completed: true,
      state: 'succeeded',
      diagnostics: [],
      finalized: true,
      timedOut: false,
    });
    assert.equal(clean.ok, true);
    assert.equal(clean.status, 'build-succeeded');
    assert.equal(clean.warnings, undefined);

    const warned = formatBuildWaitOutcome({
      pickedUp: true,
      completed: true,
      state: 'succeeded',
      diagnostics: [diag('warning')],
      finalized: true,
      timedOut: false,
    });
    assert.equal(warned.ok, true);
    assert.equal(warned.warnings?.length, 1);
  });
});

describe('waitForSimulatorBuild (no-op Redis)', () => {
  test('times out with pickedUp=true when no state ever appears', async () => {
    // No-op Redis: desired key reads null (treated as consumed) and no build
    // result ever appears — the waiter must time out, not hang or throw.
    const outcome = await waitForSimulatorBuild('proj-test', {
      requestedAt: Date.now(),
      timeoutMs: 3_000,
    });
    assert.equal(outcome.pickedUp, true);
    assert.equal(outcome.completed, false);
    assert.equal(outcome.timedOut, true);
  });
});
