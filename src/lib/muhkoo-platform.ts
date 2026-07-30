/**
 * MuhKoo Platform API client.
 *
 * MuhKoo is an edge Backend-as-a-Service (https://docs.muhkoo.dev). Unlike
 * Convex — where we run the CLI in a Fly worker — MuhKoo's management API is a
 * thin bearer-token REST surface (the `@muhkoo/cli` is just an HTTP client), so
 * we provision every backend directly from the Next.js server. Only the initial
 * developer login needs MuhKoo's zero-knowledge prover; everything below is
 * plain REST authenticated with a single platform developer session token.
 *
 * Platform-owned ONLY — there is no bring-your-own MuhKoo. Every user's app is
 * created under our developer account (MUHKOO_DEV_TOKEN). That token and the
 * per-app SECRET keys are server-side secrets and NEVER reach the user sandbox;
 * only the publishable key (mk_*_pk_*) is browser-safe.
 *
 * Auth surfaces (mirrors @muhkoo/cli src/lib/http.js):
 *   - management  → Authorization: Bearer <MUHKOO_DEV_TOKEN>
 *   - hosting     → Authorization: Bearer <app secret key mk_*_sk_*>
 */

const DEFAULT_API_BASE = "https://api.muhkoo.dev";

/** The MuhKoo management API base (prod by default; override for staging/local). */
export function muhkooApiBase(): string {
  return (process.env.MUHKOO_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
}

function muhkooDevToken(): string {
  const token = process.env.MUHKOO_DEV_TOKEN;
  if (!token) {
    throw new Error(
      "MUHKOO_DEV_TOKEN is not set. Mint one with `muhkoo login --web` and store " +
        "it as a platform secret before provisioning MuhKoo backends.",
    );
  }
  return token;
}

/** The public hosting host suffix for an API base (apps.* / apps.staging.*). */
function appsSuffixFor(base: string): string {
  return base.includes("staging") ? "apps.staging.muhkoo.dev" : "apps.muhkoo.dev";
}

/** `https://<slug>.apps.muhkoo.dev` — where a provisioned app is hosted. */
export function muhkooHostingUrl(slug: string): string {
  return `https://${slug}.${appsSuffixFor(muhkooApiBase())}`;
}

export interface MuhkooAppKey {
  env: "test" | "live";
  type: "pk" | "sk";
  plaintext?: string;
  keyId?: string;
}

/** A DB table definition applied at provision time (PUT .../db/tables/:table). */
export interface MuhkooTableSpec {
  table: string;
  columns?: Array<{ name: string; type: string; [k: string]: unknown }>;
  primaryKey?: string;
  indexes?: unknown[];
  [k: string]: unknown;
}

interface DevResult<T = unknown> {
  ok: boolean;
  status: number;
  body: T | null;
}

/** A management call authenticated with the platform developer session token. */
async function devCall<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<DevResult<T>> {
  const res = await fetch(muhkooApiBase() + path, {
    method,
    headers: {
      Authorization: `Bearer ${muhkooDevToken()}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Read the body defensively; NEVER log it — create-app responses carry the
  // app's secret keys, and error bodies can echo the request payload.
  const text = await res.text();
  let parsed: T | null = null;
  try {
    parsed = text ? (JSON.parse(text) as T) : null;
  } catch {
    parsed = text as unknown as T;
  }
  console.log(`[MuhKoo API] ${method} ${path} -> ${res.status}`);
  return { ok: res.ok, status: res.status, body: parsed };
}

/**
 * Ensure our platform developer account is bootstrapped. A fresh account
 * returns `needsBootstrap: true` from /api/developer/me and must be bootstrapped
 * once with a billing email before it can create apps.
 */
async function ensureDeveloper(): Promise<void> {
  const me = await devCall<{ needsBootstrap?: boolean }>("GET", "/api/developer/me");
  if (me.status === 401) {
    throw new Error(
      "MUHKOO_DEV_TOKEN is invalid or expired — re-mint it with `muhkoo login --web`.",
    );
  }
  if (me.ok && !me.body?.needsBootstrap) return;

  const email = process.env.MUHKOO_DEVELOPER_EMAIL;
  if (!email) {
    throw new Error(
      "MuhKoo developer account needs bootstrapping — set MUHKOO_DEVELOPER_EMAIL.",
    );
  }
  const r = await devCall("POST", "/api/developer/bootstrap", { email });
  if (!r.ok) {
    throw new Error(`MuhKoo developer bootstrap failed (status ${r.status}).`);
  }
}

/**
 * A DNS-safe, deterministic slug for a project (stable across retries).
 * MuhKoo slugs become subdomains and are capped at 32 chars (3-32, lowercase
 * + dashes) — base(≤22) + "-" + projectId suffix(8) stays within that.
 */
export function deriveMuhkooSlug(projectName: string, projectId: string): string {
  const base =
    (projectName || "app")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 22)
      .replace(/-+$/, "") || "app";
  const suffix = projectId.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
  return `${base}-${suffix}`.slice(0, 32);
}

/** Whether a hosting slug is free. */
export async function isMuhkooSlugAvailable(slug: string): Promise<boolean> {
  const r = await devCall<{ available?: boolean }>(
    "GET",
    `/api/apps/slug-available?slug=${encodeURIComponent(slug)}`,
  );
  return r.ok ? Boolean(r.body?.available) : false;
}

export interface ProvisionedMuhkooApp {
  appId: string;
  slug: string;
  /** Test publishable key (mk_test_pk_*) — browser-safe, injected as VITE_MUHKOO_KEY. */
  publishableKey: string;
  /** Test secret key (mk_test_sk_*) — hosting deploy key, SERVER-ONLY. */
  secretKey: string;
  hostingUrl: string;
  /** The API base clients talk to (VITE_WORKER_URL). */
  apiBase: string;
}

/**
 * Provision a new MuhKoo backend (app) for a project. Idempotent by slug: if the
 * deterministic slug already exists we surface a clear error so the caller can
 * fall back to its stored appId instead of duplicating.
 *
 * This is the MuhKoo analogue of `provisionConvexBackend`.
 */
export async function provisionMuhkooBackend(opts: {
  projectId: string;
  projectName: string;
  allowedOrigins?: string;
}): Promise<ProvisionedMuhkooApp> {
  await ensureDeveloper();

  const slug = deriveMuhkooSlug(opts.projectName, opts.projectId);
  const r = await devCall<{ appId: string; slug?: string; keys?: MuhkooAppKey[] }>(
    "POST",
    "/api/apps",
    { slug, allowedOrigins: opts.allowedOrigins ?? "*" },
  );
  if (!r.ok) {
    // 402 → account needs a paid plan / billing email; 409 → slug taken.
    const hint =
      r.status === 402
        ? " (the platform MuhKoo account needs billing set up)"
        : r.status === 409
          ? " (slug already exists — reuse the stored appId)"
          : "";
    throw new Error(`MuhKoo create app failed (status ${r.status})${hint}.`);
  }

  const appId = r.body?.appId;
  const keys = r.body?.keys ?? [];
  const publishableKey = keys.find((k) => k.env === "test" && k.type === "pk")?.plaintext;
  const secretKey = keys.find((k) => k.env === "test" && k.type === "sk")?.plaintext;
  if (!appId || !publishableKey || !secretKey) {
    throw new Error("MuhKoo create app did not return an appId and test keys.");
  }

  const resolvedSlug = r.body?.slug ?? slug;
  return {
    appId,
    slug: resolvedSlug,
    publishableKey,
    secretKey,
    hostingUrl: muhkooHostingUrl(resolvedSlug),
    apiBase: muhkooApiBase(),
  };
}

/**
 * Create or update a database table on a provisioned app (additive; destructive
 * column changes are rejected by MuhKoo with 409). Used when the agent designs a
 * schema for a MuhKoo project.
 */
export async function putMuhkooTable(
  appId: string,
  spec: MuhkooTableSpec,
): Promise<void> {
  const r = await devCall(
    "PUT",
    `/api/apps/${appId}/db/tables/${encodeURIComponent(spec.table)}`,
    spec,
  );
  if (!r.ok) {
    throw new Error(`MuhKoo table "${spec.table}" failed (status ${r.status}).`);
  }
}

/** List a provisioned app's tables. */
export async function listMuhkooTables(appId: string): Promise<string[]> {
  const r = await devCall<{ tables?: Array<{ table?: string; name?: string }> }>(
    "GET",
    `/api/apps/${appId}/db/tables`,
  );
  if (!r.ok) return [];
  return (r.body?.tables ?? [])
    .map((t) => t.table ?? t.name)
    .filter((n): n is string => Boolean(n));
}

/** Delete a MuhKoo app and revoke its keys (called when a project is deleted). */
export async function deleteMuhkooApp(appId: string): Promise<void> {
  const r = await devCall("DELETE", `/api/apps/${appId}`);
  // Treat "already gone" as success so project deletion is idempotent.
  if (!r.ok && r.status !== 404) {
    throw new Error(`MuhKoo delete app failed (status ${r.status}).`);
  }
}
