/**
 * Platform RevenueCat webhook: per-user Authorization secret, routing by the
 * project-namespaced app_user_id (bfp_<projectId>__<id>), idempotency.
 */
import { createHash } from 'node:crypto';
import { http, HttpResponse } from 'msw';
import { describe, expect, test, vi } from 'vitest';
import { revenueCatWebhookDeliveries, userRevenueCatIdentity } from '@/db/schema';
import {
  buildNamespacedAppUserId,
  parseProjectIdFromAppUserId,
  stripNamespacedAppUserId,
} from '@/lib/revenuecat-app-user-id';
import { currentTestDb, setupTestDb, snapshotDb } from '@/test/db';
import { createProject } from '@/test/factories';
import { server } from '@/test/network';
import { callRoute } from '@/test/route';
import { POST } from './route';

vi.hoisted(() => {
  process.env.REVENUECAT_ENABLED = 'true';
});

setupTestDb();

const SECRET_A = 'Bearer rc_inbound_secret_owner_a';
const SECRET_B = 'Bearer rc_inbound_secret_owner_b';

async function identity(userId: string, secret: string) {
  await currentTestDb()
    .insert(userRevenueCatIdentity)
    .values({
      userId,
      rcInboundWebhookSecret: secret,
      rcInboundWebhookSecretDigest: createHash('sha256').update(secret).digest('hex'),
    });
}

async function rcProject(userId: string, site: string, overrides: Record<string, unknown> = {}) {
  return createProject({
    userId,
    platform: 'swift',
    revenuecatStatus: 'connected',
    revenuecatWebhookSecret: `rc_project_${site}`,
    convexDeployUrl: `https://${site}.convex.cloud`,
    ...overrides,
  });
}

function mockSites() {
  const hits: { site: string; body: Record<string, unknown> }[] = [];
  server.use(
    http.post('https://:site.convex.site/revenuecat/webhook', async ({ request, params }) => {
      hits.push({ site: String(params.site), body: (await request.json()) as Record<string, unknown> });
      return new HttpResponse(null, { status: 200 });
    }),
  );
  return hits;
}

function rcEvent(appUserId: string, overrides: Record<string, unknown> = {}) {
  return {
    event: {
      id: `rcevt_${Math.random().toString(36).slice(2)}`,
      type: 'INITIAL_PURCHASE',
      app_user_id: appUserId,
      product_id: 'pro_monthly',
      entitlement_ids: ['pro'],
      environment: 'SANDBOX',
      ...overrides,
    },
  };
}

function send(body: unknown, auth: string | null = SECRET_A) {
  return callRoute(POST, {
    method: 'POST',
    path: '/api/webhooks/revenuecat',
    body,
    headers: auth ? { authorization: auth } : {},
  });
}

describe('namespaced app_user_id helpers', () => {
  const PID = '0b6a2f9e-6a7c-4b1e-9b3a-5d2f0c1e7a11';

  test('round-trip', () => {
    const id = buildNamespacedAppUserId(PID, 'user_42');
    expect(parseProjectIdFromAppUserId(id)).toBe(PID);
    expect(stripNamespacedAppUserId(id)).toBe('user_42');
  });

  test('app user ids containing the separator survive', () => {
    const id = buildNamespacedAppUserId(PID, 'a__b__c');
    expect(parseProjectIdFromAppUserId(id)).toBe(PID);
    expect(stripNamespacedAppUserId(id)).toBe('a__b__c');
  });

  test.each([
    null,
    '',
    'user_42',
    'bfp_',
    'bfp___user',
    `bfp_${PID}`, // no separator
    'bfp_not-a-uuid__user',
    `bfp_${PID.slice(1)}__user`, // 35 chars
    `xbfp_${PID}__user`,
    `bfp_${PID}x__user`,
  ])('%j routes to no project', (id) => {
    expect(parseProjectIdFromAppUserId(id)).toBeNull();
  });
});

describe('authorization', () => {
  test.each([
    ['missing', null],
    ['wrong', 'Bearer nope'],
    ['prefix of the real secret', SECRET_A.slice(0, -1)],
    ['real secret plus junk', `${SECRET_A}x`],
    ['different case', SECRET_A.toUpperCase()],
  ])('%s Authorization → 401, nothing recorded', async (_label, auth) => {
    await identity('owner_a', SECRET_A);
    const p = await rcProject('owner_a', 'a');
    const hits = mockSites();
    const before = await snapshotDb();
    const res = await send(rcEvent(buildNamespacedAppUserId(p.id, 'u1')), auth);
    expect(res.status).toBe(401);
    expect(hits).toEqual([]);
    expect(await snapshotDb()).toEqual(before);
  });
});

describe('routing', () => {
  test('namespaced event → exactly that project, app user id stripped', async () => {
    await identity('owner_a', SECRET_A);
    const p = await rcProject('owner_a', 'a');
    await rcProject('owner_a', 'a2');
    const hits = mockSites();
    const res = await send(rcEvent(buildNamespacedAppUserId(p.id, 'u1')));
    expect(res.status).toBe(200);
    expect(hits.map((h) => h.site)).toEqual(['a']);
    expect(hits[0].body).toMatchObject({
      type: 'entitlement.granted',
      data: { appUserId: 'u1', rawAppUserId: buildNamespacedAppUserId(p.id, 'u1') },
    });
  });

  test("owner A's secret cannot deliver into owner B's project (cross-tenant)", async () => {
    await identity('owner_a', SECRET_A);
    await identity('owner_b', SECRET_B);
    await rcProject('owner_a', 'a');
    const victim = await rcProject('owner_b', 'b');
    const hits = mockSites();
    const res = await send(rcEvent(buildNamespacedAppUserId(victim.id, 'u1')), SECRET_A);
    expect(res.status).toBe(200);
    expect(hits).toEqual([]);
    expect(await currentTestDb().select().from(revenueCatWebhookDeliveries)).toEqual([]);
  });

  test('disconnected project is not delivered to', async () => {
    await identity('owner_a', SECRET_A);
    const p = await rcProject('owner_a', 'a', { revenuecatStatus: 'none' });
    const hits = mockSites();
    await send(rcEvent(buildNamespacedAppUserId(p.id, 'u1')));
    expect(hits).toEqual([]);
  });

  test("un-namespaced event broadcasts only to this owner's connected projects", async () => {
    await identity('owner_a', SECRET_A);
    await identity('owner_b', SECRET_B);
    await rcProject('owner_a', 'a');
    await rcProject('owner_a', 'a2');
    await rcProject('owner_a', 'aoff', { revenuecatStatus: 'none' });
    await rcProject('owner_b', 'b');
    const hits = mockSites();
    await send(rcEvent('legacy_user'));
    expect(hits.map((h) => h.site).sort()).toEqual(['a', 'a2']);
  });

  test('RevenueCat retries (same event id) deliver once', async () => {
    await identity('owner_a', SECRET_A);
    const p = await rcProject('owner_a', 'a');
    const hits = mockSites();
    const evt = rcEvent(buildNamespacedAppUserId(p.id, 'u1'));
    for (let i = 0; i < 5; i++) await send(evt);
    expect(hits).toHaveLength(1);
  });

  test('malformed JSON → 400 after auth', async () => {
    await identity('owner_a', SECRET_A);
    const res = await callRoute(POST, {
      method: 'POST',
      body: '{not json',
      headers: { authorization: SECRET_A, 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });
});
