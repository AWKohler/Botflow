import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CLIENT_ID = process.env.GITHUB_CLIENT_ID!;
const SCOPES = 'repo user:email';

export async function GET(req: NextRequest) {
  const origin = new URL(req.url).origin;
  // Caller sends `returnTo`; also accept `return_to` for safety.
  const { searchParams } = new URL(req.url);
  const returnTo = searchParams.get('returnTo') || searchParams.get('return_to') || '/projects';

  // This endpoint is reached via a full-page browser navigation, so every
  // response must be a redirect (or HTML) — never JSON, or the browser renders
  // the raw object in the page instead of advancing the flow.
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.redirect(`${origin}/sign-in`);

    if (!CLIENT_ID) {
      return NextResponse.redirect(`${origin}${returnTo}?github_error=not_configured`);
    }

    // Encode returnTo into state so callback can redirect back
    const state = Buffer.from(JSON.stringify({ userId, returnTo, ts: Date.now() })).toString('base64url');

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      scope: SCOPES,
      state,
    });

    const authUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;
    // Bounce the browser straight to GitHub's consent screen.
    return NextResponse.redirect(authUrl);
  } catch (e) {
    console.error('GitHub OAuth start failed:', e);
    return NextResponse.redirect(`${origin}${returnTo}?github_error=server`);
  }
}
