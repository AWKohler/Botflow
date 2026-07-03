/**
 * Codex (ChatGPT-plan) OAuth helpers — refresh + access-token resolution.
 *
 * Shared by /api/agent (direct Codex-backend API calls) and /api/agent/opencode
 * (OpenCode subprocess path). Both paths need a valid access token, just used
 * differently:
 *  - /api/agent: as the Authorization bearer on chatgpt.com backend calls
 *  - /api/agent/opencode: written into ~/.local/share/opencode/auth.json inside
 *    the sandbox, then used by the opencode binary itself
 *
 * The client id is OpenAI's public Codex client — the same one OpenCode's
 * native ChatGPT-plan auth uses, which is what makes our stored tokens
 * drop-in compatible with OpenCode's auth.json.
 */
import { setUserCredentials } from "@/lib/user-credentials";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";

export interface CodexOAuthCreds {
  codexOAuthAccessToken: string | null;
  codexOAuthRefreshToken: string | null;
  codexOAuthExpiresAt: number | null;
}

/**
 * Refresh the user's Codex OAuth access token using the stored refresh token.
 * On success: persists the new tokens back to Clerk metadata + returns the new
 * access token. On failure: returns null (caller decides whether to fall back
 * to a BYOK OpenAI key or surface an auth error).
 */
export async function refreshCodexOAuthToken(
  creds: Pick<CodexOAuthCreds, "codexOAuthRefreshToken">,
  userId: string,
): Promise<string | null> {
  if (!creds.codexOAuthRefreshToken) return null;

  try {
    const refreshRes = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: creds.codexOAuthRefreshToken,
        client_id: CLIENT_ID,
      }).toString(),
    });

    if (!refreshRes.ok) return null;

    const refreshed = (await refreshRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const newExpiresAt = refreshed.expires_in
      ? Date.now() + refreshed.expires_in * 1000 - 5 * 60 * 1000
      : null;

    await setUserCredentials(userId, {
      codexOAuthAccessToken: refreshed.access_token,
      codexOAuthRefreshToken: refreshed.refresh_token ?? creds.codexOAuthRefreshToken,
      codexOAuthExpiresAt: newExpiresAt,
    });

    return refreshed.access_token;
  } catch {
    return null;
  }
}

/**
 * Returns a usable Codex OAuth access token for `userId`, refreshing it
 * proactively if it's within 5 minutes of expiry. Returns null when the user
 * has no Codex OAuth credentials at all or the refresh fails.
 *
 * The proactive refresh matters most on the OpenCode path: the token is
 * written into the sandbox at turn start and must survive the whole turn, so
 * we never hand the bridge a token that's about to lapse.
 */
export async function getFreshCodexAccessToken(
  creds: CodexOAuthCreds,
  userId: string,
): Promise<string | null> {
  if (!creds.codexOAuthAccessToken) return null;

  const expiresAt = creds.codexOAuthExpiresAt ?? 0;
  const needsRefresh = expiresAt > 0 && expiresAt < Date.now() + 5 * 60 * 1000;

  if (!needsRefresh) return creds.codexOAuthAccessToken;

  const refreshed = await refreshCodexOAuthToken(creds, userId);
  return refreshed ?? creds.codexOAuthAccessToken;
}
