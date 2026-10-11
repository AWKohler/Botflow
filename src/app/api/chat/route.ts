import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb } from '@/db';
import { chatMessages, chatSessions } from '@/db/schema';
import { requireProjectAccess } from '@/lib/project-access';
import { auth } from '@/lib/auth/server';
import { ensureThreadSegment, resolveThread, threadModel } from '@/lib/agent/threads';
import { clearClaudeCodeSessionId } from '@/lib/agent/claude-code/session-store';
import { clearOpenCodeSessionId } from '@/lib/agent/opencode/session-store';

// Chat endpoints are IO-bound and may stream/persist large payloads; extend limits
export const maxDuration = 300;
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Every endpoint addresses ONE thread (docs/features/multi-agent-threads.md).
// `threadId` is optional for older clients: they get the project's most
// recently active thread, created on demand.

export async function GET(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const projectId = req.nextUrl.searchParams.get('projectId');
    if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

    // When the client wants the older messages too (for the segment-divider
    // view), it passes ?includeAllSegments=true. Otherwise we scope strictly
    // to the thread's current segment so the agent's history matches what it sees.
    const includeAllSegments = req.nextUrl.searchParams.get('includeAllSegments') === 'true';

    const db = getDb();
    const access = await requireProjectAccess(projectId, userId);
    if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const thread = await resolveThread(access.project, userId, req.nextUrl.searchParams.get('threadId'));
    if (!thread) return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
    const currentSegmentId = await ensureThreadSegment(thread);

    const whereClause = includeAllSegments
      ? eq(chatMessages.sessionId, thread.id)
      : and(eq(chatMessages.sessionId, thread.id), eq(chatMessages.segmentId, currentSegmentId));

    const rows = await db
      .select()
      .from(chatMessages)
      .where(whereClause)
      .orderBy(desc(chatMessages.createdAt));

    // Return in chronological order. v6: messages use `parts` array.
    const messages = [...rows].reverse().map((r) => {
      const stored = r.content as Record<string, unknown>;
      const base = {
        id: r.messageId,
        role: r.role,
        // Include segmentId so the client can render segment dividers without
        // a second fetch. The active segment matches `currentSegmentId`.
        segmentId: r.segmentId,
        userId: r.userId,
        createdAt: r.createdAt,
      };
      if (stored && typeof stored === 'object' && 'parts' in stored) {
        return { ...base, parts: stored.parts };
      }
      if (stored && typeof stored === 'object') {
        return { ...base, parts: stored };
      }
      return { ...base, parts: [{ type: 'text', text: String(stored ?? '') }] };
    });
    return NextResponse.json({
      threadId: thread.id,
      sessionId: thread.id,
      model: threadModel(thread, access.project),
      title: thread.title,
      messages,
      currentSegmentId,
    });
  } catch (err) {
    console.error('GET /api/chat failed:', err);
    return NextResponse.json({ error: 'Failed to fetch chat' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();
    const { projectId, threadId, message } = body as {
      projectId?: string;
      threadId?: string;
      message?: { id: string; role: string; content?: unknown; parts?: unknown };
    };
    if (!projectId || !message?.id || !message?.role) {
      return NextResponse.json({ error: 'projectId and full message are required' }, { status: 400 });
    }
    const db = getDb();
    const access = await requireProjectAccess(projectId, userId);
    if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const thread = await resolveThread(access.project, userId, threadId);
    if (!thread) return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
    const currentSegmentId = await ensureThreadSegment(thread);

    const storedContent = message.parts
      ? { parts: message.parts }
      : (message.content as object);

    // Stamp every new message with the thread's current segment id. Upsert
    // by (thread, messageId) so streaming updates to the same assistant
    // message — and the server's own end-of-turn save — never duplicate.
    await db
      .insert(chatMessages)
      .values({
        sessionId: thread.id,
        messageId: message.id,
        role: message.role,
        content: storedContent,
        segmentId: currentSegmentId,
        userId: message.role === 'user' ? userId : null,
      })
      .onConflictDoUpdate({
        target: [chatMessages.sessionId, chatMessages.messageId],
        set: {
          role: message.role,
          content: storedContent,
          // Don't touch segmentId on update — preserves the message's
          // original segment even if the thread later switches backends.
        },
      });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('POST /api/chat failed:', err);
    return NextResponse.json({ error: 'Failed to save message' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const projectId = req.nextUrl.searchParams.get('projectId');
    if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
    const db = getDb();
    const access = await requireProjectAccess(projectId, userId);
    if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const thread = await resolveThread(access.project, userId, req.nextUrl.searchParams.get('threadId'));
    if (!thread) return NextResponse.json({ error: 'Thread not found' }, { status: 404 });

    // Reset clears THIS thread: its messages, its title (the next prompt
    // names it again), and the agents' session pointers so the next turn
    // starts a genuinely fresh session. Other threads are untouched.
    await db.delete(chatMessages).where(eq(chatMessages.sessionId, thread.id));
    const newSegmentId = randomUUID();
    await db
      .update(chatSessions)
      .set({ currentSegmentId: newSegmentId, title: null, lastTurnError: null, updatedAt: new Date() })
      .where(eq(chatSessions.id, thread.id));
    await Promise.all([
      clearClaudeCodeSessionId(thread.id).catch(() => {}),
      clearOpenCodeSessionId(thread.id).catch(() => {}),
    ]);
    return NextResponse.json({ ok: true, threadId: thread.id, currentSegmentId: newSegmentId });
  } catch (err) {
    console.error('DELETE /api/chat failed:', err);
    return NextResponse.json({ error: 'Failed to reset chat' }, { status: 500 });
  }
}
