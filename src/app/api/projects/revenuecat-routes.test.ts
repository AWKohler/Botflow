/**
 * The Payments tab's routes: connect (one pasted key), status (the setup
 * health list, including whether the app's backend is really listening),
 * products and disconnect.
 */
import { http, HttpResponse } from 'msw';
import { describe, expect, test, vi } from 'vitest';
import { projectRevenueCatConnections } from '@/db/schema';
import { createUser, signInAs, signOut } from '@/test/auth';
import { currentTestDb, setupTestDb } from '@/test/db';
import { addMember, createProject } from '@/test/factories';
import { server } from '@/test/network';
import { fakeRevenueCat } from '@/test/revenuecat-fake';
import { callRoute, readJson } from '@/test/route';
import { markAgentWaitingForConnect } from '@/lib/revenuecat-connection';

const background = vi.hoisted(() => {
  process.env.REVENUECAT_ENABLED = 'true';
  process.env.NEXT_PUBLIC_SHARING_ENABLED = 'true';
  process.env.SECRETS_ENCRYPTION_KEY = 'test-secrets-encryption-key-0123456789abcdef';
  process.env.NEXT_PUBLIC_APP_URL = 'https://botflow.test';
  return { tasks: [] as Array<() => unknown>, scaffolded: [] as string[], materialized: [] as string[] };
});

// Background work (`after`) is collected instead of run: these tests are about
// the response and the stored connection; the sandbox writes have their own.
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (task: () => unknown) => void background.tasks.push(task),
}));
vi.mock('@/lib/revenuecat-scaffold', () => ({
  scaffoldRevenueCatIntoProject: async (id: string) => {
    background.scaffolded.push(id);
    return { filesWritten: [], envSet: true, routeWired: true };
  },
}));
vi.mock('@/lib/sandbox-env', () => ({
  materializeSwiftRevenueCatConfig: async (id: string) => void background.materialized.push(id),
}));

const connectRoute = await import('./[id]/revenuecat/connect/route');
const statusRoute = await import('./[id]/revenuecat/status/route');
const productsRoute = await import('./[id]/revenuecat/products/route');
const disconnectRoute = await import('./[id]/revenuecat/disconnect/route');

setupTestDb();

const OWNER = 'owner_pro';
const EDITOR = 'editor_user';

async function proOwner() {
  await createUser({ id: OWNER, plan: 'pro' });
  await signInAs(OWNER);
}

async function swiftProject(overrides: Record<string, unknown> = {}) {
  return createProject({
    userId: OWNER,
    name: 'StreakPal',
    platform: 'swift',
    backendType: 'user',
    userConvexUrl: 'https://happy-otter-1.convex.cloud',
    ...overrides,
  });
}

/** What the app's backend answers to the unsigned liveness probe. */
function backendAnswers(status: number) {
  server.use(
    http.post('https://happy-otter-1.convex.site/revenuecat/webhook', () => new HttpResponse('x', { status })),
  );
}

const connect = (id: string, body: unknown) =>
  callRoute(connectRoute.POST, { method: 'POST', params: { id }, body });
const status = (id: string, method: 'GET' | 'POST' = 'GET') =>
  callRoute(method === 'GET' ? statusRoute.GET : statusRoute.POST, { method, params: { id } });

describe('POST revenuecat/connect', () => {
  test('one pasted key connects the project', async () => {
    await proOwner();
    fakeRevenueCat();
    const p = await swiftProject();
    const res = await connect(p.id, { rcSecretKey: 'sk_full' });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({
      ok: true,
      status: 'connected',
      projectName: 'StreakPal',
      testStoreReady: true,
      appStoreReady: false,
      webhook: 'created',
      agentThread: null,
    });
    // The backend receiver and the Swift key file are (re)written afterwards.
    expect(background.tasks.length).toBeGreaterThan(0);
  });

  test('tells the workspace which chat asked for payments', async () => {
    await proOwner();
    fakeRevenueCat();
    const p = await swiftProject({ revenuecatStatus: 'connecting' });
    await markAgentWaitingForConnect(p.id, 'thread_123');
    const body = await readJson(await connect(p.id, { rcSecretKey: 'sk_full' }));
    expect(body.agentThread).toBe('thread_123');
    // Delivered once: a later reconnect does not nudge the agent again.
    const again = await readJson(await connect(p.id, { rcSecretKey: 'sk_full' }));
    expect(again.agentThread).toBeNull();
  });

  test.each([
    ['nothing pasted', {}, 'not-secret-key'],
    ['an SDK key', { rcSecretKey: 'appl_abc' }, 'not-secret-key'],
    ['a V1 key', { rcSecretKey: 'sk_legacy' }, 'legacy-key'],
    ['a read-only key', { rcSecretKey: 'sk_readonly' }, 'read-only'],
  ])('%s → 400 with a code and no connection', async (_label, body, code) => {
    await proOwner();
    fakeRevenueCat();
    const p = await swiftProject();
    const res = await connect(p.id, body);
    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({ ok: false, code });
    expect(await currentTestDb().select().from(projectRevenueCatConnections)).toEqual([]);
  });

  test('the Free plan is refused before RevenueCat is contacted', async () => {
    await createUser({ id: OWNER });
    await signInAs(OWNER);
    const rc = fakeRevenueCat();
    const p = await swiftProject();
    const res = await connect(p.id, { rcSecretKey: 'sk_full' });
    expect(res.status).toBe(402);
    expect(rc.calls).toEqual([]);
  });

  test.each([
    ['a web project', { platform: 'sandboxed-web' }],
    ['a Swift project without a backend', { backendType: 'none' }],
  ])('%s cannot connect', async (_label, overrides) => {
    await proOwner();
    const rc = fakeRevenueCat();
    const p = await swiftProject(overrides);
    const res = await connect(p.id, { rcSecretKey: 'sk_full' });
    expect(res.status).toBe(400);
    expect(rc.calls).toEqual([]);
  });

  test('signed out → 401', async () => {
    await proOwner();
    const p = await swiftProject();
    signOut();
    expect((await connect(p.id, { rcSecretKey: 'sk_full' })).status).toBe(401);
  });
});

describe('GET revenuecat/status', () => {
  test('before connecting: nothing checked, no secrets', async () => {
    await proOwner();
    const p = await swiftProject();
    const body = await readJson(await status(p.id));
    expect(body).toMatchObject({
      status: 'none',
      connection: null,
      manualWebhook: null,
      checks: { key: { ok: false, error: null }, testStore: { ok: false }, backend: { state: 'unknown' } },
    });
  });

  test('connected and deployed: everything green', async () => {
    await proOwner();
    const rc = fakeRevenueCat();
    const p = await swiftProject();
    await connect(p.id, { rcSecretKey: 'sk_full' });
    backendAnswers(401); // the deployed receiver rejects an unsigned request
    const body = await readJson(await status(p.id));
    expect(body).toMatchObject({
      status: 'connected',
      role: 'owner',
      connection: { rcProjectId: rc.projectId, rcProjectName: 'StreakPal' },
      checks: {
        key: { ok: true, error: null },
        testStore: { ok: true },
        appStore: { ok: false },
        webhook: { mode: 'automatic', ok: true },
        backend: { state: 'live' },
      },
      manualWebhook: null,
      links: { apiKeys: 'https://app.revenuecat.com/projects/1a2b3c4d/api-keys' },
    });
  });

  test.each([
    [404, 'not-deployed'],
    [500, 'not-configured'],
    [503, 'unknown'],
  ] as const)('backend answering %i → %s', async (code, state) => {
    await proOwner();
    fakeRevenueCat();
    const p = await swiftProject();
    await connect(p.id, { rcSecretKey: 'sk_full' });
    backendAnswers(code);
    const body = await readJson<{ checks: { backend: { state: string } } }>(await status(p.id));
    expect(body.checks.backend.state).toBe(state);
  });

  test('a key deleted in RevenueCat shows as broken, with advice', async () => {
    await proOwner();
    const rc = fakeRevenueCat();
    const p = await swiftProject();
    await connect(p.id, { rcSecretKey: 'sk_full' });
    rc.keys.delete('sk_full');
    backendAnswers(401);
    const body = await readJson<{ checks: { key: { ok: boolean; error: string } } }>(await status(p.id));
    expect(body.checks.key.ok).toBe(false);
    expect(body.checks.key.error).toMatch(/does not recognise/);
  });

  test('when the webhook had to be added by hand, only the owner gets its credential', async () => {
    await proOwner();
    await createUser({ id: EDITOR });
    const rc = fakeRevenueCat();
    const p = await swiftProject();
    await connect(p.id, { rcSecretKey: 'sk_full' });
    // Simulate "Botflow could not create the webhook": no integration id stored.
    await currentTestDb().update(projectRevenueCatConnections).set({ rcWebhookIntegrationId: null });
    rc.webhooks.length = 0;
    await addMember(p.id, EDITOR);
    backendAnswers(401);

    const owner = await readJson<{ manualWebhook: { url: string; authorizationHeader: string } }>(await status(p.id));
    expect(owner.manualWebhook.url).toBe('https://botflow.test/api/webhooks/revenuecat');
    expect(owner.manualWebhook.authorizationHeader).toMatch(/^bfrcin_/);

    await signInAs(EDITOR);
    const editor = await readJson(await status(p.id));
    expect(editor).toMatchObject({ role: 'editor', manualWebhook: null });
    expect(JSON.stringify(editor)).not.toContain('bfrcin_');
  });

  test('"Check again" (POST) repairs the webhook and rewrites the project files', async () => {
    await proOwner();
    const rc = fakeRevenueCat();
    const p = await swiftProject();
    await connect(p.id, { rcSecretKey: 'sk_full' });
    rc.webhooks.length = 0;
    background.scaffolded.length = 0;
    backendAnswers(401);

    const body = await readJson(await status(p.id, 'POST'));
    expect(body).toMatchObject({ checks: { webhook: { mode: 'automatic', ok: true } } });
    expect(rc.webhooks).toHaveLength(1);
    expect(background.scaffolded).toEqual([p.id]);
  });
});

describe('revenuecat/products', () => {
  test('not connected → 409 needs-connect', async () => {
    await proOwner();
    const p = await swiftProject();
    const res = await callRoute(productsRoute.GET, { params: { id: p.id } });
    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({ status: 'needs-connect' });
  });

  test('create then read: the catalog is ready for a test purchase', async () => {
    await proOwner();
    fakeRevenueCat();
    const p = await swiftProject();
    await connect(p.id, { rcSecretKey: 'sk_full' });

    const created = await callRoute(productsRoute.POST, {
      method: 'POST',
      params: { id: p.id },
      body: { storeIdentifier: 'pro_monthly', type: 'subscription', priceUsd: 4.99, entitlement: 'pro', package: '$rc_monthly' },
    });
    expect(created.status).toBe(200);
    expect(await readJson(created)).toMatchObject({ ok: true, testStore: { price: '$4.99' } });

    const read = await readJson<{ catalog: { readyForTestPurchases: boolean; issues: unknown[] } }>(
      await callRoute(productsRoute.GET, { params: { id: p.id } }),
    );
    expect(read.catalog.readyForTestPurchases).toBe(true);
    expect(read.catalog.issues).toEqual([]);
  });

  test('bad input → 400 before any RevenueCat write', async () => {
    await proOwner();
    const rc = fakeRevenueCat();
    const p = await swiftProject();
    await connect(p.id, { rcSecretKey: 'sk_full' });
    const writes = rc.writes();
    const res = await callRoute(productsRoute.POST, {
      method: 'POST',
      params: { id: p.id },
      body: { storeIdentifier: 'bad id!', type: 'subscription' },
    });
    expect(res.status).toBe(400);
    expect(rc.writes()).toBe(writes);
  });
});

describe('POST revenuecat/disconnect', () => {
  test('removes the key and the webhook, and the status goes back to setup', async () => {
    await proOwner();
    const rc = fakeRevenueCat();
    const p = await swiftProject();
    await connect(p.id, { rcSecretKey: 'sk_full' });

    const res = await callRoute(disconnectRoute.POST, { method: 'POST', params: { id: p.id } });
    expect(await readJson(res)).toEqual({ ok: true, status: 'none', webhookRemoved: true });
    expect(rc.webhooks).toEqual([]);
    expect(await currentTestDb().select().from(projectRevenueCatConnections)).toEqual([]);
    expect(await readJson(await status(p.id))).toMatchObject({ status: 'none', connection: null });
  });
});
