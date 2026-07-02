/**
 * GET /api/projects/[id]/revenuecat/activity
 *
 * The payments tab's activity feed: recent entitlement events the platform
 * routed to THIS project, read from the revenuecat_webhook_deliveries outbox
 * (no RevenueCat API calls). Doubles as delivery debugging — each row carries
 * whether the signed delivery reached the app's Convex backend.
 *
 * Test Store / sandbox purchases land here exactly like production ones (with
 * environment 'SANDBOX'), which is what makes this the dev-loop feedback view:
 * make a simulated purchase in the streamed simulator, watch it arrive.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { projects, revenueCatWebhookDeliveries } from '@/db/schema';
import { REVENUECAT_ENABLED } from '@/lib/feature-flags';

export const runtime = 'nodejs';
export const maxDuration = 15;

const LIMIT = 50;

interface ActivityItem {
  id: string;
  eventId: string;
  type: string; // canonical: entitlement.granted | .revoked | .cancellation | billing.issue
  productId: string | null;
  price: number | null;
  currency: string | null;
  environment: string | null; // 'SANDBOX' (incl. Test Store) | 'PRODUCTION'
  store: string | null;
  appUserId: string | null;
  rcEventType: string | null;
  delivery: { status: string; attempts: number; lastError: string | null };
  at: string;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!REVENUECAT_ENABLED) {
    return NextResponse.json(
      { ok: false, error: 'RevenueCat is not enabled on this deployment.' },
      { status: 404 },
    );
  }

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id: projectId } = await params;
  const db = getDb();
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project) {
    return NextResponse.json({ ok: false, error: 'Project not found' }, { status: 404 });
  }

  const rows = await db
    .select()
    .from(revenueCatWebhookDeliveries)
    .where(eq(revenueCatWebhookDeliveries.projectId, projectId))
    .orderBy(desc(revenueCatWebhookDeliveries.createdAt))
    .limit(LIMIT);

  const items: ActivityItem[] = rows.map((row) => {
    let data: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.payload) as { data?: Record<string, unknown> };
      data = parsed.data ?? {};
    } catch {
      /* keep empty — still show the event row */
    }
    return {
      id: row.id,
      eventId: row.eventId,
      type: row.canonicalType,
      productId: (data.productId as string | null) ?? null,
      price: (data.price as number | null) ?? null,
      currency: (data.currency as string | null) ?? null,
      environment: (data.environment as string | null) ?? null,
      store: (data.store as string | null) ?? null,
      appUserId: (data.appUserId as string | null) ?? null,
      rcEventType: (data.rcEventType as string | null) ?? null,
      delivery: { status: row.status, attempts: row.attempts, lastError: row.lastError },
      at: row.createdAt.toISOString(),
    };
  });

  return NextResponse.json({ ok: true, items });
}
