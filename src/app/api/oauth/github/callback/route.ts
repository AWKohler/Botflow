import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { setUserCredentials } from '@/lib/user-credentials';
import { enforce, identifierFor } from '@/lib/rate-limit';
import { getDb } from '@/db';
import { userSettings } from '@/db/schema';
import { eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CLIENT_ID = process.env.GITHUB_CLIENT_ID!;
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET!;

export async function GET(req: NextRequest) {
  const origin = new URL(req.url).origin;
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.redirect(`${origin}/sign-in`);
  }

  const blocked = await enforce(identifierFor(userId, req), 'oauthExchange');
  if (blocked) return blocked;

  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const stateParam = searchParams.get('state');

  // Decode returnTo from state if present
  let returnTo = '/projects';
  if (stateParam) {
    try {
      const decoded = JSON.parse(Buffer.from(stateParam, 'base64url').toString('utf-8')) as { returnTo?: string };
      if (decoded.returnTo) returnTo = decoded.returnTo;
    } catch { /* use default */ }
  }

  if (!code) {
    return NextResponse.redirect(`${origin}${returnTo}?github_error=no_code`);
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
      }),
    });

    const tokenData = await tokenRes.json() as { access_token?: string; error?: string };

    if (!tokenData.access_token) {
      console.error('GitHub token exchange failed:', tokenData);
      return NextResponse.redirect(`${origin}${returnTo}?github_error=token_exchange`);
    }

    // Fetch GitHub user info
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });
    const ghUser = await userRes.json() as { login: string; avatar_url: string };

    // Write token to Clerk privateMetadata (cache-invalidating)
    await setUserCredentials(userId, {
      githubAccessToken: tokenData.access_token,
      githubUsername: ghUser.login,
      githubAvatarUrl: ghUser.avatar_url,
    });

    // Also keep display fields in Neon userSettings for components that read them directly
    const db = getDb();
    const [existing] = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
    if (existing) {
      await db
        .update(userSettings)
        .set({ githubUsername: ghUser.login, githubAvatarUrl: ghUser.avatar_url, updatedAt: new Date() })
        .where(eq(userSettings.userId, userId));
    } else {
      await db.insert(userSettings).values({
        userId,
        githubUsername: ghUser.login,
        githubAvatarUrl: ghUser.avatar_url,
      });
    }

    return NextResponse.redirect(`${origin}${returnTo}?github_connected=1`);
  } catch (e) {
    console.error('GitHub OAuth callback failed:', e);
    return NextResponse.redirect(`${origin}${returnTo}?github_error=server`);
  }
}
