import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getUserCredentials, setUserCredentials } from '@/lib/user-credentials';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CONVEX_CLI_API = 'https://api.convex.dev/api';

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { projectId, projectName } = await req.json() as { projectId: string; projectName: string };
  if (!projectId) return NextResponse.json({ error: 'projectId required' }, { status: 400 });

  const creds = await getUserCredentials(userId);
  if (!creds.convexOAuthAccessToken) {
    return NextResponse.json({ error: 'convex_not_connected', message: 'Please connect your Convex account first.' }, { status: 401 });
  }

  const db = getDb();
  const [project] = await db.select().from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);

  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  // Idempotency guard: if this project already has a user-owned Convex
  // deployment, return it instead of calling create_project again. Without this,
  // a repeat or concurrent call would provision a SECOND Convex project, orphan
  // the first, and overwrite the DB pointer. (A truly-simultaneous first call is
  // still a narrow race — a per-project provisioning lock would close it fully.)
  if (project.backendType === 'user' && project.userConvexUrl && project.userConvexDeployKey) {
    return NextResponse.json({ ok: true, deployUrl: project.userConvexUrl, alreadyProvisioned: true });
  }

  try {
    // Resolve team slug from stored value or token prefix ("team:<slug>|<jwt>")
    let teamSlug = creds.convexTeamId ?? null;
    if (!teamSlug) {
      const match = creds.convexOAuthAccessToken.match(/^team:([^|]+)\|/);
      if (!match) throw new Error('Cannot determine Convex team from OAuth token');
      teamSlug = match[1];
      await setUserCredentials(userId, { convexTeamId: teamSlug });
    }

    const headers = {
      'Authorization': `Bearer ${creds.convexOAuthAccessToken}`,
      'Content-Type': 'application/json',
    };

    const convexProjectName = projectName
      ? `bf-${projectName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20)}`
      : `bf-${projectId.slice(0, 8)}`;

    const res = await fetch(`${CONVEX_CLI_API}/create_project`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ team: teamSlug, projectName: convexProjectName, deploymentType: 'prod' }),
    });

    if (!res.ok) {
      const errText = await res.text();
      if (errText.includes('ProjectQuotaReached')) {
        return NextResponse.json({
          error: 'convex_quota',
          message: 'Your Convex account has reached its project quota. Delete unused projects at dashboard.convex.dev or upgrade your Convex plan.',
        }, { status: 402 });
      }
      throw new Error(`Convex create_project failed: ${res.status} ${errText}`);
    }

    const data = await res.json() as Record<string, unknown>;
    // Do NOT log the raw response — create_project can include an adminKey/deployKey.

    const projectSlug =
      (data.projectSlug as string | undefined) ||
      (data.slug as string | undefined) ||
      ((data.project as Record<string, unknown> | undefined)?.slug as string | undefined);
    const deploymentName =
      (data.deploymentName as string | undefined) ||
      (data.prodDeploymentName as string | undefined) ||
      ((data.prodDeployment as Record<string, unknown> | undefined)?.name as string | undefined) ||
      '';
    const prodUrl =
      (data.prodUrl as string | undefined) ||
      ((data.prodDeployment as Record<string, unknown> | undefined)?.url as string | undefined);

    if (!projectSlug || !deploymentName) {
      throw new Error(`Incomplete create_project response from Convex API — got keys: ${Object.keys(data).join(', ')}`);
    }

    let adminKey =
      (data.adminKey as string | undefined) ||
      (data.deployKey as string | undefined) ||
      ((data.prodDeployment as Record<string, unknown> | undefined)?.adminKey as string | undefined);

    if (!adminKey) {
      const keyRes = await fetch(
        `https://api.convex.dev/v1/deployments/${deploymentName}/create_deploy_key`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: `ide-${Date.now()}` }),
        },
      );
      const keyData = await keyRes.json() as Record<string, unknown>;
      // Never log keyData — it contains the deploy key. Status only.
      console.log(`[BYOC provision] create_deploy_key status=${keyRes.status}`);
      if (!keyRes.ok) {
        const cliKeyRes = await fetch(`https://api.convex.dev/api/get_admin_key`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ deploymentName, team: teamSlug }),
        });
        const cliKeyData = await cliKeyRes.json() as Record<string, unknown>;
        console.log(`[BYOC provision] CLI get_admin_key status=${cliKeyRes.status}`);
        adminKey =
          (cliKeyData.adminKey as string | undefined) ||
          (cliKeyData.key as string | undefined);
      } else {
        adminKey =
          (keyData.key as string | undefined) ||
          (keyData.deployKey as string | undefined) ||
          (keyData.accessToken as string | undefined);
      }
      if (!adminKey) {
        // Don't include the response body — it may contain a partial/secret key.
        throw new Error('Failed to obtain Convex deploy key from the Convex API.');
      }
    }

    const deploymentUrl = prodUrl || `https://${deploymentName}.convex.cloud`;

    await db.update(projects)
      .set({
        userConvexUrl: deploymentUrl,
        userConvexDeployKey: adminKey,
        convexProjectId: projectSlug,
        convexDeploymentId: deploymentName,
        convexDeployUrl: deploymentUrl,
        backendType: 'user',
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId));

    return NextResponse.json({ ok: true, deployUrl: deploymentUrl });
  } catch (e) {
    // Log server-side (messages no longer embed key material); return a stable,
    // non-sensitive message to the client.
    console.error('Convex BYOC provision failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({
      error: 'provision_failed',
      message: 'Failed to provision your Convex backend. Please try again, or reconnect Convex in Settings.',
    }, { status: 500 });
  }
}
