import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db';
import { projects, projectMembers } from '@/db/schema';
import { desc, eq, isNull, and, inArray } from 'drizzle-orm';
import { SHARING_ENABLED } from '@/lib/feature-flags';
import { sanitizeProjectForRole } from '@/lib/project-access';
import { claimPendingInvites, verifiedEmailsForUser } from '@/lib/sharing';
import { auth } from '@/lib/auth/server';
import { getUserTierAndLimits, isBetaUser } from '@/lib/tier';
import { countUserProjects } from '@/lib/usage';
import { limitReachedResponse } from '@/lib/plan-response';
import { isManagedConvexEnabled, normalizeProjectPlatform, normalizeBackendType, type ProjectPlatform, type BackendType } from '@/lib/project-platform';
import { isModelDisabled, modelDisabledReason, resolveModelId } from '@/lib/agent/models';
import { chooseProviderForNewProject } from '@/lib/sandbox-provider';
import { canUseSwift } from '@/lib/swift-access';

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const db = getDb();
    const allProjects = await db
      .select()
      .from(projects)
      .where(and(eq(projects.userId, userId), isNull(projects.deletedAt)))
      .orderBy(desc(projects.lastOpened), desc(projects.createdAt));

    if (!SHARING_ENABLED) return NextResponse.json(allProjects);

    // Lazy invite claim — fallback for a missed user.created webhook. Cheap
    // when there's nothing pending for this user's emails.
    try {
      const emails = await verifiedEmailsForUser(userId);
      await claimPendingInvites(userId, emails);
    } catch {
      // Best-effort; the webhook is the primary claim path.
    }

    // "Shared with me": projects where this user is an ACTIVE member. Secret
    // fields are stripped (editor role); `shared: true` lets the projects page
    // badge them.
    const memberships = await db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(and(eq(projectMembers.userId, userId), eq(projectMembers.status, 'active')));
    if (memberships.length === 0) return NextResponse.json(allProjects);

    const shared = await db
      .select()
      .from(projects)
      .where(and(inArray(projects.id, memberships.map((m) => m.projectId)), isNull(projects.deletedAt)))
      .orderBy(desc(projects.lastOpened));
    const sharedSanitized = shared.map((p) => ({
      ...sanitizeProjectForRole(p, 'editor'),
      shared: true,
    }));
    return NextResponse.json([...allProjects, ...sharedSanitized]);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to fetch projects' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await request.json();
    const { name, platform, model, backendType } = body as {
      name?: string;
      platform?: ProjectPlatform;
      backendType?: BackendType;
      model?: string;
    };

    if (!name) {
      return NextResponse.json({ error: 'Project name is required' }, { status: 400 });
    }

    // Reject globally disabled models (e.g. rescinded by the provider) before
    // they can be persisted as a project's preferred model — applies to every
    // user and auth path.
    if (model && isModelDisabled(resolveModelId(model))) {
      return NextResponse.json({ error: modelDisabledReason(resolveModelId(model)) }, { status: 403 });
    }

    // Enforce project count limit (beta testers are exempt)
    const [limits, currentCount, beta] = await Promise.all([
      getUserTierAndLimits(userId),
      countUserProjects(userId),
      isBetaUser(userId),
    ]);

    if (!beta && currentCount >= limits.maxProjects) {
      return limitReachedResponse({
        limitType: 'project_count',
        current: currentCount,
        limit: limits.maxProjects,
        tier: limits.tier,
      });
    }

    const db = getDb();
    const resolvedPlatform = normalizeProjectPlatform(platform);
    // normalizeProjectPlatform enforces the global kill switch. The entitlement
    // gate allows Pro/Max subscribers plus invited beta users (whose effective
    // tier is automatically raised to Pro).
    if (resolvedPlatform === 'swift' && !(await canUseSwift(userId))) {
      return NextResponse.json(
        { error: 'Swift projects require a Pro or Max plan, or beta access.' },
        { status: 403 },
      );
    }
    const resolvedBackendType = normalizeBackendType(backendType);
    // A 'platform' project would get a managed Convex backend lazily on its
    // first convexDeploy — refuse it up front while managed Convex is off.
    if (resolvedBackendType === 'platform' && !isManagedConvexEnabled()) {
      return NextResponse.json(
        { error: 'Botflow-managed Convex is not available. Use Bring Your Own Convex or No Backend.' },
        { status: 403 },
      );
    }
    // MuhKoo is in private beta — gate it at creation, mirroring Swift above.
    if (resolvedBackendType === 'muhkoo' && !(await isBetaUser(userId))) {
      return NextResponse.json(
        { error: 'MuhKoo backends are currently in private beta.' },
        { status: 403 },
      );
    }
    // Stamp the sandbox template up-front so the reaper / auto-reseed paths
    // know how to repopulate /vercel/sandbox after a true 404.
    const sandboxTemplate: 'swift' | 'swiftConvex' | 'vite' | 'viteConvex' | 'viteMuhkoo' | null =
      resolvedPlatform === 'swift'
        ? (resolvedBackendType === 'none' ? 'swift' : 'swiftConvex')
        : resolvedPlatform === 'sandboxed-web'
          ? (resolvedBackendType === 'muhkoo'
              ? 'viteMuhkoo'
              : resolvedBackendType === 'none' ? 'vite' : 'viteConvex')
          : null;
    // Free-tier owners get the self-hosted sandbox backend (when the rollout
    // switch is on); paid tiers stay on Vercel Sandbox. Sticky for the life
    // of the project — the sandbox's files live on whichever backend this picks.
    const sandboxProvider = await chooseProviderForNewProject(userId);
    const [newProject] = await db
      .insert(projects)
      .values({
        name,
        userId,
        platform: resolvedPlatform,
        backendType: resolvedBackendType,
        sandboxTemplate,
        sandboxProvider,
        // Legacy/renamed ids map to their successor; unknown → default model.
        model: resolveModelId(model),
      })
      .returning();

    return NextResponse.json(newProject, { status: 201 });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to create project' }, { status: 500 });
  }
}
