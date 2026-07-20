/**
 * Lazy promotion of free-tier (sandbox-host) projects to Vercel Sandbox when
 * their OWNER is now on a paid tier.
 *
 * Paid plans guarantee unrestricted sandbox internet; sandbox-host VMs have an
 * egress allowlist. So when a workspace opens a sandbox-host project whose
 * owner tier resolves to pro/max, we move the project's files onto a fresh
 * Vercel sandbox and retire the self-hosted VM. Modeled on the lazy
 * WebContainer migration (webcontainer-migration.ts): triggered on open,
 * idempotent, with ordering chosen so an interruption at any step leaves a
 * retryable state:
 *
 *   1. tar the source tree out of the sandbox-host VM        (source intact)
 *   2. create the Vercel sandbox + extract + verify           (source intact)
 *   3. flip projects.sandbox_provider → 'vercel'              (target is now
 *      the project's backend; a crash after this point leaves a working
 *      Vercel project)
 *   4. delete the sandbox-host VM + snapshots                 (best-effort;
 *      failure only leaks an idle VM on our own hardware)
 *
 * Failure BEFORE the flip is non-fatal by design: the caller proceeds on
 * sandbox-host exactly as before, and the next open retries.
 *
 * Concurrency: a Redis NX lock serializes promotion across serverless
 * instances. Losers of the race wait for the winner (bounded) and then
 * re-read the column, so both boots converge on the promoted sandbox. The
 * copy window is quiet by construction — promotion runs inside the blocking
 * workspace-boot call, before the editor or agent can write.
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
  tarSandboxProject,
} from "@/lib/vercel-sandbox";
import { materializeFrontendEnv } from "@/lib/sandbox-env";

const SANDBOX_ROOT = "/vercel/sandbox";
const LOCK_TTL_SECONDS = 300;
// How long a losing boot waits for the winning instance's promotion.
const WAIT_FOR_PEER_MS = 60_000;
const WAIT_POLL_MS = 2_000;

export type PromotionResult =
  | { status: "skipped"; reason: "not-sandbox-host" | "owner-not-paid" | "tier-unknown" }
  | { status: "promoted" }
  | { status: "promoted-elsewhere" }
  | { status: "in-progress" }
  | { status: "failed"; reason: string };

function lockKey(projectId: string): string {
  return `sandbox-promote:${projectId}`;
}

type PromotableProject = {
  id: string;
  userId: string;
  sandboxProvider: string;
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

async function copyIntoVercelSandbox(projectId: string): Promise<void> {
  // Source: the sandbox-host VM (the provider column still points there, so
  // the column-driven tar helper reads from the right backend).
  const tarBuf = await tarSandboxProject(projectId);

  const target = await getOrCreateSandboxOnProvider(projectId, "vercel");

  // Idempotency: a prior interrupted run may have copied already.
  if (await sandboxHasContent(target)) return;

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

  const redis = getRedis();
  const key = lockKey(project.id);

  let locked: unknown;
  try {
    locked = await redis.set(key, "1", { nx: true, ex: LOCK_TTL_SECONDS });
  } catch {
    // Redis down — don't promote without a lock; boot on sandbox-host.
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
    console.log(`[sandbox-promotion] promoting project ${project.id} to Vercel`);

    // 1–2. Copy + verify (source untouched throughout).
    await copyIntoVercelSandbox(project.id);

    // Regenerate .env on the new sandbox (VITE_CONVEX_URL + user vars) so a
    // backend added post-upgrade works immediately. Best-effort.
    try {
      await materializeFrontendEnv(project.id);
    } catch (e) {
      console.warn(`[sandbox-promotion] env materialize failed (non-fatal)`, e);
    }

    // 3. Flip — from here the project lives on Vercel.
    await getDb()
      .update(projects)
      .set({ sandboxProvider: "vercel", updatedAt: new Date() })
      .where(eq(projects.id, project.id));
    invalidateProviderCache(project.id);

    // 4. Retire the sandbox-host VM + snapshots. Best-effort: a failure here
    // only leaks an idle VM on our own hardware (flag it loudly for ops).
    try {
      await deleteSandboxOnProvider(project.id, "sandbox-host");
    } catch (e) {
      console.error(
        `[sandbox-promotion] ORPHANED sandbox-host VM for project ${project.id} — delete failed`,
        e,
      );
    }

    console.log(`[sandbox-promotion] project ${project.id} promoted to Vercel`);
    return { status: "promoted" };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`[sandbox-promotion] promotion failed for ${project.id}: ${reason}`);
    return { status: "failed", reason };
  } finally {
    await redis.del(key).catch(() => undefined);
  }
}
