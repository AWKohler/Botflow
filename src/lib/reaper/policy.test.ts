/**
 * Reaper decision table. The reaper destroys user data (sandbox VM + source
 * at archive, the project record at hard delete), so every branch is pinned.
 */
import { describe, expect, test } from 'vitest';
import {
  HARD_DELETE_IDLE_DAYS,
  WARN104_IDLE_DAYS,
  WARN90_IDLE_DAYS,
  WARNING_RESEND_INTERVAL_DAYS,
  appHasLiveTraffic,
  decideReapAction,
  shouldPollConvexUsage,
  type ReapDecisionInput,
} from './policy';

const NOW = new Date('2026-10-01T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

function decide(
  project: Partial<ReapDecisionInput['project']>,
  ownerTier: ReapDecisionInput['ownerTier'] = 'free',
) {
  const createdAt = project.createdAt ?? daysAgo(400);
  return decideReapAction({
    ownerTier,
    now: NOW,
    project: {
      id: 'p',
      reapStage: 'active',
      becameReapableAt: null,
      lastSandboxActivityAt: null,
      lastOpened: createdAt, // never reopened since creation
      createdAt,
      lastReapWarningSentAt: null,
      convexCallsLast30d: 0,
      backendType: 'platform',
      ...project,
    },
  }).kind;
}

describe('never reaps', () => {
  test.each(['pro', 'max'] as const)('%s owners, at any idleness or stage', (tier) => {
    for (const reapStage of ['active', 'warned_90d', 'archived'] as const) {
      expect(decide({ reapStage, lastSandboxActivityAt: daysAgo(10_000) }, tier)).toBe('noop');
    }
  });

  test('already-deleted projects', () => {
    expect(decide({ reapStage: 'deleted', createdAt: daysAgo(10_000) })).toBe('noop');
  });

  test('apps with live traffic, even when the editor is idle for years', () => {
    expect(decide({ convexCallsLast30d: 1, createdAt: daysAgo(10_000) })).toBe('noop');
    expect(decide({ reapStage: 'archived', convexCallsLast30d: 5, createdAt: daysAgo(10_000) })).toBe('noop');
  });

  test.each([
    ['lastSandboxActivityAt'],
    ['lastOpened'],
    ['createdAt'],
    ['becameReapableAt'],
  ] as const)('a recent %s resets the idle clock', (field) => {
    expect(decide({ [field]: daysAgo(WARN90_IDLE_DAYS - 1) })).toBe('noop');
  });

  test('a fresh downgrade gets the full window even on an ancient project', () => {
    expect(decide({ createdAt: daysAgo(1000), lastOpened: daysAgo(900), becameReapableAt: daysAgo(1) })).toBe('noop');
  });
});

describe('stage progression (free, no traffic)', () => {
  test.each([
    [WARN90_IDLE_DAYS - 0.01, 'noop'],
    [WARN90_IDLE_DAYS, 'send_warn90'],
    [WARN104_IDLE_DAYS - 0.01, 'send_warn90'],
    [WARN104_IDLE_DAYS, 'archive_and_warn104'],
  ])('%f idle days → %s', (idle, action) => {
    expect(decide({ createdAt: daysAgo(idle) })).toBe(action);
  });

  test('warn90 is not re-sent within the resend interval', () => {
    expect(
      decide({ reapStage: 'warned_90d', createdAt: daysAgo(95), lastReapWarningSentAt: daysAgo(WARNING_RESEND_INTERVAL_DAYS - 1) }),
    ).toBe('noop');
    expect(
      decide({ reapStage: 'warned_90d', createdAt: daysAgo(95), lastReapWarningSentAt: daysAgo(WARNING_RESEND_INTERVAL_DAYS) }),
    ).toBe('send_warn90');
  });

  test('archived projects are hard-deleted only after a full idle year with no traffic', () => {
    expect(decide({ reapStage: 'archived', createdAt: daysAgo(HARD_DELETE_IDLE_DAYS - 1) })).toBe('noop');
    expect(decide({ reapStage: 'archived', createdAt: daysAgo(HARD_DELETE_IDLE_DAYS) })).toBe('delete_project_record');
  });

  test('only archived projects can be hard-deleted', () => {
    for (const reapStage of ['active', 'warned_90d', 'warned_104d'] as const) {
      expect(decide({ reapStage, createdAt: daysAgo(10_000) })).not.toBe('delete_project_record');
    }
  });

  // KNOWN GAP: archive_and_warn104 tears down the sandbox (the project's
  // source) and sends its email in the same step, and nothing requires a
  // warn90 to have gone out first. A project first seen ≥104 days idle loses
  // its VM with zero advance notice.
  test.fails('archiving requires a warn90 sent at least 14 days earlier', () => {
    expect(decide({ reapStage: 'active', createdAt: daysAgo(200) })).not.toBe('archive_and_warn104');
  });
});

describe('liveness signal', () => {
  test('positive call counts are live; zero is not', () => {
    expect(appHasLiveTraffic({ convexCallsLast30d: 1 })).toBe(true);
    expect(appHasLiveTraffic({ convexCallsLast30d: 0 })).toBe(false);
  });

  // KNOWN GAP: appHasLiveTraffic's own doc says unknown liveness (null =
  // not polled yet, undefined = BYOC) should "skip destructive actions when we
  // lack a signal", but it returns false — so a BYOC app with real users is
  // archived at 104 days and hard-deleted at 365 if nobody opens the editor.
  test.fails.each([null, undefined])('unknown liveness (%s) never leads to archive or delete', (calls) => {
    expect(decide({ convexCallsLast30d: calls, backendType: 'user', createdAt: daysAgo(200) })).toBe('noop');
    expect(
      decide({ convexCallsLast30d: calls, backendType: 'user', reapStage: 'archived', createdAt: daysAgo(500) }),
    ).toBe('noop');
  });

  test('only managed Convex deployments are polled for usage', () => {
    expect(shouldPollConvexUsage({ backendType: 'platform', convexDeploymentId: 'd' })).toBe(true);
    expect(shouldPollConvexUsage({ backendType: 'user', convexDeploymentId: 'd' })).toBe(false);
    expect(shouldPollConvexUsage({ backendType: 'platform', convexDeploymentId: null })).toBe(false);
  });
});
