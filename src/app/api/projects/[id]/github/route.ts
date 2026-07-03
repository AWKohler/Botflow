import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { getUserCredentials } from '@/lib/user-credentials';
import { eq } from 'drizzle-orm';
import { requireProjectAccess } from '@/lib/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Connect project to a GitHub repo (or update connection)
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const db = getDb();
    const access = await requireProjectAccess(id, userId);
    if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const creds = await getUserCredentials(userId);
    if (!creds.githubAccessToken) {
      return NextResponse.json({ error: 'GitHub not connected' }, { status: 400 });
    }

    const { owner, name, defaultBranch, headSha } = await req.json() as {
      owner: string;
      name: string;
      defaultBranch?: string;
      headSha?: string | null;
    };

    const [updated] = await db
      .update(projects)
      .set({
        githubRepoOwner: owner,
        githubRepoName: name,
        githubDefaultBranch: defaultBranch ?? 'main',
        githubLastPushedSha: headSha ?? null,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, id))
      .returning();

    return NextResponse.json(updated);
  } catch (e) {
    console.error('Connect GitHub repo failed:', e);
    return NextResponse.json({ error: 'Failed to connect repository' }, { status: 500 });
  }
}

// Disconnect project from GitHub repo
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const db = getDb();
    const access = await requireProjectAccess(id, userId);
    if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const [updated] = await db
      .update(projects)
      .set({
        githubRepoOwner: null,
        githubRepoName: null,
        githubDefaultBranch: 'main',
        githubLastPushedSha: null,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, id))
      .returning();

    return NextResponse.json(updated);
  } catch (e) {
    console.error('Disconnect GitHub repo failed:', e);
    return NextResponse.json({ error: 'Failed to disconnect repository' }, { status: 500 });
  }
}
