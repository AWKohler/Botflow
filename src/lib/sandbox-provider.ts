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
 */
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

// Per-instance cache of projectId → provider. The column effectively never
// changes outside the offline migration, so a short TTL only bounds staleness
// across serverless instances after a migration run.
const providerCache = new Map<string, { provider: SandboxProvider; at: number }>();
const PROVIDER_CACHE_TTL_MS = 60_000;

export async function getProjectSandboxProvider(
  projectId: string,
): Promise<SandboxProvider> {
  const hit = providerCache.get(projectId);
  if (hit && Date.now() - hit.at < PROVIDER_CACHE_TTL_MS) return hit.provider;

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

  return "sandbox-host";
}
