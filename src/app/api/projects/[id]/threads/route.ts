/**
 * GET  /api/projects/:id/threads?viewing=<threadId>
 *      — every thread with live status, who's viewing which thread, member
 *        identities, and the viewed thread's queue. Polled by the agent panel;
 *        DB + Redis only, never the sandbox. Records the caller's presence.
 * POST /api/projects/:id/threads  — create a thread. Body: { model? }
 *
 * Threads are shared by all project members (docs/features/multi-agent-threads.md).
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/server';
import { requireProjectAccess } from '@/lib/project-access';
import { createThread, getThread, listThreadSummaries, threadModel } from '@/lib/agent/threads';
import { listQueue } from '@/lib/agent/thread-queue';
import { getProjectPeople, notePresence, threadViewers } from '@/lib/agent/thread-presence';
import { isAcceptedModelInput, isModelDisabled, resolveModelId } from '@/lib/agent/models';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const access = await requireProjectAccess(id, userId);
    if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const requestedViewing = req.nextUrl.searchParams.get('viewing');
    const viewing = requestedViewing && (await getThread(id, requestedViewing)) ? requestedViewing : null;
    await notePresence(id, userId, viewing);
    const [threads, viewers, people, queue] = await Promise.all([
      listThreadSummaries(access.project, userId),
      threadViewers(id),
      getProjectPeople(access.project),
      viewing ? listQueue(viewing) : Promise.resolve([]),
    ]);
    return NextResponse.json({ threads, viewers, people, me: userId, queue });
  } catch (err) {
    console.error('GET /api/projects/[id]/threads failed:', err);
    return NextResponse.json({ error: 'Failed to load threads' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const access = await requireProjectAccess(id, userId);
    if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const body = (await req.json().catch(() => ({}))) as { model?: string };
    if (body.model && (!isAcceptedModelInput(body.model) || isModelDisabled(resolveModelId(body.model)))) {
      return NextResponse.json({ error: 'Invalid model' }, { status: 400 });
    }
    const thread = await createThread(access.project, userId, body.model ? resolveModelId(body.model) : null);
    return NextResponse.json({
      thread: {
        id: thread.id,
        title: thread.title,
        model: threadModel(thread, access.project),
        status: 'idle',
        unread: false,
        createdBy: thread.createdBy,
        archived: false,
        createdAt: thread.createdAt.toISOString(),
        updatedAt: thread.updatedAt.toISOString(),
        lastTurnEndedAt: null,
        liveTurnId: null,
        queued: 0,
      },
    });
  } catch (err) {
    console.error('POST /api/projects/[id]/threads failed:', err);
    return NextResponse.json({ error: 'Failed to create thread' }, { status: 500 });
  }
}
