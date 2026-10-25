/**
 * Durable Stripe→app delivery retries: a paid event is delivered exactly
 * once even with overlapping cron runs, backs off on failure, and is
 * eventually marked exhausted instead of retrying forever.
 */
import { http, HttpResponse } from 'msw';
import { eq } from 'drizzle-orm';
import { describe, expect, test, vi } from 'vitest';
import { stripeWebhookDeliveries } from '@/db/schema';
import { MAX_DELIVERY_ATTEMPTS } from '@/lib/webhook-delivery';
import { currentTestDb, setupTestDb, snapshotDb } from '@/test/db';
import { createProject } from '@/test/factories';
import { server } from '@/test/network';
import { callRoute } from '@/test/route';
import { GET } from './route';

vi.hoisted(() => {
  process.env.CRON_SECRET = 'cron-secret';
});

setupTestDb();

const run = (auth = 'Bearer cron-secret') =>
  callRoute(GET as never, { path: '/api/cron/retry-stripe-deliveries', headers: { authorization: auth } });

function mockSite(status = 200) {
  const hits: string[] = [];
  server.use(
    http.post('https://app.convex.site/stripe/webhook', async ({ request }) => {
      hits.push(await request.text());
      return new HttpResponse(null, { status });
    }),
  );
  return hits;
}

async function row(overrides: Partial<typeof stripeWebhookDeliveries.$inferInsert> = {}) {
  const p = await createProject({
    userId: 'owner',
    stripeWebhookSecret: 'whsec_p',
    convexDeployUrl: 'https://app.convex.cloud',
  });
  const [r] = await currentTestDb()
    .insert(stripeWebhookDeliveries)
    .values({
      eventId: `evt_${Math.random().toString(36).slice(2)}`,
      projectId: p.id,
      canonicalType: 'payment.succeeded',
      mode: 'test',
      payload: '{"type":"payment.succeeded"}',
      status: 'failed',
      attempts: 1,
      nextAttemptAt: new Date(Date.now() - 1000),
      ...overrides,
    })
    .returning();
  return r;
}

async function reload(id: string) {
  const [r] = await currentTestDb().select().from(stripeWebhookDeliveries).where(eq(stripeWebhookDeliveries.id, id));
  return r;
}

describe('retry-stripe-deliveries cron', () => {
  test.each(['', 'Bearer nope', 'cron-secret'])('authorization %j → 401, nothing touched', async (auth) => {
    await row();
    const hits = mockSite();
    const before = await snapshotDb();
    expect((await run(auth)).status).toBe(401);
    expect(hits).toEqual([]);
    expect(await snapshotDb()).toEqual(before);
  });

  test('due failed row is delivered once and marked delivered', async () => {
    const r = await row();
    const hits = mockSite();
    await run();
    expect(hits).toHaveLength(1);
    expect(await reload(r.id)).toMatchObject({ status: 'delivered', attempts: 2 });
  });

  test('two overlapping cron runs deliver each due row exactly once', async () => {
    const rows = await Promise.all([row(), row(), row(), row(), row()]);
    const hits = mockSite();
    await Promise.all([run(), run(), run()]);
    expect(hits).toHaveLength(rows.length);
    for (const r of rows) expect((await reload(r.id)).status).toBe('delivered');
  });

  test.each([
    ['not yet due', { nextAttemptAt: new Date(Date.now() + 60_000) }],
    ['already delivered', { status: 'delivered' }],
    ['exhausted', { status: 'exhausted' }],
    ['pending, still leased by the inbound receiver', { status: 'pending', nextAttemptAt: new Date(Date.now() + 60_000) }],
  ])('%s → untouched', async (_l, overrides) => {
    const r = await row(overrides as never);
    const hits = mockSite();
    const before = await reload(r.id);
    await run();
    expect(hits).toEqual([]);
    expect(await reload(r.id)).toEqual(before);
  });

  test('pending row whose lease expired (receiver crashed) is reclaimed', async () => {
    const r = await row({ status: 'pending', attempts: 0, nextAttemptAt: new Date(Date.now() - 1) });
    const hits = mockSite();
    await run();
    expect(hits).toHaveLength(1);
    expect((await reload(r.id)).status).toBe('delivered');
  });

  test('failure backs off and counts the attempt', async () => {
    const r = await row({ attempts: 1 });
    mockSite(503);
    const t0 = Date.now();
    await run();
    const after = await reload(r.id);
    expect(after).toMatchObject({ status: 'failed', attempts: 2, lastStatus: 503 });
    expect(after.nextAttemptAt.getTime()).toBeGreaterThan(t0);
  });

  test('gives up as exhausted at MAX_DELIVERY_ATTEMPTS', async () => {
    const r = await row({ attempts: MAX_DELIVERY_ATTEMPTS - 1 });
    mockSite(500);
    await run();
    expect(await reload(r.id)).toMatchObject({ status: 'exhausted', attempts: MAX_DELIVERY_ATTEMPTS });
  });

  test('project missing its backend keeps retrying (user may be mid-setup)', async () => {
    const r = await row();
    await currentTestDb()
      .update(stripeWebhookDeliveries)
      .set({ status: 'failed' })
      .where(eq(stripeWebhookDeliveries.id, r.id));
    const { projects } = await import('@/db/schema');
    await currentTestDb().update(projects).set({ convexDeployUrl: null }).where(eq(projects.id, r.projectId));
    await run();
    expect(await reload(r.id)).toMatchObject({ status: 'failed', lastError: 'no_convex_site', attempts: 2 });
  });
});
