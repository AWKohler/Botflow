import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { provisionConvexBackend, getConvexPlatformClient } from '@/lib/convex-platform';
import { getUserTierAndLimits, isBetaUser } from '@/lib/tier';
import { countUserConvexProjects } from '@/lib/usage';
import { limitReachedResponse } from '@/lib/plan-response';

const FLY_WORKER_URL = process.env.FLY_WORKER_URL;
const WORKER_AUTH_TOKEN = process.env.FLY_WORKER_AUTH_TOKEN ?? process.env.WORKER_AUTH_TOKEN ?? "";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // 1. Verify authentication
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: projectId } = await params;

    // 2. Verify project ownership and get deploy key
    const db = getDb();
    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .limit(1);

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // No-backend projects intentionally have no Convex deployment. Reject the
    // call so we don't silently provision one behind the user's back.
    if (project.backendType === 'none') {
      return NextResponse.json({
        error: 'no_backend',
        message: 'This project was created without a backend — Convex deploy is not available.',
      }, { status: 400 });
    }

    // If using user-managed Convex backend, check for user deploy key
    if (project.backendType === 'user') {
      if (!project.userConvexDeployKey) {
        return NextResponse.json({
          error: 'convex_disconnected',
          message: 'Your Convex account is not connected. Please reconnect in project settings.',
        }, { status: 402 });
      }
    } else {
      // Re-read the latest row right before deciding to provision: a concurrent
      // deploy may have just provisioned, and acting on the stale snapshot would
      // create a SECOND platform Convex project (orphaning the first and bypassing
      // the per-tier cap). This narrows — but a truly simultaneous pair still
      // needs a per-project provisioning lock to fully close.
      const [freshProject] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      if (freshProject) {
        project.convexDeployKey = freshProject.convexDeployKey;
        project.convexProjectId = freshProject.convexProjectId;
        project.convexDeploymentId = freshProject.convexDeploymentId;
        project.convexDeployUrl = freshProject.convexDeployUrl;
        project.userConvexDeployKey = freshProject.userConvexDeployKey;
      }
      // Auto-provision platform Convex backend if missing (handles projects created before
      // Convex integration or where provisioning silently failed at creation time).
      if (!project.convexDeployKey && !project.userConvexDeployKey) {
        // Enforce per-user managed-Convex limit before provisioning a new one
        // (beta testers are exempt).
        if (!project.convexProjectId) {
          const [limits, currentConvex, beta] = await Promise.all([
            getUserTierAndLimits(userId),
            countUserConvexProjects(userId),
            isBetaUser(userId),
          ]);
          if (!beta && currentConvex >= limits.maxConvexProjects) {
            return limitReachedResponse({
              limitType: 'convex_project_count',
              current: currentConvex,
              limit: limits.maxConvexProjects,
              tier: limits.tier,
            });
          }
        }

        try {
          let deployKey: string;

          if (project.convexDeploymentId) {
            // Deployment exists but key was lost — create a new deploy key
            const client = getConvexPlatformClient();
            deployKey = await client.createDeployKey(project.convexDeploymentId);
            await db.update(projects)
              .set({ convexDeployKey: deployKey, updatedAt: new Date() })
              .where(eq(projects.id, projectId));
            project.convexDeployKey = deployKey;
          } else {
            // No Convex backend at all — provision one now
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
              .where(eq(projects.id, projectId));
            project.convexDeployKey = convex.deployKey;
          }
        } catch (provisionErr) {
          const msg = provisionErr instanceof Error ? provisionErr.message : String(provisionErr);
          console.error('[convex/deploy] provisioning failed:', msg);
          const isQuota = msg.includes('ProjectQuotaReached');
          return NextResponse.json(
            {
              // Generic for non-quota so we never echo an upstream Convex body to
              // the client (the detail is in the server log above).
              error: isQuota
                ? 'Convex project quota reached (20/20). Delete unused projects or upgrade your Convex plan at https://www.convex.dev/plans to continue.'
                : 'Failed to provision a Convex backend. Please try again.',
            },
            { status: isQuota ? 402 : 500 }
          );
        }
      }
    }

    // 3. Resolve the deploy key — prefer user key, fall back to platform key
    const resolvedDeployKey = (project.userConvexDeployKey || project.convexDeployKey || '').trim();
    // Don't log any portion of the deploy key — just whether one is present.
    console.log(`[convex/deploy] project=${projectId} backendType=${project.backendType} hasKey=${resolvedDeployKey ? 'yes' : 'no'}`);
    if (!resolvedDeployKey) {
      console.error(`No deploy key available for project ${projectId} (backendType=${project.backendType})`);
      return NextResponse.json(
        { ok: false, output: '', error: 'No Convex deploy key available. Please reconnect your Convex account or contact support.' },
        { status: 500 }
      );
    }

    // Get the zip blob from request body
    const zipBlob = await request.blob();

    if (zipBlob.size === 0) {
      return NextResponse.json(
        { error: 'No deployment package provided' },
        { status: 400 }
      );
    }

    // 4. Send to deployment worker
    if (!FLY_WORKER_URL) {
      console.error('Convex deploy worker URL is not configured');
      return NextResponse.json(
        { ok: false, output: '', error: 'Deployment service is not available. Please try again later.' },
        { status: 503 }
      );
    }

    let response: Response;
    try {
      response = await fetch(FLY_WORKER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${WORKER_AUTH_TOKEN}`,
          'X-Convex-Deploy-Key': resolvedDeployKey,
        },
        body: zipBlob,
      });
    } catch (fetchError) {
      console.error('Convex deploy worker unreachable:', fetchError);
      return NextResponse.json(
        { ok: false, output: '', error: 'Deployment service is temporarily unavailable. Please try again in a moment.' },
        { status: 503 }
      );
    }

    // 5. Parse response from deployment worker
    let result: {
      success?: boolean;
      logs?: string;
      error?: string;
      generatedFiles?: { path: string; content: string }[];
      functionSpec?: import('@/lib/swift-convex-codegen').ConvexFunctionSpec;
    };
    try {
      result = await response.json();
    } catch {
      console.error('Convex deploy worker returned non-JSON response, status:', response.status);
      return NextResponse.json(
        { ok: false, output: '', error: 'Deployment service returned an unexpected response. Please try again.' },
        { status: 502 }
      );
    }

    if (!response.ok || !result.success) {
      console.error('Convex deploy worker error:', result.error, 'status:', response.status);
      return NextResponse.json(
        {
          ok: false,
          output: result.logs || '',
          error: result.error || 'Deployment failed. Please check your Convex functions for errors and try again.',
          generatedFiles: [],
        },
        { status: 200 }
      );
    }

    // 5b. Swift codegen: regenerate Sources/Core/ConvexAPI.swift from the
    // deployed function manifest so Swift call sites reference compile-checked
    // constants instead of raw strings. Non-fatal; no-op for web projects.
    let swiftApiRegenerated = false;
    if (result.functionSpec) {
      const { writeSwiftConvexApi } = await import('@/lib/swift-convex-codegen');
      swiftApiRegenerated = await writeSwiftConvexApi(projectId, project, result.functionSpec);
    }

    // 6. Return success with logs and generated files
    return NextResponse.json({
      ok: true,
      output:
        (result.logs || '') +
        (swiftApiRegenerated
          ? '\nRegenerated Sources/Core/ConvexAPI.swift from the deployed functions — reference Convex functions through ConvexAPI constants only.\n'
          : ''),
      generatedFiles: result.generatedFiles || [],
    });
  } catch (error) {
    console.error('Convex deployment error:', error);
    return NextResponse.json(
      {
        ok: false,
        output: '',
        error: 'An unexpected error occurred during deployment. Please try again.',
      },
      { status: 500 }
    );
  }
}
