import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { setUserCredentials } from '@/lib/user-credentials';
import { enforce, identifierFor } from '@/lib/rate-limit';

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

  let returnTo = '/';
  if (stateParam) {
    try {
      const decoded = JSON.parse(Buffer.from(stateParam, 'base64url').toString('utf-8')) as { returnTo?: string };
      if (decoded.returnTo) returnTo = decoded.returnTo;
    } catch { /* use default */ }
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

    await setUserCredentials(userId, {
      convexOAuthAccessToken: accessToken,
      convexOAuthRefreshToken: null,
      convexOAuthExpiresAt: null,
      convexBackendPreference: 'user',
      ...(convexTeamId ? { convexTeamId } : {}),
    });

    return NextResponse.redirect(`${origin}${returnTo}?convex_connected=1`);
  } catch (e) {
    console.error('Convex OAuth callback failed:', e);
    return NextResponse.redirect(`${origin}${returnTo}?convex_error=server`);
  }
}
