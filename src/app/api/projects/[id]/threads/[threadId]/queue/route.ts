/**
 * POST /api/projects/:id/threads/:threadId/queue — { message: UIMessage }
 *
 * Queue a message on a thread (any project member). Used when the thread's
 * agent is busy; the server starts it as the caller when the running turn
 * ends. Also tries to start it right away, in case the turn just finished.
 */
import { NextRequest, NextResponse } from 'next/server';
import type { UIMessage } from 'ai';
import { auth } from '@/lib/auth/server';
import { requireProjectAccess } from '@/lib/project-access';
import { enforce, identifierFor } from '@/lib/rate-limit';
import { getThread } from '@/lib/agent/threads';
import { drainThreadQueue, enqueueMessage } from '@/lib/agent/thread-queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; threadId: string }> },
) {
  const { id, threadId } = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    // Queuing can start a turn — meter it like the agent routes.
    const blocked = await enforce(identifierFor(userId, req), 'agent');
    if (blocked) return blocked;
    const access = await requireProjectAccess(id, userId);
    if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!(await getThread(id, threadId))) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const body = (await req.json().catch(() => ({}))) as { message?: UIMessage };
    const message = body.message;
    if (!message?.id || message.role !== 'user' || !Array.isArray(message.parts) || message.parts.length === 0) {
      return NextResponse.json({ error: 'A user message is required' }, { status: 400 });
    }

    const item = await enqueueMessage({ projectId: id, threadId, userId, message });
    const drain = await drainThreadQueue({ projectId: id, threadId, origin: new URL(req.url).origin });
    return NextResponse.json({ ok: true, queueId: item.id, drain });
  } catch (err) {
    console.error('POST /api/projects/[id]/threads/[threadId]/queue failed:', err);
    return NextResponse.json({ error: 'Failed to queue message' }, { status: 500 });
  }
}
