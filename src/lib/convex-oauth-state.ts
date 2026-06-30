/**
 * Signed state for the platform↔Convex OAuth connect flow.
 *
 * The state must be UNFORGEABLE: a plain base64(JSON) state lets an attacker
 * craft `{ userId: <victim>, ts: now }`, which would pass a userId-match check in
 * the callback and bind the attacker's Convex team to the victim's account. We
 * therefore HMAC-sign the payload with a server secret; the callback rejects any
 * state whose signature doesn't verify, so the embedded userId is trustworthy.
 *
 * Format: `<base64url(payload)>.<base64url(hmac)>`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ConvexOAuthStatePayload {
  userId: string;
  returnTo: string;
  ts: number;
}

function stateSecret(): string {
  const s = process.env.SESSION_COOKIE_SECRET || process.env.SECRETS_ENCRYPTION_KEY;
  if (!s) {
    throw new Error(
      'SESSION_COOKIE_SECRET (or SECRETS_ENCRYPTION_KEY) must be set to sign the Convex OAuth state.',
    );
  }
  return s;
}

export function signConvexOAuthState(payload: ConvexOAuthStatePayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', stateSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** Verify the signature and return the payload, or null if tampered/malformed. */
export function verifyConvexOAuthState(state: string): ConvexOAuthStatePayload | null {
  const dot = state.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = createHmac('sha256', stateSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as Partial<ConvexOAuthStatePayload>;
    if (typeof obj.userId === 'string' && typeof obj.ts === 'number') {
      return {
        userId: obj.userId,
        returnTo: typeof obj.returnTo === 'string' ? obj.returnTo : '/',
        ts: obj.ts,
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}
