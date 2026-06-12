import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { enforce, identifierFor } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CLIENT_ID = process.env.GITHUB_CLIENT_ID!;
const SCOPES = 'repo user:email';

export async function GET(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const blocked = await enforce(identifierFor(userId, req), 'oauthStart');
    if (blocked) return blocked;

    if (!CLIENT_ID) {
      return NextResponse.json({ error: 'GitHub OAuth not configured' }, { status: 500 });
    }

    const { searchParams } = new URL(req.url);
    const returnTo = searchParams.get('return_to') || '/projects';

    // Encode returnTo into state so callback can redirect back
    const state = Buffer.from(JSON.stringify({ userId, returnTo, ts: Date.now() })).toString('base64url');

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      scope: SCOPES,
      state,
    });

    const authUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;
    return NextResponse.json({ authUrl });
  } catch (e) {
    console.error('GitHub OAuth start failed:', e);
    return NextResponse.json({ error: 'Failed to start OAuth flow' }, { status: 500 });
  }
}
