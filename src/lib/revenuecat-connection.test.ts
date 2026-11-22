/**
 * Connecting a project to RevenueCat from one pasted secret key: what gets
 * discovered and stored, which keys are refused (and with what advice), the
 * webhook lifecycle, and what disconnect leaves behind.
 */
import { eq } from 'drizzle-orm';
import { http, HttpResponse } from 'msw';
import { describe, expect, test, vi } from 'vitest';
import { projectRevenueCatConnections, projects } from '@/db/schema';
import { decryptSecret } from '@/lib/secrets';
import { currentTestDb, setupTestDb } from '@/test/db';
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
  test('a second app on the same RevenueCat project needs an explicit yes', async () => {
    const rc = fakeRevenueCat();
    const first = await swiftProject('owner_a', 'StreakPal');
    const second = await swiftProject('owner_a', 'FocusTimer');
    await connect(first, 'sk_full');

    const refused = await connect(second, 'sk_full');
    expect(refused).toMatchObject({ ok: false, status: 409, code: 'shared-project', sharedWith: ['StreakPal'] });
    expect(await connectionRow(second.id)).toBeUndefined();

    const allowed = await connect(second, 'sk_full', { allowSharedProject: true });
    expect(allowed.ok).toBe(true);
    // Each app has its own webhook with its own secret, so events never cross.
    expect(rc.webhooks).toHaveLength(2);
    expect(new Set(rc.webhooks.map((w) => w.authorization_header)).size).toBe(2);
  });

  test("another owner's use of the same RevenueCat project is not revealed", async () => {
    fakeRevenueCat();
    await connect(await swiftProject('owner_a'), 'sk_full');
    const result = await connect(await swiftProject('owner_b'), 'sk_full');
    expect(result.ok).toBe(true);
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
    expect(refreshed).toMatchObject({ keyValid: false, testStoreReady: true });
    expect(refreshed?.keyError).toMatch(/does not recognise/);
    expect((await connectionRow(project.id)).rcTestStoreSdkKey).toBe('test_PUBLICKEY');
  });
});

describe('disconnecting', () => {
  test('removes the webhook from RevenueCat and the stored key from Botflow', async () => {
    const rc = fakeRevenueCat();
    const project = await swiftProject();
    await connect(project, 'sk_full');

    expect(await disconnectRevenueCat(project.id)).toEqual({ webhookRemoved: true });
    expect(rc.webhooks).toEqual([]);
    expect(await connectionRow(project.id)).toBeUndefined();
    expect(await getRevenueCatConnection(project.id)).toBeNull();
    const [p] = await currentTestDb().select().from(projects).where(eq(projects.id, project.id));
    expect(p).toMatchObject({ revenuecatStatus: 'none', revenuecatProjectId: null, revenuecatWebhookSecret: null });
  });

  test('is safe before any key was pasted (cancelling setup)', async () => {
    const project = await createProject({ userId: 'owner_a', platform: 'swift', revenuecatStatus: 'connecting' });
    expect(await disconnectRevenueCat(project.id)).toEqual({ webhookRemoved: false });
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
