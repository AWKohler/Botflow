import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db';
import { projects, projectStars } from '@/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { auth } from '@clerk/nextjs/server';
import { enforce, identifierFor } from '@/lib/rate-limit';

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const blocked = await enforce(identifierFor(userId, req), 'write');
    if (blocked) return blocked;

    const db = getDb();
    const [proj] = await db
      .select({ id: projects.id, starCount: projects.starCount })
      .from(projects)
      .where(and(eq(projects.publicSlug, slug), eq(projects.isPublic, true)));
    if (!proj) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const [existing] = await db
      .select({ id: projectStars.id })
      .from(projectStars)
      .where(and(eq(projectStars.projectId, proj.id), eq(projectStars.userId, userId)));

    if (existing) {
      // Un-star
      await db.delete(projectStars).where(eq(projectStars.id, existing.id));
      const [updated] = await db
        .update(projects)
        .set({ starCount: sql`GREATEST(${projects.starCount} - 1, 0)` })
        .where(eq(projects.id, proj.id))
        .returning({ starCount: projects.starCount });
      return NextResponse.json({ starred: false, starCount: updated?.starCount ?? 0 });
    } else {
      await db.insert(projectStars).values({ projectId: proj.id, userId });
      const [updated] = await db
        .update(projects)
        .set({ starCount: sql`${projects.starCount} + 1` })
        .where(eq(projects.id, proj.id))
        .returning({ starCount: projects.starCount });
      return NextResponse.json({ starred: true, starCount: updated?.starCount ?? 1 });
    }
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to toggle star' }, { status: 500 });
  }
}
