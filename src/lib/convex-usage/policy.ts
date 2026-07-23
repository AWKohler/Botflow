/**
 * Convex usage guardrail policy — pure decisions, no I/O (same discipline as
 * src/lib/reaper/policy.ts). The cron route wires DB / Convex / email around
 * these.
 *
 * Status machine ('convexStatus' on projects):
 *
 *   active ──warn──▶ warned ──pause──▶ paused ──(admin/transfer)──▶ …
 *     ▲                │
 *     └────clear───────┘
 *
 * 'paused' is sticky: only an admin unpause or the BYOC transfer flow leaves
 * it — the poller never auto-unpauses, so a flapping workload can't ping-pong
 * a customer's backend. 'migrating' / 'transferred' are owned by the transfer
 * state machine (Phase 3) and are never touched here.
 */

export const CONVEX_USAGE_STATUSES = [
  "active",
  "warned",
  "paused",
  "migrating",
  "transferred",
] as const;

export type ConvexUsageStatus = (typeof CONVEX_USAGE_STATUSES)[number];

/**
 * 'pause' fires on the tick that CROSSES the pause bar; 'pause_repeat' on
 * every subsequent tick still over it. The route treats them identically for
 * enforcement (retry a failed pause until the status flips) but alerts only
 * on 'pause' — so alert-only mode sends at most one would-pause email per
 * project per UTC day (buckets reset at midnight).
 */
export type UsageAction = "noop" | "warn" | "pause" | "pause_repeat" | "clear";

// Defaults chosen 2026-07-23 (chat w/ Aronne): warn at 100k calls/day, pause
// at 1M. Both env-overridable; defaults apply when the var is unset or not a
// positive integer.
export const DEFAULT_WARN_CALLS_PER_DAY = 100_000;
export const DEFAULT_PAUSE_CALLS_PER_DAY = 1_000_000;

export type UsageThresholds = {
  warnCallsPerDay: number;
  pauseCallsPerDay: number;
};

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

export function usageThresholds(
  env: Record<string, string | undefined> = process.env,
): UsageThresholds {
  const warnCallsPerDay = parsePositiveInt(
    env.CONVEX_WARN_CALLS_PER_DAY,
    DEFAULT_WARN_CALLS_PER_DAY,
  );
  const pauseCallsPerDay = parsePositiveInt(
    env.CONVEX_PAUSE_CALLS_PER_DAY,
    DEFAULT_PAUSE_CALLS_PER_DAY,
  );
  // A pause threshold below the warn threshold is a misconfiguration; treat
  // the larger value as the pause bar so we never pause before warning.
  return {
    warnCallsPerDay,
    pauseCallsPerDay: Math.max(warnCallsPerDay, pauseCallsPerDay),
  };
}

/** Whether the poller should auto-pause, or only alert. Strict opt-in. */
export function autoPauseEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.CONVEX_AUTO_PAUSE === "true";
}

export type UsageDecisionInput = {
  status: ConvexUsageStatus;
  /** Function calls in today's UTC bucket AFTER this tick's counting. */
  callsToday: number;
  /** Today's bucket BEFORE this tick's counting (crossing detection). */
  callsTodayBefore: number;
  /** Yesterday's full UTC bucket (0 if absent). Used for clear hysteresis. */
  callsYesterday: number;
  thresholds: UsageThresholds;
};

export function decideUsageAction(input: UsageDecisionInput): UsageAction {
  const { status, callsToday, callsTodayBefore, callsYesterday, thresholds } = input;

  // Terminal-ish states the poller must never transition. (The route
  // separately watches for the paused-but-active anomaly — a deployment
  // unpaused behind our back, e.g. via the Convex dashboard.)
  if (status === "paused" || status === "migrating" || status === "transferred") {
    return "noop";
  }

  if (callsToday >= thresholds.pauseCallsPerDay) {
    return callsTodayBefore < thresholds.pauseCallsPerDay ? "pause" : "pause_repeat";
  }

  if (callsToday >= thresholds.warnCallsPerDay) {
    // Status is the warn dedup: once 'warned', stay silent until clear/pause.
    return status === "warned" ? "noop" : "warn";
  }

  // De-escalate only after a full quiet day — today under the bar isn't enough
  // (it may simply be 1am), yesterday must have finished under it too.
  if (status === "warned" && callsYesterday < thresholds.warnCallsPerDay) {
    return "clear";
  }

  return "noop";
}
