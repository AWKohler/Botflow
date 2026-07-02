/**
 * Stripe webhook delivery retry sweep.
 *
 * The inbound /api/webhooks/stripe receiver records one stripe_webhook_deliveries
 * row per (event, project) and attempts delivery inline once. Anything that
 * fails (project Convex down, transient network) — OR that got stuck because the
 * inbound request crashed mid-flight — is picked up here: due rows are claimed
 * atomically (lease bump), re-signed (fresh timestamp), and re-delivered with
 * backoff until they succeed or exhaust MAX_DELIVERY_ATTEMPTS. So a paid Stripe
 * event is never silently dropped even though we always 200 Stripe.
 *
 * Triggered by Vercel cron (see vercel.json), authorized by CRON_SECRET via the
 * Authorization header ONLY (never a query param — those land in access logs).
 */
import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { and, eq, lte, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { projects, stripeWebhookDeliveries } from '@/db/schema';
import {
  backoffMs,
  convexSiteUrlFor,
  deliverStripeEventOnce,
  DELIVERY_LEASE_MS,
  MAX_DELIVERY_ATTEMPTS,
} from '@/lib/stripe-webhook-delivery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const BATCH = 100;
const RETRYABLE = ['pending', 'failed'] as const;

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('[retry-stripe-deliveries] CRON_SECRET is not set');
    return false;
  }
  const provided = Buffer.from(req.headers.get('authorization') ?? '', 'utf-8');
  const expected = Buffer.from(`Bearer ${cronSecret}`, 'utf-8');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const db = getDb();
  const candidates = await db
    .select({ id: stripeWebhookDeliveries.id })
    .from(stripeWebhookDeliveries)
    .where(
      and(
        inArray(stripeWebhookDeliveries.status, RETRYABLE as unknown as string[]),
        lte(stripeWebhookDeliveries.nextAttemptAt, new Date()),
      ),
    )
    .limit(BATCH);

  let delivered = 0;
  let stillFailing = 0;
  let exhausted = 0;
  let claimedCount = 0;

  for (const candidate of candidates) {
    // Atomically claim: push nextAttemptAt forward only if it's still due. A
    // concurrent sweep that already claimed this row moved nextAttemptAt into the
    // future, so its WHERE no longer matches and we skip — no double delivery.
    const claimNow = new Date();
    const [claimed] = await db
      .update(stripeWebhookDeliveries)
      .set({ nextAttemptAt: new Date(claimNow.getTime() + DELIVERY_LEASE_MS), updatedAt: claimNow })
      .where(
        and(
          eq(stripeWebhookDeliveries.id, candidate.id),
          inArray(stripeWebhookDeliveries.status, RETRYABLE as unknown as string[]),
          lte(stripeWebhookDeliveries.nextAttemptAt, claimNow),
        ),
      )
      .returning();
    if (!claimed) continue; // someone else got it
    claimedCount++;

    const [project] = await db
      .select()
      .from(projects)
      .where(eq(projects.id, claimed.projectId))
      .limit(1);

    const siteUrl = project ? convexSiteUrlFor(project) : null;
    if (!project) {
      // Project is gone (rows normally cascade-delete with it; exhaust defensively).
      await db
        .update(stripeWebhookDeliveries)
        .set({ status: 'exhausted', lastError: 'project_missing', updatedAt: new Date() })
        .where(eq(stripeWebhookDeliveries.id, claimed.id));
      exhausted++;
      continue;
    }
    if (!project.stripeWebhookSecret || !siteUrl) {
      // Backend not configured yet — keep retrying (the user may be mid-setup)
      // until MAX attempts, then give up rather than dropping the event.
      const attempts = claimed.attempts + 1;
      const reason = !project.stripeWebhookSecret ? 'no_secret' : 'no_convex_site';
      if (attempts >= MAX_DELIVERY_ATTEMPTS) {
        await db
          .update(stripeWebhookDeliveries)
          .set({ status: 'exhausted', attempts, lastError: reason, updatedAt: new Date() })
          .where(eq(stripeWebhookDeliveries.id, claimed.id));
        exhausted++;
      } else {
        await db
          .update(stripeWebhookDeliveries)
          .set({
            status: 'failed',
            attempts,
            lastError: reason,
            nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
            updatedAt: new Date(),
          })
          .where(eq(stripeWebhookDeliveries.id, claimed.id));
        stillFailing++;
      }
      continue;
    }

    const result = await deliverStripeEventOnce({
      siteUrl,
      secret: project.stripeWebhookSecret,
      payload: claimed.payload,
    });
    const attempts = claimed.attempts + 1;
    if (result.ok) {
      await db
        .update(stripeWebhookDeliveries)
        .set({ status: 'delivered', attempts, lastStatus: result.status ?? null, updatedAt: new Date() })
        .where(eq(stripeWebhookDeliveries.id, claimed.id));
      delivered++;
    } else if (attempts >= MAX_DELIVERY_ATTEMPTS) {
      await db
        .update(stripeWebhookDeliveries)
        .set({
          status: 'exhausted',
          attempts,
          lastStatus: result.status ?? null,
          lastError: result.error ?? null,
          updatedAt: new Date(),
        })
        .where(eq(stripeWebhookDeliveries.id, claimed.id));
      exhausted++;
    } else {
      await db
        .update(stripeWebhookDeliveries)
        .set({
          status: 'failed',
          attempts,
          lastStatus: result.status ?? null,
          lastError: result.error ?? null,
          nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
          updatedAt: new Date(),
        })
        .where(eq(stripeWebhookDeliveries.id, claimed.id));
      stillFailing++;
    }
  }

  return NextResponse.json({
    ok: true,
    scanned: candidates.length,
    claimed: claimedCount,
    delivered,
    stillFailing,
    exhausted,
  });
}
