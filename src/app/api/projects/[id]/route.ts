import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db';
import { projects, chatImages, projectAssets } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { auth } from '@clerk/nextjs/server';
import { requireProjectAccess, sanitizeProjectForRole } from '@/lib/project-access';
import { getUserTier } from '@/lib/tier';
import { deleteConvexBackend } from '@/lib/convex-platform';
import { isModelDisabled, modelDisabledReason } from '@/lib/agent/models';
import { UTApi } from 'uploadthing/server';

const utapi = new UTApi();

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const access = await requireProjectAccess(resolvedParams.id, userId);
    if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    // Editors never receive secret-bearing fields (deploy keys, webhook secrets).
    const body: Record<string, unknown> = {
      ...sanitizeProjectForRole(access.project, access.role),
      viewerRole: access.role,
    };
    // When the owner shares credits, editors inherit the OWNER's model-tier
    // access (sharing decision 2026-07-06) — the client model selector reads
    // this; the agent route re-derives it server-side and never trusts it.
    if (access.role === 'editor' && access.project.shareOwnerCredits) {
      body.sharedTier = await getUserTier(access.project.userId);
    }
    return NextResponse.json(body);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'Failed to fetch project' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const db = getDb();
    const access = await requireProjectAccess(resolvedParams.id, userId);
    if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const body = await req.json();
    // Public visibility is no longer toggled here — it's gated on deployment and
    // set by the deploy flow (see src/lib/public-bundle.ts). This route only
    // updates non-public project fields.
    const { model, thumbnailUrl, htmlSnapshotUrl, publicDescription } = body as {
      model?: string;
      thumbnailUrl?: string;
      htmlSnapshotUrl?: string;
      publicDescription?: string;
    };
    if (
      model &&
      model !== 'gpt-5.3-codex' &&
      model !== 'gpt-5.4' &&
      model !== 'gpt-5.5' &&
      model !== 'gpt-5.2' && // backwards compat
      model !== 'gpt-4.1' && // backwards compat
      model !== 'claude-sonnet-5' &&
      model !== 'claude-sonnet-4-6' && // backwards compat → resolves to sonnet-5
      model !== 'claude-sonnet-4.5' && // backwards compat
      model !== 'claude-sonnet-4.6' && // backwards compat
      model !== 'claude-haiku-4.5' && // removed → mapped to sonnet
      model !== 'claude-opus-4-7' && // backwards compat → resolves to 4-8
      model !== 'claude-opus-4-8' &&
      model !== 'claude-fable-5' &&
      model !== 'claude-opus-4.6' && // backwards compat
      model !== 'claude-opus-4.7' && // backwards compat
      model !== 'claude-opus-4.5' && // backwards compat
      model !== 'kimi-k2.5' && // removed → mapped to minimax
      model !== 'kimi-k2-thinking-turbo' && // removed → mapped to minimax
      model !== 'fireworks-minimax-m2p7' && // backwards compat → resolves to m3
      model !== 'fireworks-minimax-m3' &&
      model !== 'fireworks-glm-5p2' &&
      model !== 'fireworks-glm-5p1' && // backwards compat → resolved to glm-5p2
      model !== 'fireworks-kimi-k2p7' &&
      model !== 'fireworks-kimi-k2p6' && // backwards compat → resolved to k2p7
      model !== 'gemini-3.1-pro-preview'
    ) {
      return NextResponse.json({ error: 'Invalid model' }, { status: 400 });
    }
    // Reject globally disabled models (e.g. rescinded by the provider) for all
    // users and auth paths — can't switch a project onto an unusable model.
    if (model && isModelDisabled(model)) {
      return NextResponse.json({ error: modelDisabledReason(model) }, { status: 403 });
    }
    const updateData: Partial<typeof access.project> = {
      updatedAt: new Date(),
    };
    if (model) updateData.model = model;
    if (thumbnailUrl !== undefined) updateData.thumbnailUrl = thumbnailUrl;
    if (htmlSnapshotUrl !== undefined) updateData.htmlSnapshotUrl = htmlSnapshotUrl;
    if (publicDescription !== undefined) updateData.publicDescription = publicDescription;

    const [updated] = await db
      .update(projects)
      .set(updateData)
      .where(eq(projects.id, resolvedParams.id))
      .returning();
    // Editors never receive secret-bearing fields (same as GET).
    return NextResponse.json(sanitizeProjectForRole(updated, access.role));
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'Failed to update project' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const db = getDb();
    const access = await requireProjectAccess(resolvedParams.id, userId, 'owner');
    if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const proj = access.project;

    // Delete Convex backend if it exists
    if (proj.convexProjectId) {
      try {
        await deleteConvexBackend(proj.convexProjectId);
        console.log(`Convex backend deleted for project ${resolvedParams.id}`);
      } catch (error) {
        // Log error but continue with project deletion
        console.error('Failed to delete Convex backend:', error);
      }
    }

    // Delete Cloudflare Pages project if it exists
    if (proj.cloudflareProjectName) {
      try {
        const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
        const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
        if (CF_ACCOUNT_ID && CF_API_TOKEN) {
          await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/pages/projects/${proj.cloudflareProjectName}`,
            {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${CF_API_TOKEN}` },
            }
          );
          console.log(`Cloudflare Pages project deleted for project ${resolvedParams.id}`);
        }
      } catch (error) {
        console.error('Failed to delete Cloudflare Pages project:', error);
      }
    }

    // Delete UploadThing files: chat images
    try {
      const imgs = await db.select({ key: chatImages.uploadThingKey }).from(chatImages).where(eq(chatImages.projectId, resolvedParams.id));
      if (imgs.length > 0) {
        await utapi.deleteFiles(imgs.map(i => i.key));
      }
    } catch (err) {
      console.error('Failed to delete chat images from UploadThing:', err);
    }

    // Delete UploadThing files: project assets
    try {
      const assets = await db.select({ key: projectAssets.uploadThingKey }).from(projectAssets).where(eq(projectAssets.projectId, resolvedParams.id));
      if (assets.length > 0) {
        await utapi.deleteFiles(assets.map(a => a.key));
      }
    } catch (err) {
      console.error('Failed to delete project assets from UploadThing:', err);
    }

    // Delete thumbnail and html snapshot from UploadThing
    try {
      const keysToDelete = [
        proj.thumbnailKey,
        proj.htmlSnapshotKey,
        proj.swiftScreenshotIphoneKey,
        proj.swiftScreenshotIpadKey,
      ].filter(Boolean) as string[];
      if (keysToDelete.length > 0) {
        await utapi.deleteFiles(keysToDelete);
      }
    } catch (err) {
      console.error('Failed to delete snapshot files from UploadThing:', err);
    }

    // Delete the project (cascades to chat sessions, messages, and env vars)
    await db.delete(projects).where(eq(projects.id, resolvedParams.id));

    return NextResponse.json({ success: true, message: 'Project deleted' });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: 'Failed to delete project' }, { status: 500 });
  }
}
