import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { enforce, identifierFor } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CLIENT_ID = process.env.CONVEX_OAUTH_CLIENT_ID!;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL!;
const REDIRECT_URI = `${APP_URL}/api/oauth/convex/callback`;

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const blocked = await enforce(identifierFor(userId, req), 'oauthStart');
  if (blocked) return blocked;

  if (!CLIENT_ID) return NextResponse.json({ error: 'Convex OAuth not configured' }, { status: 500 });

  const { searchParams } = new URL(req.url);
  const returnTo = searchParams.get('return_to') || '/';

  const state = Buffer.from(JSON.stringify({ userId, returnTo, ts: Date.now() })).toString('base64url');
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    state,
  });

  const authUrl = `https://dashboard.convex.dev/oauth/authorize/team?${params.toString()}`;
  return NextResponse.json({ authUrl });
}
