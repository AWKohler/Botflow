/**
 * RevenueCat connection for one Botflow project.
 *
 * The user pastes ONE value: the V2 secret key of the RevenueCat project they
 * created for this app. Everything else is worked out from that key:
 *
 *   • which RevenueCat project it belongs to            (GET /projects)
 *   • the Test Store app and its SDK key                (dev / simulator builds)
 *   • the App Store app and its SDK key, once one exists (release builds)
 *   • the webhook RevenueCat calls on every purchase     (created for them)
 *
 * The result is cached in project_revenuecat_connections so builds and inbound
 * webhooks never wait on the RevenueCat API. `refreshRevenueCatConnection`
 * re-runs the discovery (the tab's "Check again", and before a release build,
 * because the App Store app usually appears long after the first connect).
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import {
  projectRevenueCatConnections,
  projects,
  type ProjectRevenueCatConnection,
} from '@/db/schema';
import { redis } from '@/lib/redis';
import { decryptSecret, encryptSecret } from '@/lib/secrets';
import {
  checkSecretKeyShape,
  createWebhookIntegration,
  dashboardUrl,
  deleteWebhookIntegration,
  explainRevenueCatError,
  listApps,
  listEntitlements,
  listOfferings,
  listProducts,
  listProjects,
  listPublicApiKeys,
  listWebhookIntegrations,
  updateWebhookIntegration,
  type RevenueCatApp,
  type RevenueCatKeyProblem,
} from '@/lib/revenuecat';

export type RevenueCatConnection = ProjectRevenueCatConnection & {
  /** Decrypted secret key. Never send to a client, the sandbox, or a log. */
  secretKey: string;
};

/** The connection for a project, with its key decrypted. Null when not connected. */
export async function getRevenueCatConnection(projectId: string): Promise<RevenueCatConnection | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(projectRevenueCatConnections)
    .where(eq(projectRevenueCatConnections.projectId, projectId))
    .limit(1);
  if (!row) return null;
  const secretKey = decryptSecret(row.rcSecretKey);
  if (!secretKey) return null;
  return { ...row, secretKey };
}

// ─── Webhook address ──────────────────────────────────────────────────────────

/**
 * Where RevenueCat should send events. RevenueCat calls this from the public
 * internet, so a dev or preview deployment (whose own origin is private) points
 * REVENUECAT_WEBHOOK_ORIGIN at the production site that shares its database.
 */
export function revenueCatWebhookUrl(requestOrigin: string): string {
  const origin =
    process.env.REVENUECAT_WEBHOOK_ORIGIN?.replace(/\/$/, '') ||
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ||
    requestOrigin;
  return `${origin}/api/webhooks/revenuecat`;
}

function digestOf(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Marks a RevenueCat webhook as the one Botflow created for this project. */
function webhookName(projectId: string, projectName: string): string {
  const label = projectName.replace(/\s+/g, ' ').trim().slice(0, 60) || 'app';
  return `Botflow: ${label} [${projectId.slice(0, 8)}]`;
}

// ─── Discovery ────────────────────────────────────────────────────────────────

export interface DiscoveredApps {
  testStore: { appId: string; sdkKey: string | null } | null;
  appStore: { appId: string; sdkKey: string | null; name: string } | null;
  /** More than one App Store app: we cannot tell which one this app ships as. */
  appStoreAmbiguous: boolean;
}

type Failure = { ok: false; status: number; error: string };

/**
 * The app's public SDK key. A failed lookup is reported as a failure, never as
 * "no key": callers cache the answer, and caching a transient error as
 * "this app has no key" would ship a build with purchases switched off.
 */
async function firstSdkKey(
  secretKey: string,
  rcProjectId: string,
  app: RevenueCatApp,
  prefix: string,
): Promise<{ ok: true; key: string | null } | Failure> {
  const keys = await listPublicApiKeys(secretKey, rcProjectId, app.id);
  if (!keys.ok) return keys;
  return { ok: true, key: keys.data.items.find((k) => k.key?.startsWith(prefix))?.key ?? null };
}

/**
 * Find the Test Store and App Store apps and their public SDK keys. Fails as a
 * whole when any lookup fails, so a caller either gets the full picture or
 * keeps what it had. `preferAppStoreAppId` keeps an earlier choice stable when
 * the RevenueCat project has several App Store apps.
 */
export async function discoverApps(
  secretKey: string,
  rcProjectId: string,
  preferAppStoreAppId?: string | null,
): Promise<{ ok: true; apps: DiscoveredApps } | Failure> {
  const listed = await listApps(secretKey, rcProjectId);
  if (!listed.ok) return listed;

  const testStoreApp = listed.data.items.find((a) => a.type === 'test_store') ?? null;
  const appStoreApps = listed.data.items.filter((a) => a.type === 'app_store');
  const appStoreApp =
    appStoreApps.find((a) => a.id === preferAppStoreAppId) ??
    (appStoreApps.length === 1 ? appStoreApps[0] : null);

  const [testKey, appStoreKey] = await Promise.all([
    testStoreApp ? firstSdkKey(secretKey, rcProjectId, testStoreApp, 'test_') : null,
    appStoreApp ? firstSdkKey(secretKey, rcProjectId, appStoreApp, 'appl_') : null,
  ]);
  if (testKey && !testKey.ok) return testKey;
  if (appStoreKey && !appStoreKey.ok) return appStoreKey;

  return {
    ok: true,
    apps: {
      testStore: testStoreApp ? { appId: testStoreApp.id, sdkKey: testKey?.key ?? null } : null,
      appStore: appStoreApp
        ? { appId: appStoreApp.id, sdkKey: appStoreKey?.key ?? null, name: appStoreApp.name }
        : null,
      appStoreAmbiguous: !appStoreApp && appStoreApps.length > 1,
    },
  };
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

export type WebhookSetup =
  | {
      ok: true;
      integrationId: string;
      /** True = made by this call. False = the integration we already had, updated in place. */
      created: boolean;
    }
  | {
      ok: false;
      /** The key may not write at all (401/403): it could not create products either. */
      fatal: boolean;
      /** The integration we had no longer exists in RevenueCat and was not replaced. */
      previousGone: boolean;
      status: number;
      error: string;
    };

/**
 * Make sure RevenueCat has exactly one webhook for this Botflow project,
 * pointing at us with this connection's Authorization value. Reuses the
 * integration we created before when it still exists; otherwise removes stale
 * ones carrying this project's marker and creates a fresh one.
 */
async function ensureWebhook(opts: {
  secretKey: string;
  rcProjectId: string;
  projectId: string;
  projectName: string;
  url: string;
  authorizationHeader: string;
  existingIntegrationId: string | null;
}): Promise<WebhookSetup> {
  const { secretKey, rcProjectId, projectId, url, authorizationHeader } = opts;
  const name = webhookName(projectId, opts.projectName);
  const marker = `[${projectId.slice(0, 8)}]`;
  let previousGone = false;
  const failure = (r: { status: number; error: string }): WebhookSetup => ({
    ok: false,
    fatal: r.status === 401 || r.status === 403,
    previousGone,
    status: r.status,
    error: r.error,
  });

  if (opts.existingIntegrationId) {
    const updated = await updateWebhookIntegration(secretKey, rcProjectId, opts.existingIntegrationId, {
      name,
      url,
      authorization_header: authorizationHeader,
      status: 'active',
    });
    if (updated.ok) return { ok: true, integrationId: updated.data.id, created: false };
    // Anything but 404 (a timeout, a 5xx): the integration is still there.
    if (updated.status !== 404) return failure(updated);
    // 404: the user deleted it in the RevenueCat dashboard. Recreate it.
    previousGone = true;
  }

  const existing = await listWebhookIntegrations(secretKey, rcProjectId);
  if (!existing.ok) return failure(existing);
  for (const stale of existing.data.items) {
    if (stale.url === url && stale.name?.endsWith(marker)) {
      await deleteWebhookIntegration(secretKey, rcProjectId, stale.id);
    }
  }

  const created = await createWebhookIntegration(secretKey, rcProjectId, {
    name,
    url,
    authorization_header: authorizationHeader,
  });
  if (!created.ok) return failure(created);
  return { ok: true, integrationId: created.data.id, created: true };
}

// ─── Connect ──────────────────────────────────────────────────────────────────

export type ConnectResult =
  | {
      ok: true;
      rcProjectId: string;
      rcProjectName: string;
      testStoreReady: boolean;
      appStoreReady: boolean;
      webhook: 'created' | 'manual';
      webhookError: string | null;
    }
  | {
      ok: false;
      /** HTTP status the route should answer with. */
      status: number;
      code: RevenueCatKeyProblem | 'project-in-use' | 'busy';
      error: string;
    };

type ConnectFailure = Extract<ConnectResult, { ok: false }>;

function keyFailure(result: { status: number; error: string }): ConnectFailure {
  const explained = explainRevenueCatError(result);
  return {
    ok: false,
    // RevenueCat 4xx = something the user can fix; anything else is upstream trouble.
    status: explained.problem === 'unreachable' ? 502 : 400,
    code: explained.problem,
    error: explained.message,
  };
}

/**
 * A RevenueCat project is connected to ONE Botflow project. Its webhooks are
 * project-wide, so two apps on one RevenueCat project would each receive the
 * other's purchases (and, with matching user ids, grant each other's access);
 * they would also share one Test Store, one paywall and one App Store key.
 *
 * A connection whose key RevenueCat no longer accepts does not count: it is
 * dead, its owner can do nothing with it, and it must not lock the RevenueCat
 * project's owner out (an agency's old app, an abandoned account). Revoking
 * the old key in RevenueCat is how they take the project back.
 */
async function projectInUse(
  rcProjectId: string,
  rcProjectName: string,
  projectId: string,
  userId: string,
  /** The key being connected: it can remove a dead claim's leftover webhook. */
  newSecretKey: string,
): Promise<{ failure: ConnectFailure | null; releasedDeadClaim: boolean }> {
  const db = getDb();
  const [other] = await db
    .select({
      projectId: projectRevenueCatConnections.projectId,
      encryptedKey: projectRevenueCatConnections.rcSecretKey,
      integrationId: projectRevenueCatConnections.rcWebhookIntegrationId,
      name: projects.name,
      ownerId: projects.userId,
    })
    .from(projectRevenueCatConnections)
    .innerJoin(projects, eq(projects.id, projectRevenueCatConnections.projectId))
    .where(
      and(
        eq(projectRevenueCatConnections.rcProjectId, rcProjectId),
        ne(projectRevenueCatConnections.projectId, projectId),
      ),
    )
    .limit(1);
  if (!other) return { failure: null, releasedDeadClaim: false };

  // Dead means RevenueCat itself refused the key (401/403: revoked, deleted, or
  // stripped of the read permission, so Botflow could not use it either). A key THIS
  // deployment cannot decrypt (a dev server with a different encryption secret
  // on the shared database) or a RevenueCat outage says nothing about the claim.
  const otherKey = decryptSecret(other.encryptedKey);
  if (!otherKey) {
    console.error('[revenuecat] cannot decrypt the key of the connection claiming', rcProjectId, '- keeping its claim');
  } else {
    const alive = await listProjects(otherKey);
    if (!alive.ok && (alive.status === 401 || alive.status === 403)) {
      const released = await releaseDeadClaim({
        projectId: other.projectId,
        rcProjectId,
        encryptedKey: other.encryptedKey,
      });
      if (released === 'released') {
        // Its webhook would fail every event from now on. The dead key could
        // not remove it; the new key belongs to the same RevenueCat project.
        if (other.integrationId) await deleteWebhookIntegration(newSecretKey, rcProjectId, other.integrationId);
        return { failure: null, releasedDeadClaim: true };
      }
      if (released === 'busy') {
        return {
          failure: {
            ok: false,
            status: 409,
            code: 'busy',
            error:
              'Another app that used this RevenueCat project is being changed right now. Wait a few seconds and try again.',
          },
          releasedDeadClaim: false,
        };
      }
      // 'changed': the other app replaced its connection while we were asking,
      // so the RevenueCat project is still claimed.
    }
  }

  const mine = other.ownerId === userId;
  const failure: ConnectFailure = {
    ok: false,
    status: 409,
    code: 'project-in-use',
    error:
      `The RevenueCat project "${rcProjectName}" is already connected to ${mine ? `your app "${other.name}"` : 'another Botflow app'}. ` +
      'Each app needs its own RevenueCat project, because a RevenueCat project holds one app\'s products, ' +
      'paywall and purchase events. Create a new RevenueCat project for this app and paste its key, ' +
      (mine
        ? 'or disconnect the other app first.'
        : 'or, if that connection should no longer exist, revoke the key it uses in RevenueCat (API keys) and connect again.'),
  };
  return { failure, releasedDeadClaim: false };
}

/**
 * Remove exactly the connection that was found dead: same project, same
 * RevenueCat project, same stored key. If its app reconnected in the meantime
 * (with a new key, or to another RevenueCat project) nothing matches and
 * nothing is touched. Runs under that app's lifecycle lock.
 */
async function releaseDeadClaim(claim: {
  projectId: string;
  rcProjectId: string;
  encryptedKey: string;
}): Promise<'released' | 'changed' | 'busy'> {
  const release = await acquireLifecycleLock(claim.projectId);
  if (release === 'busy') return 'busy';
  try {
    const db = getDb();
    const deleted = await db
      .delete(projectRevenueCatConnections)
      .where(
        and(
          eq(projectRevenueCatConnections.projectId, claim.projectId),
          eq(projectRevenueCatConnections.rcProjectId, claim.rcProjectId),
          eq(projectRevenueCatConnections.rcSecretKey, claim.encryptedKey),
        ),
      )
      .returning({ projectId: projectRevenueCatConnections.projectId });
    if (deleted.length === 0) return 'changed';
    await db
      .update(projects)
      .set({
        revenuecatStatus: 'none',
        revenuecatProjectId: null,
        revenuecatWebhookSecret: null,
        revenuecatScaffoldState: null,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, claim.projectId));
    return 'released';
  } finally {
    await release();
  }
}

const LIFECYCLE_LOCK_SECONDS = 90;
const lifecycleLockKey = (projectId: string) => `revenuecat:connecting:${projectId}`;

/**
 * One lifecycle change (connect, or a refresh that repairs the webhook) per
 * project at a time. Returns a release function, 'busy' when another change
 * holds the lock, or a no-op release when Redis itself is unavailable: the lock
 * prevents duplicate webhooks, it must not make connecting depend on Redis.
 */
async function acquireLifecycleLock(projectId: string): Promise<'busy' | (() => Promise<void>)> {
  const token = randomBytes(12).toString('hex');
  const key = lifecycleLockKey(projectId);
  try {
    const locked = await redis.set(key, token, { nx: true, ex: LIFECYCLE_LOCK_SECONDS });
    if (!locked) return 'busy';
  } catch (err) {
    console.error('[revenuecat] lifecycle lock unavailable, continuing without it:', err);
    return async () => undefined;
  }
  return async () => {
    try {
      // Release only our own lock: after a very slow call it may have expired
      // and been taken by someone else. (Read-then-delete is not atomic; the
      // lock outlives the longest request that can hold it, so the gap between
      // the two cannot straddle an expiry in practice.)
      if ((await redis.get<string>(key)) === token) await redis.del(key);
    } catch {
      /* it expires by itself */
    }
  };
}

/**
 * Verify a pasted secret key, discover everything else, set up the webhook and
 * store the connection. Nothing is saved unless the key can do everything
 * Botflow needs, so a half-working connection never looks "connected".
 */
export async function connectRevenueCat(opts: {
  projectId: string;
  projectName: string;
  userId: string;
  secretKey: string;
  requestOrigin: string;
}): Promise<ConnectResult> {
  const secretKey = opts.secretKey.trim();
  const shape = checkSecretKeyShape(secretKey);
  if (!shape.ok) return { ok: false, status: 400, code: 'not-secret-key', error: shape.message };

  // One connect per project at a time: two at once (a double click, two tabs)
  // would each create a webhook, and only one would be remembered. Nothing is
  // awaited before this, so of two calls made in the same tick exactly one wins.
  const release = await acquireLifecycleLock(opts.projectId);
  if (release === 'busy') {
    return {
      ok: false,
      status: 409,
      code: 'busy',
      error: 'Another change to this project\'s payments is in progress. Wait a few seconds and try again.',
    };
  }
  try {
    return await connectLocked({ ...opts, secretKey });
  } finally {
    await release();
  }
}

async function connectLocked(opts: {
  projectId: string;
  projectName: string;
  userId: string;
  secretKey: string;
  requestOrigin: string;
}): Promise<ConnectResult> {
  const { secretKey } = opts;
  const listed = await listProjects(secretKey);
  if (!listed.ok) return keyFailure(listed);
  const rcProject = listed.data.items[0];
  if (!rcProject) {
    return {
      ok: false,
      status: 400,
      code: 'no-project',
      error: 'That key is valid but RevenueCat lists no project for it. Create the key inside the RevenueCat project for this app.',
    };
  }

  const db = getDb();
  const inUse = await projectInUse(rcProject.id, rcProject.name, opts.projectId, opts.userId, secretKey);
  if (inUse.failure) return inUse.failure;

  const existing = await getRevenueCatConnection(opts.projectId);

  // Read access to everything the tab and the agent tools use.
  const [discovered, products, entitlements, offerings] = await Promise.all([
    discoverApps(secretKey, rcProject.id, existing?.rcAppStoreAppId),
    listProducts(secretKey, rcProject.id),
    listEntitlements(secretKey, rcProject.id),
    listOfferings(secretKey, rcProject.id),
  ]);
  for (const check of [discovered, products, entitlements, offerings]) {
    if (!check.ok) return keyFailure(check);
  }
  if (!discovered.ok) return keyFailure(discovered); // narrows the type
  const { apps } = discovered;

  // Keep the Authorization value across reconnects to the same RevenueCat
  // project so a webhook the user set up by hand keeps working.
  const sameRcProject = existing?.rcProjectId === rcProject.id;
  const inboundSecret =
    sameRcProject && existing ? existing.inboundWebhookSecret : `bfrcin_${randomBytes(24).toString('hex')}`;

  // The new webhook comes FIRST. If it is refused (a read-only key), nothing
  // has been touched and the connection this project already had keeps working.
  const webhook = await ensureWebhook({
    secretKey,
    rcProjectId: rcProject.id,
    projectId: opts.projectId,
    projectName: opts.projectName,
    url: revenueCatWebhookUrl(opts.requestOrigin),
    authorizationHeader: inboundSecret,
    existingIntegrationId: sameRcProject ? existing?.rcWebhookIntegrationId ?? null : null,
  });
  if (!webhook.ok && webhook.fatal) return keyFailure(webhook);
  const webhookError = webhook.ok ? null : webhook.error;

  const now = new Date();
  const values = {
    projectId: opts.projectId,
    userId: opts.userId,
    rcSecretKey: encryptSecret(secretKey),
    rcProjectId: rcProject.id,
    rcProjectName: rcProject.name,
    rcTestStoreAppId: apps.testStore?.appId ?? null,
    rcTestStoreSdkKey: apps.testStore?.sdkKey ?? null,
    rcAppStoreAppId: apps.appStore?.appId ?? null,
    rcAppStoreSdkKey: apps.appStore?.sdkKey ?? null,
    inboundWebhookSecret: inboundSecret,
    inboundWebhookSecretDigest: digestOf(inboundSecret),
    // A failed update that did not say "gone" (a timeout, a 5xx) leaves the
    // integration we already had in place: keep its id, so it is still ours to
    // repair and to remove on disconnect.
    rcWebhookIntegrationId: webhook.ok
      ? webhook.integrationId
      : sameRcProject && !webhook.previousGone
        ? existing?.rcWebhookIntegrationId ?? null
        : null,
    webhookError,
    connectedAt: sameRcProject && existing ? existing.connectedAt : now,
    updatedAt: now,
  };
  const store = () =>
    db
      .insert(projectRevenueCatConnections)
      .values(values)
      .onConflictDoUpdate({ target: projectRevenueCatConnections.projectId, set: values });
  try {
    await store();
  } catch (err) {
    // The usual cause is the unique index on rc_project_id: another project
    // claimed this RevenueCat project between our check and our write.
    const raced = await projectInUse(rcProject.id, rcProject.name, opts.projectId, opts.userId, secretKey).catch(
      () => null,
    );
    // If that claim was dead and has just been released, the way is clear now.
    const stored = raced?.releasedDeadClaim
      ? await store().then(
          () => true,
          () => false,
        )
      : false;
    if (!stored) {
      // Nothing points at a webhook this call CREATED: remove it. One it merely
      // updated belongs to the connection that is still stored and must stay.
      if (webhook.ok && webhook.created) {
        await deleteWebhookIntegration(secretKey, rcProject.id, webhook.integrationId);
      }
      if (raced?.failure) return raced.failure;
      throw err;
    }
  }

  // Only now that the new connection is stored: take our webhook off the
  // RevenueCat project this app was connected to before.
  if (existing && !sameRcProject && existing.rcWebhookIntegrationId) {
    await deleteWebhookIntegration(existing.secretKey, existing.rcProjectId, existing.rcWebhookIntegrationId);
  }

  await db
    .update(projects)
    .set({
      revenuecatStatus: 'connected',
      revenuecatProjectId: rcProject.id,
      // Never rotate a secret already handed to the app's Convex deployment.
      revenuecatWebhookSecret: sql`COALESCE(${projects.revenuecatWebhookSecret}, ${`bfrc_${randomBytes(32).toString('hex')}`})`,
      updatedAt: now,
    })
    .where(eq(projects.id, opts.projectId));

  return {
    ok: true,
    rcProjectId: rcProject.id,
    rcProjectName: rcProject.name,
    testStoreReady: Boolean(apps.testStore?.sdkKey),
    appStoreReady: Boolean(apps.appStore?.sdkKey),
    webhook: webhook.ok ? 'created' : 'manual',
    webhookError,
  };
}

// ─── Refresh ──────────────────────────────────────────────────────────────────

export interface RefreshResult {
  /** False only when RevenueCat REJECTED the key (revoked, deleted, permissions removed). */
  keyValid: boolean;
  keyError: string | null;
  /** RevenueCat could not be reached; everything cached was kept as it was. */
  unreachable: boolean;
  testStoreReady: boolean;
  appStoreReady: boolean;
  appStoreAmbiguous: boolean;
  webhookReady: boolean;
}

/**
 * Re-run discovery for a connected project and repair the webhook if it is
 * missing. Cheap enough for the tab's "Check again" and for a release build;
 * never throws. On any failed lookup the cached SDK keys and webhook id are
 * left exactly as they were: a transient RevenueCat error must not turn into
 * "this app has no key".
 */
export async function refreshRevenueCatConnection(
  projectId: string,
  requestOrigin?: string,
): Promise<RefreshResult | null> {
  const connection = await getRevenueCatConnection(projectId);
  if (!connection) return null;
  const db = getDb();
  const { secretKey, rcProjectId } = connection;

  const discovered = await discoverApps(secretKey, rcProjectId, connection.rcAppStoreAppId);
  if (!discovered.ok) {
    const explained = explainRevenueCatError(discovered);
    const unreachable = explained.problem === 'unreachable';
    return {
      keyValid: unreachable,
      keyError: unreachable ? null : explained.message,
      unreachable,
      testStoreReady: Boolean(connection.rcTestStoreSdkKey),
      appStoreReady: Boolean(connection.rcAppStoreSdkKey),
      appStoreAmbiguous: false,
      webhookReady: Boolean(connection.rcWebhookIntegrationId),
    };
  }
  const { apps } = discovered;

  // Matching on the stored (encrypted) key identifies the exact connection that
  // was read at the top: a reconnect, even with the same key, stores a new value.
  const sameConnection = and(
    eq(projectRevenueCatConnections.projectId, projectId),
    eq(projectRevenueCatConnections.rcProjectId, connection.rcProjectId),
    eq(projectRevenueCatConnections.rcSecretKey, connection.rcSecretKey),
  );

  let integrationId = connection.rcWebhookIntegrationId;
  // Repairing the webhook writes to RevenueCat, so it takes the same lock as
  // connect. If a connect is in flight, leave the webhook to it.
  const release = requestOrigin ? await acquireLifecycleLock(projectId) : null;
  if (requestOrigin && release && release !== 'busy') {
    try {
      // Discovery took a while. If the project was disconnected or reconnected
      // meanwhile, the webhook id and secret read at the top are obsolete, and
      // "repairing" with them would replace the new connection's webhook.
      const current = await getRevenueCatConnection(projectId);
      if (
        !current ||
        current.rcProjectId !== connection.rcProjectId ||
        current.rcSecretKey !== connection.rcSecretKey
      ) {
        return null;
      }
      // The webhook id as it is NOW: another "Check again" may have repaired it
      // since the read at the top.
      integrationId = current.rcWebhookIntegrationId;
      const [project] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId));
      const webhook = await ensureWebhook({
        secretKey,
        rcProjectId,
        projectId,
        projectName: project?.name ?? 'app',
        url: revenueCatWebhookUrl(requestOrigin),
        authorizationHeader: current.inboundWebhookSecret,
        existingIntegrationId: integrationId,
      });
      let webhookError: string | null = null;
      if (!webhook.ok) {
        // Forget the id only when RevenueCat said the integration is gone. After
        // a timeout or a 5xx it is still there, and still ours to remove later.
        if (webhook.previousGone) integrationId = null;
        webhookError = webhook.error;
      } else {
        integrationId = webhook.integrationId;
      }
      // Stored before the lock is released, so the next repair starts from it.
      await db
        .update(projectRevenueCatConnections)
        .set({ rcWebhookIntegrationId: integrationId, webhookError, updatedAt: new Date() })
        .where(sameConnection);
    } finally {
      await release();
    }
  }

  // Everything above was learned about the connection read at the top. If the
  // project was reconnected or disconnected while RevenueCat was answering,
  // that knowledge is about a different connection: write nothing. The webhook
  // fields are not written here: only a repair (above, under the lock) knows
  // them, and a refresh without one would put back what it read before a
  // repair that ran meanwhile.
  await db
    .update(projectRevenueCatConnections)
    .set({
      rcTestStoreAppId: apps.testStore?.appId ?? null,
      rcTestStoreSdkKey: apps.testStore?.sdkKey ?? null,
      rcAppStoreAppId: apps.appStore?.appId ?? null,
      rcAppStoreSdkKey: apps.appStore?.sdkKey ?? null,
      updatedAt: new Date(),
    })
    .where(sameConnection);

  return {
    keyValid: true,
    keyError: null,
    unreachable: false,
    testStoreReady: Boolean(apps.testStore?.sdkKey),
    appStoreReady: Boolean(apps.appStore?.sdkKey),
    appStoreAmbiguous: apps.appStoreAmbiguous,
    webhookReady: Boolean(integrationId),
  };
}

// ─── Disconnect ───────────────────────────────────────────────────────────────

export interface DisconnectResult {
  /** Botflow had created a webhook in the RevenueCat project. */
  hadWebhook: boolean;
  /** …and it is gone from RevenueCat now. False = the user has to delete it there. */
  webhookRemoved: boolean;
  /** Where to delete it by hand when we could not. */
  integrationsUrl: string | null;
}

/**
 * Remove everything Botflow holds for this connection: the webhook it created
 * in RevenueCat and the stored secret key. Products, customers and purchases in
 * RevenueCat are the user's and are left alone. Safe to call when not connected.
 *
 * The stored key is deleted even when the webhook could not be (the usual
 * reason to disconnect is a revoked key, which cannot delete anything); the
 * caller is told, so the user can remove the leftover webhook in RevenueCat.
 */
export async function disconnectRevenueCat(
  projectId: string,
  opts: {
    /** Deleting the whole project: do not wait for, or yield to, a change in flight. */
    force?: boolean;
  } = {},
): Promise<DisconnectResult | 'busy'> {
  const release = opts.force ? null : await acquireLifecycleLock(projectId);
  if (release === 'busy') return 'busy';
  try {
    return await disconnectLocked(projectId);
  } finally {
    if (release) await release();
  }
}

async function disconnectLocked(projectId: string): Promise<DisconnectResult> {
  const db = getDb();
  const connection = await getRevenueCatConnection(projectId);
  const hadWebhook = Boolean(connection?.rcWebhookIntegrationId);
  let webhookRemoved = false;
  if (connection?.rcWebhookIntegrationId) {
    const removed = await deleteWebhookIntegration(
      connection.secretKey,
      connection.rcProjectId,
      connection.rcWebhookIntegrationId,
    );
    webhookRemoved = removed.ok || removed.status === 404;
  }
  // Delete by project id (not via `connection`) so a row whose key no longer
  // decrypts is removed too.
  await db.delete(projectRevenueCatConnections).where(eq(projectRevenueCatConnections.projectId, projectId));
  await db
    .update(projects)
    .set({
      revenuecatStatus: 'none',
      revenuecatProjectId: null,
      revenuecatWebhookSecret: null,
      revenuecatScaffoldState: null,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, projectId));
  return {
    hadWebhook,
    webhookRemoved,
    integrationsUrl:
      hadWebhook && !webhookRemoved && connection ? dashboardUrl(connection.rcProjectId, 'integrations') : null,
  };
}

// ─── Helpers for callers ──────────────────────────────────────────────────────

/** What the catalog module needs from a connection. */
export function catalogContext(connection: RevenueCatConnection): {
  secretKey: string;
  rcProjectId: string;
  testStoreAppId: string | null;
  appStoreAppId: string | null;
} {
  return {
    secretKey: connection.secretKey,
    rcProjectId: connection.rcProjectId,
    testStoreAppId: connection.rcTestStoreAppId,
    appStoreAppId: connection.rcAppStoreAppId,
  };
}

// The chat thread whose agent asked for payments while RevenueCat was not yet
// connected. When the user finishes connecting, the workspace tells that agent
// so it can create the products instead of the user having to prompt again.
const AGENT_WAITING_TTL_SECONDS = 7 * 24 * 60 * 60;
const agentWaitingKey = (projectId: string) => `revenuecat:agent-waiting:${projectId}`;

export async function markAgentWaitingForConnect(projectId: string, threadId: string | null | undefined): Promise<void> {
  try {
    await redis.setex(agentWaitingKey(projectId), AGENT_WAITING_TTL_SECONDS, threadId || 'current');
  } catch (err) {
    console.error('[revenuecat] could not record the waiting agent thread:', err);
  }
}

/**
 * The thread whose agent is waiting for the connection: a thread id, 'current',
 * or null when no agent asked. The marker is NOT cleared here: the browser
 * still has to deliver the note, and may fail to (tab closed, request lost).
 * It is cleared when that agent next uses a RevenueCat tool.
 */
export async function peekAgentWaitingForConnect(projectId: string): Promise<string | null> {
  try {
    const value = await redis.get<string>(agentWaitingKey(projectId));
    return value ? String(value) : null;
  } catch (err) {
    console.error('[revenuecat] could not read the waiting agent thread:', err);
    return null;
  }
}

/** The agent has picked the work back up; nobody is waiting any more. */
export async function clearAgentWaitingForConnect(projectId: string): Promise<void> {
  try {
    await redis.del(agentWaitingKey(projectId));
  } catch (err) {
    console.error('[revenuecat] could not clear the waiting agent thread:', err);
  }
}
