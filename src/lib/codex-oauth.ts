/**
 * Codex (ChatGPT-plan) OAuth helpers — refresh + access-token resolution.
 *
 * Used by /api/agent/opencode (OpenCode subprocess path) and the LLM proxy.
 * OpenCode writes the access token into ~/.local/share/opencode/auth.json
 * inside the sandbox, where the opencode binary uses it directly (the one
 * credential the proxy doesn't front).
 *
 * The client id is OpenAI's public Codex client — the same one OpenCode's
 * native ChatGPT-plan auth uses, which is what makes our stored tokens
 * drop-in compatible with OpenCode's auth.json.
 */
import {
  getUserCredentials,
  invalidateCredentialsCache,
  setUserCredentials,
} from "@/lib/user-credentials";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";

export interface CodexOAuthCreds {
  codexOAuthAccessToken: string | null;
  codexOAuthRefreshToken: string | null;
  codexOAuthExpiresAt: number | null;
}

/** A complete, usable Codex credential set — always written to the sandbox
 *  TOGETHER. Mixing a fresh access token with a pre-rotation refresh token
 *  (or a stale expiry) makes OpenCode "refresh" with a dead token → 401. */
export interface FreshCodexCreds {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms; null when the provider didn't say. */
  expiresAt: number | null;
}

type RefreshOutcome =
  | { kind: "refreshed"; creds: FreshCodexCreds }
  /** OpenAI refused this refresh token: expired, revoked, or already rotated. */
  | { kind: "rejected" }
  /** No verdict on the token (network error, 429, 5xx): it may still be good. */
  | { kind: "transient" };

/**
 * Refresh the user's Codex OAuth tokens using the stored refresh token. OpenAI
 * ROTATES the refresh token: the old one is dead after a successful call, so
 * the new set must reach the caller even if persisting it fails.
 */
async function refreshCodexOAuthToken(
  refreshToken: string,
  userId: string,
): Promise<RefreshOutcome> {
  let refreshRes: Response;
  try {
    refreshRes = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    console.error("Codex token refresh unreachable:", e);
    return { kind: "transient" };
  }

  if (!refreshRes.ok) {
    // The error code is safe to log and is what tells these failures apart
    // (refresh_token_reused vs refresh_token_expired vs ...).
    const body = (await refreshRes.json().catch(() => null)) as {
      error?: { code?: string } | string;
    } | null;
    const code = typeof body?.error === "string" ? body.error : body?.error?.code;
    console.error("Codex token refresh failed:", refreshRes.status, code ?? "unknown");
    return refreshRes.status === 429 || refreshRes.status >= 500
      ? { kind: "transient" }
      : { kind: "rejected" };
  }

  let refreshed: { access_token: string; refresh_token?: string; expires_in?: number };
  try {
    refreshed = await refreshRes.json();
  } catch (e) {
    console.error("Codex token refresh returned an unreadable body:", e);
    return { kind: "transient" };
  }

  const fresh: FreshCodexCreds = {
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? refreshToken,
    expiresAt: refreshed.expires_in
      ? Date.now() + refreshed.expires_in * 1000 - 5 * 60 * 1000
      : null,
  };
  try {
    await setUserCredentials(userId, {
      codexOAuthAccessToken: fresh.accessToken,
      codexOAuthRefreshToken: fresh.refreshToken,
      codexOAuthExpiresAt: fresh.expiresAt,
    });
  } catch (e) {
    // The old pair is already dead. The turn still gets the new one, and the
    // next turn adopts it from the sandbox (shouldAdoptSandboxCodexAuth).
    console.error("Codex token refresh could not be persisted:", e);
  }
  return { kind: "refreshed", creds: fresh };
}

/** True when the stored token is (nearly) expired and must be refreshed. */
export function codexNeedsRefresh(expiresAt: number | null, now = Date.now()): boolean {
  const at = expiresAt ?? 0;
  return at > 0 && at < now + 5 * 60 * 1000;
}

/**
 * The user's Codex credentials, refreshed proactively when within 5 minutes
 * of expiry. Returns the COMPLETE set to write into the sandbox — never a
 * fresh access token paired with the pre-rotation refresh token.
 *
 * Returns null only when the user must reconnect ChatGPT: no credentials, or
 * OpenAI rejected the refresh token and no newer set is stored. An outage
 * returns the existing set unchanged, because its refresh token is still good
 * and OpenCode refreshes for itself once the token really expires.
 *
 * The proactive refresh matters on the OpenCode path: the set is written into
 * the sandbox at turn start and must survive the whole turn.
 */
export async function getFreshCodexCredentials(
  creds: CodexOAuthCreds,
  userId: string,
): Promise<FreshCodexCreds | null> {
  if (!creds.codexOAuthAccessToken) return null;
  const current: FreshCodexCreds = {
    accessToken: creds.codexOAuthAccessToken,
    refreshToken: creds.codexOAuthRefreshToken,
    expiresAt: creds.codexOAuthExpiresAt,
  };
  if (!codexNeedsRefresh(creds.codexOAuthExpiresAt)) return current;
  if (!creds.codexOAuthRefreshToken) return null;

  const outcome = await refreshCodexOAuthToken(creds.codexOAuthRefreshToken, userId);
  if (outcome.kind === "refreshed") return outcome.creds;
  if (outcome.kind === "transient") return current;

  // Rejected. A concurrent turn (another thread or project) may have just
  // rotated this same token, which makes the rejection expected: use its set.
  await invalidateCredentialsCache(userId);
  const stored = await getUserCredentials(userId);
  if (
    stored.codexOAuthAccessToken &&
    stored.codexOAuthRefreshToken &&
    stored.codexOAuthRefreshToken !== creds.codexOAuthRefreshToken &&
    !codexNeedsRefresh(stored.codexOAuthExpiresAt)
  ) {
    return {
      accessToken: stored.codexOAuthAccessToken,
      refreshToken: stored.codexOAuthRefreshToken,
      expiresAt: stored.codexOAuthExpiresAt,
    };
  }
  return null;
}

/**
 * Should a Codex credential pair found in the sandbox's OpenCode auth.json
 * replace the stored one? Only when it is NEWER — i.e. OpenCode refreshed
 * mid-turn and the route that would have persisted the rotation died. Never
 * when the stored pair is newer (a fresh sign-in, or our own server-side
 * refresh): adopting the sandbox's older pair would overwrite good tokens
 * with already-rotated, dead ones on every turn.
 */
export function shouldAdoptSandboxCodexAuth(
  sandbox: { access?: string; refresh?: string; expires?: number } | null | undefined,
  stored: { refreshToken: string | null; expiresAt: number | null },
): boolean {
  if (!sandbox?.access || !sandbox.refresh) return false;
  if (sandbox.refresh === stored.refreshToken) return false;
  return (sandbox.expires ?? 0) > (stored.expiresAt ?? 0);
}
