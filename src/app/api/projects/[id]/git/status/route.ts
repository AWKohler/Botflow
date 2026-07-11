import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { pendingGitCommits } from '@/db/schema';
import { getUserCredentials } from '@/lib/user-credentials';
import { eq, asc } from 'drizzle-orm';
import { requireProjectAccess } from '@/lib/project-access';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Compute GitHub-compatible blob SHA: sha1("blob {size}\0{content}")
function gitBlobSha(content: string): string {
  const buf = Buffer.from(content, 'utf-8');
  const header = `blob ${buf.length}\0`;
  const hash = crypto.createHash('sha1');
  hash.update(header);
  hash.update(buf);
  return hash.digest('hex');
}

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

    const creds = await getUserCredentials(userId);
    if (!creds.githubAccessToken) {
      return NextResponse.json({ error: 'GitHub not connected' }, { status: 400 });
    }

    // Current files from WebContainer (client sends these)
    const { files: currentFiles } = await req.json() as {
      files: Record<string, string>; // path -> content
    };

    // Fetch committed state from GitHub if we have a SHA
    const committedTree: Record<string, string> = {}; // path -> sha

    if (proj.githubLastPushedSha) {
      const treeRes = await fetch(
        `https://api.github.com/repos/${proj.githubRepoOwner}/${proj.githubRepoName}/git/trees/${proj.githubLastPushedSha}?recursive=1`,
        {
          headers: {
            Authorization: `Bearer ${creds.githubAccessToken}`,
            Accept: 'application/vnd.github.v3+json',
          },
        }
      );

      if (treeRes.ok) {
        const treeData = await treeRes.json() as {
          tree: Array<{ path: string; type: string; sha: string }>;
        };
        for (const item of treeData.tree) {
          if (item.type === 'blob') {
            committedTree[`/${item.path}`] = item.sha;
          }
        }
      }
    }

    // Compute status for each current file
    const added: string[] = [];
    const modified: string[] = [];

    for (const [path, content] of Object.entries(currentFiles)) {
      const currentSha = gitBlobSha(content);
      if (!committedTree[path]) {
        added.push(path);
      } else if (committedTree[path] !== currentSha) {
        modified.push(path);
      }
    }

    // Deleted files: in committedTree but not in currentFiles
    const deleted: string[] = [];
    for (const path of Object.keys(committedTree)) {
      if (!(path in currentFiles)) {
        deleted.push(path);
      }
    }

    // Get pending commit count
    const pending = await db
      .select({ id: pendingGitCommits.id, message: pendingGitCommits.message, createdAt: pendingGitCommits.createdAt })
      .from(pendingGitCommits)
      .where(eq(pendingGitCommits.projectId, id))
      .orderBy(asc(pendingGitCommits.createdAt));

    return NextResponse.json({
      added: added.sort(),
      modified: modified.sort(),
      deleted: deleted.sort(),
      pendingCommits: pending,
      hasChanges: added.length > 0 || modified.length > 0 || deleted.length > 0,
    });
  } catch (e) {
    console.error('Git status failed:', e);
    return NextResponse.json({ error: 'Failed to get git status' }, { status: 500 });
  }
}
