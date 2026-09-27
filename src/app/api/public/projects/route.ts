import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/db';
import { projects, projectStars } from '@/db/schema';
import { eq, and, desc, sql, isNotNull, inArray } from 'drizzle-orm';
import { auth } from '@/lib/auth/server';
import { identityClient } from '@/lib/auth/server';
import { type ProjectPlatform } from '@/lib/project-platform';

export async function GET(req: NextRequest) {
  try {
    const { userId } = await auth();
    const { searchParams } = new URL(req.url);
    const limitRaw = parseInt(searchParams.get('limit') ?? '24', 10);
    const limit = Math.min(Math.max(isNaN(limitRaw) ? 24 : limitRaw, 1), 60);
    const offsetRaw = parseInt(searchParams.get('offset') ?? '0', 10);
    const offset = Math.max(isNaN(offsetRaw) ? 0 : offsetRaw, 0);
    const sortParam = searchParams.get('sort') === 'recent' ? 'recent' : 'top';
    const platformFilter = searchParams.get('platform');

    const db = getDb();
    const whereClauses = [eq(projects.isPublic, true), isNotNull(projects.publicSlug)];
    if (platformFilter === 'web') {
      // "Web" spans the new sandbox platform plus legacy WebContainer rows
      // (and deprecated mobile/multiplatform, which are surfaced as Web).
      whereClauses.push(
        inArray(projects.platform, ['sandboxed-web', 'web', 'mobile', 'multiplatform']),
      );
    } else if (platformFilter === 'swift') {
      whereClauses.push(eq(projects.platform, 'swift' as ProjectPlatform));
    }

    const orderBy =
      sortParam === 'recent'
        ? [desc(projects.publishedAt), desc(projects.createdAt)]
        : [desc(projects.starCount), desc(projects.publishedAt)];

    const rows = await db
      .select({
        id: projects.id,
        name: projects.name,
        userId: projects.userId,
        platform: projects.platform,
        publicSlug: projects.publicSlug,
        publicDescription: projects.publicDescription,
        thumbnailUrl: projects.thumbnailUrl,
        htmlSnapshotUrl: projects.htmlSnapshotUrl,
        starCount: projects.starCount,
        publishedAt: projects.publishedAt,
        createdAt: projects.createdAt,
      })
      .from(projects)
      .where(and(...whereClauses))
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset);

    // Resolve author display names via Clerk
    const uniqueUserIds = Array.from(new Set(rows.map((r) => r.userId)));
    const userMap: Record<string, { name: string; imageUrl: string | null }> = {};
    if (uniqueUserIds.length > 0) {
      try {
        const client = await identityClient();
        const userList = await client.users.getUserList({ userId: uniqueUserIds, limit: uniqueUserIds.length });
        for (const u of userList.data) {
          const name =
            u.firstName || u.lastName
              ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim()
              : u.username ?? (u.emailAddresses[0]?.emailAddress?.split('@')[0] ?? 'Anonymous');
          userMap[u.id] = { name, imageUrl: u.imageUrl ?? null };
        }
      } catch (err) {
        console.error('Clerk user lookup failed:', err);
      }
    }

    // Determine which of these the current user has starred
    let starredSet = new Set<string>();
    if (userId && rows.length > 0) {
      const projectIds = rows.map((r) => r.id);
      const stars = await db
        .select({ projectId: projectStars.projectId })
        .from(projectStars)
        .where(and(eq(projectStars.userId, userId), sql`${projectStars.projectId} IN (${sql.join(projectIds.map((id) => sql`${id}`), sql`, `)})`));
      starredSet = new Set(stars.map((s) => s.projectId));
    }

    return NextResponse.json({
      projects: rows.map((r) => ({
        ...r,
        author: userMap[r.userId] ?? { name: 'Anonymous', imageUrl: null },
        hasStarred: starredSet.has(r.id),
      })),
      limit,
      offset,
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to load public projects' }, { status: 500 });
  }
}
