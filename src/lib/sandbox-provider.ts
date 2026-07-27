/**
 * Sandbox backend selection.
 *
 * Two backends can host a project's persistent sandbox:
 *   'vercel'       — Vercel Sandbox (the historical default; paid tiers)
 *   'sandbox-host' — self-hosted Firecracker microVM service (free tier;
 *                    drop-in `@sandbox-host/sdk` fork of `@vercel/sandbox`)
 *
 * The choice is stamped on projects.sandbox_provider at creation time (see
 * POST /api/projects) and only changes via the offline migration script, so a
 * project's files never silently split across two backends. Everything
 * downstream — vercel-sandbox.ts and its callers — resolves the provider
 * through here.
 *
 * Env contract (all server-side):
 *   SANDBOX_API_URL            — base URL of the sandbox-host control plane,
 *                                e.g. https://<host>.ts.net/api. Read natively
 *                                by @sandbox-host/sdk; verified NOT read by
 *                                @vercel/sandbox@2.0.0-beta.14, so setting it
 *                                cannot redirect real Vercel Sandbox traffic.
 *   SANDBOX_HOST_TOKEN         — bearer token for the service.
 *   SANDBOX_HOST_TEAM_ID       — tenant team id (default "default").
 *   SANDBOX_HOST_PROJECT_ID    — tenant project id (default "default").
 *   SANDBOX_HOST_ENABLED       — MASTER SWITCH. "1" routes NEW free-tier
 *                                projects to sandbox-host. Off by default: with
 *                                it unset the feature is inert — every new
 *                                project goes to Vercel regardless of the other
 *                                vars — so merging to main can't activate
 *                                sandbox-host anywhere until this is explicitly
 *                                set. Turning it OFF later stops routing NEW
 *                                projects but does NOT disturb existing
 *                                sandbox-host projects (they keep dispatching to
 *                                the host by their stored column; there is no
 *                                safe silent fallback to an empty Vercel VM).
 *   SANDBOX_HOST_STRICT        — "1" makes chooseProviderForNewProject THROW
 *                                (instead of silently returning "vercel") when
 *                                a free-tier project can't be placed on
 *                                sandbox-host. Temporary rollout-testing aid so
 *                                misconfiguration is loud, not a silent Vercel
 *                                sandbox. Leave OFF in production.
 *   SANDBOX_HOST_OVERFLOW_TO_VERCEL
 *                              — "1" lets a NEW free-tier project fall back to
 *                                Vercel when the host has no free session slot
 *                                (or is unreachable), instead of being stamped
 *                                'sandbox-host' and hitting an "at capacity"
 *                                wall on first open. OFF by default: overflow
 *                                costs real Vercel spend and is STICKY (the
 *                                project stays on Vercel for life), so it's an
 *                                explicit decision to trade money for
 *                                availability. Only ever consulted at project
 *                                CREATION, where no files exist yet — never for
 *                                an existing project, which must always resolve
 *                                to the backend holding its data.
 *   SANDBOX_HOST_MAX_SESSIONS  — soft capacity threshold used by the overflow
 *                                probe; keep in sync with the host's per-token
 *                                `maxSessions` in /etc/sandbox-host/api.json
 *                                (default 25).
 */
import { Sandbox as HostSandbox } from "@sandbox-host/sdk";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { getUserTier, type Tier } from "@/lib/tier";

export type SandboxProvider = "vercel" | "sandbox-host";

export type SandboxHostCredentials = {
  token: string;
  teamId: string;
  projectId: string;
};

/** Both halves of the host config present — the service is usable at all. */
export function sandboxHostConfigured(): boolean {
  return Boolean(process.env.SANDBOX_API_URL && process.env.SANDBOX_HOST_TOKEN);
}

/**
 * Master switch: are NEW free-tier projects routed to sandbox-host? Requires
 * both the explicit SANDBOX_HOST_ENABLED opt-in AND a reachable host config.
 * Gates routing only — never the dispatch of already-created sandbox-host
 * projects (see the env contract note above).
 */
export function sandboxHostRoutingEnabled(): boolean {
  return process.env.SANDBOX_HOST_ENABLED === "1" && sandboxHostConfigured();
}

/**
 * Overflow switch: may a NEW free-tier project be placed on Vercel when the
 * host has no free slot? See the env contract above for why this is opt-in.
 */
export function sandboxHostOverflowEnabled(): boolean {
  return process.env.SANDBOX_HOST_OVERFLOW_TO_VERCEL === "1";
}

function hostMaxSessions(): number {
  const raw = parseInt(process.env.SANDBOX_HOST_MAX_SESSIONS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 25;
}

// The probe costs one HTTP round-trip to the host, so cache it briefly: a
// burst of signups shouldn't turn into a burst of list calls. Short enough
// that a freed slot is noticed almost immediately.
const CAPACITY_CACHE_TTL_MS = 10_000;
let capacityCache: { full: boolean; at: number } | null = null;

/**
 * True when the host has no free session slot — i.e. a create would 429 with
 * `concurrency_limit`. Mirrors the service's own accounting exactly: it counts
 * sandboxes in `running` or `pending` against the per-token `maxSessions`
 * (cmd/api/handlers.go). Note this only bounds CREATES; the host deliberately
 * lets resumes exceed the cap, so an existing project always reopens.
 *
 * Fails CLOSED (returns true) when the host can't be reached or listed: if we
 * can't confirm a slot exists, a new project shouldn't be committed to a
 * backend that may be full or down. With overflow disabled this is never
 * called, so an unreachable host cannot change existing behavior.
 */
export async function sandboxHostAtCapacity(): Promise<boolean> {
  const now = Date.now();
  if (capacityCache && now - capacityCache.at < CAPACITY_CACHE_TTL_MS) {
    return capacityCache.full;
  }

  let full: boolean;
  try {
    const creds = getSandboxHostCredentials();
    const page = await HostSandbox.list({ ...creds });
    const active = (page.sandboxes ?? []).filter(
      (s: { status?: string }) => s.status === "running" || s.status === "pending",
    ).length;
    full = active >= hostMaxSessions();
    if (full) {
      console.warn(
        `[sandbox-provider] host at capacity (${active}/${hostMaxSessions()}) — new free projects overflow to Vercel`,
      );
    }
  } catch (e) {
    console.warn(
      `[sandbox-provider] capacity probe failed; treating host as unavailable: ${e instanceof Error ? e.message : String(e)}`,
    );
    full = true;
  }

  capacityCache = { full, at: now };
  return full;
}

/**
 * Explicit credentials for every @sandbox-host/sdk call. Always passed
 * per-call (never via the SDK's SANDBOX_TOKEN/… env fallback) so there is no
 * ambient-credential ambiguity with @vercel/sandbox in the same process.
 * NB: `projectId` here is the host service's TENANT project id ("default"),
 * not a Botflow project id.
 */
export function getSandboxHostCredentials(): SandboxHostCredentials {
  const token = process.env.SANDBOX_HOST_TOKEN;
  if (!process.env.SANDBOX_API_URL || !token) {
    throw new Error(
      "sandbox-host is not configured: set SANDBOX_API_URL and SANDBOX_HOST_TOKEN " +
        "(plus optional SANDBOX_HOST_TEAM_ID / SANDBOX_HOST_PROJECT_ID).",
    );
  }
  return {
    token,
    teamId: process.env.SANDBOX_HOST_TEAM_ID || "default",
    projectId: process.env.SANDBOX_HOST_PROJECT_ID || "default",
  };
}

// Per-instance cache of projectId → provider. 'vercel' entries cache for 60s
// ('vercel' is terminal — nothing moves a project off Vercel), but
// 'sandbox-host' entries only 10s: a paid-owner promotion can flip
// host→vercel at any moment, and invalidateProviderCache only reaches the
// promoting instance — other instances must notice via TTL. The remaining
// window is closed by doAcquireSandbox's fresh re-read on a host 404.
const providerCache = new Map<string, { provider: SandboxProvider; at: number }>();
const PROVIDER_CACHE_TTL_MS = 60_000;
const HOST_PROVIDER_CACHE_TTL_MS = 10_000;

export async function getProjectSandboxProvider(
  projectId: string,
  opts: { fresh?: boolean } = {},
): Promise<SandboxProvider> {
  const hit = opts.fresh ? undefined : providerCache.get(projectId);
  if (hit) {
    const ttl =
      hit.provider === "sandbox-host" ? HOST_PROVIDER_CACHE_TTL_MS : PROVIDER_CACHE_TTL_MS;
    if (Date.now() - hit.at < ttl) return hit.provider;
  }

  const [row] = await getDb()
    .select({ sandboxProvider: projects.sandboxProvider })
    .from(projects)
    .where(eq(projects.id, projectId));

  let provider: SandboxProvider = "vercel";
  if (row?.sandboxProvider === "sandbox-host") {
    // A host-assigned project with the service unconfigured must fail loudly.
    // Falling back to Vercel here would create a second, empty sandbox and
    // split the project's files across backends.
    if (!sandboxHostConfigured()) {
      throw new Error(
        `Project ${projectId} lives on sandbox-host but SANDBOX_API_URL / ` +
          "SANDBOX_HOST_TOKEN are not set in this environment.",
      );
    }
    provider = "sandbox-host";
  }

  providerCache.set(projectId, { provider, at: Date.now() });
  return provider;
}

/** Drop the cached provider after changing projects.sandbox_provider. */
export function invalidateProviderCache(projectId: string): void {
  providerCache.delete(projectId);
}

/**
 * Backend for a project being created right now. Free-tier owners go to
 * sandbox-host when the rollout switch is on; everyone else (and any tier
 * lookup failure) stays on Vercel — misclassifying a paid user onto the
 * self-hosted box is worse than missing a free user.
 */
export async function chooseProviderForNewProject(
  userId: string,
): Promise<SandboxProvider> {
  // In-dev strict switch: surface every reason a free-tier project would fall
  // back to Vercel as a hard error instead of a silent downgrade.
  const strict = process.env.SANDBOX_HOST_STRICT === "1";

  if (!sandboxHostRoutingEnabled()) {
    if (strict) {
      throw new Error(
        "[sandbox-host strict] rollout not active: " +
          `SANDBOX_HOST_ENABLED=${process.env.SANDBOX_HOST_ENABLED ?? "unset"}, ` +
          `SANDBOX_API_URL=${process.env.SANDBOX_API_URL ? "set" : "unset"}, ` +
          `SANDBOX_HOST_TOKEN=${process.env.SANDBOX_HOST_TOKEN ? "set" : "unset"}`,
      );
    }
    return "vercel";
  }

  let tier: Tier;
  try {
    tier = await getUserTier(userId);
  } catch (e) {
    if (strict) {
      throw new Error(
        `[sandbox-host strict] tier lookup failed for ${userId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return "vercel";
  }

  if (tier !== "free") {
    // Misclassifying a paid user onto the self-hosted box is worse than missing
    // a free user, so non-strict stays on Vercel here.
    if (strict) {
      throw new Error(
        `[sandbox-host strict] user ${userId} resolved to tier '${tier}', not free`,
      );
    }
    return "vercel";
  }

  // Capacity-aware placement: only safe here, at creation, because the project
  // has no files yet — so choosing Vercel strands nothing. Once stamped, the
  // choice is permanent.
  if (sandboxHostOverflowEnabled() && (await sandboxHostAtCapacity())) {
    console.log(
      `[sandbox-provider] overflowing new free project for ${userId} to Vercel (host full/unreachable)`,
    );
    return "vercel";
  }

  return "sandbox-host";
}
