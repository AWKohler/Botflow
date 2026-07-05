import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { projects, pendingGitCommits } from '@/db/schema';
import { getUserCredentials } from '@/lib/user-credentials';
import { eq, asc } from 'drizzle-orm';
import { requireProjectAccess } from '@/lib/project-access';
import type { ConflictFile } from '../pull/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface GitHubBlob {
  sha: string;
  url: string;
}

interface GitHubTree {
  sha: string;
  url: string;
}

interface GitHubCommit {
  sha: string;
  html_url: string;
}

async function ghFetch(
  path: string,
  token: string,
  method = 'GET',
  body?: unknown
): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function fetchBlobContent(
  repoPath: string,
  blobSha: string,
  token: string
): Promise<string | null> {
  const res = await ghFetch(`${repoPath}/git/blobs/${blobSha}`, token);
  if (!res.ok) return null;
  const blob = await res.json() as { content: string; encoding: string };
  if (blob.encoding === 'base64') {
    return Buffer.from(blob.content.replace(/\n/g, ''), 'base64').toString('utf-8');
  }
  return null;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Optionally read body for { force: boolean }
    let force = false;
    try {
      const body = await req.json() as { force?: boolean };
      force = Boolean(body?.force);
    } catch {
      // No body or not JSON — that's fine
    }

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

    const token = creds.githubAccessToken;
    const repoPath = `/repos/${proj.githubRepoOwner}/${proj.githubRepoName}`;
    const branch = proj.githubDefaultBranch ?? 'main';

    // Get all pending commits in order
    const pending = await db
      .select()
      .from(pendingGitCommits)
      .where(eq(pendingGitCommits.projectId, id))
      .orderBy(asc(pendingGitCommits.createdAt));

    if (pending.length === 0) {
      return NextResponse.json({ error: 'No pending commits to push' }, { status: 400 });
    }

    // Get current HEAD SHA on remote
    const refRes = await ghFetch(`${repoPath}/git/ref/heads/${branch}`, token);
    let currentSha: string;

    if (refRes.ok) {
      const refData = await refRes.json() as { object: { sha: string } };
      currentSha = refData.object.sha;
    } else if (refRes.status === 404) {
      // Branch doesn't exist yet — repo may be empty
      const repoRes = await ghFetch(repoPath, token);
      if (!repoRes.ok) {
        return NextResponse.json({ error: 'Failed to access repository' }, { status: 500 });
      }
      currentSha = '';
    } else {
      return NextResponse.json({ error: 'Failed to get branch ref' }, { status: 500 });
    }

    // ── Divergence check ──────────────────────────────────────────────────────
    // If remote has advanced beyond our tracked base, we have a conflict (unless force)
    if (!force && proj.githubLastPushedSha && currentSha && currentSha !== proj.githubLastPushedSha) {
      // Get what changed on remote since our last push
      const compareRes = await ghFetch(
        `${repoPath}/compare/${proj.githubLastPushedSha}...${currentSha}`,
        token
      );

      if (compareRes.ok) {
        const compareData = await compareRes.json() as {
          files?: Array<{ filename: string; status: string; sha: string }>;
        };
        const remoteFiles = compareData.files ?? [];

        // Fetch remote file content at current remote HEAD
        const remoteChanges: Record<string, string | null> = {};
        for (const file of remoteFiles) {
          const path = '/' + file.filename;
          if (file.status === 'removed') {
            remoteChanges[path] = null;
          } else {
            remoteChanges[path] = await fetchBlobContent(repoPath, file.sha, token);
          }
        }

        // Files touched by pending commits (with / prefix)
        const pendingFilePaths = new Set<string>();
        for (const commit of pending) {
          const snapshot = commit.filesSnapshot as Record<string, string | null>;
          for (const p of Object.keys(snapshot)) {
            pendingFilePaths.add(p.startsWith('/') ? p : '/' + p);
          }
        }

        // Determine conflicts: remote-changed files that also appear in pending commits
        const conflicts: ConflictFile[] = [];
        const nonConflictedRemote: Record<string, string | null> = {};

        for (const [path, remoteContent] of Object.entries(remoteChanges)) {
          if (pendingFilePaths.has(path)) {
            // Find this file's content in the latest pending commit that touches it
            let localContent: string | null = null;
            for (let i = pending.length - 1; i >= 0; i--) {
              const snapshot = pending[i].filesSnapshot as Record<string, string | null>;
              if (path in snapshot) {
                localContent = snapshot[path];
                break;
              }
              // Try without leading slash (defensive)
              const noSlash = path.slice(1);
              if (noSlash in snapshot) {
                localContent = snapshot[noSlash];
                break;
              }
            }
            conflicts.push({ path, remote: remoteContent, local: localContent });
          } else {
            nonConflictedRemote[path] = remoteContent;
          }
        }

        return NextResponse.json(
          {
            conflict: true,
            remoteSha: currentSha,
            remoteChanges,
            conflicts,
            nonConflictedRemote,
          },
          { status: 409 }
        );
      }
    }

    // ── Apply pending commits to GitHub ───────────────────────────────────────
    let latestSha = currentSha;

    for (const commit of pending) {
      const snapshot = commit.filesSnapshot as Record<string, string | null>;

      const treeEntries: Array<{
        path: string;
        mode: string;
        type: string;
        sha?: string | null;
      }> = [];

      for (const [filePath, content] of Object.entries(snapshot)) {
        const cleanPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;

        if (content === null) {
          // Deleted file
          treeEntries.push({ path: cleanPath, mode: '100644', type: 'blob', sha: null });
        } else {
          const blobRes = await ghFetch(`${repoPath}/git/blobs`, token, 'POST', {
            content: Buffer.from(content, 'utf-8').toString('base64'),
            encoding: 'base64',
          });

          if (!blobRes.ok) {
            console.error('Failed to create blob for', cleanPath);
            continue;
          }

          const blob = await blobRes.json() as GitHubBlob;
          treeEntries.push({ path: cleanPath, mode: '100644', type: 'blob', sha: blob.sha });
        }
      }

      if (treeEntries.length === 0) continue;

      // Create tree
      const treeBody: { base_tree?: string; tree: typeof treeEntries } = { tree: treeEntries };
      if (latestSha) treeBody.base_tree = latestSha;

      const treeRes = await ghFetch(`${repoPath}/git/trees`, token, 'POST', treeBody);
      if (!treeRes.ok) {
        const err = await treeRes.text();
        console.error('Failed to create tree:', err);
        return NextResponse.json({ error: 'Failed to create git tree' }, { status: 500 });
      }

      const tree = await treeRes.json() as GitHubTree;

      // Create commit
      const commitBody: { message: string; tree: string; parents?: string[] } = {
        message: commit.message,
        tree: tree.sha,
      };
      if (latestSha) commitBody.parents = [latestSha];

      const commitRes = await ghFetch(`${repoPath}/git/commits`, token, 'POST', commitBody);
      if (!commitRes.ok) {
        const err = await commitRes.text();
        console.error('Failed to create commit:', err);
        return NextResponse.json({ error: 'Failed to create git commit' }, { status: 500 });
      }

      const newCommit = await commitRes.json() as GitHubCommit;
      latestSha = newCommit.sha;
    }

    // Update the branch ref (force if requested)
    if (latestSha && latestSha !== currentSha) {
      const updateRefRes = await ghFetch(
        `${repoPath}/git/refs/heads/${branch}`,
        token,
        'PATCH',
        { sha: latestSha, force }
      );

      if (!updateRefRes.ok && updateRefRes.status !== 422) {
        // Try to create the ref if it doesn't exist
        const createRefRes = await ghFetch(`${repoPath}/git/refs`, token, 'POST', {
          ref: `refs/heads/${branch}`,
          sha: latestSha,
        });
        if (!createRefRes.ok) {
          return NextResponse.json({ error: 'Failed to update branch ref' }, { status: 500 });
        }
      }
    }

    // Update project with new SHA and clear pending commits
    await db
      .update(projects)
      .set({ githubLastPushedSha: latestSha, updatedAt: new Date() })
      .where(eq(projects.id, id));

    await db.delete(pendingGitCommits).where(eq(pendingGitCommits.projectId, id));

    return NextResponse.json({
      ok: true,
      pushedCommits: pending.length,
      newSha: latestSha,
      repoUrl: `https://github.com/${proj.githubRepoOwner}/${proj.githubRepoName}`,
    });
  } catch (e) {
    console.error('Git push failed:', e);
    return NextResponse.json({ error: 'Failed to push to GitHub' }, { status: 500 });
  }
}
