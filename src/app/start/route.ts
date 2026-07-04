import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { provisionConvexBackend } from '@/lib/convex-platform';
import { getUserTierAndLimits, isBetaUser } from '@/lib/tier';
import { countUserConvexProjects } from '@/lib/usage';
import { getUserCredentials, setUserCredentials, type UserCredentials } from '@/lib/user-credentials';
import { normalizeProjectPlatform, type ProjectPlatform, type BackendType } from '@/lib/project-platform';
import { resolveModelId } from '@/lib/agent/models';
import { credFlagsFromUserCredentials, resolveBackends, type AgentBackend } from '@/lib/agent/backend-resolution';
import { USE_TOGETHER_KIMI } from '@/lib/feature-flags';
import { canUseSwift } from '@/lib/swift-access';
import { randomUUID } from 'node:crypto';

const CONVEX_CLI_API = 'https://api.convex.dev/api';

/**
 * Resolve the Convex team slug from stored credentials or the OAuth token.
 * Team-scoped tokens have format "team:<slug>|<jwt>".
 */
function resolveTeamSlug(creds: UserCredentials): string | null {
  if (creds.convexTeamId) return creds.convexTeamId;
  const match = creds.convexOAuthAccessToken?.match(/^team:([^|]+)\|/);
  return match ? match[1] : null;
}

/**
 * Provision a Convex project in the user's own account via their OAuth token.
 * Uses the Convex CLI API (/api/) which accepts OAuth access tokens.
 */
async function provisionUserConvex(
  creds: UserCredentials,
  projectDisplayName: string,
  userId: string,
): Promise<{ projectSlug: string; deploymentName: string; deploymentUrl: string; adminKey: string }> {
  const teamSlug = resolveTeamSlug(creds);
  if (!teamSlug) throw new Error('Cannot determine Convex team from OAuth token');

  // Cache team slug for future requests
  if (!creds.convexTeamId) {
    await setUserCredentials(userId, { convexTeamId: teamSlug });
  }

  const headers = {
    'Authorization': `Bearer ${creds.convexOAuthAccessToken}`,
    'Content-Type': 'application/json',
  };

  const convexProjectName = `bf-${projectDisplayName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20)}`;
  const res = await fetch(`${CONVEX_CLI_API}/create_project`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ team: teamSlug, projectName: convexProjectName, deploymentType: 'prod' }),
  });

  if (!res.ok) {
    const errText = await res.text();
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

  // Convex no longer returns adminKey in create_project — fetch it separately.
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
    console.log(`[BYOC] create_deploy_key status=${keyRes.status}`);
    if (!keyRes.ok) {
      // Platform API v1 may not accept OAuth tokens — try the CLI API fallback
      const cliKeyRes = await fetch(`https://api.convex.dev/api/get_admin_key`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ deploymentName, teamSlug }),
      });
      const cliKeyData = await cliKeyRes.json() as Record<string, unknown>;
      console.log(`[BYOC] CLI get_admin_key status=${cliKeyRes.status}`);
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

  return {
    projectSlug,
    deploymentName,
    deploymentUrl: prodUrl || `https://${deploymentName}.convex.cloud`,
    adminKey,
  };
}

export async function GET(request: Request) {
  const { userId, redirectToSignIn } = await auth();
  const url = new URL(request.url);
  const prompt = url.searchParams.get('prompt')?.slice(0, 30000) ?? '';
  const visibility = url.searchParams.get('visibility') ?? 'public';
  const platformParam = url.searchParams.get('platform');
  // Template fork: seedSlug points at a public project whose source bundle seeds
  // the new sandbox. Forks are always the sandbox "Web" platform.
  const seedSlug = url.searchParams.get('seedSlug');
  const platform = (seedSlug ? 'sandboxed-web' : normalizeProjectPlatform(platformParam)) as ProjectPlatform;
  const backendTypeParam = url.searchParams.get('backendType');
  const modelParam = url.searchParams.get('model');
  const model = (
    modelParam === 'gpt-5.3-codex' ? 'gpt-5.3-codex' :
    modelParam === 'gpt-5.4' ? 'gpt-5.4' :
    modelParam === 'gpt-5.5' ? 'gpt-5.5' :
    modelParam === 'gpt-5.2' ? 'gpt-5.3-codex' : // migrate legacy
    modelParam === 'gpt-4.1' ? 'gpt-5.3-codex' : // migrate legacy
    modelParam === 'claude-sonnet-5' ? 'claude-sonnet-5' :
    modelParam === 'claude-sonnet-4-6' ? 'claude-sonnet-5' : // migrate legacy → superseded by Sonnet 5
    modelParam === 'claude-sonnet-4.6' ? 'claude-sonnet-5' : // migrate legacy
    modelParam === 'claude-sonnet-4.5' ? 'claude-sonnet-5' : // migrate legacy
    modelParam === 'claude-haiku-4.5' ? 'claude-sonnet-5' : // removed model
    modelParam === 'claude-opus-4-8' ? 'claude-opus-4-8' :
    modelParam === 'claude-opus-4-7' ? 'claude-opus-4-8' : // migrate legacy
    modelParam === 'claude-opus-4.7' ? 'claude-opus-4-8' : // migrate legacy
    modelParam === 'claude-opus-4.6' ? 'claude-opus-4-8' : // migrate legacy
    modelParam === 'claude-opus-4.5' ? 'claude-opus-4-8' : // migrate legacy
    modelParam === 'claude-fable-5' ? 'claude-fable-5' :
    modelParam === 'fireworks-minimax-m2p5' ? 'fireworks-minimax-m3' : // updated model
    modelParam === 'fireworks-minimax-m2p7' ? 'fireworks-minimax-m3' : // updated model
    modelParam === 'kimi-k2.5' ? 'fireworks-minimax-m3' : // removed model
    modelParam === 'kimi-k2-thinking-turbo' ? 'fireworks-minimax-m3' : // removed model
    modelParam === 'fireworks-minimax-m3' ? 'fireworks-minimax-m3' :
    modelParam === 'fireworks-glm-5p2' ? 'fireworks-glm-5p2' :
    modelParam === 'fireworks-glm-5p1' ? 'fireworks-glm-5p2' : // updated model
    modelParam === 'fireworks-kimi-k2p6' ? 'fireworks-kimi-k2p7' : // updated model
    modelParam === 'fireworks-kimi-k2p7' ? 'fireworks-kimi-k2p7' :
    modelParam === 'gemini-3.1-pro-preview' ? 'gemini-3.1-pro-preview' :
    'fireworks-kimi-k2p7'
  ) as 'gpt-5.3-codex' | 'gpt-5.4' | 'gpt-5.5' | 'claude-sonnet-5' | 'claude-opus-4-8' | 'claude-fable-5' | 'fireworks-minimax-m3' | 'fireworks-glm-5p2' | 'fireworks-kimi-k2p7' | 'gemini-3.1-pro-preview';

  if (!userId) {
    return redirectToSignIn({ returnBackUrl: request.url });
  }

  // This is the landing page's primary creation path. Enforce the same Swift
  // entitlement as the JSON projects API so direct URLs cannot create an
  // unusable Swift project.
  if (platform === 'swift' && !(await canUseSwift(userId))) {
    const errUrl = new URL('/', request.url);
    errUrl.searchParams.set('error', 'swift_requires_pro');
    return NextResponse.redirect(errUrl);
  }

  try {
    const db = getDb();
    const requestedName = url.searchParams.get('name');
    const name = requestedName?.trim()
      ? requestedName.trim().slice(0, 48)
      : prompt?.trim()
        ? prompt.slice(0, 48)
        : 'New Project';

    // Resolve backend type from server-side credential store (authoritative).
    //   'none'     -> frontend-only project, no Convex provisioning
    //   'user'     -> user-owned (BYOC), provisioned via their OAuth token
    //   'platform' -> Botflow-managed (default)
    const creds = await getUserCredentials(userId);
    let backendType: BackendType;
    // 'No Backend' is supported on platforms that have a no-backend template
    // variant: web + sandboxed-web (plain Vite) and swift (the plain swift
    // template vs. swift-convex). Mobile/multiplatform ship with Convex baked
    // in, so for those we silently coerce `none` -> `platform`.
    const supportsNoBackend =
      platform === 'web' || platform === 'sandboxed-web' || platform === 'swift';
    // Precedence: an EXPLICIT URL param always wins over the sticky saved
    // preference, then the saved preference, then platform default.
    //   • ?backendType=user  → BYOC (the hard gate below errors if no token)
    //   • ?backendType=none  → no backend (coerced to platform if unsupported)
    //   • else sticky 'none' → no backend
    //   • else sticky 'user' → BYOC, but ONLY if a Convex OAuth token actually
    //     exists (so a disconnected user — token cleared, preference left 'user'
    //     — falls back to platform instead of being stuck on convex_not_connected)
    //   • else                → platform
    if (backendTypeParam === 'user') {
      backendType = 'user';
    } else if (backendTypeParam === 'none') {
      backendType = supportsNoBackend ? 'none' : 'platform';
    } else if (creds.convexBackendPreference === 'none' && supportsNoBackend) {
      backendType = 'none';
    } else if (creds.convexBackendPreference === 'user' && !!creds.convexOAuthAccessToken) {
      backendType = 'user';
    } else {
      backendType = 'platform';
    }
    console.log(
      `[start] project creation: platform=${platform} backendTypeParam=${backendTypeParam} ` +
      `pref=${creds.convexBackendPreference ?? 'null'} → backendType=${backendType}`,
    );

    // BYOC hard gate: if user selected BYOC, they MUST have a valid OAuth token.
    // Never fall through to platform provisioning — that would consume platform resources.
    if (backendType === 'user' && !creds.convexOAuthAccessToken) {
      const errUrl = new URL('/', request.url);
      errUrl.searchParams.set('error', 'convex_not_connected');
      return NextResponse.redirect(errUrl);
    }

    // Decide whether this project may provision a NEW platform-managed Convex
    // backend, and enforce the per-tier managed-Convex cap at creation time
    // (the other half of the cap; the deploy route enforces the rest):
    //   - beta testers: exempt (always allowed)
    //   - free: never (unless the global override flag is set)
    //   - pro/max: allowed only while under maxConvexProjects
    // When a platform backend isn't allowed we downgrade to 'none' so the
    // workspace mounts the no-backend template — except for template forks
    // (seeded Convex code would break) and platforms without a no-backend
    // template (mobile/multiplatform ship Convex baked in), which instead bounce
    // with an upsell. We re-check server-side in case the client lied.
    if (backendType === 'platform') {
      const cloudConvexForAll = process.env.ALLOW_CLOUD_CONVEX_FOR_ALL === 'true';
      const [limits, beta] = await Promise.all([
        getUserTierAndLimits(userId),
        isBetaUser(userId),
      ]);

      let allowed: boolean;
      if (beta) {
        allowed = true;
      } else if (limits.tier === 'free') {
        allowed = cloudConvexForAll;
      } else {
        const currentConvex = await countUserConvexProjects(userId);
        allowed = currentConvex < limits.maxConvexProjects;
      }

      if (!allowed) {
        if (!supportsNoBackend || seedSlug) {
          const errUrl = new URL('/', request.url);
          errUrl.searchParams.set(
            'error',
            limits.tier === 'free' ? 'convex_requires_pro' : 'convex_limit_reached',
          );
          return NextResponse.redirect(errUrl);
        }
        backendType = 'none';
      }
    }

    // Resolve the source bundle for a template fork (seeds the new sandbox on
    // first open). Looked up here so the column is set at insert time.
    let seedBundleUrl: string | null = null;
    if (seedSlug) {
      const [src] = await db
        .select({ publicSourceUrl: projects.publicSourceUrl })
        .from(projects)
        .where(eq(projects.publicSlug, seedSlug))
        .limit(1);
      seedBundleUrl = src?.publicSourceUrl ?? null;
    }

    // Resolve the initial agent backend for this project. The user's BYOK
    // preference applies only when both backends are available; OAuth users
    // are locked to claude-code automatically.
    const resolvedModel = resolveModelId(model);
    const backendResolution = resolveBackends({
      model: resolvedModel,
      platform,
      creds: credFlagsFromUserCredentials(creds),
      useTogetherKimi: USE_TOGETHER_KIMI,
    });
    let initialAgentBackend: AgentBackend = backendResolution.defaultBackend;
    if (
      backendResolution.locked === null &&
      backendResolution.available.length >= 2 &&
      creds.preferredAnthropicBackend &&
      backendResolution.available.includes(creds.preferredAnthropicBackend)
    ) {
      initialAgentBackend = creds.preferredAnthropicBackend;
    }

    const [project] = await db
      .insert(projects)
      .values({
        name,
        userId,
        platform,
        model,
        backendType,
        agentBackend: initialAgentBackend,
        currentSegmentId: randomUUID(),
        // Template fork: seed the sandbox from the source bundle on first open
        // (falls back to the template if the source had no bundle).
        ...(seedBundleUrl ? { seedBundleUrl } : {}),
        ...(seedSlug
          ? { sandboxTemplate: backendType === 'none' ? 'vite' as const : 'viteConvex' as const }
          : {}),
      })
      .returning();

    if (backendType === 'none') {
      // No backend selected — skip provisioning entirely. The project will use
      // the no-backend template (vite_template) and never have a /convex folder.
    } else if (backendType === 'user') {
      // BYOC: provision in the user's own Convex account via their OAuth token.
      // If this fails, delete the project and redirect with an error — never fall through.
      try {
        const convexResult = await provisionUserConvex(creds, name, userId);

        await db.update(projects)
          .set({
            userConvexUrl: convexResult.deploymentUrl,
            userConvexDeployKey: convexResult.adminKey,
            convexProjectId: convexResult.projectSlug,
            convexDeploymentId: convexResult.deploymentName,
            convexDeployUrl: convexResult.deploymentUrl,
            backendType: 'user',
            updatedAt: new Date(),
          })
          .where(eq(projects.id, project.id));
      } catch (error) {
        // BYOC failed — clean up the project row and redirect with error
        await db.delete(projects).where(eq(projects.id, project.id));
        const msg = error instanceof Error ? error.message : String(error);
        console.error('BYOC Convex provisioning failed:', msg);
        const errUrl = new URL('/', request.url);
        if (msg.includes('ProjectQuotaReached')) {
          errUrl.searchParams.set('error', 'convex_quota');
        } else {
          errUrl.searchParams.set('error', 'convex_provision_failed');
        }
        return NextResponse.redirect(errUrl);
      }
    } else {
      // Platform-managed: provision under our account
      const limits = await getUserTierAndLimits(userId);
      const cloudConvexForAll = process.env.ALLOW_CLOUD_CONVEX_FOR_ALL === 'true';
      if (cloudConvexForAll || limits.tier !== 'free') {
        try {
          const convexProjectName = `ide-${project.id.slice(0, 8)}`;
          const convex = await provisionConvexBackend(convexProjectName);

          await db.update(projects)
            .set({
              convexProjectId: convex.projectId,
              convexDeploymentId: convex.deploymentId,
              convexDeployUrl: convex.deployUrl,
              convexDeployKey: convex.deployKey,
              updatedAt: new Date(),
            })
            .where(eq(projects.id, project.id));

          console.log(`Convex backend provisioned for project ${project.id}: ${convex.deployUrl}`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (msg.includes('ProjectQuotaReached')) {
            console.error('Convex quota reached, cannot create project:', msg);
            const errUrl = new URL('/', request.url);
            errUrl.searchParams.set('error', 'convex_quota');
            return NextResponse.redirect(errUrl);
          }
          console.error('Failed to provision Convex backend:', error);
        }
      }
    }

    // Redirect to workspace and pass starter prompt for auto-run
    const workspaceUrl = new URL(`${url.origin}/workspace/${project.id}`);
    if (prompt) workspaceUrl.searchParams.set('prompt', prompt);
    workspaceUrl.searchParams.set('platform', platform);
    workspaceUrl.searchParams.set('model', model);
    workspaceUrl.searchParams.set('backendType', backendType);
    if (visibility) workspaceUrl.searchParams.set('visibility', visibility);
    return NextResponse.redirect(workspaceUrl);
  } catch (err) {
    console.error('Failed to start project:', err);
    return NextResponse.redirect(new URL('/', request.url));
  }
}
