/**
 * POST /api/webhooks/revenuecat
 *
 * Platform-level RevenueCat webhook receiver. RevenueCat sends subscription /
 * entitlement lifecycle events here. Auth is a shared Authorization header the
 * user pastes into their RevenueCat dashboard (we generate it per-user as
 * user_revenuecat_identity.rc_inbound_webhook_secret). We then:
 *
 *   1. Authenticate by matching the Authorization header to a Botflow user.
 *   2. Claim the event by INSERTing into revenuecat_webhook_events. PK conflict
 *      = already processed → 200 (RevenueCat retries up to 5×, reusing the id).
 *   3. Normalize to a small canonical entitlement vocabulary.
 *   4. Fan out to each of the user's RevenueCat-connected projects' Convex HTTP
 *      endpoint, HMAC-signed with the project's revenuecat_webhook_secret.
 *
 * Mirrors src/app/api/webhooks/stripe/route.ts. Returns 401 only when the
 * Authorization header doesn't match (so a misconfigured webhook is visible);
 * after that, always 200 — we own the retry budget from here.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import {
  projects,
  revenueCatWebhookEvents,
  userRevenueCatIdentity,
} from '@/db/schema';
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

// ─── Fan-out to project Convex sites ──────────────────────────────────────

function convexSiteUrlFor(project: typeof projects.$inferSelect): string | null {
  const deployUrl = project.userConvexUrl ?? project.convexDeployUrl;
  if (!deployUrl) return null;
  return deployUrl.replace('.convex.cloud', '.convex.site');
}

async function deliverWithRetry(opts: {
  url: string;
  signature: string;
  body: string;
}): Promise<{ ok: boolean; lastStatus?: number; lastError?: string }> {
  const delays = [200, 1000, 5000];
  let lastStatus: number | undefined;
  let lastError: string | undefined;
  for (let i = 0; i < delays.length; i++) {
    try {
      const res = await fetch(opts.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Botflow-Signature': opts.signature,
        },
        body: opts.body,
        signal: AbortSignal.timeout(8000),
      });
      lastStatus = res.status;
      if (res.ok) return { ok: true, lastStatus };
      lastError = (await res.text()).slice(0, 300);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (i < delays.length - 1) {
      await new Promise((r) => setTimeout(r, delays[i + 1]));
    }
  }
  return {
    ok: false,
    ...(lastStatus !== undefined ? { lastStatus } : {}),
    ...(lastError ? { lastError } : {}),
  };
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

  // Authenticate: which Botflow user owns this inbound secret?
  const identities = await db
    .select({
      userId: userRevenueCatIdentity.userId,
      secret: userRevenueCatIdentity.rcInboundWebhookSecret,
    })
    .from(userRevenueCatIdentity);
  const identity = identities.find(
    (row) => row.secret && constantTimeEqual(authHeader, row.secret),
  );
  if (!identity) {
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
  if (!rcEvent?.id) {
    return NextResponse.json({ ok: true, ignored: 'no_event_id' });
  }

  // Claim the event — PK conflict = already processed → 200.
  try {
    await db.insert(revenueCatWebhookEvents).values({ eventId: rcEvent.id });
  } catch {
    return NextResponse.json({ ok: true, dedup: true });
  }

  const canonical = normalize(rcEvent);
  if (!canonical) {
    return NextResponse.json({ ok: true, ignored: rcEvent.type ?? 'unknown' });
  }

  // Fan out to all of this user's RevenueCat-connected projects. A user may run
  // several apps under one RevenueCat project, so each project's billing.ts
  // decides relevance by app_user_id.
  const projectRows = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.userId, identity.userId),
        eq(projects.revenuecatStatus, 'connected'),
      ),
    );

  const payload = JSON.stringify(canonical);
  const deliveries = await Promise.all(
    projectRows.map(async (project) => {
      if (!project.revenuecatWebhookSecret) {
        return { projectId: project.id, ok: false, reason: 'no_secret' };
      }
      const siteUrl = convexSiteUrlFor(project);
      if (!siteUrl) {
        return { projectId: project.id, ok: false, reason: 'no_convex_site' };
      }
      const signature = createHmac('sha256', project.revenuecatWebhookSecret)
        .update(payload)
        .digest('hex');
      const result = await deliverWithRetry({
        url: `${siteUrl}/revenuecat/webhook`,
        signature,
        body: payload,
      });
      if (!result.ok) {
        console.error(
          '[revenuecat/webhook] fan-out failed',
          project.id,
          'lastStatus=',
          result.lastStatus,
          'lastError=',
          result.lastError,
        );
      }
      return {
        projectId: project.id,
        ok: result.ok,
        ...(result.lastStatus !== undefined ? { lastStatus: result.lastStatus } : {}),
      };
    }),
  );

  return NextResponse.json({
    ok: true,
    type: canonical.type,
    deliveries: deliveries.length,
    failed: deliveries.filter((d) => !d.ok).length,
  });
}
