/**
 * Fetch and merge the linked repository's working branch from GitHub.
 *
 * Response shapes:
 *   • { ok: true, clean: true }                       — fast-forward / no-op
 *   • { ok: true, clean: false, conflicts: [paths],
 *       conflictBlobs: { [path]: { ours, theirs, base, marked } } }
 *                                                       — conflicts present
 *   • non-ok responses for git failures (network, etc.)
 *
 * On conflicts we eagerly pull the three index stages plus the working-tree
 * marked text for every conflicted file so the conflict modal doesn't have to
 * round-trip again. Token never leaves the server.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireProjectAccess } from "@/lib/project-access";
import { getUserCredentials } from "@/lib/user-credentials";
import {
  getConflictBlobs,
  getCurrentBranch,
  hasGitDir,
  pullBranch,
  type ConflictFileBlobs,
} from "@/lib/sandbox-git";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const access = await requireProjectAccess(id, userId);
    if (!access) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { project: proj } = access;
    if (!proj.githubRepoOwner || !proj.githubRepoName) {
      return NextResponse.json({ error: "No GitHub repository linked." }, { status: 400 });
    }
    if (!(await hasGitDir(id))) {
      return NextResponse.json(
        { error: "Sandbox has no .git directory. Re-link the repository." },
        { status: 409 },
      );
    }

    const creds = await getUserCredentials(userId);
    if (!creds.githubAccessToken) {
      return NextResponse.json({ error: "GitHub not connected" }, { status: 400 });
    }

    const cur = await getCurrentBranch(id);
    const branch = cur.ok && cur.branch ? cur.branch : (proj.githubDefaultBranch ?? "main");

    const res = await pullBranch(id, {
      token: creds.githubAccessToken,
      owner: proj.githubRepoOwner,
      name: proj.githubRepoName,
      branch,
    });

    if (!res.ok) {
      return NextResponse.json({ error: res.message, stderr: res.stderr }, { status: 500 });
    }

    if (res.clean) {
      return NextResponse.json({ ok: true, clean: true, branch, changed: res.changed });
    }

    // Eagerly fetch conflict blobs so the modal renders without another fetch.
    const conflictBlobs: Record<string, ConflictFileBlobs> = {};
    for (const path of res.conflicts) {
      const blobs = await getConflictBlobs(id, path);
      if (blobs.ok && blobs.blobs) conflictBlobs[path] = blobs.blobs;
    }

    return NextResponse.json({
      ok: true,
      clean: false,
      branch,
      conflicts: res.conflicts,
      conflictBlobs,
    });
  } catch (err) {
    console.error("POST /github/sandbox/pull failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Pull failed" },
      { status: 500 },
    );
  }
}
