/**
 * POST /api/projects/:id/threads/:threadId/viewed — the caller has looked at
 * the thread; clears its unread dot for them.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/server';
import { requireProjectAccess } from '@/lib/project-access';
import { getThread, markThreadViewed } from '@/lib/agent/threads';

export const dynamic = 'force-dynamic';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; threadId: string }> },
) {
  const { id, threadId } = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const access = await requireProjectAccess(id, userId);
    if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!(await getThread(id, threadId))) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    await markThreadViewed(threadId, userId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('POST /api/projects/[id]/threads/[threadId]/viewed failed:', err);
    return NextResponse.json({ error: 'Failed to mark viewed' }, { status: 500 });
  }
}
