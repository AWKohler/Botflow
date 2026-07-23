/**
 * Unit tests for the Convex usage guardrail policy: threshold parsing
 * (defaults + env overrides + garbage), the decision matrix, sticky pause,
 * and clear hysteresis.
 *
 * Uses Node's built-in test runner (no extra dependency). Run with:
 *   node --import tsx --test src/lib/convex-usage/policy.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PAUSE_CALLS_PER_DAY,
  DEFAULT_WARN_CALLS_PER_DAY,
  autoPauseEnabled,
  decideUsageAction,
  usageThresholds,
  type ConvexUsageStatus,
  type UsageThresholds,
} from './policy';

const T: UsageThresholds = { warnCallsPerDay: 100, pauseCallsPerDay: 1000 };

const decide = (status: ConvexUsageStatus, callsToday: number, callsYesterday = 0) =>
  decideUsageAction({ status, callsToday, callsYesterday, thresholds: T });

describe('usageThresholds', () => {
  test('defaults when env is empty', () => {
    assert.deepEqual(usageThresholds({}), {
      warnCallsPerDay: DEFAULT_WARN_CALLS_PER_DAY,
      pauseCallsPerDay: DEFAULT_PAUSE_CALLS_PER_DAY,
    });
  });

  test('env overrides are honored', () => {
    assert.deepEqual(
      usageThresholds({ CONVEX_WARN_CALLS_PER_DAY: '5000', CONVEX_PAUSE_CALLS_PER_DAY: '50000' }),
      { warnCallsPerDay: 5000, pauseCallsPerDay: 50000 },
    );
  });

  test('garbage / non-positive values fall back to defaults', () => {
    for (const bad of ['abc', '-5', '0', '1.5', '']) {
      const t = usageThresholds({ CONVEX_WARN_CALLS_PER_DAY: bad, CONVEX_PAUSE_CALLS_PER_DAY: bad });
      assert.equal(t.warnCallsPerDay, DEFAULT_WARN_CALLS_PER_DAY, `warn for ${JSON.stringify(bad)}`);
      assert.equal(t.pauseCallsPerDay, DEFAULT_PAUSE_CALLS_PER_DAY, `pause for ${JSON.stringify(bad)}`);
    }
  });

  test('pause below warn is clamped up to warn (never pause before warning)', () => {
    const t = usageThresholds({ CONVEX_WARN_CALLS_PER_DAY: '1000', CONVEX_PAUSE_CALLS_PER_DAY: '10' });
    assert.equal(t.warnCallsPerDay, 1000);
    assert.equal(t.pauseCallsPerDay, 1000);
  });
});

describe('autoPauseEnabled', () => {
  test('strict opt-in: only the literal "true" enables', () => {
    assert.equal(autoPauseEnabled({}), false);
    assert.equal(autoPauseEnabled({ CONVEX_AUTO_PAUSE: '1' }), false);
    assert.equal(autoPauseEnabled({ CONVEX_AUTO_PAUSE: 'TRUE' }), false);
    assert.equal(autoPauseEnabled({ CONVEX_AUTO_PAUSE: 'true' }), true);
  });
});

describe('decideUsageAction', () => {
  test('quiet active project: noop', () => {
    assert.equal(decide('active', 0), 'noop');
    assert.equal(decide('active', 99), 'noop');
  });

  test('active crossing warn threshold: warn (inclusive bound)', () => {
    assert.equal(decide('active', 100), 'warn');
    assert.equal(decide('active', 999), 'warn');
  });

  test('warned and still over warn bar: noop (no re-warn spam)', () => {
    assert.equal(decide('warned', 100), 'noop');
    assert.equal(decide('warned', 999, 5000), 'noop');
  });

  test('over pause threshold: pause from active AND from warned (inclusive bound)', () => {
    assert.equal(decide('active', 1000), 'pause');
    assert.equal(decide('warned', 1000), 'pause');
    assert.equal(decide('warned', 999_999), 'pause');
  });

  test('pause re-emits while over the bar (route retries a failed pause)', () => {
    assert.equal(decide('warned', 2000), 'pause');
    assert.equal(decide('warned', 2000), 'pause');
  });

  test('paused is sticky: never auto-unpause, even when fully quiet', () => {
    assert.equal(decide('paused', 0, 0), 'noop');
    assert.equal(decide('paused', 1_000_000), 'noop');
  });

  test('migrating / transferred are never touched', () => {
    assert.equal(decide('migrating', 1_000_000), 'noop');
    assert.equal(decide('transferred', 1_000_000), 'noop');
  });

  test('clear requires a full quiet yesterday, not just a quiet morning', () => {
    // Yesterday was over the warn bar → today being quiet may just be 1am.
    assert.equal(decide('warned', 0, 500), 'noop');
    // Yesterday finished under the bar → de-escalate.
    assert.equal(decide('warned', 0, 99), 'clear');
    assert.equal(decide('warned', 50, 0), 'clear');
  });

  test('clear never fires from active', () => {
    assert.equal(decide('active', 0, 0), 'noop');
  });
});
