/**
 * Env vars & secrets: what each role can see, which keys the platform owns,
 * and what reaches the browser-facing .env.
 */
import { http, HttpResponse } from 'msw';
import { describe, expect, test, vi } from 'vitest';
import { projectEnvVars } from '@/db/schema';
import { RESERVED_ENV_VARS } from '@/lib/platform-env';
import { buildFrontendEnvMap } from '@/lib/sandbox-env';
import { signInAs } from '@/test/auth';
import { currentTestDb, setupTestDb, snapshotDb } from '@/test/db';
import { addMember, createProject } from '@/test/factories';
import { server } from '@/test/network';
import { callRoute } from '@/test/route';
import * as envRoute from './[id]/env/route';
import * as backendEnvRoute from './[id]/env/backend/route';

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SHARING_ENABLED = 'true';
});

// Writing the sandbox .env is a VM side effect; record instead.
const materialized = vi.hoisted(() => [] as string[]);
vi.mock('@/lib/sandbox-env', async (orig) => ({
  ...(await orig<typeof import('@/lib/sandbox-env')>()),
  materializeFrontendEnv: async (id: string) => void materialized.push(id),
}));

setupTestDb();

async function projectWithEnv() {
  const p = await createProject({ userId: 'owner' });
  await addMember(p.id, 'editor');
  await currentTestDb().insert(projectEnvVars).values([
    { projectId: p.id, key: 'VITE_PUBLIC_THING', value: 'public-value', isSecret: false },
    { projectId: p.id, key: 'VITE_STRIPE_KEY', value: 'pk_live_SECRETVALUE', isSecret: true },
    // A reserved key that somehow landed in the table must never surface.
    { projectId: p.id, key: 'VITE_CONVEX_URL', value: 'https://hijack.convex.cloud', isSecret: false },
  ]);
  return p;
}

const get = (id: string) => callRoute(envRoute.GET, { params: { id } });

describe('GET env', () => {
  test('editor sees secret values masked', async () => {
    const p = await projectWithEnv();
    await signInAs('editor');
    const text = await (await get(p.id)).text();
    expect(text).not.toContain('pk_live_SECRETVALUE');
    expect(text).toContain('public-value');
  });

  test('owner sees their secret values', async () => {
    const p = await projectWithEnv();
    await signInAs('owner');
    expect(await (await get(p.id)).text()).toContain('pk_live_SECRETVALUE');
  });

  test('reserved keys are never listed as user-editable', async () => {
    const p = await projectWithEnv();
    await signInAs('owner');
    expect(await (await get(p.id)).text()).not.toContain('hijack.convex.cloud');
  });
});

describe('reserved (platform-managed) keys cannot be written', () => {
  const variants = (key: string) => [key, key.toLowerCase(), key[0] + key.slice(1).toLowerCase()];
  const reservedKeys = RESERVED_ENV_VARS.map((v) => v.key);

  test.each(reservedKeys.flatMap(variants))('POST %s → 400', async (key) => {
    const p = await createProject({ userId: 'owner' });
    await signInAs('owner');
    const before = await snapshotDb();
    const res = await callRoute(envRoute.POST, { method: 'POST', params: { id: p.id }, body: { key, value: 'x' } });
    expect(res.status).toBe(400);
    expect(await snapshotDb()).toEqual(before);
  });

  test('PUT bulk import skips every reserved key (any case)', async () => {
    const p = await createProject({ userId: 'owner' });
    await signInAs('owner');
    const content = [
      ...reservedKeys.flatMap(variants).map((k) => `${k}=evil`),
      'MY_VAR=ok',
      'export SNEAKY=1',
    ].join('\n');
    const res = await callRoute(envRoute.PUT, { method: 'PUT', params: { id: p.id }, body: { content } });
    expect(res.status).toBe(200);
    const rows = await currentTestDb().select().from(projectEnvVars);
    expect(rows.map((r) => r.key)).toEqual(['MY_VAR']);
  });

  test.each(reservedKeys.flatMap(variants))('DELETE %s → 400', async (key) => {
    const p = await createProject({ userId: 'owner' });
    await signInAs('owner');
    const res = await callRoute(envRoute.DELETE, { method: 'DELETE', params: { id: p.id }, body: { key } });
    expect(res.status).toBe(400);
  });

  test.each(['1BAD', 'BAD-KEY', 'BAD KEY', '', 'A=B', 'KEY\nINJECT=1'])('invalid name %j → 400', async (key) => {
    const p = await createProject({ userId: 'owner' });
    await signInAs('owner');
    const res = await callRoute(envRoute.POST, { method: 'POST', params: { id: p.id }, body: { key, value: 'x' } });
    expect(res.status).toBe(400);
  });

  test('a value with newlines cannot inject a second variable via bulk import', async () => {
    const p = await createProject({ userId: 'owner' });
    await signInAs('owner');
    await callRoute(envRoute.PUT, {
      method: 'PUT',
      params: { id: p.id },
      body: { content: 'A=1\r\nVITE_CONVEX_URL=https://hijack.convex.cloud' },
    });
    const rows = await currentTestDb().select().from(projectEnvVars);
    expect(rows.map((r) => r.key)).toEqual(['A']);
  });
});

describe('malformed bodies', () => {
  // KNOWN GAP: PUT/DELETE destructure req.json() without validation and throw
  // (500) on a missing/invalid body instead of answering 400.
  test.fails.each([
    ['PUT', {}],
    ['PUT', { content: 42 }],
    ['DELETE', undefined],
  ] as const)('%s with %j → 400, not a crash', async (method, body) => {
    const p = await createProject({ userId: 'owner' });
    await signInAs('owner');
    const handler = method === 'PUT' ? envRoute.PUT : envRoute.DELETE;
    const res = await callRoute(handler, { method, params: { id: p.id }, body });
    expect(res.status).toBe(400);
  });
});

describe('frontend .env contents', () => {
  test('only user vars + the public Convex URL; never a platform secret column', async () => {
    const p = await createProject({
      userId: 'owner',
      backendType: 'platform',
      convexDeployUrl: 'https://happy-otter-1.convex.cloud',
      convexDeployKey: 'prod:DEPLOYKEY',
      userConvexDeployKey: 'prod:USERDEPLOYKEY',
      stripeWebhookSecret: 'whsec_STRIPE',
      revenuecatWebhookSecret: 'rc_SECRET',
    });
    await currentTestDb().insert(projectEnvVars).values({ projectId: p.id, key: 'VITE_X', value: '1' });
    const env = await buildFrontendEnvMap(p.id);
    const dump = JSON.stringify(env);
    for (const secret of ['DEPLOYKEY', 'USERDEPLOYKEY', 'whsec_STRIPE', 'rc_SECRET']) {
      expect(dump).not.toContain(secret);
    }
    expect(env.VITE_X).toBe('1');
    expect(Object.values(env)).toContain('https://happy-otter-1.convex.cloud');
  });
});

describe('Convex backend env', () => {
  test('managed bearer secrets (OAuth client secrets, signing keys) are masked even for the owner', async () => {
    const p = await createProject({
      userId: 'owner',
      backendType: 'platform',
      convexDeployUrl: 'https://happy-otter-1.convex.cloud',
      convexDeployKey: 'prod:DEPLOYKEY',
    });
    server.use(
      http.post('https://happy-otter-1.convex.cloud/api/:endpoint', () =>
        HttpResponse.json({
          status: 'success',
          value: [
            { name: 'AUTH_GOOGLE_SECRET', value: 'GOCSPX-REALSECRET' },
            { name: 'JWT_PRIVATE_KEY', value: '-----BEGIN PRIVATE KEY-----REAL' },
            { name: 'AUTH_GOOGLE_ID', value: 'client-id.apps.googleusercontent.com' },
          ],
        }),
      ),
    );
    await signInAs('owner');
    const res = await callRoute(backendEnvRoute.GET, { params: { id: p.id } });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain('GOCSPX-REALSECRET');
    expect(text).not.toContain('BEGIN PRIVATE KEY');
    expect(text).toContain('client-id.apps.googleusercontent.com');
  });
});
