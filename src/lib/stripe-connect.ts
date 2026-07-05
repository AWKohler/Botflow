/**
 * Shared helpers for the Stripe Connect modal flow. Both the standalone
 * /api/stripe/oauth/start endpoint and the agent tool create state tokens +
 * authorize URLs via this module, so the shape stays in lock-step.
 */
import { randomBytes } from 'node:crypto';
import { getDb } from '@/db';
import { stripeConnectRequests, stripeOauthStates } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { getConnectClientId, type StripeMode } from '@/lib/stripe';
import { markAgentWaiting } from '@/lib/agent/modal-wait';

const STATE_TTL_MS = 60 * 60_000;

/** Mint a one-shot OAuth state token + authorize URL for the given user/project/mode. */
export async function mintStripeAuthorizeUrl(opts: {
  userId: string;
  projectId: string;
  mode: StripeMode;
  appOrigin: string;
}): Promise<{ state: string; authorizeUrl: string; expiresAt: Date }> {
  const { userId, projectId, mode, appOrigin } = opts;
  const db = getDb();

  const state = randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + STATE_TTL_MS);

  await db.insert(stripeOauthStates).values({
    state,
    userId,
    projectId,
    mode,
    createdAt: now,
    expiresAt,
  });

  const clientId = getConnectClientId(mode);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: 'read_write',
    redirect_uri: `${appOrigin}/api/stripe/oauth/callback`,
    state,
  });
  const authorizeUrl = `https://connect.stripe.com/oauth/authorize?${params.toString()}`;
  return { state, authorizeUrl, expiresAt };
}

/**
 * Cancel any pending Stripe connect requests for the project (used before
 * creating a new one — keeps the workspace from showing two modals).
 */
export async function cancelPendingConnectRequests(projectId: string): Promise<void> {
  const db = getDb();
  await db
    .update(stripeConnectRequests)
    .set({ status: 'dismissed', updatedAt: new Date() })
    .where(
      and(
        eq(stripeConnectRequests.projectId, projectId),
        eq(stripeConnectRequests.status, 'pending'),
      ),
    );
}

/** Create a pending connect-request row that the workspace UI will pick up. */
export async function createConnectRequest(opts: {
  userId: string;
  projectId: string;
  mode: StripeMode;
  state: string;
  authorizeUrl: string;
}): Promise<{ id: string }> {
  const db = getDb();
  const [row] = await db
    .insert(stripeConnectRequests)
    .values({
      userId: opts.userId,
      projectId: opts.projectId,
      mode: opts.mode,
      state: opts.state,
      authorizeUrl: opts.authorizeUrl,
      status: 'pending',
    })
    .returning({ id: stripeConnectRequests.id });
  return { id: row.id };
}

/** Poll the request row up to deadlineMs, returning the resolved status.
 *
 *  Timing out leaves the row PENDING and the modal open: a timeout means "the
 *  user hasn't finished yet", never "the user declined". The workspace's lazy
 *  stale-expiry clears truly abandoned rows, and a late completion notifies
 *  the agent via a system note. */
export async function pollConnectRequest(opts: {
  requestId: string;
  projectId: string;
  deadlineMs: number;
  intervalMs?: number;
}): Promise<'completed' | 'dismissed' | 'gone' | 'timeout'> {
  const interval = opts.intervalMs ?? 3000;
  const db = getDb();
  while (Date.now() < opts.deadlineMs) {
    void markAgentWaiting('stripe-connect', opts.requestId);
    await new Promise<void>((r) => setTimeout(r, interval));
    const [row] = await db
      .select({ status: stripeConnectRequests.status })
      .from(stripeConnectRequests)
      .where(
        and(
          eq(stripeConnectRequests.id, opts.requestId),
          eq(stripeConnectRequests.projectId, opts.projectId),
        ),
      )
      .limit(1);
    if (!row) return 'gone';
    if (row.status === 'completed') return 'completed';
    if (row.status === 'dismissed') return 'dismissed';
    // pending — keep polling
  }
  return 'timeout';
}

/** One short polling window (for the Claude Code tool route, whose bridge-side
 *  caller loops until terminal). Returns 'pending' when the window closes
 *  without a terminal status; the row is not touched. */
export async function pollConnectRequestOnce(opts: {
  requestId: string;
  projectId: string;
  windowMs?: number;
}): Promise<'completed' | 'dismissed' | 'gone' | 'pending'> {
  const db = getDb();
  const deadline = Date.now() + (opts.windowMs ?? 20_000);
  void markAgentWaiting('stripe-connect', opts.requestId);
  for (;;) {
    const [row] = await db
      .select({ status: stripeConnectRequests.status })
      .from(stripeConnectRequests)
      .where(
        and(
          eq(stripeConnectRequests.id, opts.requestId),
          eq(stripeConnectRequests.projectId, opts.projectId),
        ),
      )
      .limit(1);
    if (!row) return 'gone';
    if (row.status === 'completed') return 'completed';
    if (row.status === 'dismissed') return 'dismissed';
    if (Date.now() >= deadline) return 'pending';
    await new Promise<void>((r) => setTimeout(r, 3000));
  }
}
