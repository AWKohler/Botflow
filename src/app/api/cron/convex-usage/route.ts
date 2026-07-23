/**
 * Convex usage poller — the platform-side guardrail for managed Convex
 * deployments (docs/features/convex-usage-guardrails.md).
 *
 * Every tick (vercel.json, every 30 min), for each platform-managed deployment:
 *
 *   1. Count new function executions since the stored cursor via the
 *      deployment's admin log stream (src/lib/convex-usage/poll.ts), bucketed
 *      per UTC day from each entry's own timestamp (midnight straddles and
 *      cron-downtime backlogs land on the day they actually ran). Saturated
 *      polls (buffer cap hit) are extrapolated from the covered time span,
 *      capped at SATURATION_MAX_FACTOR — a deliberate anti-abuse bias.
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
 * Deployments with nothing new LONG-POLL until the fetch timeout, so quiet
 * projects cost ~POLL_TIMEOUT_MS each — polls run in concurrent batches, and
 * `limit` is capped so the worst-case sweep fits maxDuration. Candidates are
 * ordered by least-recently-checked so a fleet larger than `limit` rotates
 * fairly instead of starving the tail. Every per-project step is try/caught
 * so one bad deployment can't abort the sweep (same contract as the reaper).
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
import { pauseConvexDeployment } from "@/lib/convex-platform";

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
// A saturated poll extrapolates count × (elapsed / covered-span), capped here.
const SATURATION_MAX_FACTOR = 20;
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

  async function processProject(project: Candidate): Promise<void> {
    const deployUrl = project.convexDeployUrl;
    const deployKey = project.convexDeployKey;
    const deployment = project.convexDeploymentId;
    if (!deployUrl || !deployKey) {
      results.push({ projectId: project.id, deployment, action: "skip", detail: "missing deploy url/key" });
      return;
    }

    // First poll for a project starts counting from now — we deliberately
    // don't count the pre-existing buffer into today's bucket.
    const cursor = project.convexUsageCursor ?? now;
    const poll = await fetchNewFunctionCalls(deployUrl, deployKey, cursor, POLL_TIMEOUT_MS);
    if (!poll.ok) {
      results.push({ projectId: project.id, deployment, action: "error", detail: poll.error });
      return;
    }

    // Saturated poll: the buffer capped out, so the real count is higher.
    // Extrapolate by wall-time coverage (entries spanned spanMs of an
    // elapsed-since-cursor window), capped to avoid wild swings.
    let scale = 1;
    if (poll.saturated && poll.spanMs > 0) {
      const elapsedMs = Math.max(now - cursor, poll.spanMs);
      scale = Math.min(elapsedMs / poll.spanMs, SATURATION_MAX_FACTOR);
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

    if (!dryRun) {
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

    // Resolve the decision into: the status to persist, the alert to send,
    // and the result action to report. Enforcement (the pause call) happens
    // BEFORE the status write — never record 'paused' for a running backend.
    let nextStatus: ConvexUsageStatus = status;
    let pausedAtUpdate: { convexPausedAt?: Date; convexPauseReason?: string } = {};
    let alert: Parameters<typeof sendUsageAlert>[0] | null = null;
    let action: ResultAction = decision;
    let detail: string | undefined;

    if (decision === "warn") {
      nextStatus = "warned";
      alert = { kind: "warn", ...alertBase };
    } else if (decision === "pause" || decision === "pause_repeat") {
      if (autoPause) {
        if (dryRun) {
          action = "pause";
        } else {
          try {
            await pauseConvexDeployment(deployUrl, deployKey);
            nextStatus = "paused";
            pausedAtUpdate = { convexPausedAt: new Date(), convexPauseReason: "usage_spike" };
            alert = { kind: "pause", ...alertBase };
            action = "pause";
          } catch (err) {
            // Loud failure: the exact runaway that most needs attention must
            // never be silent. Status stays un-paused; policy re-emits
            // pause_repeat next tick, so this retries until it sticks.
            detail = `pause failed: ${err instanceof Error ? err.message : String(err)}`;
            if (status === "active") nextStatus = "warned";
            alert = { kind: "pause_failed", ...alertBase, detail };
            action = "pause_failed";
          }
        }
      } else {
        // Alert-only mode: escalate status for the UI, email once per day
        // (only on the crossing tick — 'pause', not 'pause_repeat').
        if (status === "active") nextStatus = "warned";
        if (decision === "pause") alert = { kind: "would_pause", ...alertBase };
        action = "would_pause";
        if (decision === "pause_repeat") detail = "already alerted today (no re-send)";
      }
    } else if (decision === "clear") {
      nextStatus = "active";
    } else if (status === "paused" && poll.count > 0) {
      // State drift: we believe it's paused but it just served traffic
      // (unpaused via the Convex dashboard, or our pause silently lapsed).
      if (autoPause && !dryRun) {
        try {
          await pauseConvexDeployment(deployUrl, deployKey);
          action = "repause";
          detail = `re-paused after drift (${poll.count} calls observed)`;
        } catch (err) {
          detail = `re-pause failed: ${err instanceof Error ? err.message : String(err)}`;
          alert = { kind: "pause_failed", ...alertBase, detail };
          action = "pause_failed";
        }
      }
      // First activity of the UTC day → one drift alert per day, not 48.
      if (!alert && callsTodayBefore === 0) {
        alert = { kind: "paused_but_active", ...alertBase, detail: `${poll.count} calls observed while status='paused'` };
        if (action === "noop") action = "error";
      }
    }

    if (!dryRun) {
      await db
        .update(projects)
        .set({
          // newCursor is a float (fractional ms, observed live 2026-07-23);
          // the column is bigint. Ceil biases toward missing ≤1 boundary entry
          // per tick rather than re-counting one — undercount can't contribute
          // to a false-positive pause.
          convexUsageCursor: Math.ceil(poll.newCursor),
          convexCallsLast30d: last30d,
          convexCallsCheckedAt: new Date(),
          ...(nextStatus !== status ? { convexStatus: nextStatus } : {}),
          ...pausedAtUpdate,
        })
        .where(eq(projects.id, project.id));
      if (alert) await sendUsageAlert(alert);
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
    cleared: tally("clear"),
    errors: tally("error"),
    skipped: tally("skip"),
    results,
  });
}
