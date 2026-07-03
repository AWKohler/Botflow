import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { getUserCredentials } from '@/lib/user-credentials';
import { eq } from 'drizzle-orm';
import { requireProjectAccess } from '@/lib/project-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export interface ConflictFile {
  path: string;
  remote: string | null; // null = deleted on remote
  local: string | null;  // null = deleted locally
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

    const body = await req.json() as {
      action: 'pull' | 'force-update-sha';
      remoteSha?: string;
      localFiles?: Record<string, string>;
    };

    const { action } = body;
    const token = creds.githubAccessToken;
    const repoPath = `/repos/${proj.githubRepoOwner}/${proj.githubRepoName}`;
    const branch = proj.githubDefaultBranch ?? 'main';

    // Update tracked SHA after a force pull / merge completion
    if (action === 'force-update-sha') {
      const { remoteSha } = body;
      if (!remoteSha) return NextResponse.json({ error: 'remoteSha required' }, { status: 400 });
      await db
        .update(projects)
        .set({ githubLastPushedSha: remoteSha, updatedAt: new Date() })
        .where(eq(projects.id, id));
      return NextResponse.json({ ok: true });
    }

    // action === 'pull' — compare remote vs local
    const { localFiles = {} } = body;

    // Get remote HEAD SHA
    const refRes = await ghFetch(`${repoPath}/git/ref/heads/${branch}`, token);
    if (!refRes.ok) {
      return NextResponse.json({ error: 'Failed to fetch remote branch' }, { status: 500 });
    }
    const refData = await refRes.json() as { object: { sha: string } };
    const remoteSha = refData.object.sha;

    const lastPushedSha = proj.githubLastPushedSha;

    if (lastPushedSha === remoteSha) {
      return NextResponse.json({ nothingToPull: true });
    }

    // No known base SHA: fetch full remote tree, treat everything as new
    if (!lastPushedSha) {
      const treeRes = await ghFetch(`${repoPath}/git/trees/${remoteSha}?recursive=1`, token);
      if (!treeRes.ok) {
        return NextResponse.json({ error: 'Failed to fetch remote tree' }, { status: 500 });
      }
      const treeData = await treeRes.json() as {
        tree: Array<{ path: string; type: string; sha: string }>;
      };

      const remoteChanges: Record<string, string | null> = {};
      for (const entry of treeData.tree) {
        if (entry.type !== 'blob') continue;
        const content = await fetchBlobContent(repoPath, entry.sha, token);
        if (content !== null) remoteChanges['/' + entry.path] = content;
      }

      return NextResponse.json({
        remoteSha,
        remoteChanges,
        conflicts: [],
        nonConflictedRemote: remoteChanges,
      });
    }

    // Compare remote HEAD vs last-pushed SHA to find what changed on remote
    const compareRes = await ghFetch(
      `${repoPath}/compare/${lastPushedSha}...${remoteSha}`,
      token
    );
    if (!compareRes.ok) {
      return NextResponse.json({ error: 'Failed to compare commits' }, { status: 500 });
    }

    const compareData = await compareRes.json() as {
      files?: Array<{ filename: string; status: string; sha: string }>;
    };
    const changedFiles = compareData.files ?? [];

    // Fetch content of each remote-changed file at the remote HEAD
    const remoteChanges: Record<string, string | null> = {};
    for (const file of changedFiles) {
      const path = '/' + file.filename;
      if (file.status === 'removed') {
        remoteChanges[path] = null;
      } else {
        const content = await fetchBlobContent(repoPath, file.sha, token);
        remoteChanges[path] = content; // null if fetch failed — treat as no change
      }
    }

    // Classify: conflicts vs non-conflicting remote changes
    const conflicts: ConflictFile[] = [];
    const nonConflictedRemote: Record<string, string | null> = {};

    for (const [path, remoteContent] of Object.entries(remoteChanges)) {
      const local = localFiles[path] ?? null;

      if (local === remoteContent) {
        // Already in sync — no action needed
        continue;
      }

      if (remoteContent === null) {
        // Remote deleted this file; user still has it locally → conflict
        if (local !== null) conflicts.push({ path, remote: null, local });
        // else: also deleted locally → nothing to do
      } else if (local === null) {
        // Remote added a file that doesn't exist locally → safe to apply
        nonConflictedRemote[path] = remoteContent;
      } else {
        // Both sides differ → conflict
        conflicts.push({ path, remote: remoteContent, local });
      }
    }

    return NextResponse.json({
      remoteSha,
      remoteChanges,
      conflicts,
      nonConflictedRemote,
    });
  } catch (e) {
    console.error('Git pull failed:', e);
    return NextResponse.json({ error: 'Failed to pull from GitHub' }, { status: 500 });
  }
}
