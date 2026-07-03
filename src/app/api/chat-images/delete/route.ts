import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { UTApi } from 'uploadthing/server';
import { getDb } from '@/db';
import { chatImages } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireProjectAccess } from '@/lib/project-access';

const utapi = new UTApi();

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await request.json() as { id: string };
    if (!id) {
      return NextResponse.json({ error: 'Missing id' }, { status: 400 });
    }

    const db = getDb();

    // Fetch image and verify ownership via project
    const [img] = await db
      .select({ id: chatImages.id, key: chatImages.uploadThingKey, projectId: chatImages.projectId })
      .from(chatImages)
      .where(eq(chatImages.id, id));

    if (!img) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // Verify the project belongs to the user
    const access = await requireProjectAccess(img.projectId, userId);
    if (!access) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Delete from UploadThing and DB
    await utapi.deleteFiles([img.key]);
    await db.delete(chatImages).where(eq(chatImages.id, id));

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('chat-images/delete error:', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
