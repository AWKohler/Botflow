/**
 * Platform Stripe Connect webhook: signature gate, idempotency, and — the
 * money/privacy-critical part — routing each payment event to exactly the one
 * project that owns it, never to another tenant or another of the owner's apps.
 */
import { createHmac } from 'node:crypto';
import { http, HttpResponse } from 'msw';
import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { describe, expect, test, vi } from 'vitest';
import { stripeWebhookDeliveries, userStripeIdentity } from '@/db/schema';
import { currentTestDb, setupTestDb, snapshotDb } from '@/test/db';
import { createProject } from '@/test/factories';
import { server } from '@/test/network';
import { callRoute } from '@/test/route';
import { POST } from './route';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STRIPE_CONNECT_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY_TEST = 'sk_test_dummy';
  process.env.STRIPE_SECRET_KEY_LIVE = 'sk_live_dummy';
  process.env.STRIPE_WEBHOOK_SECRET_TEST = 'whsec_test_platform';
  process.env.STRIPE_WEBHOOK_SECRET_LIVE = 'whsec_live_platform';
});

setupTestDb();

const stripe = new Stripe('sk_test_dummy');
const ACCT_A = 'acct_owner_a';

type SiteHit = { project: string; body: string; headers: Headers };

/** Each project gets its own Convex site; record every delivery. */
function mockConvexSites(status = 200) {
  const hits: SiteHit[] = [];
  server.use(
    http.post('https://:site.convex.site/stripe/webhook', async ({ request, params }) => {
      hits.push({ project: String(params.site), body: await request.text(), headers: request.headers });
      return new HttpResponse(null, { status });
    }),
  );
  return hits;
}

async function stripeProject(userId: string, site: string, overrides: Record<string, unknown> = {}) {
  return createProject({
    userId,
    stripeEnabled: true,
    stripePaymentMode: 'test',
    stripeWebhookSecret: `whsec_project_${site}`,
    convexDeployUrl: `https://${site}.convex.cloud`,
    ...overrides,
  });
}

async function linkAccount(userId: string, testAccountId: string) {
  await currentTestDb().insert(userStripeIdentity).values({ userId, testAccountId });
}

function event(type: string, object: Record<string, unknown>, opts: { id?: string; account?: string } = {}) {
  return {
    id: opts.id ?? `evt_${Math.random().toString(36).slice(2)}`,
    object: 'event',
    type,
    account: opts.account ?? ACCT_A,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  };
}

function paymentSucceeded(projectId: string | null, opts: { id?: string; account?: string; paid?: boolean } = {}) {
  return event(
    'checkout.session.completed',
    {
      id: 'cs_1',
      object: 'checkout.session',
      payment_status: opts.paid === false ? 'unpaid' : 'paid',
      amount_total: 500,
      currency: 'usd',
      customer: 'cus_1',
      payment_intent: 'pi_1',
      metadata: projectId ? { botflow_project_id: projectId } : {},
    },
    opts,
  );
}

async function send(payload: object, opts: { secret?: string; timestamp?: number; header?: string | null } = {}) {
  const body = JSON.stringify(payload);
  const header =
    opts.header !== undefined
      ? opts.header
      : stripe.webhooks.generateTestHeaderString({
          payload: body,
          secret: opts.secret ?? 'whsec_test_platform',
          ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
        });
  return callRoute(POST, {
    method: 'POST',
    path: '/api/webhooks/stripe',
    body,
    headers: { 'content-type': 'application/json', ...(header ? { 'stripe-signature': header } : {}) },
  });
}

async function deliveries() {
  return currentTestDb().select().from(stripeWebhookDeliveries);
}

describe('signature gate', () => {
  test.each([
    ['missing header', { header: null }],
    ['garbage header', { header: 't=1,v1=deadbeef' }],
    ['signed with an unknown secret', { secret: 'whsec_attacker' }],
    ['signed with a project (not platform) secret', { secret: 'whsec_project_a' }],
    ['stale timestamp (replayed capture, >5 min old)', { timestamp: Math.floor(Date.now() / 1000) - 600 }],
  ])('%s → 400, nothing recorded or delivered', async (_label, opts) => {
    const p = await stripeProject('owner_a', 'a');
    await linkAccount('owner_a', ACCT_A);
    const hits = mockConvexSites();
    const before = await snapshotDb();
    const res = await send(paymentSucceeded(p.id), opts);
    expect(res.status).toBe(400);
    expect(hits).toEqual([]);
    expect(await snapshotDb()).toEqual(before);
  });

  test('a body altered after signing is rejected', async () => {
    const p = await stripeProject('owner_a', 'a');
    await linkAccount('owner_a', ACCT_A);
    const hits = mockConvexSites();
    const original = JSON.stringify(paymentSucceeded(p.id));
    const header = stripe.webhooks.generateTestHeaderString({ payload: original, secret: 'whsec_test_platform' });
    const res = await callRoute(POST, {
      method: 'POST',
      body: original.replace('"amount_total":500', '"amount_total":50000'),
      headers: { 'stripe-signature': header, 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect(hits).toEqual([]);
  });
});

describe('routing', () => {
  test('payment goes to exactly the project named in metadata, signed with that project secret', async () => {
    const a = await stripeProject('owner_a', 'a');
    await stripeProject('owner_a', 'a2'); // owner's other app on the same account
    await linkAccount('owner_a', ACCT_A);
    const hits = mockConvexSites();

    const res = await send(paymentSucceeded(a.id));
    expect(res.status).toBe(200);
    expect(hits.map((h) => h.project)).toEqual(['a']);

    const body = hits[0].body;
    const ts = hits[0].headers.get('x-botflow-timestamp');
    const expected = createHmac('sha256', 'whsec_project_a').update(`${ts}.${body}`).digest('hex');
    expect(hits[0].headers.get('x-botflow-signature-v2')).toBe(expected);
    expect(JSON.parse(body)).toMatchObject({ type: 'payment.succeeded', data: { amountTotal: 500 } });

    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ projectId: a.id, status: 'delivered' });
  });

  test("metadata naming ANOTHER tenant's project is dropped (cross-tenant injection)", async () => {
    // Owner A controls their connected account and can set any metadata.
    await stripeProject('owner_a', 'a');
    const victim = await stripeProject('owner_b', 'b');
    await linkAccount('owner_a', ACCT_A);
    await linkAccount('owner_b', 'acct_owner_b');
    const hits = mockConvexSites();

    const res = await send(paymentSucceeded(victim.id));
    expect(res.status).toBe(200);
    expect(hits).toEqual([]);
    expect(await deliveries()).toEqual([]);
  });

  test("metadata naming the owner's project in the other mode is dropped", async () => {
    const live = await stripeProject('owner_a', 'a', { stripePaymentMode: 'live' });
    await linkAccount('owner_a', ACCT_A);
    const hits = mockConvexSites();
    await send(paymentSucceeded(live.id)); // signed with the TEST platform secret
    expect(hits).toEqual([]);
  });

  test('payment for a project with Stripe disabled is dropped', async () => {
    const p = await stripeProject('owner_a', 'a', { stripeEnabled: false });
    await linkAccount('owner_a', ACCT_A);
    const hits = mockConvexSites();
    await send(paymentSucceeded(p.id));
    expect(hits).toEqual([]);
  });

  test('event from an account no Botflow user linked is ignored', async () => {
    const p = await stripeProject('owner_a', 'a');
    const hits = mockConvexSites();
    const res = await send(paymentSucceeded(p.id, { account: 'acct_unknown' }));
    expect(res.status).toBe(200);
    expect(hits).toEqual([]);
  });

  test('metadata-less follow-up routes via the subscription→project map, not broadcast', async () => {
    const a = await stripeProject('owner_a', 'a');
    await stripeProject('owner_a', 'a2');
    await linkAccount('owner_a', ACCT_A);
    const hits = mockConvexSites();

    const sub = (md: Record<string, string>) => ({
      id: 'sub_1',
      object: 'subscription',
      customer: 'cus_1',
      status: 'active',
      items: { data: [{ price: { id: 'price_1' } }] },
      metadata: md,
    });
    await send(event('customer.subscription.created', sub({ botflow_project_id: a.id })));
    await send(event('customer.subscription.deleted', sub({})));

    expect(hits.map((h) => h.project)).toEqual(['a', 'a']);
  });

  test("unattributable payment (no metadata, no map) is dropped rather than broadcast", async () => {
    await stripeProject('owner_a', 'a');
    await stripeProject('owner_a', 'a2');
    await linkAccount('owner_a', ACCT_A);
    const hits = mockConvexSites();
    await send(paymentSucceeded(null));
    expect(hits).toEqual([]);
  });

  test("account.updated reaches only the owner's same-mode Stripe projects", async () => {
    await stripeProject('owner_a', 'a');
    await stripeProject('owner_a', 'a2');
    await stripeProject('owner_a', 'alive', { stripePaymentMode: 'live' });
    await stripeProject('owner_a', 'aoff', { stripeEnabled: false });
    await stripeProject('owner_b', 'b');
    await linkAccount('owner_a', ACCT_A);
    const hits = mockConvexSites();
    await send(event('account.updated', { id: ACCT_A, object: 'account', charges_enabled: true }));
    expect(hits.map((h) => h.project).sort()).toEqual(['a', 'a2']);
  });
});

describe('exactly one fulfillment per payment', () => {
  test('payment_intent.succeeded is ignored (checkout.session.completed is the signal)', async () => {
    const a = await stripeProject('owner_a', 'a');
    await linkAccount('owner_a', ACCT_A);
    const hits = mockConvexSites();
    await send(
      event('payment_intent.succeeded', {
        id: 'pi_1',
        object: 'payment_intent',
        amount: 500,
        currency: 'usd',
        metadata: { botflow_project_id: a.id },
      }),
    );
    expect(hits).toEqual([]);
  });

  test('async checkout: unpaid completed → nothing; async_payment_succeeded → one payment', async () => {
    const a = await stripeProject('owner_a', 'a');
    await linkAccount('owner_a', ACCT_A);
    const hits = mockConvexSites();
    await send(paymentSucceeded(a.id, { paid: false }));
    expect(hits).toEqual([]);
    const later = paymentSucceeded(a.id);
    later.type = 'checkout.session.async_payment_succeeded';
    await send(later);
    expect(hits.map((h) => JSON.parse(h.body).type)).toEqual(['payment.succeeded']);
  });
});

describe('durability', () => {
  test('Stripe re-delivering the same event id delivers once', async () => {
    const a = await stripeProject('owner_a', 'a');
    await linkAccount('owner_a', ACCT_A);
    const hits = mockConvexSites();
    const evt = paymentSucceeded(a.id, { id: 'evt_dup' });
    await send(evt);
    await send(evt);
    await send(evt);
    expect(hits).toHaveLength(1);
    expect(await deliveries()).toHaveLength(1);
  });

  test('down Convex backend → 200 to Stripe, row queued for retry (never lost)', async () => {
    const a = await stripeProject('owner_a', 'a');
    await linkAccount('owner_a', ACCT_A);
    mockConvexSites(503);
    const res = await send(paymentSucceeded(a.id));
    expect(res.status).toBe(200);
    const [row] = await deliveries();
    expect(row).toMatchObject({ status: 'failed', attempts: 1, lastStatus: 503 });
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('project without a backend yet → queued, not dropped', async () => {
    const a = await stripeProject('owner_a', 'a', { convexDeployUrl: null });
    await linkAccount('owner_a', ACCT_A);
    const res = await send(paymentSucceeded(a.id));
    expect(res.status).toBe(200);
    const [row] = await currentTestDb()
      .select()
      .from(stripeWebhookDeliveries)
      .where(eq(stripeWebhookDeliveries.projectId, a.id));
    expect(row).toMatchObject({ status: 'failed', lastError: 'no_convex_site' });
  });
});
