/**
 * Signed, user-bound OAuth `state` for third-party connect flows.
 *
 * The state round-trips through the provider, so it is attacker-controlled on
 * the way back. It must be:
 *   - unforgeable   — HMAC over the payload; an unsigned base64(JSON) state can
 *                     be crafted with any userId/returnTo.
 *   - session-bound — the callback rejects a state minted for a different user,
 *                     so a victim can't be made to complete an attacker's flow
 *                     (which would link the attacker's account to the victim's).
 *   - fresh         — rejected after `maxAgeMs`.
 *   - purpose-bound — a state minted for one provider can't be replayed into
 *                     another provider's callback.
 * `returnTo` is sanitized to a same-origin path on the way in and out.
 *
 * Format: `<base64url(payload)>.<base64url(hmac(purpose + "." + payload))>`.
 * (The Convex flow predates this and keeps its own compatible signer in
 * convex-oauth-state.ts.)
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { safeRedirect } from '@/lib/auth/policy';

export type OAuthStatePurpose = 'github';

interface Payload {
  p: OAuthStatePurpose;
  u: string;
  r: string;
  t: number;
}

const CLOCK_SKEW_MS = 60_000;

function stateSecret(): string {
  const s = process.env.SESSION_COOKIE_SECRET || process.env.SECRETS_ENCRYPTION_KEY;
  if (!s) {
    throw new Error('SESSION_COOKIE_SECRET (or SECRETS_ENCRYPTION_KEY) must be set to sign OAuth state.');
  }
  return s;
}

function sign(purpose: OAuthStatePurpose, body: string): string {
  return createHmac('sha256', stateSecret()).update(`${purpose}.${body}`).digest('base64url');
}

export function signOAuthState(
  purpose: OAuthStatePurpose,
  opts: { userId: string; returnTo: string; now?: number },
): string {
  const payload: Payload = {
    p: purpose,
    u: opts.userId,
    r: safeRedirect(opts.returnTo),
    t: opts.now ?? Date.now(),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(purpose, body)}`;
}

/**
 * Returns the sanitized returnTo when `state` was minted by us, for this
 * purpose, for `userId`, within `maxAgeMs`; otherwise null.
 */
export function verifyOAuthState(
  purpose: OAuthStatePurpose,
  state: string | null | undefined,
  opts: { userId: string; maxAgeMs: number; now?: number },
): { returnTo: string } | null {
  if (!state) return null;
  const dot = state.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const given = Buffer.from(state.slice(dot + 1));
  const expected = Buffer.from(sign(purpose, body));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let payload: Partial<Payload>;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<Payload>;
  } catch {
    return null;
  }
  const now = opts.now ?? Date.now();
  if (
    payload.p !== purpose ||
    payload.u !== opts.userId ||
    typeof payload.t !== 'number' ||
    now - payload.t > opts.maxAgeMs ||
    payload.t - now > CLOCK_SKEW_MS
  ) {
    return null;
  }
  return { returnTo: safeRedirect(typeof payload.r === 'string' ? payload.r : null) };
}

/** Same-origin redirect to `path` with extra query params merged in (never string-concatenated). */
export function redirectUrl(origin: string, path: string, params: Record<string, string> = {}): URL {
  const url = new URL(safeRedirect(path), origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}
