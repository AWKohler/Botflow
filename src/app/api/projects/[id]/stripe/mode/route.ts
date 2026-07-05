/**
 * POST /api/projects/[id]/stripe/mode
 *
 * Toggle a project between Stripe test and live mode. The toolbar switch in
 * the Stripe tab calls this.
 *
 * If the user hasn't linked a Stripe account in the requested mode yet, we
 * return status='needs-connect' + authorizeUrl so the UI can launch OAuth
 * for that mode.
 *
 * On success we:
 *   - update projects.stripe_payment_mode
 *   - update STRIPE_MODE on the project's Convex deployment (so the
 *     scaffolded actions read the right value)
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { projects, userStripeIdentity } from '@/db/schema';
import { requireProjectAccess } from '@/lib/project-access';
import { canUseStripeConnect } from '@/lib/tier';
import { isConnectOAuthConfigured, isStripeConfigured, type StripeMode } from '@/lib/stripe';
import { setStripeConvexEnv, mirrorStripeProductsAcrossModes } from '@/lib/stripe-scaffold';
import { ensureConnectWebhookEndpoint } from '@/lib/stripe-webhook-provisioning';
import { mintStripeAuthorizeUrl } from '@/lib/stripe-connect';
import { STRIPE_CONNECT_ENABLED } from '@/lib/feature-flags';

export const runtime = 'nodejs';
export const maxDuration = 30;

interface RequestBody {
  mode?: 'test' | 'live';
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!STRIPE_CONNECT_ENABLED) {
    return NextResponse.json(
      { ok: false, error: 'Stripe Connect is not enabled on this deployment.' },
      { status: 404 },
    );
  }
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  const { id: projectId } = await params;

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }
  const requested: StripeMode = body.mode === 'live' ? 'live' : 'test';

  const db = getDb();
  const access = await requireProjectAccess(projectId, userId);
  if (!access) {
    return NextResponse.json({ ok: false, error: 'Project not found' }, { status: 404 });
  }
  const project = access.project;
  if (project.backendType === 'none') {
    return NextResponse.json(
      { ok: false, error: 'Stripe requires a Convex backend.' },
      { status: 400 },
    );
  }
  const gate = await canUseStripeConnect(userId);
  if (!gate.allowed) {
    return NextResponse.json({ ok: false, error: gate.reason }, { status: 402 });
  }

  if (!isStripeConfigured(requested) || !isConnectOAuthConfigured(requested)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Server isn't configured for ${requested} mode. Set the keys + client_id and redeploy.`,
      },
      { status: 500 },
    );
  }

  // Already on this mode? No-op.
  if (project.stripePaymentMode === requested) {
    return NextResponse.json({ ok: true, mode: requested, alreadyActive: true });
  }

  // Does the user have an acct linked for the requested mode?
  const [identity] = await db
    .select()
    .from(userStripeIdentity)
    .where(eq(userStripeIdentity.userId, userId))
    .limit(1);
  const accountId =
    identity && requested === 'live' ? identity.liveAccountId : identity?.testAccountId;

  if (!accountId) {
    // Mint an authorize URL for the new mode and return needs-connect.
    const { authorizeUrl } = await mintStripeAuthorizeUrl({
      userId,
      projectId,
      mode: requested,
      appOrigin: new URL(req.url).origin,
    });
    return NextResponse.json({
      ok: false,
      status: 'needs-connect',
      mode: requested,
      authorizeUrl,
      message: `You haven't connected Stripe in ${requested} mode yet. Click Connect to authorize.`,
    });
  }

  // All set — flip mode + update Convex env.
  await db
    .update(projects)
    .set({ stripePaymentMode: requested, updatedAt: new Date() })
    .where(eq(projects.id, projectId));

  if (project.stripeWebhookSecret) {
    await setStripeConvexEnv(projectId, {
      mode: requested,
      webhookSecret: project.stripeWebhookSecret,
      proxyBase: new URL(req.url).origin,
    }).catch((err) => {
      console.error('[stripe/mode] setStripeConvexEnv failed (non-fatal):', err);
    });
  }

  // Ensure the platform's Connect webhook endpoint exists for the mode we're
  // entering (covers users who connected before programmatic provisioning).
  void ensureConnectWebhookEndpoint(requested).catch(() => {});

  // Mirror this project's products from the mode we're leaving into the mode
  // we're entering, so a stable lookup key resolves to a real price in the new
  // mode without anyone re-creating the product. Best-effort, non-fatal.
  const fromMode: StripeMode = project.stripePaymentMode === 'live' ? 'live' : 'test';
  const fromAccountId =
    fromMode === 'live' ? identity?.liveAccountId : identity?.testAccountId;
  if (fromAccountId && fromAccountId !== accountId) {
    try {
      const result = await mirrorStripeProductsAcrossModes({
        projectId,
        fromMode,
        fromAccountId,
        toMode: requested,
        toAccountId: accountId,
      });
      if (result.errors.length) {
        console.warn('[stripe/mode] product mirror had errors:', result.errors);
      }
    } catch (err) {
      console.error('[stripe/mode] product mirror failed (non-fatal):', err);
    }
  }

  return NextResponse.json({ ok: true, mode: requested, accountId });
}
