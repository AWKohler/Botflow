/**
 * POST /api/webhooks/revenuecat
 *
 * Platform-level RevenueCat webhook receiver. RevenueCat sends subscription /
 * entitlement lifecycle events here. Each connected project has its own
 * webhook in RevenueCat (created by Botflow at connect time) carrying that
 * connection's Authorization value, so one request maps to one project:
 *
 *   1. Authenticate: the Authorization header identifies the connection.
 *   2. Normalize to a small canonical entitlement vocabulary.
 *   3. Claim one revenuecat_webhook_deliveries row for (event, project) — the
 *      unique index makes RevenueCat's retries (up to 5×, same id) idempotent.
 *   4. Deliver to the project's Convex HTTP endpoint, HMAC-signed with the
 *      project's revenuecat_webhook_secret; the cron retries failures.
 *
 * A RevenueCat project is connected to exactly one Botflow project (unique
 * index), so no other project's webhook ever sees these events. Apps generated
 * by the first version of this integration tagged their customers
 * bfp_<projectId>__<id>; that prefix is still stripped before delivery, and an
 * event tagged for a different project is dropped.
 *
 * Returns 401 only when the Authorization header matches no connection (so a
 * misconfigured webhook is visible in RevenueCat); after that, always 200 — we
 * own the retry budget from here.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { getDb } from '@/db';
import {
  projectRevenueCatConnections,
  projects,
  revenueCatWebhookDeliveries,
} from '@/db/schema';
import {
  backoffMs,
  convexSiteUrlFor,
  deliverWebhookEventOnce,
  DELIVERY_LEASE_MS,
} from '@/lib/webhook-delivery';
import { parseProjectIdFromAppUserId, stripNamespacedAppUserId } from '@/lib/revenuecat-app-user-id';
import { REVENUECAT_ENABLED } from '@/lib/feature-flags';

export const runtime = 'nodejs';
export const maxDuration = 60;

interface CanonicalEvent {
  type:
    | 'entitlement.granted'
    | 'entitlement.revoked'
    | 'entitlement.cancellation'
    | 'billing.issue';
  id: string;
  data: Record<string, unknown>;
}

// RevenueCat event payload (the fields we use). See
// https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields
interface RevenueCatEvent {
  type?: string;
  id?: string;
  app_user_id?: string;
  original_app_user_id?: string;
  product_id?: string;
  entitlement_ids?: string[] | null;
  period_type?: string;
  purchased_at_ms?: number;
  expiration_at_ms?: number;
  store?: string;
  environment?: string;
  price?: number;
  currency?: string;
  cancel_reason?: string;
  expiration_reason?: string;
}

// ─── Normalization ────────────────────────────────────────────────────────

const GRANT_TYPES = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'UNCANCELLATION',
  'NON_RENEWING_PURCHASE',
  'PRODUCT_CHANGE',
  'SUBSCRIPTION_EXTENDED',
  'TEMPORARY_ENTITLEMENT_GRANT',
]);

function normalize(event: RevenueCatEvent): CanonicalEvent | null {
  const id = event.id;
  const rawType = event.type;
  if (!id || !rawType) return null;

  const base = {
    appUserId: event.app_user_id ?? event.original_app_user_id ?? null,
    productId: event.product_id ?? null,
    entitlementIds: event.entitlement_ids ?? [],
    periodType: event.period_type ?? null,
    expirationAtMs: event.expiration_at_ms ?? null,
    store: event.store ?? null,
    environment: event.environment ?? null,
    price: event.price ?? null,
    currency: event.currency ?? null,
    rcEventType: rawType,
  };

  if (GRANT_TYPES.has(rawType)) {
    return { type: 'entitlement.granted', id, data: base };
  }
  switch (rawType) {
    case 'EXPIRATION':
      return {
        type: 'entitlement.revoked',
        id,
        data: { ...base, expirationReason: event.expiration_reason ?? null },
      };
    case 'CANCELLATION':
      // Auto-renew turned off — access usually continues until expiration.
      return {
        type: 'entitlement.cancellation',
        id,
        data: { ...base, cancelReason: event.cancel_reason ?? null },
      };
    case 'BILLING_ISSUE':
      return { type: 'billing.issue', id, data: base };
    default:
      // TEST, SUBSCRIPTION_PAUSED, TRANSFER, INVOICE_ISSUANCE, etc. — ignore.
      return null;
  }
}

// ─── Durable, routed fan-out (mirrors the hardened Stripe path) ────────────

/** Record a (event, project) target and attempt inline delivery once. */
async function recordAndDeliver(opts: {
  project: typeof projects.$inferSelect;
  eventId: string;
  canonicalType: string;
  payload: string;
}): Promise<{ projectId: string; ok: boolean; reason?: string }> {
  const { project, eventId, canonicalType, payload } = opts;
  const db = getDb();

  // Claim the (event, project) target FIRST — before deliverability checks — so a
  // paid entitlement event is never dropped because the project momentarily lacks
  // a secret/backend; the cron retries once config catches up. onConflictDoNothing
  // makes RevenueCat's re-delivery idempotent; the lease lets a crashed attempt be
  // reclaimed instead of stranded 'pending'.
  const [claimed] = await db
    .insert(revenueCatWebhookDeliveries)
    .values({
      eventId,
      projectId: project.id,
      canonicalType,
      payload,
      status: 'pending',
      nextAttemptAt: new Date(Date.now() + DELIVERY_LEASE_MS),
    })
    .onConflictDoNothing()
    .returning({ id: revenueCatWebhookDeliveries.id });
  if (!claimed) {
    return { projectId: project.id, ok: true, reason: 'already_claimed' };
  }

  const siteUrl = convexSiteUrlFor(project);
  if (!project.revenuecatWebhookSecret || !siteUrl) {
    await db
      .update(revenueCatWebhookDeliveries)
      .set({
        status: 'failed',
        lastError: !project.revenuecatWebhookSecret ? 'no_secret' : 'no_convex_site',
        nextAttemptAt: new Date(Date.now() + backoffMs(1)),
        updatedAt: new Date(),
      })
      .where(eq(revenueCatWebhookDeliveries.id, claimed.id));
    return {
      projectId: project.id,
      ok: false,
      reason: !project.revenuecatWebhookSecret ? 'no_secret' : 'no_convex_site',
    };
  }

  const result = await deliverWebhookEventOnce({
    url: `${siteUrl}/revenuecat/webhook`,
    secret: project.revenuecatWebhookSecret,
    payload,
  });
  const nowTs = new Date();
  if (result.ok) {
    await db
      .update(revenueCatWebhookDeliveries)
      .set({ status: 'delivered', attempts: 1, lastStatus: result.status ?? null, updatedAt: nowTs })
      .where(eq(revenueCatWebhookDeliveries.id, claimed.id));
    return { projectId: project.id, ok: true };
  }
  console.error('[revenuecat/webhook] inline delivery failed', project.id, 'status=', result.status, 'err=', result.error);
  await db
    .update(revenueCatWebhookDeliveries)
    .set({
      status: 'failed',
      attempts: 1,
      lastStatus: result.status ?? null,
      lastError: result.error ?? null,
      nextAttemptAt: new Date(Date.now() + backoffMs(1)),
      updatedAt: nowTs,
    })
    .where(eq(revenueCatWebhookDeliveries.id, claimed.id));
  return { projectId: project.id, ok: false, reason: 'delivery_failed' };
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ─── Handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  if (!REVENUECAT_ENABLED) {
    return NextResponse.json(
      { ok: false, error: 'RevenueCat is not enabled on this deployment.' },
      { status: 404 },
    );
  }

  const authHeader = req.headers.get('authorization');
  if (!authHeader) {
    return NextResponse.json({ ok: false, error: 'Missing Authorization header' }, { status: 401 });
  }

  const db = getDb();

  // Authenticate by INDEXED digest lookup (O(1)), then constant-time compare
  // the full secret as defense.
  const digest = createHash('sha256').update(authHeader).digest('hex');
  const [connection] = await db
    .select({
      projectId: projectRevenueCatConnections.projectId,
      secret: projectRevenueCatConnections.inboundWebhookSecret,
    })
    .from(projectRevenueCatConnections)
    .where(eq(projectRevenueCatConnections.inboundWebhookSecretDigest, digest))
    .limit(1);
  if (!connection || !constantTimeEqual(authHeader, connection.secret)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const rawBody = await req.text();
  let parsed: { event?: RevenueCatEvent };
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }
  const rcEvent = parsed.event;

  // Any authenticated request proves RevenueCat can reach us with the right
  // Authorization value — including the dashboard's "send test event", which
  // is how a hand-configured webhook gets verified. Best-effort.
  await db
    .update(projectRevenueCatConnections)
    .set({ lastEventAt: new Date() })
    .where(eq(projectRevenueCatConnections.projectId, connection.projectId))
    .catch((err) => console.error('[revenuecat/webhook] lastEventAt update failed:', err));

  if (!rcEvent?.id) {
    return NextResponse.json({ ok: true, ignored: 'no_event_id' });
  }

  const canonical = normalize(rcEvent);
  if (!canonical) {
    return NextResponse.json({ ok: true, ignored: rcEvent.type ?? 'unknown' });
  }

  // Older generated apps tag their customers bfp_<projectId>__<their user id>.
  // A tag naming a different project means the event is not this project's.
  const appUserId = (canonical.data.appUserId as string | null) ?? null;
  const taggedProjectId = parseProjectIdFromAppUserId(appUserId);
  if (taggedProjectId && taggedProjectId !== connection.projectId) {
    return NextResponse.json({ ok: true, ignored: 'other_project' });
  }

  // Deliver the STRIPPED app user id (the value the app passed to RevenueCat),
  // so the app's billing code can match its own users. Keep the raw id too.
  canonical.data.rawAppUserId = appUserId;
  canonical.data.appUserId = stripNamespacedAppUserId(appUserId);

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, connection.projectId), eq(projects.revenuecatStatus, 'connected')))
    .limit(1);
  if (!project) {
    return NextResponse.json({ ok: true, ignored: 'project_disconnected' });
  }

  // First production event ratchets the project out of 'sandbox' — the tab
  // otherwise shows "sandbox" forever, since nothing else ever wrote this.
  if (canonical.data.environment === 'PRODUCTION') {
    await db
      .update(projects)
      .set({ revenuecatEnvironment: 'production', updatedAt: new Date() })
      .where(and(eq(projects.id, project.id), ne(projects.revenuecatEnvironment, 'production')))
      .catch((err) => console.error('[revenuecat/webhook] environment ratchet failed:', err));
  }

  const delivery = await recordAndDeliver({
    project,
    eventId: canonical.id,
    canonicalType: canonical.type,
    payload: JSON.stringify(canonical),
  });

  return NextResponse.json({
    ok: true,
    type: canonical.type,
    deliveries: 1,
    failed: delivery.ok ? 0 : 1,
  });
}
