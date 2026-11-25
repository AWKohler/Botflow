/**
 * /api/projects/[id]/revenuecat/status
 *
 * GET  — everything the Payments tab shows about the connection: whether the
 *        stored key still works, which stores are ready, whether RevenueCat can
 *        reach us (webhook) and whether the app's backend is listening.
 * POST — "Check again": re-discover the RevenueCat apps and SDK keys (a Test
 *        Store or App Store app added since connecting), repair the webhook,
 *        re-add the backend receiver files, rewrite the Swift SDK-key file, and
 *        return the fresh status. Owner only, because it changes things.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/server';
import { requireProjectAccess, type ProjectRole } from '@/lib/project-access';
import type { Project } from '@/db/schema';
import { dashboardUrl, explainRevenueCatError, listProjects } from '@/lib/revenuecat';
import {
  getRevenueCatConnection,
  refreshRevenueCatConnection,
  revenueCatWebhookUrl,
} from '@/lib/revenuecat-connection';
import { scaffoldRevenueCatIntoProject } from '@/lib/revenuecat-scaffold';
import { convexSiteUrlFor } from '@/lib/webhook-delivery';
import { REVENUECAT_ENABLED } from '@/lib/feature-flags';

export const runtime = 'nodejs';
export const maxDuration = 60;

type BackendState = 'live' | 'not-deployed' | 'not-configured' | 'no-backend' | 'unknown';

/**
 * Ask the app's backend whether the receiver is deployed. An unsigned request
 * is the cheapest honest probe: the deployed receiver rejects it with 401
 * ("missing signature"), an undeployed one is a 404, and a receiver deployed
 * without its secret answers 500.
 */
async function probeBackend(project: Project): Promise<BackendState> {
  const site = convexSiteUrlFor(project);
  if (!site) return 'no-backend';
  try {
    const res = await fetch(`${site}/revenuecat/webhook`, {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(6_000),
      cache: 'no-store',
    });
    if (res.status === 401) return 'live';
    if (res.status === 404) return 'not-deployed';
    if (res.status === 500) return 'not-configured';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

async function buildStatus(req: NextRequest, project: Project, role: ProjectRole) {
  const connection = await getRevenueCatConnection(project.id);
  // `project` was read when the request started. If the connection was removed
  // since (a disconnect that overlapped "Check again"), say so rather than
  // "connected" with no connection.
  const status = (!connection && project.revenuecatStatus === 'connected' ? 'none' : project.revenuecatStatus) as
    | 'none'
    | 'connecting'
    | 'connected';

  const [keyCheck, backend] = await Promise.all([
    connection ? listProjects(connection.secretKey) : null,
    status === 'none' ? ('unknown' as BackendState) : probeBackend(project),
  ]);
  const keyOk = Boolean(keyCheck?.ok && keyCheck.data.items.some((p) => p.id === connection?.rcProjectId));
  const keyError =
    !connection || keyOk
      ? null
      : keyCheck && !keyCheck.ok
        ? explainRevenueCatError(keyCheck).message
        : 'The stored key no longer has access to this RevenueCat project. Connect again with a new key.';

  const webhookAutomatic = Boolean(connection?.rcWebhookIntegrationId);
  const rcProjectId = connection?.rcProjectId ?? null;

  return {
    ok: true,
    status,
    role,
    environment: project.revenuecatEnvironment as 'sandbox' | 'production',
    connection: connection
      ? {
          rcProjectId: connection.rcProjectId,
          rcProjectName: connection.rcProjectName,
          connectedAt: connection.connectedAt.toISOString(),
        }
      : null,
    links: {
      overview: dashboardUrl(rcProjectId),
      apiKeys: dashboardUrl(rcProjectId, 'api-keys'),
      products: dashboardUrl(rcProjectId, 'product-catalog/products'),
      apps: dashboardUrl(rcProjectId, 'apps'),
      integrations: dashboardUrl(rcProjectId, 'integrations'),
      customers: dashboardUrl(rcProjectId, 'customers'),
    },
    checks: {
      key: { ok: keyOk, error: keyError },
      testStore: { ok: Boolean(connection?.rcTestStoreSdkKey) },
      appStore: { ok: Boolean(connection?.rcAppStoreSdkKey) },
      webhook: {
        mode: webhookAutomatic ? ('automatic' as const) : ('manual' as const),
        // Automatic = Botflow created it. Manual = it counts once an event has arrived.
        ok: webhookAutomatic || Boolean(connection?.lastEventAt),
        error: connection?.webhookError ?? null,
        lastEventAt: connection?.lastEventAt?.toISOString() ?? null,
      },
      backend: { state: backend },
    },
    // Only when Botflow could not create the webhook itself, and only for the
    // owner: the Authorization value is a credential.
    manualWebhook:
      connection && !webhookAutomatic && role === 'owner'
        ? {
            url: revenueCatWebhookUrl(new URL(req.url).origin),
            authorizationHeader: connection.inboundWebhookSecret,
          }
        : null,
  };
}

export type RevenueCatStatusResponse = Awaited<ReturnType<typeof buildStatus>>;

async function authorize(
  params: Promise<{ id: string }>,
  minRole: ProjectRole,
): Promise<{ ok: true; project: Project; role: ProjectRole } | { ok: false; res: NextResponse }> {
  if (!REVENUECAT_ENABLED) {
    return {
      ok: false,
      res: NextResponse.json({ ok: false, error: 'RevenueCat is not enabled on this deployment.' }, { status: 404 }),
    };
  }
  const { userId } = await auth();
  if (!userId) {
    return { ok: false, res: NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 }) };
  }
  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, userId, minRole);
  if (!access) {
    return { ok: false, res: NextResponse.json({ ok: false, error: 'Project not found' }, { status: 404 }) };
  }
  return { ok: true, project: access.project, role: access.role };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authz = await authorize(params, 'editor');
  if (!authz.ok) return authz.res;
  return NextResponse.json(await buildStatus(req, authz.project, authz.role));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authz = await authorize(params, 'owner');
  if (!authz.ok) return authz.res;
  const { project } = authz;

  if (project.revenuecatStatus === 'connected') {
    // Null: the connection was removed or replaced while this ran. Whoever did
    // that owns the project's files now; repair nothing on its behalf.
    const refreshed = await refreshRevenueCatConnection(project.id, new URL(req.url).origin);
    if (refreshed) {
      try {
        await scaffoldRevenueCatIntoProject(project.id);
        const { materializeSwiftRevenueCatConfig } = await import('@/lib/sandbox-env');
        await materializeSwiftRevenueCatConfig(project.id);
      } catch (err) {
        console.error('[revenuecat/status] repair failed:', err);
      }
    }
  }
  return NextResponse.json(await buildStatus(req, project, authz.role));
}
