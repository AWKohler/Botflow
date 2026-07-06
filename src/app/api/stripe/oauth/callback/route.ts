/**
 * GET /api/stripe/oauth/callback?code=…&state=…
 *
 * Stripe redirects here after the user authorizes their Standard account.
 * We exchange the code for the connected account id (`acct_…`), store it on
 * user_stripe_identity for the current mode, flip projects.stripe_enabled,
 * then redirect into the workspace.
 *
 * Security:
 *   • The state token (32 random bytes, single-use, 1h TTL) is consumed
 *     ATOMICALLY before anything else, so a state leaked into access logs can
 *     never be replayed or raced by two concurrent callbacks.
 *   • We additionally require the current Clerk session to be the same user the
 *     state was minted for — a leaked state alone can't bind a stranger's Stripe
 *     account to a victim's project.
 *   • A connected account already owned by a different Botflow user is rejected
 *     (backstopped by partial-unique indexes) so inbound webhooks can never
 *     resolve to the wrong owner.
 *
 * Error path: redirect into the workspace with ?stripe_connect=error&reason=…
 * so the UI can show a toast without us holding the response.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { and, eq, isNull, gt, ne } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { getDb } from '@/db';
import {
  projects,
  stripeConnectRequests,
  stripeOauthStates,
  userStripeIdentity,
} from '@/db/schema';
import { requireProjectAccess } from '@/lib/project-access';
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

  // Throttle by client IP before any auth/state work, so an attacker can't grind
  // states or hammer the Stripe exchange and the heavy write/provisioning side
  // effects below. Keyed by IP since this guard runs ahead of the auth() check.
  const blocked = await enforce(identifierFor(null, req), 'oauthExchange');
  if (blocked) return blocked;

  // Require an authenticated session FIRST (before consuming the state) so a
  // transient auth hiccup never burns a legit user's one-shot token. The
  // callback runs as a top-level same-origin navigation in the popup, so the
  // Clerk session cookie is present in the normal flow.
  const { userId } = await auth();
  if (!userId) {
    return workspaceRedirect(url.origin, null, {
      stripe_connect: 'error',
      reason: 'unauthorized',
    });
  }

  const db = getDb();

  // Atomically claim (consume) the state: only one caller can flip consumedAt
  // from NULL while it's unexpired. Closes the replay + concurrent-callback
  // races in one statement.
  const now = new Date();
  const [stateRow] = await db
    .update(stripeOauthStates)
    .set({ consumedAt: now })
    .where(
      and(
        eq(stripeOauthStates.state, state),
        isNull(stripeOauthStates.consumedAt),
        gt(stripeOauthStates.expiresAt, now),
      ),
    )
    .returning();

  if (!stateRow) {
    return workspaceRedirect(url.origin, null, {
      stripe_connect: 'error',
      reason: 'invalid-or-expired-state',
    });
  }

  // The session must match the user the state was minted for. A state leaked
  // into logs is useless to anyone signed in as someone else.
  if (stateRow.userId !== userId) {
    return workspaceRedirect(url.origin, null, {
      stripe_connect: 'error',
      reason: 'user-mismatch',
    });
  }

  // Re-verify the project still belongs to this user (could have been deleted
  // or transferred while the popup was open).
  const access = await requireProjectAccess(stateRow.projectId, userId, "owner");
  if (!access) {
    return workspaceRedirect(url.origin, stateRow.projectId, {
      stripe_connect: 'error',
      reason: 'project-not-found',
    });
  }
  const { project } = access;

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

  const accountField = mode === 'live' ? 'liveAccountId' : 'testAccountId';
  const pkField = mode === 'live' ? 'livePublishableKey' : 'testPublishableKey';

  // Reject linking a Stripe account that already belongs to a DIFFERENT Botflow
  // user (backstopped by the partial-unique index). Otherwise inbound webhooks
  // for that account could route to the wrong owner's projects.
  const accountCol = mode === 'live' ? userStripeIdentity.liveAccountId : userStripeIdentity.testAccountId;
  const [conflict] = await db
    .select({ userId: userStripeIdentity.userId })
    .from(userStripeIdentity)
    .where(and(eq(accountCol, stripeUserId), ne(userStripeIdentity.userId, userId)))
    .limit(1);
  if (conflict) {
    return workspaceRedirect(url.origin, stateRow.projectId, {
      stripe_connect: 'error',
      reason: 'account-already-linked',
    });
  }

  // Upsert the user_stripe_identity row with the new account id for this mode.
  // We intentionally don't overwrite the other mode's columns.
  const [existing] = await db
    .select()
    .from(userStripeIdentity)
    .where(eq(userStripeIdentity.userId, userId))
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
      .where(eq(userStripeIdentity.userId, userId));
  } else {
    await db.insert(userStripeIdentity).values({
      userId,
      [accountField]: stripeUserId,
      [pkField]: publishableKey,
      connectedAt: now,
      updatedAt: now,
    });
  }

  // Flip the project flag so the Stripe tab can appear and the agent's next
  // initializeStripePayments call returns already-connected. Ensure a per-project
  // webhook secret exists NOW (don't rely on a later flipProjectEnabled) — the
  // inbound fan-out drops events for a stripeEnabled project that has no secret.
  const webhookSecret = project.stripeWebhookSecret ?? `bfws_${randomBytes(32).toString('hex')}`;
  await db
    .update(projects)
    .set({
      stripeEnabled: true,
      stripePaymentMode: mode,
      stripeWebhookSecret: webhookSecret,
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
