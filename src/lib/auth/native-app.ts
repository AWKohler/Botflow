/**
 * Sign-in for the Botflow iOS app.
 *
 * The app opens /native/authorize in a system browser sheet. The person signs
 * in there exactly as on the website (password, email code, Google, GitHub,
 * or a new account), then confirms that the app may sign in as them. That
 * confirmation mints a one-time code and hands it to the app through its
 * `botflow://` URL; the app trades the code for a session of its own.
 *
 * The exchange is bound with PKCE (RFC 7636, S256): the app sends the hash of
 * a secret when it starts and the secret itself when it redeems the code. A
 * code captured in transit (the custom URL scheme can be claimed by another
 * app) is useless without that secret.
 *
 *   POST /api/auth/native/authorize  { challenge }            (signed in)  → { code }
 *   POST /api/auth/native/token      { code, verifier, … }    (no session) → session cookie
 *
 * The app's session is a separate row from the browser's, so signing out of
 * one leaves the other alone and each shows up as its own device.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { generateRandomString } from "better-auth/crypto";
import { z } from "zod";

/** A code lives just long enough for the redirect and one request. */
const CODE_TTL_MS = 2 * 60 * 1000;

/** base64url(SHA-256(x)) is always 43 characters. */
export const NATIVE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636 §4.1: 43 to 128 unreserved characters. */
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** Codes are stored hashed, so a database read cannot be replayed as a sign-in. */
function codeIdentifier(code: string): string {
  return `native-auth:${sha256Base64Url(code)}`;
}

function cleanDeviceName(value: string | undefined): string {
  const name = (value ?? "").replace(/[^\p{L}\p{N} '’._-]/gu, "").trim().slice(0, 60);
  return name || "iPhone";
}

export function nativeApp() {
  return {
    id: "native-app",
    endpoints: {
      nativeAuthorize: createAuthEndpoint(
        "/native/authorize",
        {
          method: "POST",
          body: z.object({ challenge: z.string().regex(NATIVE_CHALLENGE_PATTERN) }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const { session, user } = ctx.context.session;
          // An impersonation session must never turn into a device that stays signed in.
          if ((session as { impersonatedBy?: string | null }).impersonatedBy) {
            throw new APIError("FORBIDDEN", { message: "Unavailable while impersonating." });
          }
          const code = generateRandomString(48, "a-z", "A-Z", "0-9");
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: codeIdentifier(code),
            value: JSON.stringify({ userId: user.id, challenge: ctx.body.challenge }),
            expiresAt: new Date(Date.now() + CODE_TTL_MS),
          });
          return ctx.json({ code });
        },
      ),
      nativeToken: createAuthEndpoint(
        "/native/token",
        {
          method: "POST",
          body: z.object({
            code: z.string().min(20).max(128),
            verifier: z.string().regex(VERIFIER_PATTERN),
            deviceName: z.string().max(200).optional(),
          }),
        },
        async (ctx) => {
          const invalid = () => new APIError("UNAUTHORIZED", { message: "This sign-in code is invalid or has expired." });

          // Single use: the first request to present the code takes it.
          const row = await ctx.context.internalAdapter.consumeVerificationValue(codeIdentifier(ctx.body.code));
          if (!row) throw invalid();
          let stored: { userId?: string; challenge?: string };
          try {
            stored = JSON.parse(row.value) as { userId?: string; challenge?: string };
          } catch {
            throw invalid();
          }
          if (!stored.userId || !stored.challenge) throw invalid();

          const presented = Buffer.from(sha256Base64Url(ctx.body.verifier));
          const expected = Buffer.from(stored.challenge);
          if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) throw invalid();

          const user = await ctx.context.internalAdapter.findUserById(stored.userId);
          if (!user || (user as { banned?: boolean | null }).banned) throw invalid();

          const session = await ctx.context.internalAdapter.createSession(user.id, false, {
            userAgent: `Botflow for iOS (${cleanDeviceName(ctx.body.deviceName)})`,
          });
          if (!session) throw new APIError("FORBIDDEN", { message: "Sign-in is not available for this account." });
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ user: { id: user.id, name: user.name, email: user.email } });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
