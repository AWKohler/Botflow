// Which Mac a user's simulator session or build goes to.
//
// New work: `pickSimTarget(userId)` takes the serving hosts in the registry
// that this user may use (beta-only hosts need a beta user), drops the ones
// whose controller or agent is down, and takes the lowest priority number
// with a free slot (most free slots breaks a tie). If every candidate is
// full, the work queues on the first one that is up; if none answers its
// health check, the first candidate is tried anyway rather than failing on
// the health probe alone.
//
// Follow-up calls (rebuild, release, build status, IPA download) must reach
// the controller that holds the session or build, so each placement is
// remembered in Redis; on a miss (expired, or created before this existed),
// every registered host is asked whether it has it.
//
// With no rows in the registry at all — or the table not migrated yet — all
// of this falls back to the env-configured controller (SIM_CONTROLLER_URL),
// which is how Botflow worked before the registry.

import type { SimHostRow } from "@/db/schema";
import { redis } from "@/lib/redis";
import { envSimTarget, type SimTarget } from "@/lib/sim-platform";
import { isBetaUser } from "@/lib/tier";
import { freeSlots, probeSimHostHealth } from "./health";
import { runtimeRank as rankOf } from "./model";
import { getSimHostRow, listSimHostRows, toSimTarget } from "./store";

export type SimWorkKind = "session" | "device-build" | "app-store-build";

/** Raised when the registry has hosts but none may serve this user right now. */
export class NoSimHostError extends Error {
  constructor() {
    super("No iOS simulator host is available right now. Please try again in a few minutes.");
    this.name = "NoSimHostError";
  }
}

const ROUTE_TTL_SECONDS = 6 * 60 * 60;
const routeKey = (kind: SimWorkKind, id: string) => `simroute:${kind}:${id}`;

/** Registry rows, or null when the registry can't be read (falls back to env). */
async function loadRows(): Promise<SimHostRow[] | null> {
  try {
    return await listSimHostRows();
  } catch (error) {
    console.error("[sim-hosts] registry unavailable, using SIM_CONTROLLER_URL:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** The hosts a user may be placed on, in preference order (before health). */
export async function eligibleSimHosts(
  rows: SimHostRow[],
  userId: string,
  opts: { release?: boolean } = {},
): Promise<SimHostRow[]> {
  // Release (App Store) builds stay off beta-only hosts, which are where
  // unsecured and pre-release (beta macOS / Xcode) Macs are kept.
  const serving = rows.filter((r) => r.serving && !(opts.release && r.scope === "beta"));
  const needsBeta = serving.some((r) => r.scope === "beta");
  const beta = needsBeta ? await isBetaUser(userId).catch(() => false) : false;
  return serving
    .filter((r) => r.scope !== "beta" || beta)
    .sort((a, b) => a.priority - b.priority || runtimeRank(a) - runtimeRank(b));
}

// At equal priority the more isolated runtime is preferred.
function runtimeRank(row: SimHostRow): number {
  return rankOf(row.runtime);
}

/** Choose the host for new simulator or build work by this user. */
export async function pickSimTarget(userId: string, opts: { release?: boolean } = {}): Promise<SimTarget> {
  const rows = await loadRows();
  if (!rows || rows.length === 0) return envSimTarget();

  const candidates = await eligibleSimHosts(rows, userId, opts);
  if (candidates.length === 0) throw new NoSimHostError();

  const probed = await Promise.all(
    candidates.map(async (row) => ({ row, health: await probeSimHostHealth(row) })),
  );
  const up = probed.filter((p) => p.health.reachable && p.health.agentConnected);
  const withRoom = up
    .map((p) => ({ ...p, free: freeSlots(p.row, p.health) }))
    .filter((p) => p.free > 0)
    .sort((a, b) => a.row.priority - b.row.priority || b.free - a.free || runtimeRank(a.row) - runtimeRank(b.row));

  const chosen = withRoom[0]?.row ?? up[0]?.row ?? candidates[0];
  return toSimTarget(chosen);
}

/** Remember which host holds a session or build, for follow-up calls. */
export async function rememberSimRoute(kind: SimWorkKind, id: string, target: SimTarget): Promise<void> {
  await redis.set(routeKey(kind, id), target.hostId, { ex: ROUTE_TTL_SECONDS }).catch((error: unknown) => {
    console.warn("[sim-hosts] could not remember route:", error instanceof Error ? error.message : error);
  });
}

export async function forgetSimRoute(kind: SimWorkKind, id: string): Promise<void> {
  await redis.del(routeKey(kind, id)).catch(() => undefined);
}

const PROBE_PATH: Record<SimWorkKind, string> = {
  session: "/api/sessions/",
  "device-build": "/api/device-builds/",
  "app-store-build": "/api/app-store-builds/",
};

/**
 * The controller that holds an existing session or build. A host switched
 * off in the panel still serves the work already placed on it (it drains);
 * only new work avoids it.
 */
export async function targetForSimWork(kind: SimWorkKind, id: string): Promise<SimTarget> {
  const remembered = await redis.get<string>(routeKey(kind, id)).catch(() => null);
  if (remembered === "env") return envSimTarget();
  if (remembered) {
    const row = await getSimHostRow(remembered).catch(() => null);
    if (row) return toSimTarget(row);
  }

  const rows = await loadRows();
  if (!rows || rows.length === 0) return envSimTarget();

  const targets: SimTarget[] = [];
  for (const row of rows) {
    try {
      targets.push(toSimTarget(row));
    } catch {
      // A host whose token can't be read can't hold anything we can reach.
    }
  }
  if (targets.length === 0) return toSimTarget(rows[0]);
  if (targets.length === 1) return targets[0];

  const found = await Promise.all(
    targets.map(async (t) => {
      try {
        const res = await fetch(`${t.http}${PROBE_PATH[kind]}${encodeURIComponent(id)}`, {
          headers: { "x-platform-token": t.token },
          cache: "no-store",
          signal: AbortSignal.timeout(3_000),
        });
        return res.ok ? t : null;
      } catch {
        return null;
      }
    }),
  );
  const hit = found.find((t): t is SimTarget => t !== null);
  if (hit) {
    await rememberSimRoute(kind, id, hit);
    return hit;
  }
  // Nobody has it: the first host answers, and its "not found" reaches the caller.
  return targets[0];
}
