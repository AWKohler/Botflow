/**
 * Lazy promotion of free-tier (sandbox-host) projects to Vercel Sandbox when
 * their OWNER is now on a paid tier.
 *
 * Paid plans guarantee unrestricted sandbox internet; sandbox-host VMs have an
 * egress allowlist. So when a workspace opens a sandbox-host project whose
 * owner tier resolves to pro/max, we move the project's files onto a fresh
 * Vercel sandbox and retire the self-hosted VM. Modeled on the lazy
 * WebContainer migration (webcontainer-migration.ts): triggered on open,
 * idempotent, ordered so an interruption at any step leaves a retryable
 * state:
 *
 *   1. gates: provider, owner tier, real Redis, 5-min idle window
 *   2. take the Redis NX lock, then RE-READ provider + activity fresh from
 *      the DB (a stale request must never act on a row another instance
 *      already promoted — that would wipe the live Vercel sandbox)
 *   3. snapshot the source tree signature, tar it (strict — a tar that saw
 *      concurrent changes is a hard failure, not a snapshot)
 *   4. create the Vercel sandbox, WIPE any partial prior copy (wipe failure
 *      is fatal), extract, verify
 *   5. re-check the source signature — any concurrent writer aborts pre-flip
 *   6. durably record the host-VM retirement in a Redis set (recording
 *      failure ABORTS, still pre-flip), then flip
 *      projects.sandbox_provider → 'vercel'
 *
 * The host VM is NOT deleted inline. Retirement happens only via
 * sweepPromotionHostCleanup (reaper cron), which deletes a host VM only
 * after verifying the project's column is committed to 'vercel'. That makes
 * destruction provider-verified, keeps a ≤1-day recovery window in case a
 * writer slipped every guard, and means a stale set entry (flip never
 * happened) is dropped harmlessly instead of deleting a live source.
 *
 * Failure anywhere BEFORE the flip is non-fatal by design: the caller
 * proceeds on sandbox-host exactly as before, and the next open retries from
 * scratch. A crash AFTER the flip leaves a working Vercel project plus a
 * cleanup entry the sweep retires.
 *
 * Writer safety is layered, not absolute: the idle gate plus the signature
 * comparison catch every realistic writer (agent turns, saves, second tabs,
 * detached bridges), and the deferred provider-verified deletion means even
 * a writer that starts in the final seconds loses only writes made to a
 * backend the column no longer points at — recoverable from the host VM
 * until the sweep runs. A true distributed writer barrier was deliberately
 * not added; it would put a Redis check on every sandbox hot-path call.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { getRedis } from "@/lib/redis";
import { getUserTier } from "@/lib/tier";
import { invalidateProviderCache } from "@/lib/sandbox-provider";
import {
  deleteSandboxOnProvider,
  getOrCreateSandboxOnProvider,
  sandboxTreeSignature,
  tarSandboxProject,
} from "@/lib/vercel-sandbox";
import { materializeFrontendEnv } from "@/lib/sandbox-env";

const SANDBOX_ROOT = "/vercel/sandbox";
const LOCK_TTL_SECONDS = 300;
// How long a losing boot waits for the winning instance's promotion.
const WAIT_FOR_PEER_MS = 60_000;
const WAIT_POLL_MS = 2_000;
// Don't attempt promotion while the sandbox is (or was very recently) in
// use — an in-flight agent turn or save would be lost with the source VM.
const IDLE_REQUIRED_MS = 5 * 60 * 1000;

/** Durable record of host VMs whose deletion is still owed (flip happened,
 *  delete didn't). Swept by the sandbox-reaper cron. */
export const PROMOTION_CLEANUP_SET = "sandbox-promotion:pending-host-cleanup";

export type PromotionResult =
  | {
      status: "skipped";
      reason: "not-sandbox-host" | "owner-not-paid" | "tier-unknown" | "recently-active";
    }
  | { status: "promoted" }
  | { status: "promoted-elsewhere" }
  | { status: "in-progress" }
  | { status: "failed"; reason: string };

function lockKey(projectId: string): string {
  return `sandbox-promote:${projectId}`;
}

/** The Redis client degrades to a no-op stub without these — and a no-op
 *  "lock" would let every instance promote at once. */
function hasRealRedis(): boolean {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
  );
}

type PromotableProject = {
  id: string;
  userId: string;
  sandboxProvider: string;
  lastSandboxActivityAt: Date | null;
};

type SandboxHandle = Awaited<ReturnType<typeof getOrCreateSandboxOnProvider>>;

/** True when the sandbox already has content (ignoring node_modules/.git). */
async function sandboxHasContent(sandbox: SandboxHandle): Promise<boolean> {
  const check = await sandbox.runCommand("sh", [
    "-c",
    `ls -A ${SANDBOX_ROOT} 2>/dev/null | grep -v '^node_modules$' | grep -v '^\\.git$' | head -1 || true`,
  ]);
  return Boolean((await check.stdout()).trim());
}

/**
 * Copy the source (sandbox-host) tree into a Vercel sandbox. The target is
 * wiped first: pre-flip it serves no one, and a partial copy from an
 * interrupted run must never be mistaken for a completed one.
 */
async function copyIntoVercelSandbox(projectId: string, tarBuf: Buffer): Promise<void> {
  const target = await getOrCreateSandboxOnProvider(projectId, "vercel");

  const wipe = await target.runCommand("sh", [
    "-c",
    `find ${SANDBOX_ROOT} -mindepth 1 -maxdepth 1 -exec rm -rf {} +`,
  ]);
  if (wipe.exitCode !== 0) {
    // Extracting over stale content could blend two copies — hard abort.
    throw new Error(
      `target wipe failed (${wipe.exitCode}): ${(await wipe.stderr()).slice(0, 500)}`,
    );
  }

  const tmp = `/tmp/promote-${projectId}.tar.gz`;
  await target.writeFiles([{ path: tmp, content: tarBuf }]);
  const extract = await target.runCommand("sh", [
    "-c",
    `mkdir -p ${SANDBOX_ROOT} && tar xzf ${tmp} -C ${SANDBOX_ROOT} && rm -f ${tmp}`,
  ]);
  if (extract.exitCode !== 0) {
    throw new Error(
      `extract failed (${extract.exitCode}): ${(await extract.stderr()).slice(0, 500)}`,
    );
  }
  if (!(await sandboxHasContent(target))) {
    throw new Error("target sandbox empty after extract");
  }
}

/**
 * Promote a sandbox-host project to Vercel when its owner is on a paid tier.
 * Cheap no-op for everything else. Never throws — a failed promotion reports
 * `failed` and the caller proceeds on sandbox-host as before.
 */
export async function maybePromoteSandboxToVercel(
  project: PromotableProject,
): Promise<PromotionResult> {
  if (project.sandboxProvider !== "sandbox-host") {
    return { status: "skipped", reason: "not-sandbox-host" };
  }

  // OWNER tier decides (not the acting user — shared projects bill/behave by
  // owner). Beta's pro floor counts as paid, consistent with the rest of the
  // platform's tier gates.
  let paid: boolean;
  try {
    paid = (await getUserTier(project.userId)) !== "free";
  } catch {
    return { status: "skipped", reason: "tier-unknown" };
  }
  if (!paid) return { status: "skipped", reason: "owner-not-paid" };

  // Idle gate: any recent activity (agent turn, save, cron touch) means a
  // writer may still be in flight. Defer to a later, quieter boot. Note this
  // reads the row fetched by the route BEFORE this boot touched the sandbox.
  const lastActivity = project.lastSandboxActivityAt?.getTime() ?? 0;
  if (Date.now() - lastActivity < IDLE_REQUIRED_MS) {
    return { status: "skipped", reason: "recently-active" };
  }

  if (!hasRealRedis()) {
    // Without a real lock, concurrent boots could race the copy/delete.
    return { status: "failed", reason: "redis-not-configured" };
  }
  const redis = getRedis();
  const key = lockKey(project.id);

  let locked: unknown;
  try {
    locked = await redis.set(key, "1", { nx: true, ex: LOCK_TTL_SECONDS });
  } catch {
    return { status: "failed", reason: "lock-unavailable" };
  }

  if (!locked) {
    // Another instance is promoting. Wait for it, then re-read the column so
    // this boot lands on whatever backend won.
    const deadline = Date.now() + WAIT_FOR_PEER_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
      try {
        if (!(await redis.get(key))) {
          invalidateProviderCache(project.id);
          const [row] = await getDb()
            .select({ sandboxProvider: projects.sandboxProvider })
            .from(projects)
            .where(eq(projects.id, project.id));
          return row?.sandboxProvider === "vercel"
            ? { status: "promoted-elsewhere" }
            : { status: "failed", reason: "peer-promotion-failed" };
        }
      } catch {
        // Redis blip — keep waiting until the deadline.
      }
    }
    return { status: "in-progress" };
  }

  try {
    // 2. Post-lock revalidation: this request's `project` row may be stale
    //    (fetched before another instance promoted and released the lock).
    //    Acting on stale state here would wipe the LIVE Vercel sandbox, so
    //    re-read both gates fresh from the DB under the lock.
    const [fresh] = await getDb()
      .select({
        sandboxProvider: projects.sandboxProvider,
        lastSandboxActivityAt: projects.lastSandboxActivityAt,
      })
      .from(projects)
      .where(eq(projects.id, project.id));
    if (!fresh) return { status: "failed", reason: "project-gone" };
    if (fresh.sandboxProvider !== "sandbox-host") {
      invalidateProviderCache(project.id);
      return { status: "promoted-elsewhere" };
    }
    const freshActivity = fresh.lastSandboxActivityAt?.getTime() ?? 0;
    if (Date.now() - freshActivity < IDLE_REQUIRED_MS) {
      return { status: "skipped", reason: "recently-active" };
    }

    console.log(`[sandbox-promotion] promoting project ${project.id} to Vercel`);

    // 3. Snapshot + strict tar. The signature covers path/size/mtime of the
    //    full tree, so any concurrent write flips it.
    const preSig = await sandboxTreeSignature(project.id);
    const tarBuf = await tarSandboxProject(project.id, { strict: true });

    // 4. Copy into a wiped Vercel sandbox and verify.
    await copyIntoVercelSandbox(project.id, tarBuf);

    // 5. Writer detection: if the source changed while we copied, abort
    //    before the flip — nothing is lost, and the next open retries.
    const postSig = await sandboxTreeSignature(project.id);
    if (preSig && postSig && preSig !== postSig) {
      return { status: "failed", reason: "source-changed-during-copy" };
    }
    if (!preSig || !postSig) {
      console.warn(
        `[sandbox-promotion] tree signature unavailable for ${project.id} — proceeding on strict-tar guarantee alone`,
      );
    }

    // 6. Durably record the host-VM retirement BEFORE the flip. Mandatory:
    //    without it, a crash after the flip would orphan the VM forever.
    //    Still pre-flip, so aborting here is fully safe — and a stale entry
    //    (crash before the flip) is harmless because the sweep only deletes
    //    after verifying the column committed to 'vercel'.
    try {
      await redis.sadd(PROMOTION_CLEANUP_SET, project.id);
    } catch {
      return { status: "failed", reason: "cleanup-record-failed" };
    }

    await getDb()
      .update(projects)
      .set({ sandboxProvider: "vercel", updatedAt: new Date() })
      .where(eq(projects.id, project.id));
    invalidateProviderCache(project.id);

    // Regenerate .env on the NEW sandbox (the column now points at Vercel, so
    // the column-driven env writer targets it). Best-effort.
    try {
      await materializeFrontendEnv(project.id);
    } catch (e) {
      console.warn(`[sandbox-promotion] env materialize failed (non-fatal)`, e);
    }

    // The host VM is intentionally NOT deleted here — the reaper's
    // provider-verified sweep retires it (see module doc).
    console.log(
      `[sandbox-promotion] project ${project.id} promoted to Vercel; host VM queued for sweep retirement`,
    );
    return { status: "promoted" };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`[sandbox-promotion] promotion failed for ${project.id}: ${reason}`);
    return { status: "failed", reason };
  } finally {
    await redis.del(key).catch(() => undefined);
  }
}

/**
 * Retire host VMs owed by completed promotions. Called by the sandbox-reaper
 * cron. This is the ONLY place promotion ever deletes a host VM, and it
 * deletes only after verifying the project's column is committed to
 * 'vercel' — so a stale set entry (a promotion that crashed before its
 * flip, or a project that somehow lives on sandbox-host again) can never
 * destroy a live source. Idempotent: deleteSandboxOnProvider treats 404 as
 * success, and set entries are re-attempted until they clear.
 */
export async function sweepPromotionHostCleanup(
  limit = 20,
): Promise<{ swept: number; droppedStale: number; failed: number }> {
  if (!hasRealRedis()) return { swept: 0, droppedStale: 0, failed: 0 };
  const redis = getRedis();

  let ids: string[];
  try {
    ids = ((await redis.smembers(PROMOTION_CLEANUP_SET)) ?? []) as string[];
  } catch {
    return { swept: 0, droppedStale: 0, failed: 0 };
  }

  let swept = 0;
  let droppedStale = 0;
  let failed = 0;
  for (const id of ids.slice(0, limit)) {
    try {
      const [row] = await getDb()
        .select({ sandboxProvider: projects.sandboxProvider })
        .from(projects)
        .where(eq(projects.id, id));

      if (row && row.sandboxProvider !== "vercel") {
        // Flip never committed (promotion crashed pre-flip) or the project
        // legitimately lives on sandbox-host again: the entry is stale —
        // drop it WITHOUT deleting anything.
        await redis.srem(PROMOTION_CLEANUP_SET, id);
        droppedStale++;
        continue;
      }

      // Column committed to 'vercel' (or the row is gone entirely, in which
      // case no live project can own the host VM's name): safe to retire.
      await deleteSandboxOnProvider(id, "sandbox-host");
      await redis.srem(PROMOTION_CLEANUP_SET, id);
      swept++;
    } catch (e) {
      failed++;
      console.error(`[sandbox-promotion] cleanup sweep failed for ${id}`, e);
    }
  }
  return { swept, droppedStale, failed };
}
