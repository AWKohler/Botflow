/**
 * Convex usage poller — the platform-side guardrail for managed Convex
 * deployments (docs/features/convex-usage-guardrails.md).
 *
 * Every tick (vercel.json, every 30 min), for each platform-managed deployment:
 *
 *   1. Count new function executions since the stored cursor via the
 *      deployment's admin log stream (src/lib/convex-usage/poll.ts).
 *   2. Bucket counts per UTC day (convex_usage_daily) and roll the 30-day sum
 *      into projects.convexCallsLast30d (also the reaper's liveness signal).
 *   3. Apply the pure policy (src/lib/convex-usage/policy.ts):
 *      warn → convexStatus='warned' + operator alert;
 *      pause → pause the deployment iff CONVEX_AUTO_PAUSE=true (strict
 *      opt-in; otherwise alert-only), sticky until admin unpause/transfer;
 *      clear → back to 'active' after a full quiet day.
 *
 * Deployments with nothing new LONG-POLL until the fetch timeout, so quiet
 * projects cost ~POLL_TIMEOUT_MS each — polls run in concurrent batches to
 * keep the sweep inside maxDuration. Every per-project step is try/caught so
 * one bad deployment can't abort the sweep (same contract as the reaper).
 */

import { NextResponse } from "next/server";
import { and, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { projects, convexUsageDaily, type Project } from "@/db/schema";
import {
  autoPauseEnabled,
  decideUsageAction,
  usageThresholds,
  type ConvexUsageStatus,
} from "@/lib/convex-usage/policy";
import { fetchNewFunctionCalls } from "@/lib/convex-usage/poll";
import { sendUsageAlert } from "@/lib/convex-usage/alert";
import { pauseConvexDeployment } from "@/lib/convex-platform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const POLL_TIMEOUT_MS = 8_000;
const POLL_CONCURRENCY = 10;
const PRUNE_AFTER_DAYS = 35;
const ROLLUP_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[convex-usage] CRON_SECRET is not set");
    return false;
  }
  if (req.headers.get("authorization") === `Bearer ${cronSecret}`) return true;
  const url = new URL(req.url);
  return url.searchParams.get("token") === cronSecret;
}

/** UTC day key, 'YYYY-MM-DD'. */
function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

type ProjectResult = {
  projectId: string;
  deployment: string | null;
  action: "noop" | "warn" | "pause" | "would_pause" | "clear" | "skip" | "error";
  newCalls?: number;
  callsToday?: number;
  detail?: string;
};

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "300", 10) || 300, 1000);

  const db = getDb();
  const thresholds = usageThresholds();
  const autoPause = autoPauseEnabled();
  const now = Date.now();
  const today = dayKey(now);
  const yesterday = dayKey(now - DAY_MS);
  const rollupCutoff = dayKey(now - ROLLUP_WINDOW_DAYS * DAY_MS);

  // Platform-managed deployments only. 'migrating'/'transferred' are owned by
  // the BYOC transfer flow; 'paused' stays in the sweep (near-free — no new
  // log entries) so its buckets/rollup stay fresh for the UI.
  const candidates: Project[] = await db
    .select()
    .from(projects)
    .where(
      and(
        isNull(projects.deletedAt),
        eq(projects.backendType, "platform"),
        isNotNull(projects.convexDeploymentId),
        sql`${projects.convexStatus} NOT IN ('migrating', 'transferred')`,
      ),
    )
    .limit(limit);

  const results: ProjectResult[] = [];

  async function processProject(project: Project): Promise<void> {
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

    if (!dryRun && poll.count > 0) {
      await db
        .insert(convexUsageDaily)
        .values({ projectId: project.id, day: today, calls: poll.count })
        .onConflictDoUpdate({
          target: [convexUsageDaily.projectId, convexUsageDaily.day],
          set: {
            calls: sql`${convexUsageDaily.calls} + ${poll.count}`,
            updatedAt: new Date(),
          },
        });
    }

    // Today/yesterday buckets + 30-day rollup. (Two small queries per project;
    // fine at current fleet size — batch if the candidate set grows past ~1k.)
    const buckets = await db
      .select({ day: convexUsageDaily.day, calls: convexUsageDaily.calls })
      .from(convexUsageDaily)
      .where(
        and(
          eq(convexUsageDaily.projectId, project.id),
          inArray(convexUsageDaily.day, [today, yesterday]),
        ),
      );
    let callsToday = buckets.find((b) => b.day === today)?.calls ?? 0;
    const callsYesterday = buckets.find((b) => b.day === yesterday)?.calls ?? 0;
    if (dryRun) callsToday += poll.count; // upsert was skipped

    const [rollup] = await db
      .select({ total: sql<string | null>`sum(${convexUsageDaily.calls})` })
      .from(convexUsageDaily)
      .where(
        and(
          eq(convexUsageDaily.projectId, project.id),
          gte(convexUsageDaily.day, rollupCutoff),
        ),
      );
    const last30d = Number(rollup?.total ?? 0) + (dryRun ? poll.count : 0);

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
        })
        .where(eq(projects.id, project.id));
    }

    const status = (project.convexStatus ?? "active") as ConvexUsageStatus;
    const decision = decideUsageAction({ status, callsToday, callsYesterday, thresholds });

    const alertBase = {
      projectId: project.id,
      projectName: project.name,
      ownerUserId: project.userId,
      deploymentName: deployment ?? "?",
      callsToday,
      warnThreshold: thresholds.warnCallsPerDay,
      pauseThreshold: thresholds.pauseCallsPerDay,
    };

    if (decision === "warn") {
      if (!dryRun) {
        await db.update(projects).set({ convexStatus: "warned" }).where(eq(projects.id, project.id));
        await sendUsageAlert({ kind: "warn", ...alertBase });
      }
      results.push({ projectId: project.id, deployment, action: "warn", newCalls: poll.count, callsToday });
      return;
    }

    if (decision === "pause") {
      if (autoPause) {
        if (!dryRun) {
          // Pause FIRST, then record — if the pause call fails we stay
          // 'warned' and retry next tick (policy re-emits 'pause' until the
          // status flips). Never record 'paused' for a still-running backend.
          await pauseConvexDeployment(deployUrl, deployKey);
          await db
            .update(projects)
            .set({
              convexStatus: "paused",
              convexPausedAt: new Date(),
              convexPauseReason: "usage_spike",
            })
            .where(eq(projects.id, project.id));
          await sendUsageAlert({ kind: "pause", ...alertBase });
        }
        results.push({ projectId: project.id, deployment, action: "pause", newCalls: poll.count, callsToday });
      } else {
        // Alert-only mode. The policy re-emits 'pause' every tick while over
        // the bar, so dedupe here: alert only on the tick that crossed the
        // threshold (counts reset at the UTC day boundary → at most one
        // would_pause alert per project per day).
        const crossedThisTick = callsToday - poll.count < thresholds.pauseCallsPerDay;
        if (!dryRun) {
          if (status === "active") {
            await db.update(projects).set({ convexStatus: "warned" }).where(eq(projects.id, project.id));
          }
          if (crossedThisTick) await sendUsageAlert({ kind: "would_pause", ...alertBase });
        }
        results.push({
          projectId: project.id,
          deployment,
          action: "would_pause",
          newCalls: poll.count,
          callsToday,
          ...(crossedThisTick ? {} : { detail: "already alerted (no re-send)" }),
        });
      }
      return;
    }

    if (decision === "clear") {
      if (!dryRun) {
        await db.update(projects).set({ convexStatus: "active" }).where(eq(projects.id, project.id));
      }
      results.push({ projectId: project.id, deployment, action: "clear", newCalls: poll.count, callsToday });
      return;
    }

    results.push({ projectId: project.id, deployment, action: "noop", newCalls: poll.count, callsToday });
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

  // Prune buckets past the retention window (one global delete per sweep).
  let pruned = 0;
  if (!dryRun) {
    try {
      const pruneCutoff = dayKey(now - PRUNE_AFTER_DAYS * DAY_MS);
      const deleted = await db
        .delete(convexUsageDaily)
        .where(lt(convexUsageDaily.day, pruneCutoff))
        .returning({ projectId: convexUsageDaily.projectId });
      pruned = deleted.length;
    } catch (err) {
      console.error("[convex-usage] prune failed:", err);
    }
  }

  const tally = (a: ProjectResult["action"]) => results.filter((r) => r.action === a).length;
  return NextResponse.json({
    dryRun,
    autoPause,
    thresholds,
    candidates: candidates.length,
    warned: tally("warn"),
    paused: tally("pause"),
    wouldPause: tally("would_pause"),
    cleared: tally("clear"),
    errors: tally("error"),
    skipped: tally("skip"),
    pruned,
    results,
  });
}
