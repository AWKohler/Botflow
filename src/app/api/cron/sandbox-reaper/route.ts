/**
 * Daily reaper sweep.
 *
 * Triggered by Vercel cron (see vercel.json). Authorized by CRON_SECRET shared
 * across cron routes. Iterates projects in batches:
 *
 *   - Skip paid-tier owners (cached lookup via tier.ts).
 *   - Compute the reap action from the project row.
 *   - Send the right email + advance the stage + (for archive) tear down the
 *     sandbox and managed-Convex deployment.
 *
 * The route is conservative: every destructive step is wrapped in try/catch
 * so a single bad project doesn't abort the sweep.
 */

import { NextResponse } from "next/server";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { projects, type Project } from "@/db/schema";
import { getUserTier } from "@/lib/tier";
import { decideReapAction, WARN90_IDLE_DAYS } from "@/lib/reaper/policy";
import { deletePersistentSandbox } from "@/lib/vercel-sandbox";
import { sweepPromotionHostCleanup } from "@/lib/sandbox-promotion";
import { deleteConvexBackend } from "@/lib/convex-platform";
import { getEmailForClerkUser } from "@/lib/email";
import { sendWarn90Email, sendWarn104Email } from "@/lib/reaper/emails";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[reaper] CRON_SECRET is not set");
    return false;
  }
  if (req.headers.get("authorization") === `Bearer ${cronSecret}`) return true;
  const url = new URL(req.url);
  return url.searchParams.get("token") === cronSecret;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "500", 10) || 500, 2000);

  const db = getDb();

  // Candidate set: anything not already in the terminal "deleted" stage with
  // a touch date older than the earliest threshold. We also include rows where
  // lastSandboxActivityAt is null but createdAt is old enough — captures
  // projects that were created and never touched.
  const earliestTouch = new Date(Date.now() - WARN90_IDLE_DAYS * DAY_MS);
  const candidates: Project[] = await db
    .select()
    .from(projects)
    .where(
      and(
        isNull(projects.deletedAt),
        sql`${projects.reapStage} <> 'deleted'`,
        or(
          lt(projects.lastSandboxActivityAt, earliestTouch),
          and(
            isNull(projects.lastSandboxActivityAt),
            lt(projects.lastOpened, earliestTouch),
          ),
        ),
      ),
    )
    .limit(limit);

  // Cache tier lookups within a run.
  const tierCache = new Map<string, Awaited<ReturnType<typeof getUserTier>>>();
  async function tierOf(userId: string) {
    let t = tierCache.get(userId);
    if (!t) {
      t = await getUserTier(userId).catch(() => "free" as const);
      tierCache.set(userId, t);
    }
    return t;
  }

  const stats = {
    examined: candidates.length,
    skippedPaid: 0,
    noop: 0,
    warned90: 0,
    archived: 0,
    hardDeleted: 0,
    errors: 0,
    dryRun,
  };

  for (const project of candidates) {
    try {
      const ownerTier = await tierOf(project.userId);
      const decision = decideReapAction({ ownerTier, project });

      if (decision.kind === "noop") {
        stats.noop++;
        if (ownerTier !== "free") stats.skippedPaid++;
        continue;
      }

      if (decision.kind === "send_warn90") {
        if (!dryRun) await actWarn90(project);
        stats.warned90++;
        continue;
      }

      if (decision.kind === "archive_and_warn104") {
        if (!dryRun) await actArchiveAndWarn104(project);
        stats.archived++;
        continue;
      }

      if (decision.kind === "delete_project_record") {
        if (!dryRun) await actHardDelete(project);
        stats.hardDeleted++;
        continue;
      }
    } catch (e) {
      stats.errors++;
      console.error(`[reaper] project ${project.id} failed:`, e);
    }
  }

  // Retry host-VM deletions owed by interrupted tier promotions (flip
  // happened, delete didn't) so they can't leak indefinitely.
  const promotionCleanup = dryRun
    ? { swept: 0, failed: 0 }
    : await sweepPromotionHostCleanup().catch(() => ({ swept: 0, failed: 0 }));

  return NextResponse.json({ ok: true, stats: { ...stats, promotionCleanup } });
}

// ────────────────────────────────────────────────────────────────────────────
// Stage actions
// ────────────────────────────────────────────────────────────────────────────

async function actWarn90(project: Project): Promise<void> {
  const contact = await getEmailForClerkUser(project.userId);
  if (contact) {
    await sendWarn90Email({
      to: contact.email,
      name: contact.name,
      projectName: project.name,
      projectId: project.id,
    });
  }
  await getDb()
    .update(projects)
    .set({
      reapStage: "warned_90d",
      lastReapWarningSentAt: new Date(),
    })
    .where(eq(projects.id, project.id));
}

async function actArchiveAndWarn104(project: Project): Promise<void> {
  const contact = await getEmailForClerkUser(project.userId);
  if (contact) {
    await sendWarn104Email({
      to: contact.email,
      name: contact.name,
      projectName: project.name,
      projectId: project.id,
    });
  }
  // Tear down the sandbox VM + its retained snapshots.
  await deletePersistentSandbox(project.id).catch((e) =>
    console.warn(`[reaper] sandbox teardown failed for ${project.id}:`, e),
  );
  await getDb()
    .update(projects)
    .set({
      reapStage: "archived",
      lastReapWarningSentAt: new Date(),
    })
    .where(eq(projects.id, project.id));
}

async function actHardDelete(project: Project): Promise<void> {
  // Sandbox already torn down at archive; double-tap as belt-and-suspenders.
  await deletePersistentSandbox(project.id).catch(() => undefined);

  // For managed-Convex only: tear down the user's Convex project too.
  if (project.backendType === "platform" && project.convexProjectId) {
    await deleteConvexBackend(project.convexProjectId).catch((e) =>
      console.warn(`[reaper] convex teardown failed for ${project.id}:`, e),
    );
  }

  // Soft-delete the row rather than hard-deleting — keeps audit trail and
  // FK-dependent rows (chat history, etc.) intact for any future appeal.
  await getDb()
    .update(projects)
    .set({
      reapStage: "deleted",
      deletedAt: new Date(),
    })
    .where(eq(projects.id, project.id));
}

// POST allowed too — easier to fire from the dashboard with curl -X POST.
export const POST = GET;
