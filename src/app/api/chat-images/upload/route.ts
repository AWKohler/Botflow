import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { UTApi } from 'uploadthing/server';
import { getDb } from '@/db';
import { projects, chatImages } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { enforce, identifierFor } from '@/lib/rate-limit';

const utapi = new UTApi();

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const blocked = await enforce(identifierFor(userId, request), 'upload');
    if (blocked) return blocked;

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const projectId = formData.get('projectId') as string | null;

    if (!file || !projectId) {
      return NextResponse.json({ error: 'Missing file or projectId' }, { status: 400 });
    }

    // Validate type and size
    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json({ error: 'Invalid file type. Only JPEG, PNG, and WebP are allowed.' }, { status: 400 });
    }
    if (file.size > MAX_SIZE) {
      return NextResponse.json({ error: 'File too large. Maximum size is 5MB.' }, { status: 400 });
    }

    // Verify project ownership
    const db = getDb();
    const [proj] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
    if (!proj) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Upload to UploadThing
    const uploaded = await utapi.uploadFiles(file);
    if (uploaded.error || !uploaded.data) {
      console.error('UploadThing error:', uploaded.error);
      return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
    }

    const { url, key } = uploaded.data;

    // Insert into DB
    const [record] = await db.insert(chatImages).values({
      projectId,
      uploadThingUrl: url,
      uploadThingKey: key,
      filename: file.name,
      size: file.size,
      mediaType: file.type,
    }).returning();

    return NextResponse.json({ id: record.id, url, key });
  } catch (e) {
    console.error('chat-images/upload error:', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
