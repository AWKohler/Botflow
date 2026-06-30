import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { desc, eq, isNull, and } from 'drizzle-orm';
import { auth } from '@clerk/nextjs/server';
import { getUserTierAndLimits, isBetaUser } from '@/lib/tier';
import { countUserProjects } from '@/lib/usage';
import { limitReachedResponse } from '@/lib/plan-response';
import { normalizeProjectPlatform, normalizeBackendType, type ProjectPlatform, type BackendType } from '@/lib/project-platform';
import { isModelDisabled, modelDisabledReason } from '@/lib/agent/models';

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
    return NextResponse.json(allProjects);
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
        | 'claude-sonnet-4-6'
        | 'claude-opus-4-8'
        | 'claude-fable-5'
        | 'fireworks-minimax-m3'
        | 'fireworks-glm-5p2'
        | 'fireworks-kimi-k2p7'
        | 'gemini-3.1-pro-preview';
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
    // Swift is a beta-only platform. normalizeProjectPlatform already enforces
    // the global kill-switch (NEXT_PUBLIC_ALLOW_PERSISTENT_EXP); this adds the
    // per-user gate. Only runs when swift is actually requested, so it costs
    // nothing on the common web-project path — and the getUserTierAndLimits call
    // above has already warmed the beta cache for free users.
    if (resolvedPlatform === 'swift' && !(await isBetaUser(userId))) {
      return NextResponse.json(
        { error: 'Swift projects are currently in private beta.' },
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
          : model === 'claude-sonnet-4-6'
            ? 'claude-sonnet-4-6'
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
            : 'fireworks-kimi-k2p7',
      })
      .returning();

    return NextResponse.json(newProject, { status: 201 });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to create project' }, { status: 500 });
  }
}
