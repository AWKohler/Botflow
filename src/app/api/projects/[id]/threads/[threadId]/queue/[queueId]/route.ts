/**
 * DELETE /api/projects/:id/threads/:threadId/queue/:queueId — remove a waiting
 * (or failed) message. Any project member may: threads are shared.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/server';
import { requireProjectAccess } from '@/lib/project-access';
import { getThread } from '@/lib/agent/threads';
import { cancelQueued } from '@/lib/agent/thread-queue';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; threadId: string; queueId: string }> },
) {
  const { id, threadId, queueId } = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const access = await requireProjectAccess(id, userId);
    if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!(await getThread(id, threadId))) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const removed = await cancelQueued(threadId, queueId);
    return NextResponse.json({ ok: removed });
  } catch (err) {
    console.error('DELETE queue item failed:', err);
    return NextResponse.json({ error: 'Failed to remove queued message' }, { status: 500 });
  }
}
