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
import { decryptSecret, encryptSecret } from '@/lib/secrets';
import {
  checkSecretKeyShape,
  createWebhookIntegration,
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

async function firstSdkKey(
  secretKey: string,
  rcProjectId: string,
  app: RevenueCatApp,
  prefix: string,
): Promise<string | null> {
  const keys = await listPublicApiKeys(secretKey, rcProjectId, app.id);
  if (!keys.ok) return null;
  return keys.data.items.find((k) => k.key?.startsWith(prefix))?.key ?? null;
}

/**
 * Find the Test Store and App Store apps and their public SDK keys.
 * `preferAppStoreAppId` keeps an earlier choice stable when the RevenueCat
 * project has several App Store apps.
 */
export async function discoverApps(
  secretKey: string,
  rcProjectId: string,
  preferAppStoreAppId?: string | null,
): Promise<{ ok: true; apps: DiscoveredApps } | { ok: false; status: number; error: string }> {
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

  return {
    ok: true,
    apps: {
      testStore: testStoreApp ? { appId: testStoreApp.id, sdkKey: testKey } : null,
      appStore: appStoreApp ? { appId: appStoreApp.id, sdkKey: appStoreKey, name: appStoreApp.name } : null,
      appStoreAmbiguous: !appStoreApp && appStoreApps.length > 1,
    },
  };
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

export type WebhookSetup =
  | { ok: true; integrationId: string }
  | { ok: false; fatal: boolean; status: number; error: string };

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
  // A read-only key fails here; that is fatal (it could not create products either).
  const failure = (r: { status: number; error: string }): WebhookSetup => ({
    ok: false,
    fatal: r.status === 401 || r.status === 403,
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
    if (updated.ok) return { ok: true, integrationId: updated.data.id };
    if (updated.status !== 404) return failure(updated);
    // 404: the user deleted it in the RevenueCat dashboard. Fall through and recreate.
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
  return { ok: true, integrationId: created.data.id };
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
      code: RevenueCatKeyProblem | 'shared-project';
      error: string;
      /** Other Botflow projects of this owner on the same RevenueCat project. */
      sharedWith?: string[];
    };

function keyFailure(result: { status: number; error: string }): Extract<ConnectResult, { ok: false }> {
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
  /** The user confirmed sharing a RevenueCat project with another of their apps. */
  allowSharedProject?: boolean;
}): Promise<ConnectResult> {
  const secretKey = opts.secretKey.trim();
  const shape = checkSecretKeyShape(secretKey);
  if (!shape.ok) return { ok: false, status: 400, code: 'not-secret-key', error: shape.message };

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
  const existing = await getRevenueCatConnection(opts.projectId);

  // A RevenueCat project holds one app's products and one Test Store. Two
  // Botflow apps on the same project would show each other's products, so the
  // owner has to opt in.
  if (!opts.allowSharedProject) {
    const sharing = await db
      .select({ name: projects.name })
      .from(projectRevenueCatConnections)
      .innerJoin(projects, eq(projects.id, projectRevenueCatConnections.projectId))
      .where(
        and(
          eq(projectRevenueCatConnections.rcProjectId, rcProject.id),
          eq(projects.userId, opts.userId),
          ne(projectRevenueCatConnections.projectId, opts.projectId),
        ),
      );
    if (sharing.length > 0) {
      const names = sharing.map((p) => p.name);
      return {
        ok: false,
        status: 409,
        code: 'shared-project',
        sharedWith: names,
        error:
          `The RevenueCat project "${rcProject.name}" is already connected to ${names.slice(0, 3).join(', ')}` +
          `${names.length > 3 ? ' and others' : ''}. Apps that share a RevenueCat project share their products, ` +
          'paywall and test purchases. Create a separate RevenueCat project for this app, or connect anyway.',
      };
    }
  }

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

  // Reconnecting to a different RevenueCat project: remove our webhook from the old one.
  if (existing && !sameRcProject && existing.rcWebhookIntegrationId) {
    await deleteWebhookIntegration(existing.secretKey, existing.rcProjectId, existing.rcWebhookIntegrationId);
  }

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
    rcWebhookIntegrationId: webhook.ok ? webhook.integrationId : null,
    webhookError,
    connectedAt: sameRcProject && existing ? existing.connectedAt : now,
    updatedAt: now,
  };
  await db
    .insert(projectRevenueCatConnections)
    .values(values)
    .onConflictDoUpdate({ target: projectRevenueCatConnections.projectId, set: values });

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
  /** The key still works. False = revoked/deleted in RevenueCat. */
  keyValid: boolean;
  keyError: string | null;
  testStoreReady: boolean;
  appStoreReady: boolean;
  appStoreAmbiguous: boolean;
  webhookReady: boolean;
}

/**
 * Re-run discovery for a connected project and repair the webhook if it is
 * missing. Cheap enough for the tab's "Check again" and for a release build;
 * never throws.
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
    return {
      keyValid: false,
      keyError: explainRevenueCatError(discovered).message,
      testStoreReady: Boolean(connection.rcTestStoreSdkKey),
      appStoreReady: Boolean(connection.rcAppStoreSdkKey),
      appStoreAmbiguous: false,
      webhookReady: Boolean(connection.rcWebhookIntegrationId),
    };
  }
  const { apps } = discovered;

  let integrationId = connection.rcWebhookIntegrationId;
  let webhookError = connection.webhookError;
  if (requestOrigin) {
    const [project] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId));
    const webhook = await ensureWebhook({
      secretKey,
      rcProjectId,
      projectId,
      projectName: project?.name ?? 'app',
      url: revenueCatWebhookUrl(requestOrigin),
      authorizationHeader: connection.inboundWebhookSecret,
      existingIntegrationId: integrationId,
    });
    integrationId = webhook.ok ? webhook.integrationId : null;
    webhookError = webhook.ok ? null : webhook.error;
  }

  await db
    .update(projectRevenueCatConnections)
    .set({
      rcTestStoreAppId: apps.testStore?.appId ?? null,
      rcTestStoreSdkKey: apps.testStore?.sdkKey ?? null,
      rcAppStoreAppId: apps.appStore?.appId ?? null,
      rcAppStoreSdkKey: apps.appStore?.sdkKey ?? null,
      rcWebhookIntegrationId: integrationId,
      webhookError,
      updatedAt: new Date(),
    })
    .where(eq(projectRevenueCatConnections.projectId, projectId));

  return {
    keyValid: true,
    keyError: null,
    testStoreReady: Boolean(apps.testStore?.sdkKey),
    appStoreReady: Boolean(apps.appStore?.sdkKey),
    appStoreAmbiguous: apps.appStoreAmbiguous,
    webhookReady: Boolean(integrationId),
  };
}

// ─── Disconnect ───────────────────────────────────────────────────────────────

/**
 * Remove everything Botflow holds for this connection: the webhook it created
 * in RevenueCat and the stored secret key. Products, customers and purchases in
 * RevenueCat are the user's and are left alone. Safe to call when not connected.
 */
export async function disconnectRevenueCat(projectId: string): Promise<{ webhookRemoved: boolean }> {
  const db = getDb();
  const connection = await getRevenueCatConnection(projectId);
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
  return { webhookRemoved };
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
    const { redis } = await import('@/lib/redis');
    await redis.setex(agentWaitingKey(projectId), AGENT_WAITING_TTL_SECONDS, threadId || 'current');
  } catch (err) {
    console.error('[revenuecat] could not record the waiting agent thread:', err);
  }
}

/** Read and clear the marker. Returns the thread id, 'current', or null when no agent asked. */
export async function takeAgentWaitingForConnect(projectId: string): Promise<string | null> {
  try {
    const { redis } = await import('@/lib/redis');
    const value = await redis.get<string>(agentWaitingKey(projectId));
    if (!value) return null;
    await redis.del(agentWaitingKey(projectId));
    return String(value);
  } catch (err) {
    console.error('[revenuecat] could not read the waiting agent thread:', err);
    return null;
  }
}
