import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { setUserCredentials } from '@/lib/user-credentials';
import { enforce, identifierFor } from '@/lib/rate-limit';
import { verifyConvexOAuthState } from '@/lib/convex-oauth-state';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CLIENT_ID = process.env.CONVEX_OAUTH_CLIENT_ID!;
const CLIENT_SECRET = process.env.CONVEX_OAUTH_CLIENT_SECRET!;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL!;
const REDIRECT_URI = `${APP_URL}/api/oauth/convex/callback`;

export async function GET(req: NextRequest) {
  const origin = new URL(req.url).origin;
  const { userId } = await auth();
  if (!userId) return NextResponse.redirect(`${origin}/sign-in`);

  const blocked = await enforce(identifierFor(userId, req), 'oauthExchange');
  if (blocked) return blocked;

  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const stateParam = searchParams.get('state');

  // Verify the HMAC-signed state. A tampered/forged state fails verification, so
  // the embedded userId is trustworthy.
  const decoded = stateParam ? verifyConvexOAuthState(stateParam) : null;

  // Only honor a same-site path returnTo (no open redirect to //evil.com).
  const returnTo =
    decoded && decoded.returnTo.startsWith('/') && !decoded.returnTo.startsWith('//')
      ? decoded.returnTo
      : '/';

  // CSRF defense: the session completing this callback must be the SAME user who
  // started the flow, and the state must be fresh (<=15 min). Otherwise an
  // attacker could get a logged-in victim to complete an OAuth flow the attacker
  // started, binding the attacker's Convex team as the victim's BYOC connection
  // (the victim's app data would then deploy to the attacker's Convex backend).
  const STATE_TTL_MS = 15 * 60 * 1000;
  if (!decoded || decoded.userId !== userId || Date.now() - decoded.ts > STATE_TTL_MS) {
    return NextResponse.redirect(`${origin}${returnTo}?convex_error=invalid_state`);
  }

  if (!code) return NextResponse.redirect(`${origin}${returnTo}?convex_error=no_code`);

  try {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
      code,
    });

    const tokenRes = await fetch('https://api.convex.dev/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const tokenData = await tokenRes.json() as Record<string, unknown>;

    if (!tokenData.access_token) {
      console.error('Convex OAuth token exchange failed');
      return NextResponse.redirect(`${origin}${returnTo}?convex_error=token_exchange`);
    }

    const accessToken = String(tokenData.access_token);

    // Extract team slug from token (format: "team:<slug>|<jwt>")
    const teamMatch = accessToken.match(/^team:([^|]+)\|/);
    const convexTeamId = teamMatch ? teamMatch[1] : null;

    // Capture a refresh token + expiry if Convex issues them, so provisioning can
    // refresh later instead of bricking when the access token expires. (If Convex
    // issues neither, these stay null — same as before.)
    const refreshToken = typeof tokenData.refresh_token === 'string' ? tokenData.refresh_token : null;
    const expiresIn = typeof tokenData.expires_in === 'number' ? tokenData.expires_in : null;
    const expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : null;

    await setUserCredentials(userId, {
      convexOAuthAccessToken: accessToken,
      convexOAuthRefreshToken: refreshToken,
      convexOAuthExpiresAt: expiresAt,
      convexBackendPreference: 'user',
      ...(convexTeamId ? { convexTeamId } : {}),
    });

    return NextResponse.redirect(`${origin}${returnTo}?convex_connected=1`);
  } catch (e) {
    console.error('Convex OAuth callback failed:', e);
    return NextResponse.redirect(`${origin}${returnTo}?convex_error=server`);
  }
}
