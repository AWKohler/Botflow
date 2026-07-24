/**
 * Convex usage poller — the platform-side guardrail for managed Convex
 * deployments (docs/features/convex-usage-guardrails.md).
 *
 * Every tick (vercel.json, every 30 min), for each platform-managed deployment:
 *
 *   1. Count new COMPLETED function executions since the stored cursor via
 *      the deployment's admin log stream (src/lib/convex-usage/poll.ts),
 *      bucketed per UTC day from each entry's own timestamp. Saturated polls
 *      (raw buffer cap hit) are extrapolated from the covered time span,
 *      capped at SATURATION_MAX_FACTOR; a zero-span saturated poll (burst)
 *      gets the full factor — a deliberate anti-abuse bias.
 *   2. Roll the 30-day sum into projects.convexCallsLast30d (also the
 *      reaper's liveness signal).
 *   3. Apply the pure policy (src/lib/convex-usage/policy.ts):
 *      warn → convexStatus='warned' + operator alert;
 *      pause/pause_repeat → pause the deployment iff CONVEX_AUTO_PAUSE=true
 *      (strict opt-in; otherwise alert-only, one alert per project per UTC
 *      day), sticky until admin unpause / transfer;
 *      clear → back to 'active' after a full quiet day.
 *      A pause that FAILS alerts loudly (pause_failed) and retries next tick.
 *      A 'paused' project that still serves traffic (unpaused behind our
 *      back, e.g. via the Convex dashboard) is re-paused / alerted.
 *
 * Write-ordering contracts (Codex round, 2026-07-23):
 *  - The cursor is advanced with a COMPARE-AND-SET **before** the bucket
 *    upserts. A raced concurrent sweep loses the CAS and skips the project
 *    (no double-count); a crash after CAS but before the upserts loses ≤1
 *    tick of counts (undercount — can't contribute to a false pause).
 *  - Enforcement (the pause call) re-reads the CURRENT status first, so an
 *    admin unpause / Phase-3 transfer that landed mid-sweep isn't stomped;
 *    the status write itself is CAS'd on the status we selected.
 *  - One-shot alerts whose dedup is the status transition (warn, would_pause
 *    crossing) are sent BEFORE the status write and the write is withheld on
 *    send failure, so the policy re-emits (= retries the alert) next tick.
 *    Auto-pause records 'paused' regardless of alert outcome — enforcement
 *    primacy.
 *
 * Deployments with nothing new LONG-POLL until the fetch timeout, so quiet
 * projects cost ~POLL_TIMEOUT_MS each — polls run in concurrent batches, and
 * `limit` is capped so the worst-case sweep fits maxDuration. Candidates are
 * ordered by least-recently-checked so a fleet larger than `limit` rotates
 * fairly; EVERY per-project exit path (skip/error/throw) stamps
 * convexCallsCheckedAt or the row would hog the front of that queue forever.
 */

import { NextResponse } from "next/server";
import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { projects, convexUsageDaily } from "@/db/schema";
import {
  autoPauseEnabled,
  decideUsageAction,
  usageThresholds,
  type ConvexUsageStatus,
  type UsageAction,
} from "@/lib/convex-usage/policy";
import { fetchNewFunctionCalls } from "@/lib/convex-usage/poll";
import { sendUsageAlert } from "@/lib/convex-usage/alert";
import { sendConvexPausedEmail, sendConvexWarnedEmail } from "@/lib/convex-usage/user-emails";
import { getEmailForClerkUser } from "@/lib/email";
import { pauseConvexDeployment, unpauseConvexDeployment } from "@/lib/convex-platform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const POLL_TIMEOUT_MS = 8_000;
const POLL_CONCURRENCY = 10;
// ceil(LIMIT_CAP / POLL_CONCURRENCY) * POLL_TIMEOUT_MS must leave DB headroom
// inside maxDuration: 350/10 × 8s = 280s worst-case polling. Raise
// concurrency before raising the cap.
const LIMIT_CAP = 350;
const PRUNE_AFTER_DAYS = 35;
// Rollup window = today + 29 prior days = 30 buckets.
const ROLLUP_WINDOW_DAYS = 29;
// A saturated poll extrapolates completions × (elapsed / covered-span). The
// cap is on the ESTIMATE per poll, not the factor: a fixed factor re-created
// the unreachable-pause-bar bug for chatty-action apps whose Progress spam
// leaves few completions per buffer (Codex round 2: 91 completions × 50 ×
// 48 ticks ≈ 218k/day, under the 1M bar). 2M/poll keeps the bar reachable in
// a single tick of genuine runaway while bounding what one measurement can
// claim. Known residual: a saturated buffer with ZERO completions counts 0 —
// surfaced via the `saturated` flag/detail, not auto-actioned.
const MAX_ESTIMATED_CALLS_PER_POLL = 2_000_000;
// Extrapolation never assumes coverage beyond this window (2 tick intervals).
// Without it, a FIRST poll (cursor 0 → elapsed ≈ epoch) that saturates with
// even one Completion would ride rate × ∞ straight to the estimate cap and
// false-pause a brand-new chatty app.
const MAX_EXTRAPOLATION_WINDOW_MS = 60 * 60 * 1000;
// Stored cursors are clamped to now + this: one corrupt far-future cursor
// would otherwise blind the poller until the wall clock catches up.
const CURSOR_FUTURE_SLACK_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[convex-usage] CRON_SECRET is not set");
    return false;
  }
  // Authorization header ONLY. A ?token= query param lands in CDN / proxy /
  // platform access logs, leaking the cron secret (same rule as
  // rotate-apple-secrets).
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

/** UTC day key, 'YYYY-MM-DD'. */
function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

type ResultAction =
  | UsageAction
  | "would_pause"
  | "pause_failed"
  | "repause"
  | "drift"
  | "skip"
  | "error";

type ProjectResult = {
  projectId: string;
  deployment: string | null;
  action: ResultAction;
  newCalls?: number;
  callsToday?: number;
  saturated?: boolean;
  detail?: string;
};

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") || String(LIMIT_CAP), 10) || LIMIT_CAP, 1),
    LIMIT_CAP,
  );

  const db = getDb();
  const thresholds = usageThresholds();
  const autoPause = autoPauseEnabled();
  const now = Date.now();
  const today = dayKey(now);
  const yesterday = dayKey(now - DAY_MS);
  const rollupCutoff = dayKey(now - ROLLUP_WINDOW_DAYS * DAY_MS);

  // Platform-managed deployments only. 'migrating'/'transferred' are owned by
  // the BYOC transfer flow; 'paused' stays in the sweep (near-free — no new
  // log entries) both to keep buckets fresh and to catch state drift.
  // Least-recently-checked first: a fleet larger than `limit` rotates fairly.
  const candidates = await db
    .select({
      id: projects.id,
      name: projects.name,
      userId: projects.userId,
      convexDeployUrl: projects.convexDeployUrl,
      convexDeployKey: projects.convexDeployKey,
      convexDeploymentId: projects.convexDeploymentId,
      convexUsageCursor: projects.convexUsageCursor,
      convexStatus: projects.convexStatus,
    })
    .from(projects)
    .where(
      and(
        isNull(projects.deletedAt),
        eq(projects.backendType, "platform"),
        isNotNull(projects.convexDeploymentId),
        sql`${projects.convexStatus} NOT IN ('migrating', 'transferred')`,
      ),
    )
    .orderBy(sql`${projects.convexCallsCheckedAt} ASC NULLS FIRST`)
    .limit(limit);

  type Candidate = (typeof candidates)[number];
  const results: ProjectResult[] = [];

  async function stampCheckedOnly(projectId: string): Promise<void> {
    if (dryRun) return;
    await db
      .update(projects)
      .set({ convexCallsCheckedAt: new Date() })
      .where(eq(projects.id, projectId));
  }

  /** Re-read the live status right before enforcement / status writes. */
  async function freshStatus(projectId: string): Promise<ConvexUsageStatus | null> {
    const [row] = await db
      .select({ s: projects.convexStatus })
      .from(projects)
      .where(eq(projects.id, projectId));
    return (row?.s as ConvexUsageStatus | undefined) ?? null;
  }

  async function processProject(project: Candidate): Promise<void> {
    const deployUrl = project.convexDeployUrl;
    const deployKey = project.convexDeployKey;
    const deployment = project.convexDeploymentId;
    if (!deployUrl || !deployKey) {
      await stampCheckedOnly(project.id);
      results.push({ projectId: project.id, deployment, action: "skip", detail: "missing deploy url/key" });
      return;
    }

    // First poll starts from 0: the retained buffer (≤1000 raw entries) is
    // counted rather than skipped, closing the front-loaded-abuse window
    // between provisioning and the first sweep. For pre-existing deployments
    // at rollout this attributes at most ~1000 historical completions to
    // today — noise against a 100k warn bar.
    const cursor = project.convexUsageCursor ?? 0;
    const poll = await fetchNewFunctionCalls(deployUrl, deployKey, cursor, POLL_TIMEOUT_MS);
    if (!poll.ok) {
      await stampCheckedOnly(project.id);
      results.push({ projectId: project.id, deployment, action: "error", detail: poll.error });
      return;
    }

    // Saturated poll: the raw buffer capped out, so the completion count is a
    // floor. Extrapolate by wall-time coverage (rate × elapsed), bounding the
    // per-poll ESTIMATE rather than the factor; a zero-span burst implies an
    // effectively unbounded rate and gets the full estimate cap.
    let scale = 1;
    if (poll.saturated && poll.count > 0) {
      const elapsedMs = Math.min(
        Math.max(Date.now() - cursor, poll.spanMs, 1),
        MAX_EXTRAPOLATION_WINDOW_MS,
      );
      const rawScale = poll.spanMs > 0 ? elapsedMs / poll.spanMs : Number.POSITIVE_INFINITY;
      scale = Math.max(1, Math.min(rawScale, MAX_ESTIMATED_CALLS_PER_POLL / poll.count));
    }
    const increments = new Map<string, number>();
    for (const [day, calls] of Object.entries(poll.countsByDay)) {
      const scaled = Math.round(calls * scale);
      if (scaled > 0) increments.set(day, scaled);
    }
    const incToday = increments.get(today) ?? 0;
    const incInWindow = [...increments.entries()]
      .filter(([day]) => day >= rollupCutoff)
      .reduce((sum, [, calls]) => sum + calls, 0);

    // Advance the cursor with a CAS *before* writing buckets: a concurrent
    // sweep that read the same cursor loses here and skips (no double-count);
    // a crash after this point costs at most one tick of counts (undercount).
    // Clamp: monotonic, and never far-future (a corrupt timestamp would blind
    // the poller until the wall clock caught up). Fresh clock, NOT the
    // sweep-start `now` — a project processed 200s into the sweep would get
    // its legitimate cursor clamped backward and recount the tail next tick.
    // Always advance ≥1ms past the read cursor so the CAS is a real claim —
    // a same-value UPDATE would let two concurrent quiet sweeps both proceed
    // into the alert/pause paths.
    // The future-clamp applies LAST: it must be able to pull an already-
    // corrupt far-future stored cursor back toward now (the ≥1ms advance
    // would otherwise keep re-asserting the bogus value and blind the poller
    // until wall time caught up). Pulling back recounts nothing — entries
    // beyond a bogus future cursor were skipped, never counted.
    const cursorToStore = Math.min(
      Math.max(Math.ceil(poll.newCursor), Math.floor(cursor) + 1),
      Date.now() + CURSOR_FUTURE_SLACK_MS,
    );
    if (!dryRun) {
      const claimed = await db
        .update(projects)
        .set({ convexUsageCursor: cursorToStore })
        .where(
          and(
            eq(projects.id, project.id),
            project.convexUsageCursor === null
              ? isNull(projects.convexUsageCursor)
              : eq(projects.convexUsageCursor, project.convexUsageCursor),
          ),
        )
        .returning({ id: projects.id });
      if (claimed.length === 0) {
        // Another invocation already processed this cursor window.
        results.push({ projectId: project.id, deployment, action: "skip", detail: "cursor raced (concurrent sweep)" });
        return;
      }

      for (const [day, calls] of increments) {
        await db
          .insert(convexUsageDaily)
          .values({ projectId: project.id, day, calls })
          .onConflictDoUpdate({
            target: [convexUsageDaily.projectId, convexUsageDaily.day],
            set: {
              calls: sql`${convexUsageDaily.calls} + ${calls}`,
              updatedAt: new Date(),
            },
          });
      }
    }

    // One aggregate round-trip: today's bucket, yesterday's, and the 30-day
    // rollup (conditional aggregation instead of two separate reads).
    const [agg] = await db
      .select({
        today: sql<string | null>`sum(${convexUsageDaily.calls}) filter (where ${convexUsageDaily.day} = ${today})`,
        yesterday: sql<string | null>`sum(${convexUsageDaily.calls}) filter (where ${convexUsageDaily.day} = ${yesterday})`,
        total30: sql<string | null>`sum(${convexUsageDaily.calls}) filter (where ${convexUsageDaily.day} >= ${rollupCutoff})`,
      })
      .from(convexUsageDaily)
      .where(eq(convexUsageDaily.projectId, project.id));

    // In dryRun the upserts were skipped, so add this tick's increments back.
    const callsToday = Number(agg?.today ?? 0) + (dryRun ? incToday : 0);
    const callsYesterday = Number(agg?.yesterday ?? 0);
    const last30d = Number(agg?.total30 ?? 0) + (dryRun ? incInWindow : 0);
    const callsTodayBefore = callsToday - incToday;

    const status = (project.convexStatus ?? "active") as ConvexUsageStatus;
    const decision = decideUsageAction({
      status,
      callsToday,
      callsTodayBefore,
      callsYesterday,
      thresholds,
    });

    const alertBase = {
      projectId: project.id,
      projectName: project.name,
      ownerUserId: project.userId,
      deploymentName: deployment ?? "?",
      callsToday,
      warnThreshold: thresholds.warnCallsPerDay,
      pauseThreshold: thresholds.pauseCallsPerDay,
    };

    /**
     * Pause the deployment after re-reading the live status. Returns the
     * live status alongside the outcome so the follow-up status CAS can
     * expect what was actually accepted (the candidate's selected status may
     * be stale — e.g. another sweep already escalated active→warned).
     */
    async function gatedPause(
      expect: ConvexUsageStatus[],
    ): Promise<{ outcome: "ok" | "raced" | "failed"; live: ConvexUsageStatus | null }> {
      const live = await freshStatus(project.id);
      if (live === null || !expect.includes(live)) return { outcome: "raced", live };
      try {
        await pauseConvexDeployment(deployUrl!, deployKey!);
        return { outcome: "ok", live };
      } catch {
        return { outcome: "failed", live };
      }
    }

    /** CAS the status transition on the given expected current status. */
    async function casStatus(
      next: ConvexUsageStatus,
      expect: ConvexUsageStatus,
      extra: Partial<{ convexPausedAt: Date; convexPauseReason: string }> = {},
    ): Promise<boolean> {
      const updated = await db
        .update(projects)
        .set({ convexStatus: next, ...extra })
        .where(and(eq(projects.id, project.id), eq(projects.convexStatus, expect)))
        .returning({ id: projects.id });
      return updated.length > 0;
    }

    /**
     * A pause landed but the status CAS lost — someone changed the status
     * during the pause call (TOCTOU window ≈ one HTTP round-trip). Reconcile
     * by the live intent: 'active' (admin says run) → unpause our pause;
     * 'migrating'/'transferred' → leave paused, the transfer flow wants the
     * source frozen; anything else → leave paused, next tick re-evaluates.
     *
     * Returns whether the deployment ended up paused, so callers report the
     * truth instead of a 'pause' that compensation immediately reverted.
     *
     * The unpause itself has a TOCTOU tail (a transfer could set 'migrating'
     * between our read and the unpause): we re-read after unpausing and
     * re-pause if the live intent flipped to migrating/transferred.
     * CONTRACT for the Phase-3 transfer flow: re-assert the source pause
     * immediately before export and treat "running at export time" as a
     * retryable precondition failure — never assume a prior pause held.
     */
    async function compensatePauseRace(): Promise<{
      endedPaused: boolean;
      /** A re-pause the DB state REQUIRES failed → deployment running while
       *  the DB says paused/migrating; callers must alert pause_failed. */
      repauseFailed: boolean;
      detail: string;
    }> {
      const live = await freshStatus(project.id);
      if (live === "active") {
        try {
          await unpauseConvexDeployment(deployUrl!, deployKey!);
        } catch {
          return {
            endedPaused: true,
            repauseFailed: false,
            detail:
              "status raced during pause; COMPENSATING UNPAUSE FAILED — deployment paused while status is 'active'",
          };
        }
        // Recheck after unpausing: 'migrating'/'transferred' (transfer wants
        // the source frozen) and 'paused' (a concurrent sweep paused + CAS'd
        // while our unpause was in flight) all require re-pausing — else the
        // deployment runs while the DB says otherwise.
        const after = await freshStatus(project.id);
        if (after === "migrating" || after === "transferred" || after === "paused") {
          const who = after === "paused" ? "a concurrent pause" : `transfer (live='${after}')`;
          try {
            await pauseConvexDeployment(deployUrl!, deployKey!);
            return { endedPaused: true, repauseFailed: false, detail: `compensation raced ${who}; re-paused` };
          } catch {
            return {
              endedPaused: false,
              repauseFailed: true,
              detail: `compensation raced ${who} and RE-PAUSE FAILED — deployment running while DB says '${after}'`,
            };
          }
        }
        return { endedPaused: false, repauseFailed: false, detail: "status raced during pause; compensated by unpausing" };
      }
      return { endedPaused: true, repauseFailed: false, detail: `status raced during pause (live='${live}'); left paused` };
    }

    let action: ResultAction = decision;
    let detail: string | undefined;

    // Owner-facing email (Phase 2) — strictly best-effort AFTER a transition
    // persists: never gates status writes (that contract belongs to the
    // operator alert), never aborts the sweep. Dedup rides the same status
    // transition that triggered it.
    async function emailOwner(kind: "warned" | "paused"): Promise<void> {
      try {
        const contact = await getEmailForClerkUser(project.userId);
        if (!contact?.email) return;
        const opts = {
          to: contact.email,
          name: contact.name,
          projectName: project.name,
          projectId: project.id,
        };
        const result =
          kind === "warned" ? await sendConvexWarnedEmail(opts) : await sendConvexPausedEmail(opts);
        if (!result.ok) console.error(`[convex-usage] owner ${kind} email failed: ${result.error}`);
      } catch (err) {
        console.error(`[convex-usage] owner ${kind} email failed:`, err);
      }
    }

    if (dryRun) {
      // Report the decision; touch nothing. The drift branch is reported too
      // (below) so dry runs can verify every enforcement path.
      if (decision === "pause" || decision === "pause_repeat") {
        action = autoPause ? "pause" : "would_pause";
      } else if (decision === "noop" && status === "paused" && poll.count > 0) {
        action = autoPause ? "repause" : "drift";
        detail = `dryRun: would ${autoPause ? "re-pause" : "alert"} — ${poll.count} calls observed while status='paused'`;
      }
    } else if (decision === "warn") {
      // Alert BEFORE the status write: the transition is the alert's dedup,
      // so a failed send must leave status 'active' and retry next tick.
      const sent = await sendUsageAlert({ kind: "warn", ...alertBase });
      if (sent) {
        if (await casStatus("warned", status)) {
          await emailOwner("warned");
        } else {
          detail = "status raced; transition skipped";
        }
      } else {
        detail = "warn alert failed; will retry next tick";
      }
    } else if (decision === "pause" || decision === "pause_repeat") {
      if (autoPause) {
        const paused = await gatedPause(["active", "warned"]);
        if (paused.outcome === "ok") {
          // Enforcement primacy: record 'paused' regardless of alert outcome
          // (the deployment IS paused; policy must go sticky-noop). CAS on
          // the LIVE status gatedPause accepted, not the possibly-stale
          // candidate status.
          if (
            await casStatus("paused", paused.live!, {
              convexPausedAt: new Date(),
              convexPauseReason: "usage_spike",
            })
          ) {
            await sendUsageAlert({ kind: "pause", ...alertBase });
            await emailOwner("paused");
            action = "pause";
          } else {
            // CAS lost → compensation decides the truth. Only report/alert
            // 'pause' if the deployment actually ended up paused — a
            // compensated (reverted) pause must not tell the operator the
            // backend is down.
            const comp = await compensatePauseRace();
            detail = comp.detail;
            if (comp.endedPaused) {
              // Operator alert only — NO owner email here: this invocation
              // did not persist the paused status, so either the CAS winner
              // already emailed the owner, or there was no real transition
              // (unpause-failed drift / migration race). Owner emails ride
              // exclusively on our own successful CAS.
              await sendUsageAlert({ kind: "pause", ...alertBase, detail });
              action = "pause";
            } else if (comp.repauseFailed) {
              // Deployment running while the DB says paused/migrating — the
              // loudest possible failure, never a silent skip.
              await sendUsageAlert({ kind: "pause_failed", ...alertBase, detail });
              action = "pause_failed";
            } else {
              action = "skip";
            }
          }
        } else if (paused.outcome === "raced") {
          action = "skip";
          detail = "status changed mid-sweep (admin/transfer); enforcement skipped";
        } else {
          // Loud failure: the exact runaway that most needs attention must
          // never be silent. Status stays un-paused; policy re-emits
          // pause_repeat next tick, so this retries until it sticks.
          detail = "pause API call failed";
          // This is still an active→warned transition — the owner gets the
          // same heads-up email as the normal warn path.
          if (status === "active" && (await casStatus("warned", status))) {
            await emailOwner("warned");
          }
          await sendUsageAlert({ kind: "pause_failed", ...alertBase, detail });
          action = "pause_failed";
        }
      } else {
        // Alert-only mode: escalate status for the UI, email once per day —
        // on the crossing tick ('pause'), OR on pause_repeat from a still-
        // 'active' status (crash recovery: the crossing tick's status write +
        // alert were lost, so the crossing email never went out).
        const shouldAlert = decision === "pause" || status === "active";
        let sent = true;
        if (shouldAlert) sent = await sendUsageAlert({ kind: "would_pause", ...alertBase });
        else detail = "already alerted today (no re-send)";
        // Escalation is also the crash-recovery alert's dedup — hold it back
        // if the send failed so the next tick retries. (Known residual: a
        // crossing from 'warned' whose send fails both in-tick retries has no
        // persisted retry state — next crossing re-arms at UTC midnight.)
        // An active→warned persist here is a real transition: the owner gets
        // the warned email even though this project skipped straight past the
        // warn bar (in alert-only mode this may be their ONLY notification).
        if (status === "active" && sent && (await casStatus("warned", status))) {
          await emailOwner("warned");
        }
        action = "would_pause";
      }
    } else if (decision === "clear") {
      if (!(await casStatus("active", status))) detail = "status raced; transition skipped";
    } else if (status === "paused" && poll.count > 0) {
      // State drift: we believe it's paused but it just served traffic
      // (unpaused via the Convex dashboard, or our pause silently lapsed).
      // gatedPause re-checks the live status, so an admin unpause that landed
      // after our candidate select is respected, not stomped.
      if (autoPause) {
        const repaused = await gatedPause(["paused"]);
        if (repaused.outcome === "ok") {
          action = "repause";
          detail = `re-paused after drift (${poll.count} calls observed)`;
          // Close the TOCTOU tail: if an admin unpause landed DURING our
          // pause call, the live status is no longer 'paused' — reconcile,
          // and report the truth (a compensated re-pause is a skip, not a
          // 'repause', and must not fire the drift alert below).
          const live = await freshStatus(project.id);
          if (live !== "paused") {
            const comp = await compensatePauseRace();
            detail = comp.detail;
            if (comp.endedPaused) {
              action = "repause";
            } else if (comp.repauseFailed) {
              await sendUsageAlert({ kind: "pause_failed", ...alertBase, detail });
              action = "pause_failed";
            } else {
              action = "skip";
            }
          }
        } else if (repaused.outcome === "failed") {
          detail = "re-pause failed";
          await sendUsageAlert({ kind: "pause_failed", ...alertBase, detail });
          action = "pause_failed";
        } else {
          action = "skip";
          detail = "status changed mid-sweep (admin unpause?); drift enforcement skipped";
        }
      }
      // First activity of the UTC day → one drift alert per day, not 48.
      if (action !== "pause_failed" && action !== "skip" && callsTodayBefore === 0) {
        await sendUsageAlert({
          kind: "paused_but_active",
          ...alertBase,
          detail: `${poll.count} calls observed while status='paused'`,
        });
        if (action === "noop") action = "drift";
      }
    }

    if (!dryRun) {
      await db
        .update(projects)
        .set({ convexCallsLast30d: last30d, convexCallsCheckedAt: new Date() })
        .where(eq(projects.id, project.id));
    }

    results.push({
      projectId: project.id,
      deployment,
      action,
      newCalls: poll.count,
      callsToday,
      ...(poll.saturated ? { saturated: true } : {}),
      ...(detail ? { detail } : {}),
    });
  }

  // Concurrent batches — quiet deployments each burn the full poll timeout.
  for (let i = 0; i < candidates.length; i += POLL_CONCURRENCY) {
    const batch = candidates.slice(i, i + POLL_CONCURRENCY);
    await Promise.all(
      batch.map(async (project) => {
        try {
          await processProject(project);
        } catch (err) {
          // Even hard failures must stamp checkedAt, or this row sits at the
          // front of the NULLS-FIRST queue every tick and (past `limit` such
          // rows) starves the whole fleet behind it.
          try {
            await stampCheckedOnly(project.id);
          } catch {
            /* stamping is best-effort */
          }
          results.push({
            projectId: project.id,
            deployment: project.convexDeploymentId,
            action: "error",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  }

  // Prune buckets past the retention window (one global delete per sweep; no
  // .returning() — we don't need the rows shipped back just to count them).
  if (!dryRun) {
    try {
      const pruneCutoff = dayKey(now - PRUNE_AFTER_DAYS * DAY_MS);
      await db.delete(convexUsageDaily).where(lt(convexUsageDaily.day, pruneCutoff));
    } catch (err) {
      console.error("[convex-usage] prune failed:", err);
    }
  }

  const tally = (a: ResultAction) => results.filter((r) => r.action === a).length;
  return NextResponse.json({
    dryRun,
    autoPause,
    thresholds,
    candidates: candidates.length,
    warned: tally("warn"),
    paused: tally("pause"),
    wouldPause: tally("would_pause"),
    pauseFailed: tally("pause_failed"),
    repaused: tally("repause"),
    drift: tally("drift"),
    cleared: tally("clear"),
    errors: tally("error"),
    skipped: tally("skip"),
    results,
  });
}
