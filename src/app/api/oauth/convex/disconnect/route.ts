/**
 * POST /api/oauth/convex/disconnect
 *
 * Disconnect = "stop NEW provisioning only" (a deliberate product choice). It
 * clears the user's Convex OAuth tokens so the platform can no longer provision
 * NEW BYOC projects, but INTENTIONALLY leaves each already-linked project's
 * stored deploy key (userConvexDeployKey) in place so those apps keep deploying
 * and working. The deploy key is NOT an OAuth-derived credential — it was issued
 * once at provisioning time. To fully revoke the platform's access to an existing
 * deployment, the user deletes/rotates that deploy key in the Convex dashboard.
 * The response advertises this scope so callers/UX don't mistake it for a full
 * credential revocation.
 */
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { clearUserCredentials } from '@/lib/user-credentials';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await clearUserCredentials(userId, [
    'convexOAuthAccessToken',
    'convexOAuthRefreshToken',
    'convexOAuthExpiresAt',
  ]);

  return NextResponse.json({
    ok: true,
    scope: 'oauth_tokens_only',
    note:
      'Convex sign-in disconnected. Existing projects keep deploying with their already-issued deploy keys; to revoke those, delete the deploy key in your Convex dashboard.',
  });
}
