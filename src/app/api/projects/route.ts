import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db';
import { projects, projectMembers } from '@/db/schema';
import { desc, eq, isNull, and, inArray } from 'drizzle-orm';
import { SHARING_ENABLED } from '@/lib/feature-flags';
import { sanitizeProjectForRole } from '@/lib/project-access';
import { claimPendingInvites, verifiedEmailsForUser } from '@/lib/sharing';
import { auth } from '@clerk/nextjs/server';
import { getUserTierAndLimits, isBetaUser } from '@/lib/tier';
import { countUserProjects } from '@/lib/usage';
import { limitReachedResponse } from '@/lib/plan-response';
import { normalizeProjectPlatform, normalizeBackendType, type ProjectPlatform, type BackendType } from '@/lib/project-platform';
import { isModelDisabled, modelDisabledReason } from '@/lib/agent/models';
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
      model?:
        | 'gpt-5.3-codex'
        | 'gpt-5.4'
        | 'gpt-5.5'
        | 'claude-sonnet-5'
        | 'claude-opus-4-8'
        | 'claude-fable-5'
        | 'fireworks-minimax-m3'
        | 'fireworks-glm-5p2'
        | 'fireworks-kimi-k2p7'
        | 'gemini-3.1-pro-preview'
        | 'grok-4.5';
    };

    if (!name) {
      return NextResponse.json({ error: 'Project name is required' }, { status: 400 });
    }

    // Reject globally disabled models (e.g. rescinded by the provider) before
    // they can be persisted as a project's preferred model — applies to every
    // user and auth path.
    if (model && isModelDisabled(model)) {
      return NextResponse.json({ error: modelDisabledReason(model) }, { status: 403 });
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
    // Stamp the sandbox template up-front so the reaper / auto-reseed paths
    // know how to repopulate /vercel/sandbox after a true 404.
    const sandboxTemplate: 'swift' | 'swiftConvex' | 'vite' | 'viteConvex' | null =
      resolvedPlatform === 'swift'
        ? (resolvedBackendType === 'none' ? 'swift' : 'swiftConvex')
        : resolvedPlatform === 'sandboxed-web'
          ? (resolvedBackendType === 'none' ? 'vite' : 'viteConvex')
          : null;
    const [newProject] = await db
      .insert(projects)
      .values({
        name,
        userId,
        platform: resolvedPlatform,
        backendType: resolvedBackendType,
        sandboxTemplate,
        model:
          model === 'gpt-5.4'
            ? 'gpt-5.4'
          : model === 'gpt-5.5'
            ? 'gpt-5.5'
          : model === 'claude-sonnet-5'
            ? 'claude-sonnet-5'
            : model === 'claude-opus-4-8'
            ? 'claude-opus-4-8'
            : model === 'claude-fable-5'
            ? 'claude-fable-5'
            : model === 'fireworks-minimax-m3'
            ? 'fireworks-minimax-m3'
            : model === 'fireworks-glm-5p2'
            ? 'fireworks-glm-5p2'
            : model === 'fireworks-kimi-k2p7'
            ? 'fireworks-kimi-k2p7'
            : model === 'gemini-3.1-pro-preview'
            ? 'gemini-3.1-pro-preview'
            : model === 'grok-4.5'
            ? 'grok-4.5'
            : 'fireworks-kimi-k2p7',
      })
      .returning();

    return NextResponse.json(newProject, { status: 201 });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to create project' }, { status: 500 });
  }
}
