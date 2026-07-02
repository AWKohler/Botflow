/**
 * RevenueCat webhook delivery retry sweep. Mirrors retry-stripe-deliveries.
 *
 * The inbound /api/webhooks/revenuecat receiver records one
 * revenuecat_webhook_deliveries row per (event, project) and attempts delivery
 * inline once. Anything that fails — or got stuck because the inbound request
 * crashed mid-flight — is claimed atomically here (lease bump), re-signed (fresh
 * timestamp), and re-delivered with backoff until it succeeds or exhausts
 * MAX_DELIVERY_ATTEMPTS. So a paid entitlement event is never silently dropped.
 *
 * Authorized by CRON_SECRET via the Authorization header ONLY.
 */
import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { and, eq, lte, inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { projects, revenueCatWebhookDeliveries } from '@/db/schema';
import {
  backoffMs,
  convexSiteUrlFor,
  deliverWebhookEventOnce,
  DELIVERY_LEASE_MS,
  MAX_DELIVERY_ATTEMPTS,
} from '@/lib/webhook-delivery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const BATCH = 100;
const RETRYABLE = ['pending', 'failed'] as const;

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('[retry-revenuecat-deliveries] CRON_SECRET is not set');
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
    .select({ id: revenueCatWebhookDeliveries.id })
    .from(revenueCatWebhookDeliveries)
    .where(
      and(
        inArray(revenueCatWebhookDeliveries.status, RETRYABLE as unknown as string[]),
        lte(revenueCatWebhookDeliveries.nextAttemptAt, new Date()),
      ),
    )
    .limit(BATCH);

  let delivered = 0;
  let stillFailing = 0;
  let exhausted = 0;
  let claimedCount = 0;

  for (const candidate of candidates) {
    const claimNow = new Date();
    const [claimed] = await db
      .update(revenueCatWebhookDeliveries)
      .set({ nextAttemptAt: new Date(claimNow.getTime() + DELIVERY_LEASE_MS), updatedAt: claimNow })
      .where(
        and(
          eq(revenueCatWebhookDeliveries.id, candidate.id),
          inArray(revenueCatWebhookDeliveries.status, RETRYABLE as unknown as string[]),
          lte(revenueCatWebhookDeliveries.nextAttemptAt, claimNow),
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

    if (!project) {
      await db
        .update(revenueCatWebhookDeliveries)
        .set({ status: 'exhausted', lastError: 'project_missing', updatedAt: new Date() })
        .where(eq(revenueCatWebhookDeliveries.id, claimed.id));
      exhausted++;
      continue;
    }
    const siteUrl = convexSiteUrlFor(project);
    if (!project.revenuecatWebhookSecret || !siteUrl) {
      const attempts = claimed.attempts + 1;
      const reason = !project.revenuecatWebhookSecret ? 'no_secret' : 'no_convex_site';
      if (attempts >= MAX_DELIVERY_ATTEMPTS) {
        await db
          .update(revenueCatWebhookDeliveries)
          .set({ status: 'exhausted', attempts, lastError: reason, updatedAt: new Date() })
          .where(eq(revenueCatWebhookDeliveries.id, claimed.id));
        exhausted++;
      } else {
        await db
          .update(revenueCatWebhookDeliveries)
          .set({
            status: 'failed',
            attempts,
            lastError: reason,
            nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
            updatedAt: new Date(),
          })
          .where(eq(revenueCatWebhookDeliveries.id, claimed.id));
        stillFailing++;
      }
      continue;
    }

    const result = await deliverWebhookEventOnce({
      url: `${siteUrl}/revenuecat/webhook`,
      secret: project.revenuecatWebhookSecret,
      payload: claimed.payload,
    });
    const attempts = claimed.attempts + 1;
    if (result.ok) {
      await db
        .update(revenueCatWebhookDeliveries)
        .set({ status: 'delivered', attempts, lastStatus: result.status ?? null, updatedAt: new Date() })
        .where(eq(revenueCatWebhookDeliveries.id, claimed.id));
      delivered++;
    } else if (attempts >= MAX_DELIVERY_ATTEMPTS) {
      await db
        .update(revenueCatWebhookDeliveries)
        .set({
          status: 'exhausted',
          attempts,
          lastStatus: result.status ?? null,
          lastError: result.error ?? null,
          updatedAt: new Date(),
        })
        .where(eq(revenueCatWebhookDeliveries.id, claimed.id));
      exhausted++;
    } else {
      await db
        .update(revenueCatWebhookDeliveries)
        .set({
          status: 'failed',
          attempts,
          lastStatus: result.status ?? null,
          lastError: result.error ?? null,
          nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
          updatedAt: new Date(),
        })
        .where(eq(revenueCatWebhookDeliveries.id, claimed.id));
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
