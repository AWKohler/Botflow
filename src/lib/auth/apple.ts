/**
 * Sign in with Apple for Botflow's own accounts (not users' generated apps).
 *
 * Two Apple client IDs can be in play, both signed for with the same .p8 key:
 *
 *   - the Services ID (`AUTH_APPLE_SERVICE_ID`), used by the website's
 *     "Continue with Apple" redirect flow;
 *   - the iOS app's bundle ID (`AUTH_APPLE_BUNDLE_ID`, default io.botflow.app),
 *     the audience of identity tokens from the app's native Apple button.
 *
 * Apple's "client secret" is a short-lived ES256 JWT, not a fixed string, so it
 * is minted here from the key rather than stored.
 *
 * Apple also requires apps that offer the button to revoke the user's Apple
 * tokens when they delete their account (App Review Guideline 5.1.1(v)); see
 * `revokeAppleTokens`.
 */
import { signEs256Jwt } from "@/lib/asc-jwt";

export const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
/** Apple accepts client secrets for at most six months. */
const SECRET_TTL_SECONDS = 150 * 24 * 60 * 60;
/** Mint a fresh one well before the old one lapses on a long-lived server. */
const SECRET_REFRESH_SECONDS = 7 * 24 * 60 * 60;

export interface AppleConfig {
  teamId: string;
  keyId: string;
  privateKey: string;
  /** Services ID for the web flow; null when only the iOS app is set up. */
  serviceId: string | null;
  bundleId: string;
}

/** The Apple settings, or null when Sign in with Apple is not configured. */
export function appleConfig(): AppleConfig | null {
  const teamId = process.env.AUTH_APPLE_TEAM_ID?.trim();
  const keyId = process.env.AUTH_APPLE_KEY_ID?.trim();
  // Env stores often flatten newlines in a pasted PEM to a literal "\n".
  const privateKey = process.env.AUTH_APPLE_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (!teamId || !keyId || !privateKey) return null;
  return {
    teamId,
    keyId,
    privateKey,
    serviceId: process.env.AUTH_APPLE_SERVICE_ID?.trim() || null,
    bundleId: process.env.AUTH_APPLE_BUNDLE_ID?.trim() || "io.botflow.app",
  };
}

const secretCache = new Map<string, { secret: string; expiresAt: number }>();

/** The client secret Apple expects for `clientId` (the Services ID or the bundle ID). */
export function appleClientSecret(config: AppleConfig, clientId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const cacheKey = `${config.teamId}:${config.keyId}:${clientId}`;
  const cached = secretCache.get(cacheKey);
  if (cached && cached.expiresAt - now > SECRET_REFRESH_SECONDS) return cached.secret;
  const expiresAt = now + SECRET_TTL_SECONDS;
  const secret = signEs256Jwt({
    p8: config.privateKey,
    keyId: config.keyId,
    payload: { iss: config.teamId, iat: now, exp: expiresAt, aud: APPLE_ISSUER, sub: clientId },
  });
  secretCache.set(cacheKey, { secret, expiresAt });
  return secret;
}

/** Every client ID this server accepts Apple identity tokens for. */
export function appleAudiences(config: AppleConfig): string[] {
  return [config.bundleId, ...(config.serviceId ? [config.serviceId] : [])];
}

/**
 * Trade the one-time authorization code from the iOS app's Apple sheet for
 * Apple tokens. Botflow keeps only the refresh token, so it can revoke access
 * when the account is deleted. Returns null if Apple refuses.
 */
export async function exchangeAppleAuthorizationCode(
  config: AppleConfig,
  code: string,
): Promise<{ accessToken?: string; refreshToken?: string } | null> {
  const response = await fetch(APPLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.bundleId,
      client_secret: appleClientSecret(config, config.bundleId),
      code,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) {
    console.error("Apple authorization code exchange failed", response.status, await response.text().catch(() => ""));
    return null;
  }
  const body = (await response.json()) as { access_token?: string; refresh_token?: string };
  return { accessToken: body.access_token, refreshToken: body.refresh_token };
}

/** The `aud` of a stored Apple identity token: the client the tokens were issued to. */
function tokenAudience(idToken: string | null | undefined): string | null {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    const aud = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { aud?: unknown }).aud;
    return typeof aud === "string" ? aud : Array.isArray(aud) && typeof aud[0] === "string" ? aud[0] : null;
  } catch {
    return null;
  }
}

export interface StoredAppleAccount {
  idToken?: string | null;
  /** Already decrypted. */
  refreshToken?: string | null;
  /** Already decrypted. */
  accessToken?: string | null;
}

/**
 * Tell Apple to revoke Botflow's access for each Apple sign-in on an account
 * that is being deleted. Best effort: a failure is logged and never blocks the
 * deletion. Returns how many accounts Apple confirmed.
 */
export async function revokeAppleTokens(accounts: StoredAppleAccount[]): Promise<number> {
  const config = appleConfig();
  if (!config || accounts.length === 0) return 0;
  let revoked = 0;
  for (const account of accounts) {
    const token = account.refreshToken || account.accessToken;
    if (!token) continue;
    const hint = account.refreshToken ? "refresh_token" : "access_token";
    // Revocation must name the client the tokens were issued to.
    const issuedTo = tokenAudience(account.idToken);
    const clients = [...new Set([issuedTo, ...appleAudiences(config)].filter((c): c is string => !!c))];
    for (const clientId of clients) {
      try {
        const response = await fetch(APPLE_REVOKE_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: appleClientSecret(config, clientId),
            token,
            token_type_hint: hint,
          }),
        });
        if (response.ok) {
          revoked++;
          break;
        }
        console.error("Apple token revocation refused", clientId, response.status);
      } catch (error) {
        console.error("Apple token revocation failed", error);
      }
    }
  }
  return revoked;
}
