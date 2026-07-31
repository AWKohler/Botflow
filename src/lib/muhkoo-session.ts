/**
 * The MuhKoo platform developer session — read, refresh, and health-check.
 *
 * Every MuhKoo MANAGEMENT-plane call (create app, create/alter table, list
 * schema, mint an access token) authenticates with a single platform-wide
 * developer session token. MuhKoo expires it roughly daily and offers no
 * server-side refresh: re-minting means an interactive browser login
 * (`muhkoo login --web`, loopback PKCE). There is also no session-introspection
 * endpoint — `/api/auth/session` and friends 404 — so the only way to know the
 * session is dead is to call `/api/developer/me` and see a 401.
 *
 * That makes the refresh a routine, roughly-daily operator task. Keeping the
 * token in an env var meant every refresh needed a Vercel env edit plus a
 * redeploy; storing it here makes `pnpm muhkoo:auth` a single command that
 * refreshes local and production at once (they share the same database).
 *
 * Precedence: `platform_secrets` row → `MUHKOO_DEV_TOKEN` env var. The env
 * fallback keeps existing deployments (and CI) working untouched.
 *
 * Stored envelope-encrypted (src/lib/secrets.ts). Note this does move a bearer
 * credential from the Vercel env into the database: anyone with database access
 * AND the encryption key can use it, where before it was Vercel-dashboard
 * access. Encrypted-at-rest is the better of the two, but it is a real change
 * in where the credential lives.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { platformSecrets } from "@/db/schema";
import { encryptSecret, decryptSecret } from "@/lib/secrets";

/** `platform_secrets.key` holding the developer session token. */
export const MUHKOO_DEV_TOKEN_KEY = "muhkoo_dev_token";

/**
 * In-process cache. Management calls come in bursts (provision → default table
 * → mint token), and re-reading the row for each would add a DB round-trip to
 * every one. Short enough that a `pnpm muhkoo:auth` refresh takes effect within
 * a minute on already-warm lambdas.
 */
const CACHE_TTL_MS = 60_000;
let cached: { token: string; at: number } | null = null;

/** Drop the cached token (called after a refresh writes a new one). */
export function invalidateMuhkooDevTokenCache(): void {
  cached = null;
}

/**
 * The current developer session token: database first, env var as fallback.
 *
 * Throws when neither is available — the same failure mode as the old env-only
 * lookup, with a message pointing at the refresh command.
 */
export async function getMuhkooDevToken(): Promise<string> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.token;

  let fromDb: string | null = null;
  try {
    const db = getDb();
    const [row] = await db
      .select()
      .from(platformSecrets)
      .where(eq(platformSecrets.key, MUHKOO_DEV_TOKEN_KEY))
      .limit(1);
    if (row?.value) fromDb = decryptSecret(row.value);
  } catch (e) {
    // A DB hiccup must not take out MuhKoo entirely when the env var is set.
    console.warn("[muhkoo] platform_secrets read failed, falling back to env:", e);
  }

  const token = fromDb || process.env.MUHKOO_DEV_TOKEN || null;
  if (!token) {
    throw new Error(
      "No MuhKoo developer session is available. Refresh it with `pnpm muhkoo:auth` " +
        "(or set MUHKOO_DEV_TOKEN).",
    );
  }
  cached = { token, at: Date.now() };
  return token;
}

/** Store a refreshed session token, replacing whatever is there. */
export async function setMuhkooDevToken(
  token: string,
  updatedBy?: string,
): Promise<void> {
  const db = getDb();
  await db
    .insert(platformSecrets)
    .values({
      key: MUHKOO_DEV_TOKEN_KEY,
      value: encryptSecret(token),
      updatedBy: updatedBy ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: platformSecrets.key,
      set: {
        value: encryptSecret(token),
        updatedBy: updatedBy ?? null,
        updatedAt: new Date(),
      },
    });
  invalidateMuhkooDevTokenCache();
}

export interface MuhkooSessionHealth {
  ok: boolean;
  status: number;
  /** Where the token came from, for operator diagnostics. */
  source: "database" | "env" | "none";
  updatedAt?: Date | null;
  developer?: { email?: string; tier?: string; needsBootstrap?: boolean };
  error?: string;
}

/**
 * Is the developer session alive right now?
 *
 * `/api/developer/me` is the only probe available — MuhKoo exposes no session
 * introspection, so we cannot report time-to-expiry, only alive/dead.
 */
export async function checkMuhkooSession(): Promise<MuhkooSessionHealth> {
  let source: MuhkooSessionHealth["source"] = "none";
  let updatedAt: Date | null = null;
  let token: string;

  try {
    const db = getDb();
    const [row] = await db
      .select()
      .from(platformSecrets)
      .where(eq(platformSecrets.key, MUHKOO_DEV_TOKEN_KEY))
      .limit(1);
    if (row?.value) {
      source = "database";
      updatedAt = row.updatedAt;
    } else if (process.env.MUHKOO_DEV_TOKEN) {
      source = "env";
    }
  } catch {
    if (process.env.MUHKOO_DEV_TOKEN) source = "env";
  }

  try {
    token = await getMuhkooDevToken();
  } catch (e) {
    return {
      ok: false,
      status: 0,
      source: "none",
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const base = (process.env.MUHKOO_API_BASE || "https://api.muhkoo.dev").replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/api/developer/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        source,
        updatedAt,
        error:
          res.status === 401
            ? "The MuhKoo developer session has expired. Run `pnpm muhkoo:auth` to refresh it."
            : `MuhKoo developer check failed (status ${res.status}).`,
      };
    }
    const body = (await res.json().catch(() => null)) as {
      email?: string;
      tier?: string;
      needsBootstrap?: boolean;
    } | null;
    return {
      ok: true,
      status: res.status,
      source,
      updatedAt,
      developer: {
        email: body?.email,
        tier: body?.tier,
        needsBootstrap: body?.needsBootstrap,
      },
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      source,
      updatedAt,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
