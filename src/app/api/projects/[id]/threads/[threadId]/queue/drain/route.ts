/**
 * POST /api/projects/:id/threads/:threadId/queue/drain — start the thread's
 * next queued message if its agent is idle. The normal trigger is the bridge's
 * end-of-turn notify; viewers call this as a backstop when a thread has sat
 * idle with messages waiting (e.g. the notify never arrived).
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/server';
import { requireProjectAccess } from '@/lib/project-access';
import { enforce, identifierFor } from '@/lib/rate-limit';
import { getThread } from '@/lib/agent/threads';
import { drainThreadQueue } from '@/lib/agent/thread-queue';

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
    const blocked = await enforce(identifierFor(userId, req), 'agent');
    if (blocked) return blocked;
    const access = await requireProjectAccess(id, userId);
    if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!(await getThread(id, threadId))) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const drain = await drainThreadQueue({ projectId: id, threadId, origin: new URL(req.url).origin });
    return NextResponse.json({ ok: true, drain });
  } catch (err) {
    console.error('POST queue drain failed:', err);
    return NextResponse.json({ error: 'Failed to start queued message' }, { status: 500 });
  }
}
