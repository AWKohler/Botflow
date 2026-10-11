/**
 * PATCH  /api/projects/:id/threads/:threadId — { title?, model?, archived? }
 * DELETE /api/projects/:id/threads/:threadId — permanently delete a thread and
 *        its messages. Only its creator or the project owner may delete; any
 *        member may archive. A running agent is stopped first.
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth/server';
import { getDb } from '@/db';
import { chatSessions, projects } from '@/db/schema';
import { requireProjectAccess } from '@/lib/project-access';
import { getThread, threadModel } from '@/lib/agent/threads';
import { stopThreadAgent } from '@/lib/agent/stop-thread';
import { isAcceptedModelInput, isModelDisabled, modelDisabledReason, resolveModelId } from '@/lib/agent/models';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string; threadId: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id, threadId } = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const access = await requireProjectAccess(id, userId);
    if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const thread = await getThread(id, threadId);
    if (!thread) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const body = (await req.json().catch(() => ({}))) as {
      title?: string;
      model?: string;
      archived?: boolean;
    };
    const patch: Partial<typeof chatSessions.$inferInsert> = {};

    if (typeof body.title === 'string') {
      const title = body.title.replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!title) return NextResponse.json({ error: 'Title cannot be empty' }, { status: 400 });
      patch.title = title;
    }
    if (body.model !== undefined) {
      if (!isAcceptedModelInput(body.model)) {
        return NextResponse.json({ error: 'Invalid model' }, { status: 400 });
      }
      const model = resolveModelId(body.model);
      if (isModelDisabled(model)) {
        return NextResponse.json({ error: modelDisabledReason(model) }, { status: 400 });
      }
      patch.model = model;
    }
    if (typeof body.archived === 'boolean') {
      patch.archivedAt = body.archived ? new Date() : null;
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
    }

    const db = getDb();
    // Title/archive edits shouldn't reorder the list; model changes are
    // activity on the thread.
    if (patch.model) patch.updatedAt = new Date();
    const [updated] = await db
      .update(chatSessions)
      .set(patch)
      .where(eq(chatSessions.id, threadId))
      .returning();
    // The last model picked becomes the project's default for new threads.
    if (patch.model) {
      await db
        .update(projects)
        .set({ model: patch.model, updatedAt: new Date() })
        .where(eq(projects.id, id));
    }
    return NextResponse.json({
      ok: true,
      thread: {
        id: updated.id,
        title: updated.title,
        model: threadModel(updated, access.project),
        archived: Boolean(updated.archivedAt),
      },
    });
  } catch (err) {
    console.error('PATCH /api/projects/[id]/threads/[threadId] failed:', err);
    return NextResponse.json({ error: 'Failed to update thread' }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id, threadId } = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const access = await requireProjectAccess(id, userId);
    if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const thread = await getThread(id, threadId);
    if (!thread) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (access.role !== 'owner' && thread.createdBy !== userId) {
      return NextResponse.json(
        { error: 'Only the person who started this thread or the project owner can delete it. You can archive it instead.' },
        { status: 403 },
      );
    }
    await stopThreadAgent(id, threadId);
    // Messages and views cascade with the row.
    await getDb().delete(chatSessions).where(eq(chatSessions.id, threadId));
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/projects/[id]/threads/[threadId] failed:', err);
    return NextResponse.json({ error: 'Failed to delete thread' }, { status: 500 });
  }
}
