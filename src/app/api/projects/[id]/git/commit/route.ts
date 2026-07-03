import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { pendingGitCommits } from '@/db/schema';
import { requireProjectAccess } from '@/lib/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Stage a local commit (stored in DB, not yet pushed to GitHub)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const db = getDb();
    const access = await requireProjectAccess(id, userId);
    if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const { project: proj } = access;

    if (!proj.githubRepoOwner || !proj.githubRepoName) {
      return NextResponse.json({ error: 'No GitHub repo connected' }, { status: 400 });
    }

    const { message, files } = await req.json() as {
      message: string;
      // Only the changed files (added + modified), with null for deleted
      files: Record<string, string | null>;
    };

    if (!message?.trim()) {
      return NextResponse.json({ error: 'Commit message is required' }, { status: 400 });
    }

    const [commit] = await db
      .insert(pendingGitCommits)
      .values({
        projectId: id,
        message: message.trim(),
        filesSnapshot: files,
        baseSha: proj.githubLastPushedSha,
      })
      .returning();

    return NextResponse.json({ ok: true, commitId: commit.id });
  } catch (e) {
    console.error('Local git commit failed:', e);
    return NextResponse.json({ error: 'Failed to create commit' }, { status: 500 });
  }
}
