/**
 * GET /api/stripe/oauth/callback?code=…&state=…
 *
 * Stripe redirects here after the user authorizes their Standard account.
 * We exchange the code for the connected account id (`acct_…`), store it on
 * user_stripe_identity for the current mode, flip projects.stripe_enabled,
 * mark the state token consumed, then redirect into the workspace.
 *
 * Error path: redirect into the workspace with ?stripe_connect=error&reason=…
 * so the UI can show a toast without us holding the response.
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, isNull, gt } from 'drizzle-orm';
import { getDb } from '@/db';
import {
  projects,
  stripeConnectRequests,
  stripeOauthStates,
  userStripeIdentity,
} from '@/db/schema';
import { getStripe, type StripeMode } from '@/lib/stripe';
import { mirrorStripeProductsAcrossModes } from '@/lib/stripe-scaffold';
import { ensureConnectWebhookEndpoint } from '@/lib/stripe-webhook-provisioning';
import { STRIPE_CONNECT_ENABLED } from '@/lib/feature-flags';
import { enforce, identifierFor } from '@/lib/rate-limit';

export const runtime = 'nodejs';

function workspaceRedirect(
  origin: string,
  projectId: string | null,
  params: Record<string, string>,
): NextResponse {
  const target = new URL(
    projectId ? `/workspace/${projectId}` : '/projects',
    origin,
  );
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
  return NextResponse.redirect(target);
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  if (!STRIPE_CONNECT_ENABLED) {
    return workspaceRedirect(url.origin, null, {
      stripe_connect: 'error',
      reason: 'disabled',
    });
  }

  // Stripe sends error=access_denied when the user clicks "cancel".
  if (errorParam) {
    return workspaceRedirect(url.origin, null, {
      stripe_connect: 'cancelled',
      reason: errorParam,
    });
  }

  if (!code || !state) {
    return workspaceRedirect(url.origin, null, {
      stripe_connect: 'error',
      reason: 'missing-code-or-state',
    });
  }

  // Not Clerk-gated — authenticates solely via the DB-backed state token, so we
  // key by client IP to throttle state-grinding before the Stripe exchange and
  // the heavy write/provisioning side effects below.
  const blocked = await enforce(identifierFor(null, req), 'oauthExchange');
  if (blocked) return blocked;

  const db = getDb();
  const [stateRow] = await db
    .select()
    .from(stripeOauthStates)
    .where(
      and(
        eq(stripeOauthStates.state, state),
        isNull(stripeOauthStates.consumedAt),
        gt(stripeOauthStates.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!stateRow) {
    return workspaceRedirect(url.origin, null, {
      stripe_connect: 'error',
      reason: 'invalid-or-expired-state',
    });
  }

  const mode = stateRow.mode as StripeMode;
  let stripeUserId: string;
  let publishableKey: string | null = null;
  try {
    const stripe = getStripe(mode);
    // Standard OAuth code exchange. The response includes stripe_user_id
    // (the connected account `acct_…`) and stripe_publishable_key.
    const tokenResponse = await stripe.oauth.token({
      grant_type: 'authorization_code',
      code,
    });
    if (!tokenResponse.stripe_user_id) {
      throw new Error('oauth.token response missing stripe_user_id');
    }
    stripeUserId = tokenResponse.stripe_user_id;
    publishableKey = tokenResponse.stripe_publishable_key ?? null;
  } catch (err) {
    console.error('[stripe/oauth/callback] token exchange failed:', err);
    return workspaceRedirect(url.origin, stateRow.projectId, {
      stripe_connect: 'error',
      reason: 'token-exchange-failed',
    });
  }

  // Upsert the user_stripe_identity row with the new account id for this mode.
  // We intentionally don't overwrite the other mode's columns.
  const now = new Date();
  const accountField = mode === 'live' ? 'liveAccountId' : 'testAccountId';
  const pkField = mode === 'live' ? 'livePublishableKey' : 'testPublishableKey';

  const [existing] = await db
    .select()
    .from(userStripeIdentity)
    .where(eq(userStripeIdentity.userId, stateRow.userId))
    .limit(1);

  if (existing) {
    await db
      .update(userStripeIdentity)
      .set({
        [accountField]: stripeUserId,
        [pkField]: publishableKey,
        connectedAt: existing.connectedAt ?? now,
        updatedAt: now,
      })
      .where(eq(userStripeIdentity.userId, stateRow.userId));
  } else {
    await db.insert(userStripeIdentity).values({
      userId: stateRow.userId,
      [accountField]: stripeUserId,
      [pkField]: publishableKey,
      connectedAt: now,
      updatedAt: now,
    });
  }

  // Flip the project flag so the Stripe tab can appear and the agent's next
  // initializeStripePayments call returns already-connected.
  await db
    .update(projects)
    .set({
      stripeEnabled: true,
      stripePaymentMode: mode,
      updatedAt: now,
    })
    .where(eq(projects.id, stateRow.projectId));

  // Make sure the platform's Connect webhook endpoint exists for this mode, so
  // subscription/payment events from connected accounts are actually delivered
  // (no reliance on a hand-configured dashboard webhook). Idempotent + cheap.
  void ensureConnectWebhookEndpoint(mode).catch(() => {});

  // If the user already had the OTHER mode connected (e.g. they built in test
  // and just linked live), mirror this project's products into the newly
  // connected mode so existing lookup keys resolve there too. Best-effort.
  const otherMode: StripeMode = mode === 'live' ? 'test' : 'live';
  const otherAccountId =
    otherMode === 'live' ? existing?.liveAccountId : existing?.testAccountId;
  if (otherAccountId) {
    try {
      await mirrorStripeProductsAcrossModes({
        projectId: stateRow.projectId,
        fromMode: otherMode,
        fromAccountId: otherAccountId,
        toMode: mode,
        toAccountId: stripeUserId,
      });
    } catch (err) {
      console.error('[stripe/oauth/callback] product mirror failed (non-fatal):', err);
    }
  }

  // Mark the state token consumed so it can't be replayed.
  await db
    .update(stripeOauthStates)
    .set({ consumedAt: now })
    .where(eq(stripeOauthStates.state, state));

  // If this OAuth was launched from an agent-tool modal request, flip the
  // request row to completed so the tool's polling loop resolves. No-op when
  // OAuth was kicked off directly (e.g. from a settings page) without an
  // associated request.
  await db
    .update(stripeConnectRequests)
    .set({ status: 'completed', updatedAt: now })
    .where(
      and(
        eq(stripeConnectRequests.state, state),
        eq(stripeConnectRequests.status, 'pending'),
      ),
    );

  return workspaceRedirect(url.origin, stateRow.projectId, {
    stripe_connect: 'success',
    mode,
    accountId: stripeUserId,
  });
}
