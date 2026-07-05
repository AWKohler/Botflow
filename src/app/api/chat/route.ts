import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb } from '@/db';
import { chatMessages, chatSessions, projects } from '@/db/schema';
import { requireProjectAccess } from '@/lib/project-access';
import { auth } from '@clerk/nextjs/server';

// Chat endpoints are IO-bound and may stream/persist large payloads; extend limits
export const maxDuration = 300;
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Helper: find or create a chat session for a project
async function getOrCreateSession(db: ReturnType<typeof getDb>, projectId: string) {
  const existing = await db.select().from(chatSessions).where(eq(chatSessions.projectId, projectId)).limit(1);
  if (existing.length > 0) return existing[0];
  const [created] = await db.insert(chatSessions).values({ projectId }).returning();
  return created;
}

/**
 * Returns the project's current_segment_id, lazy-minting one if missing.
 * Pre-migration projects should already have a segment from the backfill, but
 * defensive against any path that creates a project without one.
 */
async function ensureProjectSegment(
  db: ReturnType<typeof getDb>,
  project: typeof projects.$inferSelect,
): Promise<string> {
  if (project.currentSegmentId) return project.currentSegmentId;
  const segmentId = randomUUID();
  await db
    .update(projects)
    .set({ currentSegmentId: segmentId, updatedAt: new Date() })
    .where(eq(projects.id, project.id));
  return segmentId;
}

export async function GET(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const projectId = req.nextUrl.searchParams.get('projectId');
    if (!projectId) return NextResponse.json({ error: 'projectId is required' }, { status: 400 });

    // When the client wants the older messages too (for the segment-divider
    // view), it passes ?includeAllSegments=true. Otherwise we scope strictly
    // to the current segment so the agent's history matches what it sees.
    const includeAllSegments = req.nextUrl.searchParams.get('includeAllSegments') === 'true';

    const db = getDb();
    const access = await requireProjectAccess(projectId, userId);
    if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const session = await getOrCreateSession(db, projectId);
    const currentSegmentId = await ensureProjectSegment(db, access.project);

    const whereClause = includeAllSegments
      ? eq(chatMessages.sessionId, session.id)
      : and(eq(chatMessages.sessionId, session.id), eq(chatMessages.segmentId, currentSegmentId));

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
    return NextResponse.json({ sessionId: session.id, messages, currentSegmentId });
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
    const { projectId, message } = body as { projectId?: string; message?: { id: string; role: string; content?: unknown; parts?: unknown } };
    if (!projectId || !message?.id || !message?.role) {
      return NextResponse.json({ error: 'projectId and full message are required' }, { status: 400 });
    }
    const db = getDb();
    const access = await requireProjectAccess(projectId, userId);
    if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const session = await getOrCreateSession(db, projectId);
    const currentSegmentId = await ensureProjectSegment(db, access.project);

    const storedContent = message.parts
      ? { parts: message.parts }
      : (message.content as object);

    // Stamp every new message with the project's current segment id. Upsert
    // by (sessionId, messageId) so streaming updates to the same assistant
    // message don't create duplicates.
    await db
      .insert(chatMessages)
      .values({
        sessionId: session.id,
        messageId: message.id,
        role: message.role,
        content: storedContent,
        segmentId: currentSegmentId,
      })
      .onConflictDoUpdate({
        target: [chatMessages.sessionId, chatMessages.messageId],
        set: {
          role: message.role,
          content: storedContent,
          // Don't touch segmentId on update — preserves the message's
          // original segment even if the project later switches backends.
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
    const session = await getOrCreateSession(db, projectId);
    // Reset deletes EVERY segment's messages and mints a fresh segment id
    // so the next message starts a clean slate.
    await db.delete(chatMessages).where(eq(chatMessages.sessionId, session.id));
    const newSegmentId = randomUUID();
    await db
      .update(projects)
      .set({ currentSegmentId: newSegmentId, updatedAt: new Date() })
      .where(eq(projects.id, projectId));
    return NextResponse.json({ ok: true, currentSegmentId: newSegmentId });
  } catch (err) {
    console.error('DELETE /api/chat failed:', err);
    return NextResponse.json({ error: 'Failed to reset chat' }, { status: 500 });
  }
}
