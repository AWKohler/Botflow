/**
 * DB-aware MuhKoo provisioning orchestration.
 *
 * Bridges the pure API client (`muhkoo-platform.ts`) and the `projects` table:
 * provisions a MuhKoo app under the platform account and persists its creds.
 * The MuhKoo analogue of the auto-provision block in the Convex deploy route.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import {
  provisionMuhkooBackend,
  putMuhkooTable,
  createMuhkooAccessToken,
  revokeMuhkooAccessToken,
  describeMuhkooTables,
  type MuhkooTableSpec,
  type MuhkooTableSchema,
} from "@/lib/muhkoo-platform";

/**
 * The starter template (vite_muhkoo_template) ships with a generic `items`
 * board wired to this table, so we provision it at creation to make the app
 * work out of the box. The agent can add/reshape tables later via the MuhKoo
 * API. Keep in sync with the template's src/appConfig.ts TABLE.
 */
const DEFAULT_MUHKOO_TABLE: MuhkooTableSpec = {
  table: "items",
  columns: [
    { name: "title", type: "text" },
    { name: "done", type: "boolean" },
    { name: "created_at", type: "text" },
  ],
};

export interface EnsureMuhkooResult {
  /** true if we provisioned just now; false if it was already provisioned. */
  provisioned: boolean;
  appId: string | null;
  slug: string | null;
  hostingUrl: string | null;
}

/**
 * Ensure a MuhKoo project has a provisioned backend. Idempotent: returns early
 * if the project already has a `muhkooAppId`. Otherwise provisions a MuhKoo app
 * and stores appId/slug/keys/hostingUrl on the project row.
 *
 * Note: like the Convex deploy route, the re-read here narrows but does not
 * fully close the concurrent-provision window — a per-project lock would.
 */
export async function ensureMuhkooProvisioned(
  projectId: string,
): Promise<EnsureMuhkooResult> {
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw new Error("Project not found");

  if (project.backendType !== "muhkoo") {
    return { provisioned: false, appId: null, slug: null, hostingUrl: null };
  }
  if (project.muhkooAppId) {
    return {
      provisioned: false,
      appId: project.muhkooAppId,
      slug: project.muhkooSlug,
      hostingUrl: project.muhkooHostingUrl,
    };
  }

  const app = await provisionMuhkooBackend({
    projectId: project.id,
    projectName: project.name,
    allowedOrigins: "*",
  });

  await db
    .update(projects)
    .set({
      muhkooAppId: app.appId,
      muhkooSlug: app.slug,
      muhkooPublishableKey: app.publishableKey,
      muhkooSecretKey: app.secretKey,
      muhkooHostingUrl: app.hostingUrl,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, projectId));

  // Provision the starter's default table so the template works immediately.
  // Best-effort: a table hiccup shouldn't block the app from being usable.
  try {
    await putMuhkooTable(app.appId, DEFAULT_MUHKOO_TABLE);
    await recordMuhkooTableSchema(projectId, DEFAULT_MUHKOO_TABLE);
  } catch (e) {
    console.warn("[muhkoo] default table provisioning failed (non-fatal):", e);
  }

  // Mint the scoped read/write credential the agent's table tools use.
  // Best-effort: the app is fully usable without it (only agent reads degrade).
  await ensureMuhkooAccessToken(projectId).catch((e) =>
    console.warn("[muhkoo] access-token minting failed (non-fatal):", e),
  );

  return {
    provisioned: true,
    appId: app.appId,
    slug: app.slug,
    hostingUrl: app.hostingUrl,
  };
}

/** Access-token lifetime requested at mint. Verified honored (not capped). */
const ACCESS_TOKEN_DAYS = 365;

/**
 * Renew this far ahead of expiry. Re-minting itself needs a live DEVELOPER
 * session, so the window wants to be generous: the wider it is, the more
 * chances a renewal has to land while that session happens to be healthy.
 */
const RENEWAL_MARGIN_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Ensure the project has a usable MuhKoo access token, minting or renewing it.
 *
 * Separate from provisioning so it also HEALS projects created before access
 * tokens existed — callers can invoke it lazily right before a data-plane read.
 * Note the heal path depends on the developer session, the very credential the
 * access token exists to be independent of; the mint that matters is the eager
 * one at provision time, when that session is definitionally alive.
 *
 * Re-mints when the token is missing, within `RENEWAL_MARGIN_MS` of expiry, or
 * `force`d (used after the data plane rejects a token — expired and revoked are
 * indistinguishable there, so the caller just forces a fresh one and retries).
 *
 * Scoped to `db:read` + `db:write` and long-lived on purpose: it must outlive
 * the roughly-daily developer session so agent table reads keep working.
 * Server-only — never injected into the sandbox.
 */
export async function ensureMuhkooAccessToken(
  projectId: string,
  opts: { force?: boolean } = {},
): Promise<string | null> {
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project || project.backendType !== "muhkoo" || !project.muhkooAppId) {
    return null;
  }

  const expiresAt = project.muhkooAccessTokenExpiresAt;
  const expiringSoon =
    typeof expiresAt === "number" && expiresAt - Date.now() < RENEWAL_MARGIN_MS;
  if (project.muhkooAccessToken && !opts.force && !expiringSoon) {
    return project.muhkooAccessToken;
  }

  const previousKeyId = project.muhkooAccessTokenKeyId;
  const token = await createMuhkooAccessToken(project.muhkooAppId, {
    scopes: ["db:read", "db:write"],
    env: "test",
    expiresInDays: ACCESS_TOKEN_DAYS,
    label: `botflow-${project.id.slice(0, 8)}`,
  });

  await db
    .update(projects)
    .set({
      muhkooAccessToken: token.plaintext,
      muhkooAccessTokenKeyId: token.keyId ?? null,
      muhkooAccessTokenExpiresAt: token.expiresAt ?? null,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, projectId));

  // Retire the one we replaced. Best-effort: the new token is already stored
  // and working, so a failed revoke should not fail the read that triggered it.
  if (previousKeyId) {
    await revokeMuhkooAccessToken(project.muhkooAppId, previousKeyId).catch((e) =>
      console.warn("[muhkoo] revoking the superseded access token failed:", e),
    );
  }

  return token.plaintext;
}

// ────────────────────────────────────────────────────────────────────────────
// Schema cache
//
// Table schema lives on the MANAGEMENT plane, and access-token scopes cover
// only the data plane (db/kv/storage/messages/functions/ai) — there is no
// schema scope. So `list_muhkoo_tables` cannot be made independent of the
// developer session the way row reads can, and that session lapses roughly
// daily. We keep a last-known-good copy so the agent still has an answer while
// it is down: degraded to "as of <time>" instead of nothing at all.
//
// Fidelity is layered. A live response is written through verbatim (it carries
// `nullable` and `version`, which we never send ourselves); the provision spec
// is only a backstop for tables that have never been listed live.
// ────────────────────────────────────────────────────────────────────────────

interface MuhkooSchemaCache {
  tables: MuhkooTableSchema[];
  cachedAt: number;
}

function readSchemaCache(raw: unknown): MuhkooSchemaCache | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Partial<MuhkooSchemaCache>;
  if (!Array.isArray(c.tables) || typeof c.cachedAt !== "number") return null;
  return { tables: c.tables, cachedAt: c.cachedAt };
}

async function writeSchemaCache(
  projectId: string,
  tables: MuhkooTableSchema[],
): Promise<void> {
  const db = getDb();
  await db
    .update(projects)
    .set({
      muhkooSchemaCache: { tables, cachedAt: Date.now() } satisfies MuhkooSchemaCache,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, projectId));
}

/**
 * Record a table we just created or altered — the lower-fidelity backstop.
 *
 * Merges by table name so an additive change replaces that table's entry and
 * leaves the rest alone. Best-effort: never let a cache write fail the
 * provisioning call that triggered it.
 */
export async function recordMuhkooTableSchema(
  projectId: string,
  spec: MuhkooTableSpec,
): Promise<void> {
  try {
    const db = getDb();
    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) return;

    const existing = readSchemaCache(project.muhkooSchemaCache)?.tables ?? [];
    const entry: MuhkooTableSchema = {
      table: spec.table,
      columns: (spec.columns ?? []).map((c) => ({ name: c.name, type: c.type })),
    };
    await writeSchemaCache(projectId, [
      ...existing.filter((t) => t.table !== spec.table),
      entry,
    ]);
  } catch (e) {
    console.warn("[muhkoo] schema cache write failed (non-fatal):", e);
  }
}

export interface MuhkooSchemaResult {
  ok: boolean;
  tables?: MuhkooTableSchema[];
  /** True when served from cache because the live call failed. */
  stale?: boolean;
  /** When the cached copy was captured (Unix ms), present only when stale. */
  cachedAt?: number;
  error?: string;
}

/**
 * The project's table schema: live when we can get it, last-known-good when we
 * cannot.
 *
 * A successful live call is written through to the cache, so the cached copy
 * converges on full fidelity after the first successful listing.
 */
export async function getMuhkooSchema(
  projectId: string,
): Promise<MuhkooSchemaResult> {
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project || project.backendType !== "muhkoo") {
    return { ok: false, error: "This project does not use a MuhKoo backend." };
  }
  if (!project.muhkooAppId) {
    return { ok: false, error: "MuhKoo backend is not provisioned for this project yet." };
  }

  const live = await describeMuhkooTables(project.muhkooAppId);
  if (live.ok) {
    await writeSchemaCache(projectId, live.tables).catch(() => {});
    return { ok: true, tables: live.tables };
  }

  const cache = readSchemaCache(project.muhkooSchemaCache);
  if (cache) {
    return { ok: true, tables: cache.tables, stale: true, cachedAt: cache.cachedAt };
  }
  return { ok: false, error: live.error };
}

/**
 * Run a data-plane operation with the project's access token, renewing once if
 * the token is rejected.
 *
 * Every data-plane call needs the same three steps — fetch the token, run, and
 * on a rejected key force a fresh token and try again — so they live here once
 * rather than at each tool site. The retry is capped at exactly one: the data
 * plane returns the same 401 for an expired key, a revoked key and a malformed
 * one, so a permanently bad credential is indistinguishable from a stale one
 * and would otherwise loop forever.
 */
export async function withMuhkooAccessToken<
  T extends { ok: boolean; authFailed?: boolean },
>(
  projectId: string,
  run: (accessToken: string) => Promise<T>,
): Promise<T | { ok: false; error: string }> {
  return runWithTokenRetry(
    (force) => ensureMuhkooAccessToken(projectId, force ? { force: true } : {}),
    run,
  );
}

/**
 * The token-retry policy itself, with the database dependency injected.
 *
 * Split out from `withMuhkooAccessToken` so the "exactly once" guarantee can be
 * tested without a database or a live MuhKoo app — that bound is the whole
 * point of this function, since the data plane cannot distinguish a stale
 * credential from a permanently broken one.
 */
export async function runWithTokenRetry<
  T extends { ok: boolean; authFailed?: boolean },
>(
  getToken: (force: boolean) => Promise<string | null>,
  run: (accessToken: string) => Promise<T>,
): Promise<T | { ok: false; error: string }> {
  let accessToken: string | null;
  try {
    accessToken = await getToken(false);
  } catch (e) {
    return {
      ok: false,
      error: `Could not obtain a MuhKoo access token: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
  if (!accessToken) {
    return { ok: false, error: "MuhKoo backend is not provisioned for this project yet." };
  }

  const first = await run(accessToken);
  if (first.ok || !first.authFailed) return first;

  const renewed = await getToken(true).catch(() => null);
  if (!renewed) return first;
  // Whatever this returns is final — no third attempt.
  return await run(renewed);
}
