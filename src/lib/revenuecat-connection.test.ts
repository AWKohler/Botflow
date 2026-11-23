/**
 * Connecting a project to RevenueCat from one pasted secret key: what gets
 * discovered and stored, which keys are refused (and with what advice), the
 * webhook lifecycle, and what disconnect leaves behind.
 */
import { eq } from 'drizzle-orm';
import { http, HttpResponse } from 'msw';
import { describe, expect, test, vi } from 'vitest';
import { projectRevenueCatConnections, projects } from '@/db/schema';
import { decryptSecret, encryptSecret } from '@/lib/secrets';
import { currentTestDb, setupTestDb } from '@/test/db';
import { fakeRedis } from '@/test/redis-fake';
import { createProject } from '@/test/factories';
import { server } from '@/test/network';
import { fakeRevenueCat } from '@/test/revenuecat-fake';
import {
  connectRevenueCat,
  disconnectRevenueCat,
  getRevenueCatConnection,
  refreshRevenueCatConnection,
} from './revenuecat-connection';
import { checkSecretKeyShape, dashboardUrl, explainRevenueCatError, listProjects } from './revenuecat';

vi.hoisted(() => {
  process.env.SECRETS_ENCRYPTION_KEY = 'test-secrets-encryption-key-0123456789abcdef';
  process.env.NEXT_PUBLIC_APP_URL = 'https://botflow.test';
  delete process.env.REVENUECAT_WEBHOOK_ORIGIN;
});

setupTestDb();

const ORIGIN = 'https://request-origin.test';

async function swiftProject(userId = 'owner_a', name = 'StreakPal') {
  return createProject({ userId, name, platform: 'swift', backendType: 'user' });
}

function connect(project: { id: string; name: string; userId: string }, secretKey: string, extra = {}) {
  return connectRevenueCat({
    projectId: project.id,
    projectName: project.name,
    userId: project.userId,
    secretKey,
    requestOrigin: ORIGIN,
    ...extra,
  });
}

async function connectionRow(projectId: string) {
  const [row] = await currentTestDb()
    .select()
    .from(projectRevenueCatConnections)
    .where(eq(projectRevenueCatConnections.projectId, projectId));
  return row;
}

describe('connecting with one secret key', () => {
  test('finds the project, both SDK keys and creates the webhook', async () => {
    const rc = fakeRevenueCat({ appStore: true });
    const project = await swiftProject();

    const result = await connect(project, '  sk_full  ');
    expect(result).toMatchObject({
      ok: true,
      rcProjectId: rc.projectId,
      rcProjectName: 'StreakPal',
      testStoreReady: true,
      appStoreReady: true,
      webhook: 'created',
    });

    const row = await connectionRow(project.id);
    expect(row).toMatchObject({
      rcProjectId: rc.projectId,
      rcTestStoreAppId: 'app_test',
      rcTestStoreSdkKey: 'test_PUBLICKEY',
      rcAppStoreAppId: 'app_ios',
      rcAppStoreSdkKey: 'appl_PUBLICKEY',
      webhookError: null,
    });
    // Stored encrypted, never in the clear.
    expect(row.rcSecretKey).not.toContain('sk_full');
    expect(decryptSecret(row.rcSecretKey)).toBe('sk_full');

    // RevenueCat was told to call the public app URL with this connection's secret.
    expect(rc.webhooks).toHaveLength(1);
    expect(rc.webhooks[0]).toMatchObject({
      url: 'https://botflow.test/api/webhooks/revenuecat',
      authorization_header: row.inboundWebhookSecret,
    });
    expect(row.rcWebhookIntegrationId).toBe(rc.webhooks[0].id);

    const [p] = await currentTestDb().select().from(projects).where(eq(projects.id, project.id));
    expect(p.revenuecatStatus).toBe('connected');
    expect(p.revenuecatProjectId).toBe(rc.projectId);
    expect(p.revenuecatWebhookSecret).toMatch(/^bfrc_/);
  });

  test('never calls the "get one project" endpoint, which API v2 does not have', async () => {
    const rc = fakeRevenueCat();
    await connect(await swiftProject(), 'sk_full');
    expect(rc.calls).not.toContain(`GET /projects/${rc.projectId}`);
    expect(rc.calls).toContain('GET /projects');
  });

  test("the Test Store key is found although RevenueCat labels its environment 'production'", async () => {
    fakeRevenueCat();
    const project = await swiftProject();
    await connect(project, 'sk_full');
    expect((await connectionRow(project.id)).rcTestStoreSdkKey).toBe('test_PUBLICKEY');
  });

  test('a RevenueCat project without a Test Store still connects, flagged as not ready', async () => {
    fakeRevenueCat({ testStore: false });
    const project = await swiftProject();
    const result = await connect(project, 'sk_full');
    expect(result).toMatchObject({ ok: true, testStoreReady: false, appStoreReady: false });
    expect((await connectionRow(project.id)).rcTestStoreSdkKey).toBeNull();
  });

  test('an existing webhook secret on the project is kept, not rotated', async () => {
    fakeRevenueCat();
    const project = await createProject({
      userId: 'owner_a',
      platform: 'swift',
      backendType: 'user',
      revenuecatWebhookSecret: 'bfrc_already_in_convex',
    });
    await connect(project, 'sk_full');
    const [p] = await currentTestDb().select().from(projects).where(eq(projects.id, project.id));
    expect(p.revenuecatWebhookSecret).toBe('bfrc_already_in_convex');
  });
});

describe('keys that cannot be used are refused with advice, and nothing is stored', () => {
  test.each([
    ['an SDK key', 'test_abcdef', 'not-secret-key', /SDK key/],
    ['something else entirely', 'hello', 'not-secret-key', /start with "sk_"/],
    ['a V1 key', 'sk_legacy', 'legacy-key', /V1 \(legacy\)/],
    ['an unknown key', 'sk_deleted', 'invalid-key', /does not recognise/],
    ['a read-only key', 'sk_readonly', 'read-only', /integrations:read_write/],
  ])('%s', async (_label, key, code, message) => {
    const rc = fakeRevenueCat();
    const project = await swiftProject();
    const result = await connect(project, key);
    expect(result).toMatchObject({ ok: false, status: 400, code });
    expect(result.ok ? '' : result.error).toMatch(message);
    expect(await connectionRow(project.id)).toBeUndefined();
    expect(rc.webhooks).toEqual([]);
    const [p] = await currentTestDb().select().from(projects).where(eq(projects.id, project.id));
    expect(p.revenuecatStatus).toBe('none');
  });

  test('a V1 key cannot be fixed, so the advice is a new key; wrong permissions can be edited in place', async () => {
    fakeRevenueCat();
    const legacy = await connect(await swiftProject(), 'sk_legacy');
    expect(legacy.ok ? '' : legacy.error).toContain('Create a new secret key');
    expect(legacy.ok ? '' : legacy.error).toContain('"Project configuration permissions" to "Read & write"');

    fakeRevenueCat();
    const readOnly = await connect(await swiftProject(), 'sk_readonly');
    expect(readOnly.ok ? '' : readOnly.error).toContain('choose Edit');
    expect(readOnly.ok ? '' : readOnly.error).toContain('"Project configuration permissions" to "Read & write"');
    expect(readOnly.ok ? '' : readOnly.error).not.toContain('Create a new secret key');
  });
});

describe('one RevenueCat project per app', () => {
  test('a RevenueCat project already used by another of your apps is refused, naming that app', async () => {
    const rc = fakeRevenueCat();
    const first = await swiftProject('owner_a', 'StreakPal');
    const second = await swiftProject('owner_a', 'FocusTimer');
    await connect(first, 'sk_full');

    const refused = await connect(second, 'sk_full');
    expect(refused).toMatchObject({ ok: false, status: 409, code: 'project-in-use' });
    expect(refused.ok ? '' : refused.error).toContain('your app "StreakPal"');
    expect(await connectionRow(second.id)).toBeUndefined();
    // Nothing was created in RevenueCat for the refused app.
    expect(rc.webhooks).toHaveLength(1);
  });

  test("another owner's app is refused too, without naming it", async () => {
    fakeRevenueCat();
    await connect(await swiftProject('owner_a', 'Secret Side Project'), 'sk_full');
    const refused = await connect(await swiftProject('owner_b', 'Other'), 'sk_full');
    expect(refused).toMatchObject({ ok: false, code: 'project-in-use' });
    expect(refused.ok ? '' : refused.error).toContain('another Botflow app');
    expect(refused.ok ? '' : refused.error).not.toContain('Secret Side Project');
  });

  test('after the first app disconnects, the RevenueCat project is free again', async () => {
    fakeRevenueCat();
    const first = await swiftProject('owner_a', 'StreakPal');
    const second = await swiftProject('owner_a', 'FocusTimer');
    await connect(first, 'sk_full');
    await disconnectRevenueCat(first.id);
    expect((await connect(second, 'sk_full')).ok).toBe(true);
  });

  test('the database refuses a second claim even if the check is raced', async () => {
    fakeRevenueCat();
    const first = await swiftProject('owner_a', 'StreakPal');
    const second = await swiftProject('owner_a', 'FocusTimer');
    await connect(first, 'sk_full');
    const row = await connectionRow(first.id);
    await expect(
      currentTestDb()
        .insert(projectRevenueCatConnections)
        .values({ ...row, projectId: second.id, inboundWebhookSecretDigest: 'different' }),
    ).rejects.toThrow();
  });
});

describe('two connects at once', () => {
  test('the second is told to wait, and only one webhook exists afterwards', async () => {
    const rc = fakeRevenueCat();
    const project = await swiftProject();
    const [a, b] = await Promise.all([connect(project, 'sk_full'), connect(project, 'sk_full')]);
    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ status: 409, code: 'busy' });
    expect(rc.webhooks).toHaveLength(1);
    // The lock is released: connecting again works.
    expect((await connect(project, 'sk_full')).ok).toBe(true);
    expect(rc.webhooks).toHaveLength(1);
  });
});

describe('reconnecting and repairing', () => {
  test('pasting a new key for the same project keeps one webhook and the same secret', async () => {
    const rc = fakeRevenueCat();
    rc.keys.set('sk_full_2', 'full');
    const project = await swiftProject();
    await connect(project, 'sk_full');
    const before = await connectionRow(project.id);

    await connect(project, 'sk_full_2');
    const after = await connectionRow(project.id);
    expect(rc.webhooks).toHaveLength(1);
    expect(after.inboundWebhookSecret).toBe(before.inboundWebhookSecret);
    expect(decryptSecret(after.rcSecretKey)).toBe('sk_full_2');
  });

  test('a webhook deleted in the RevenueCat dashboard is recreated by "Check again"', async () => {
    const rc = fakeRevenueCat();
    const project = await swiftProject();
    await connect(project, 'sk_full');
    rc.webhooks.length = 0;

    const refreshed = await refreshRevenueCatConnection(project.id, ORIGIN);
    expect(refreshed).toMatchObject({ keyValid: true, webhookReady: true });
    expect(rc.webhooks).toHaveLength(1);
    expect((await connectionRow(project.id)).rcWebhookIntegrationId).toBe(rc.webhooks[0].id);
  });

  test('switching to another RevenueCat project with a key that cannot write leaves the working connection untouched', async () => {
    const rc = fakeRevenueCat();
    const project = await swiftProject();
    await connect(project, 'sk_full');
    const before = await connectionRow(project.id);
    const webhookBefore = rc.webhooks[0].id;

    // A different RevenueCat project, reached with a read-only key: discovery
    // passes, the webhook write is refused.
    rc.projectId = 'proj_other';
    const refused = await connect(project, 'sk_readonly');
    expect(refused).toMatchObject({ ok: false, code: 'read-only' });

    // The original webhook is still in RevenueCat and the row still points at it.
    expect(rc.webhooks.map((w) => w.id)).toEqual([webhookBefore]);
    expect(await connectionRow(project.id)).toEqual(before);
  });

  test('switching to another RevenueCat project removes the webhook from the old one afterwards', async () => {
    const rc = fakeRevenueCat();
    const project = await swiftProject();
    await connect(project, 'sk_full');
    const oldWebhook = rc.webhooks[0].id;

    rc.projectId = 'proj_other';
    expect(await connect(project, 'sk_full')).toMatchObject({ ok: true, rcProjectId: 'proj_other' });
    expect(rc.webhooks).toHaveLength(1);
    expect(rc.webhooks[0].id).not.toBe(oldWebhook);
    expect((await connectionRow(project.id)).rcWebhookIntegrationId).toBe(rc.webhooks[0].id);
  });

  test.each([
    ['the Test Store key lookup', /GET .*\/apps\/app_test\/public_api_keys/],
    ['the App Store key lookup', /GET .*\/apps\/app_ios\/public_api_keys/],
    ['the app list', /GET .*\/apps$/],
  ])('a failed lookup (%s) during a refresh keeps every cached key', async (_label, match) => {
    const rc = fakeRevenueCat({ appStore: true });
    const project = await swiftProject();
    await connect(project, 'sk_full');
    const before = await connectionRow(project.id);

    rc.failures.push({ match, status: 503 });
    const refreshed = await refreshRevenueCatConnection(project.id, ORIGIN);
    expect(refreshed).toMatchObject({
      unreachable: true,
      keyValid: true, // RevenueCat did not reject the key; it just did not answer
      keyError: null,
      testStoreReady: true,
      appStoreReady: true,
    });
    const after = await connectionRow(project.id);
    expect(after.rcTestStoreSdkKey).toBe('test_PUBLICKEY');
    expect(after.rcAppStoreSdkKey).toBe('appl_PUBLICKEY');
    expect(after.rcWebhookIntegrationId).toBe(before.rcWebhookIntegrationId);
  });

  test('a connect during a RevenueCat outage fails cleanly instead of storing "no keys"', async () => {
    const rc = fakeRevenueCat();
    rc.failures.push({ match: /public_api_keys/, status: 503 });
    const project = await swiftProject();
    const result = await connect(project, 'sk_full');
    expect(result).toMatchObject({ ok: false, status: 502, code: 'unreachable' });
    expect(await connectionRow(project.id)).toBeUndefined();
    expect(rc.webhooks).toEqual([]);
  });

  test('a webhook update that fails briefly does not make Botflow forget its webhook', async () => {
    const rc = fakeRevenueCat();
    const project = await swiftProject();
    await connect(project, 'sk_full');
    const id = rc.webhooks[0].id;

    rc.failures.push({ match: /POST .*\/integrations\/webhooks\//, status: 503, times: 1 });
    const refreshed = await refreshRevenueCatConnection(project.id, ORIGIN);
    expect(refreshed?.webhookReady).toBe(true);
    const row = await connectionRow(project.id);
    expect(row.rcWebhookIntegrationId).toBe(id);
    expect(row.webhookError).toMatch(/503/);
    // …so a later disconnect still removes it.
    expect(await disconnectRevenueCat(project.id)).toMatchObject({ hadWebhook: true, webhookRemoved: true });
    expect(rc.webhooks).toEqual([]);
  });

  test('an App Store app added later is picked up by a refresh', async () => {
    const rc = fakeRevenueCat();
    const project = await swiftProject();
    await connect(project, 'sk_full');
    expect((await connectionRow(project.id)).rcAppStoreSdkKey).toBeNull();

    rc.apps.push({ id: 'app_ios', name: 'iOS', type: 'app_store' });
    rc.sdkKeys.set('app_ios', 'appl_LATER');
    const refreshed = await refreshRevenueCatConnection(project.id);
    expect(refreshed?.appStoreReady).toBe(true);
    expect((await connectionRow(project.id)).rcAppStoreSdkKey).toBe('appl_LATER');
  });

  test('two App Store apps: none is guessed', async () => {
    const rc = fakeRevenueCat({ appStore: true });
    rc.apps.push({ id: 'app_ios_2', name: 'Other', type: 'app_store' });
    rc.sdkKeys.set('app_ios_2', 'appl_OTHER');
    const project = await swiftProject();
    const result = await connect(project, 'sk_full');
    expect(result).toMatchObject({ ok: true, appStoreReady: false });
    expect((await refreshRevenueCatConnection(project.id))?.appStoreAmbiguous).toBe(true);
  });

  test('a key revoked in RevenueCat is reported, and the cached SDK keys are kept', async () => {
    const rc = fakeRevenueCat();
    const project = await swiftProject();
    await connect(project, 'sk_full');
    rc.keys.delete('sk_full');

    const refreshed = await refreshRevenueCatConnection(project.id);
    expect(refreshed).toMatchObject({ keyValid: false, unreachable: false, testStoreReady: true });
    expect(refreshed?.keyError).toMatch(/does not recognise/);
    expect((await connectionRow(project.id)).rcTestStoreSdkKey).toBe('test_PUBLICKEY');
  });
});

describe('changes that overlap or fail half-way', () => {
  test('a refresh that was reading the old connection does not overwrite a reconnect that happened meanwhile', async () => {
    const rc = fakeRevenueCat({ appStore: true });
    const project = await swiftProject();
    await connect(project, 'sk_full');

    // While the refresh waits on RevenueCat, the project is reconnected to a
    // different RevenueCat project (modelled as the row a reconnect would write).
    rc.during.push({
      match: /public_api_keys/,
      run: async () => {
        await currentTestDb()
          .update(projectRevenueCatConnections)
          .set({
            rcProjectId: 'proj_new',
            rcSecretKey: 'v1.other-encrypted-key',
            rcTestStoreSdkKey: 'test_NEW',
            rcAppStoreSdkKey: 'appl_NEW',
            rcWebhookIntegrationId: 'wh_new',
          })
          .where(eq(projectRevenueCatConnections.projectId, project.id));
      },
    });
    await refreshRevenueCatConnection(project.id);

    expect(await connectionRow(project.id)).toMatchObject({
      rcProjectId: 'proj_new',
      rcTestStoreSdkKey: 'test_NEW',
      rcAppStoreSdkKey: 'appl_NEW',
      rcWebhookIntegrationId: 'wh_new',
    });
  });

  test('"Check again" that overlaps a reconnect does not repair the webhook with the old connection\'s details', async () => {
    const rc = fakeRevenueCat();
    const project = await swiftProject();
    await connect(project, 'sk_full');
    const webhookCalls = () => rc.calls.filter((c) => c.includes('/integrations/webhooks')).length;
    const before = webhookCalls();

    // While discovery waits on RevenueCat, the project is reconnected (modelled
    // as the row a reconnect would write: another key, another webhook).
    const reconnected = {
      rcSecretKey: encryptSecret('sk_full_2'),
      rcWebhookIntegrationId: 'wh_from_the_reconnect',
      inboundWebhookSecret: 'bfrcin_new',
      inboundWebhookSecretDigest: 'digest-new',
    };
    rc.during.push({
      match: /public_api_keys/,
      run: async () => {
        await currentTestDb()
          .update(projectRevenueCatConnections)
          .set(reconnected)
          .where(eq(projectRevenueCatConnections.projectId, project.id));
      },
    });
    expect(await refreshRevenueCatConnection(project.id, ORIGIN)).toBeNull();

    // No webhook was read, updated or created on behalf of the stale connection.
    expect(webhookCalls()).toBe(before);
    expect(await connectionRow(project.id)).toMatchObject(reconnected);
    // The lock is free again.
    expect((await connect(project, 'sk_full')).ok).toBe(true);
  });

  test('a disconnect waits its turn behind a change in flight; deleting the project does not', async () => {
    const rc = fakeRevenueCat();
    const project = await swiftProject();
    await connect(project, 'sk_full');

    await fakeRedis.set(`revenuecat:connecting:${project.id}`, 'someone-else', { nx: true, ex: 90 });
    expect(await disconnectRevenueCat(project.id)).toBe('busy');
    expect(await connectionRow(project.id)).toBeDefined();
    expect(rc.webhooks).toHaveLength(1);

    expect(await disconnectRevenueCat(project.id, { force: true })).toMatchObject({ webhookRemoved: true });
    expect(await connectionRow(project.id)).toBeUndefined();
    // The other holder's lock was not taken from it.
    expect(await fakeRedis.get(`revenuecat:connecting:${project.id}`)).toBe('someone-else');
  });

  test('a database error while reconnecting never deletes the webhook the stored connection uses', async () => {
    const rc = fakeRevenueCat();
    rc.keys.set('sk_full_2', 'full');
    const project = await swiftProject();
    await connect(project, 'sk_full');
    const before = await connectionRow(project.id);

    const insert = vi.spyOn(currentTestDb(), 'insert').mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });
    await expect(connect(project, 'sk_full_2')).rejects.toThrow('database unavailable');
    insert.mockRestore();

    // The webhook was only updated in place; it is still there and still stored.
    expect(rc.webhooks.map((w) => w.id)).toEqual([before.rcWebhookIntegrationId]);
    expect(await connectionRow(project.id)).toEqual(before);
  });

  test('a database error on a first connect removes the webhook that call created', async () => {
    const rc = fakeRevenueCat();
    const project = await swiftProject();
    const insert = vi.spyOn(currentTestDb(), 'insert').mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });
    await expect(connect(project, 'sk_full')).rejects.toThrow('database unavailable');
    insert.mockRestore();
    expect(rc.webhooks).toEqual([]);
    expect(await connectionRow(project.id)).toBeUndefined();
  });

  test('replacing the key while the webhook update fails briefly keeps the webhook id', async () => {
    const rc = fakeRevenueCat();
    rc.keys.set('sk_full_2', 'full');
    const project = await swiftProject();
    await connect(project, 'sk_full');
    const id = rc.webhooks[0].id;

    rc.failures.push({ match: /POST .*\/integrations\/webhooks\//, status: 503, times: 1 });
    expect(await connect(project, 'sk_full_2')).toMatchObject({ ok: true, webhook: 'manual' });
    const row = await connectionRow(project.id);
    expect(row.rcWebhookIntegrationId).toBe(id);
    expect(decryptSecret(row.rcSecretKey)).toBe('sk_full_2');
    // Still ours to remove.
    expect(await disconnectRevenueCat(project.id)).toMatchObject({ hadWebhook: true, webhookRemoved: true });
  });

  test('connecting still works when the lock store is down', async () => {
    fakeRevenueCat();
    const project = await swiftProject();
    const set = vi.spyOn(fakeRedis, 'set').mockRejectedValueOnce(new Error('redis down'));
    expect((await connect(project, 'sk_full')).ok).toBe(true);
    set.mockRestore();
  });
});

describe('a claim held by a dead connection', () => {
  test("another app's connection whose key RevenueCat rejects is released, and the new app connects", async () => {
    const rc = fakeRevenueCat();
    rc.keys.set('sk_old_agency_key', 'full');
    const abandoned = await swiftProject('owner_agency', 'Client app (old)');
    await connect(abandoned, 'sk_old_agency_key');

    // The RevenueCat project's owner revokes the agency's key, then connects
    // their own app with a key of their own.
    rc.keys.delete('sk_old_agency_key');
    const client = await swiftProject('owner_client', 'Client app');
    expect((await connect(client, 'sk_full')).ok).toBe(true);

    expect(await connectionRow(abandoned.id)).toBeUndefined();
    const [p] = await currentTestDb().select().from(projects).where(eq(projects.id, abandoned.id));
    expect(p.revenuecatStatus).toBe('none');
    const mine = await connectionRow(client.id);
    expect(mine.rcProjectId).toBe(rc.projectId);
    // The dead connection's webhook would have failed every event: the new key
    // (same RevenueCat project) removed it.
    expect(rc.webhooks.map((w) => w.id)).toEqual([mine.rcWebhookIntegrationId]);
  });

  test('a key this deployment cannot decrypt is not proof of a dead claim', async () => {
    fakeRevenueCat();
    const first = await swiftProject('owner_a', 'First');
    await connect(first, 'sk_full');
    // Another deployment on the same database (a dev server with its own
    // encryption secret) stored this key: unreadable here, and perfectly alive.
    await currentTestDb()
      .update(projectRevenueCatConnections)
      .set({ rcSecretKey: 'v1.AAAA.BBBB.CCCC' })
      .where(eq(projectRevenueCatConnections.projectId, first.id));

    const second = await swiftProject('owner_b', 'Second');
    expect(await connect(second, 'sk_full')).toMatchObject({ ok: false, code: 'project-in-use' });
    expect(await connectionRow(first.id)).toBeDefined();
  });

  test('a dead claim whose app reconnects during the check is left alone', async () => {
    const rc = fakeRevenueCat();
    rc.keys.set('sk_old', 'full');
    rc.keys.set('sk_fresh', 'full');
    const first = await swiftProject('owner_a', 'First');
    await connect(first, 'sk_old');
    rc.keys.delete('sk_old');

    const second = await swiftProject('owner_b', 'Second');
    // While the liveness check of First's old key is in flight (the second
    // GET /projects of this connect), First's owner pastes a working key.
    let seen = 0;
    rc.during.push({
      match: {
        test: (signature: string) => signature === 'GET /projects' && ++seen === 2,
      } as RegExp,
      run: async () => {
        await currentTestDb()
          .update(projectRevenueCatConnections)
          .set({ rcSecretKey: encryptSecret('sk_fresh') })
          .where(eq(projectRevenueCatConnections.projectId, first.id));
      },
    });
    expect(await connect(second, 'sk_full')).toMatchObject({ ok: false, code: 'project-in-use' });
    expect(decryptSecret((await connectionRow(first.id)).rcSecretKey)).toBe('sk_fresh');
    const [p] = await currentTestDb().select().from(projects).where(eq(projects.id, first.id));
    expect(p.revenuecatStatus).toBe('connected');
  });

  test('a dead claim that appears between the check and the write is released, and the connect still succeeds', async () => {
    const rc = fakeRevenueCat();
    rc.keys.set('sk_old', 'full');
    const abandoned = await swiftProject('owner_agency', 'Client app (old)');
    await connect(abandoned, 'sk_old');
    const stale = await connectionRow(abandoned.id);
    await currentTestDb()
      .delete(projectRevenueCatConnections)
      .where(eq(projectRevenueCatConnections.projectId, abandoned.id));
    rc.keys.delete('sk_old');

    const client = await swiftProject('owner_client', 'Client app');
    // The claim lands after the "in use?" check, while the webhook is created.
    rc.during.push({
      match: /^POST .*integrations\/webhooks/,
      run: async () => {
        await currentTestDb().insert(projectRevenueCatConnections).values(stale);
      },
    });
    expect((await connect(client, 'sk_full')).ok).toBe(true);
    expect(await connectionRow(abandoned.id)).toBeUndefined();
    const mine = await connectionRow(client.id);
    expect(rc.webhooks.map((w) => w.id)).toEqual([mine.rcWebhookIntegrationId]);
  });

  test('a claim whose key still works is not released just because RevenueCat is briefly down', async () => {
    const rc = fakeRevenueCat();
    rc.keys.set('sk_other', 'full');
    const first = await swiftProject('owner_a', 'First');
    await connect(first, 'sk_other');
    const second = await swiftProject('owner_b', 'Second');
    // The new key's own check (the first GET /projects) succeeds; the liveness
    // check of the first connection's key (the second) gets a 503, which is
    // not a rejection.
    rc.failures.push({ match: /GET \/projects$/, status: 503, times: 1, skip: 1 });
    const result = await connect(second, 'sk_full');
    expect(result).toMatchObject({ ok: false, code: 'project-in-use' });
    expect(await connectionRow(first.id)).toBeDefined();
    // One per connect, plus the liveness check of the existing claim.
    expect(rc.calls.filter((c) => c === 'GET /projects')).toHaveLength(3);
  });
});

describe('disconnecting', () => {
  test('removes the webhook from RevenueCat and the stored key from Botflow', async () => {
    const rc = fakeRevenueCat();
    const project = await swiftProject();
    await connect(project, 'sk_full');

    expect(await disconnectRevenueCat(project.id)).toEqual({
      hadWebhook: true,
      webhookRemoved: true,
      integrationsUrl: null,
    });
    expect(rc.webhooks).toEqual([]);
    expect(await connectionRow(project.id)).toBeUndefined();
    expect(await getRevenueCatConnection(project.id)).toBeNull();
    const [p] = await currentTestDb().select().from(projects).where(eq(projects.id, project.id));
    expect(p).toMatchObject({ revenuecatStatus: 'none', revenuecatProjectId: null, revenuecatWebhookSecret: null });
  });

  test.each([
    ['the key was revoked first', (rc: ReturnType<typeof fakeRevenueCat>) => void rc.keys.delete('sk_full')],
    ['RevenueCat is down', (rc: ReturnType<typeof fakeRevenueCat>) => void rc.failures.push({ match: /DELETE /, status: 503 })],
  ])('when %s: the key is still deleted here, and the caller learns the webhook is left behind', async (_label, arrange) => {
    const rc = fakeRevenueCat();
    const project = await swiftProject();
    await connect(project, 'sk_full');
    arrange(rc);

    expect(await disconnectRevenueCat(project.id)).toEqual({
      hadWebhook: true,
      webhookRemoved: false,
      integrationsUrl: 'https://app.revenuecat.com/projects/1a2b3c4d/integrations',
    });
    expect(rc.webhooks).toHaveLength(1);
    expect(await connectionRow(project.id)).toBeUndefined();
  });

  test('is safe before any key was pasted (cancelling setup)', async () => {
    const project = await createProject({ userId: 'owner_a', platform: 'swift', revenuecatStatus: 'connecting' });
    expect(await disconnectRevenueCat(project.id)).toEqual({
      hadWebhook: false,
      webhookRemoved: false,
      integrationsUrl: null,
    });
    const [p] = await currentTestDb().select().from(projects).where(eq(projects.id, project.id));
    expect(p.revenuecatStatus).toBe('none');
  });
});

describe('RevenueCat answering "busy"', () => {
  // Observed live: two catalog edits issued at the same moment, the second
  // came back 423 Locked. Neither 423 nor 429 executes the request.
  test.each([423, 429])('a %i is retried and the caller sees the eventual success', async (status) => {
    let calls = 0;
    server.use(
      http.get('https://api.revenuecat.com/v2/projects', () => {
        calls += 1;
        return calls < 3
          ? HttpResponse.json({ type: 'locked', message: 'busy' }, { status })
          : HttpResponse.json({ items: [{ object: 'project', id: 'proj1', name: 'A', created_at: 1 }], next_page: null });
      }),
    );
    const result = await listProjects('sk_full');
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
  });

  test('it gives up after three attempts and reports the last answer', async () => {
    let calls = 0;
    server.use(
      http.get('https://api.revenuecat.com/v2/projects', () => {
        calls += 1;
        return HttpResponse.json({ message: 'still locked' }, { status: 423 });
      }),
    );
    expect(await listProjects('sk_full')).toEqual({ ok: false, status: 423, error: 'still locked' });
    expect(calls).toBe(3);
  });

  test('other failures are not retried (a write must never run twice)', async () => {
    let calls = 0;
    server.use(
      http.get('https://api.revenuecat.com/v2/projects', () => {
        calls += 1;
        return HttpResponse.json({ message: 'boom' }, { status: 500 });
      }),
    );
    expect((await listProjects('sk_full')).ok).toBe(false);
    expect(calls).toBe(1);
  });
});

describe('messages and links', () => {
  test('a missing read permission names the permission and the fix', () => {
    const explained = explainRevenueCatError({
      status: 403,
      error: 'The API key needs at least the project_configuration:apps:read permission defined',
    });
    expect(explained.problem).toBe('missing-permission');
    expect(explained.message).toContain('project_configuration:apps:read');
    expect(explained.message).toContain('Read & write');
  });

  test('upstream trouble is not blamed on the key', () => {
    expect(explainRevenueCatError({ status: 504, error: 'RevenueCat API timed out' }).problem).toBe('unreachable');
    expect(explainRevenueCatError({ status: 429, error: 'slow down' }).message).toMatch(/rate-limiting/);
  });

  test('key shape check accepts only secret keys', () => {
    expect(checkSecretKeyShape('sk_abc').ok).toBe(true);
    expect(checkSecretKeyShape('appl_abc').ok).toBe(false);
    expect(checkSecretKeyShape('').ok).toBe(false);
  });

  test('dashboard links use the id without the API "proj" prefix', () => {
    expect(dashboardUrl('proj820f9fc3')).toBe('https://app.revenuecat.com/projects/820f9fc3/overview');
    expect(dashboardUrl('proj820f9fc3', 'api-keys')).toBe('https://app.revenuecat.com/projects/820f9fc3/api-keys');
    expect(dashboardUrl(null)).toBe('https://app.revenuecat.com');
  });
});
