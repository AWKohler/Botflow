import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { setUserCredentials } from '@/lib/user-credentials';
import { enforce, identifierFor } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Tight guard against token/code-grinding: each call hits Anthropic's token
    // endpoint with attacker-supplied code+verifier. Key by userId (or client IP).
    const blocked = await enforce(identifierFor(userId, req), 'oauthExchange');
    if (blocked) return blocked;

    const { code, verifier } = await req.json() as { code: string; verifier: string };
    if (!code?.trim()) return NextResponse.json({ error: 'Missing code' }, { status: 400 });
    if (!verifier?.trim()) return NextResponse.json({ error: 'Missing verifier' }, { status: 400 });

    // Exchange code for tokens — verifier is provided by the client (PKCE client-side secret)
    const tokenRes = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code: code.trim(),
        state: verifier.trim(),
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier.trim(),
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      console.error('Token exchange failed:', tokenRes.status, body);
      return NextResponse.json(
        { error: 'Authorization failed. Make sure you copied the correct code and try again.' },
        { status: 400 }
      );
    }

    const tokens = await tokenRes.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const expiresAt = tokens.expires_in
      ? Date.now() + tokens.expires_in * 1000 - 5 * 60 * 1000 // 5-min buffer
      : null;

    await setUserCredentials(userId, {
      claudeOAuthAccessToken: tokens.access_token,
      claudeOAuthRefreshToken: tokens.refresh_token ?? null,
      claudeOAuthExpiresAt: expiresAt,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('OAuth exchange failed:', e);
    return NextResponse.json({ error: 'Failed to exchange token' }, { status: 500 });
  }
}
