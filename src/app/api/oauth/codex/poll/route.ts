import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { setUserCredentials } from '@/lib/user-credentials';
import { enforce, identifierFor } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

function extractAccountId(idToken: string): string | null {
  try {
    const parts = idToken.split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (payload.chatgpt_account_id) return payload.chatgpt_account_id;
    const nsKey = 'https://api.openai.com/auth.chatgpt_account_id';
    if (payload[nsKey]) return payload[nsKey];
    if (payload.organizations && Array.isArray(payload.organizations) && payload.organizations.length > 0) {
      return payload.organizations[0].id ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const blocked = await enforce(identifierFor(userId, req), 'oauthPoll');
    if (blocked) return blocked;

    const { device_auth_id, user_code } = await req.json() as {
      device_auth_id: string;
      user_code: string;
    };

    if (!device_auth_id || !user_code) {
      return NextResponse.json({ error: 'Missing device_auth_id or user_code' }, { status: 400 });
    }

    // Check if device auth has been completed
    const tokenRes = await fetch('https://auth.openai.com/api/accounts/deviceauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_auth_id, user_code }),
    });

    if (tokenRes.status === 403 || tokenRes.status === 404) {
      return NextResponse.json({ status: 'pending' });
    }

    if (!tokenRes.ok) {
      return NextResponse.json({ status: 'failed' });
    }

    const tokenData = await tokenRes.json() as {
      authorization_code: string;
      code_verifier: string;
    };

    // Exchange authorization code for tokens
    const exchangeRes = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: tokenData.authorization_code,
        redirect_uri: 'https://auth.openai.com/deviceauth/callback',
        client_id: CODEX_CLIENT_ID,
        code_verifier: tokenData.code_verifier,
      }).toString(),
    });

    if (!exchangeRes.ok) {
      const text = await exchangeRes.text();
      console.error('Codex token exchange failed:', exchangeRes.status, text);
      return NextResponse.json({ status: 'failed' });
    }

    const tokens = await exchangeRes.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      id_token?: string;
    };

    const accountId = tokens.id_token ? extractAccountId(tokens.id_token) : null;

    const expiresAt = tokens.expires_in
      ? Date.now() + tokens.expires_in * 1000 - 5 * 60 * 1000
      : null;

    await setUserCredentials(userId, {
      codexOAuthAccessToken: tokens.access_token,
      codexOAuthRefreshToken: tokens.refresh_token ?? null,
      codexOAuthExpiresAt: expiresAt,
      codexOAuthAccountId: accountId,
    });

    return NextResponse.json({ status: 'success' });
  } catch (e) {
    console.error('Codex OAuth poll error:', e);
    return NextResponse.json({ status: 'failed' });
  }
}
