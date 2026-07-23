/**
 * Project lifecycle reaper — decides what to do with each project on each
 * daily tick. Pure functions only; the cron route wires DB / external
 * services / email around these.
 *
 * Plan-aware: paying users are never reaped. The reaper only acts on projects
 * whose owner is currently on the free tier. A paid → free downgrade sets
 * `becameReapableAt = now` (see Clerk webhook); idle clock = the later of
 * that and lastSandboxActivityAt so a fresh downgrade gets the full warning
 * window instead of inheriting two-year-old inactivity.
 */

import type { Project } from "@/db/schema";
import type { Tier } from "@/lib/tier";

export type ReapStage =
  | "active"
  | "warned_90d"
  | "warned_104d"
  | "archived"
  | "deleted";

export type ReapAction =
  | { kind: "noop" }
  | { kind: "send_warn90" }
  | { kind: "archive_and_warn104" }
  | { kind: "delete_project_record" };

const DAY_MS = 24 * 60 * 60 * 1000;

// Tunable windows. Kept generous to avoid surprising users.
export const WARN90_IDLE_DAYS = 90;
export const WARN104_IDLE_DAYS = 104;          // ~14 days after warn90
export const HARD_DELETE_IDLE_DAYS = 365;

// Resend a stage's warning at most once per this many days, so a reaper that
// keeps re-running while a project lingers doesn't email every day.
export const WARNING_RESEND_INTERVAL_DAYS = 30;

export type LivenessInputs = {
  // null = managed-convex, haven't checked yet; undefined = byoc (we don't poll)
  convexCallsLast30d: number | null | undefined;
};

export function appHasLiveTraffic(l: LivenessInputs): boolean {
  // We treat unknown (null) liveness as "don't assume dead" — the reaper will
  // skip destructive actions when we lack a signal. BYOC (undefined) is also
  // treated as unknown.
  if (l.convexCallsLast30d === undefined || l.convexCallsLast30d === null) return false;
  return l.convexCallsLast30d > 0;
}

export type ReapDecisionInput = {
  ownerTier: Tier;
  project: Pick<
    Project,
    | "id"
    | "reapStage"
    | "becameReapableAt"
    | "lastSandboxActivityAt"
    | "lastOpened"
    | "createdAt"
    | "lastReapWarningSentAt"
    | "convexCallsLast30d"
    | "backendType"
  >;
  now?: Date;
};

export function decideReapAction(input: ReapDecisionInput): ReapAction {
  const now = (input.now ?? new Date()).getTime();
  const { project, ownerTier } = input;

  // Paid users: never reap. Authoritative.
  if (ownerTier !== "free") return { kind: "noop" };

  // Already deleted: terminal.
  if (project.reapStage === "deleted") return { kind: "noop" };

  // Idle clock: latest of last activity, last UI open, project creation, and
  // becameReapableAt. The last guards the "fresh downgrade with very old
  // project" case.
  const candidates: number[] = [];
  if (project.lastSandboxActivityAt) candidates.push(project.lastSandboxActivityAt.getTime());
  if (project.lastOpened) candidates.push(project.lastOpened.getTime());
  if (project.createdAt) candidates.push(project.createdAt.getTime());
  if (project.becameReapableAt) candidates.push(project.becameReapableAt.getTime());
  if (candidates.length === 0) return { kind: "noop" };
  const lastTouch = Math.max(...candidates);
  const idleDays = (now - lastTouch) / DAY_MS;

  const lastWarn = project.lastReapWarningSentAt?.getTime() ?? 0;
  const daysSinceWarn = (now - lastWarn) / DAY_MS;

  const live = appHasLiveTraffic({ convexCallsLast30d: project.convexCallsLast30d });

  // Hard delete: only for archived projects with no liveness signal and a full
  // year of idleness past the archive.
  if (project.reapStage === "archived") {
    if (idleDays >= HARD_DELETE_IDLE_DAYS && !live) {
      return { kind: "delete_project_record" };
    }
    return { kind: "noop" };
  }

  // Live app: keep the project, never warn.
  if (live) return { kind: "noop" };

  // Stage progression: warn90 → warn104 (= archive + email) → archived.
  if (idleDays >= WARN104_IDLE_DAYS) {
    return { kind: "archive_and_warn104" };
  }
  if (idleDays >= WARN90_IDLE_DAYS) {
    // Don't re-spam if we just warned.
    if (project.reapStage === "warned_90d" && daysSinceWarn < WARNING_RESEND_INTERVAL_DAYS) {
      return { kind: "noop" };
    }
    return { kind: "send_warn90" };
  }
  return { kind: "noop" };
}

/**
 * Whether the reaper should bother polling Convex usage for this project.
 * BYOC projects: no — we don't have admin creds. Managed projects: yes.
 *
 * NOTE: actual polling is owned by /api/cron/convex-usage, whose candidate
 * WHERE clause is the authority (it additionally excludes deleted rows and
 * 'migrating'/'transferred' statuses). Keep this predicate consistent with it
 * if either changes.
 */
export function shouldPollConvexUsage(p: Pick<Project, "backendType" | "convexDeploymentId">): boolean {
  if (!p.convexDeploymentId) return false;
  return p.backendType === "platform";
}
