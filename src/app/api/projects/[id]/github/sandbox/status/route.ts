/**
 * GET the working-tree status of a sandboxed-web project's git checkout.
 * Returns the current branch, ahead/behind counts, lists of added/modified/
 * deleted/untracked files, and whether a merge is currently in progress.
 *
 * Returns 400 if the project doesn't have a GitHub repo linked.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireProjectAccess } from "@/lib/project-access";
import { fetchOrigin, getCurrentBranch, getStatus, hasGitDir } from "@/lib/sandbox-git";
import { getUserCredentials } from "@/lib/user-credentials";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

    const gitDirExists = await hasGitDir(id);
    if (!gitDirExists) {
      return NextResponse.json(
        { error: "The sandbox has no .git directory. Re-link the repository to re-clone." },
        { status: 409 },
      );
    }

    // Fetch the cached origin/<branch> ref so the behind count reflects
    // commits that landed on GitHub since the last fetch. We default to
    // fetching because the per-call cost is small (~100–300 ms against
    // GitHub) and the alternative — stale behind counts — is the kind
    // of bug users notice and rightly complain about. Callers that
    // explicitly don't want network can pass `?fetch=0`.
    const fetchParam = req.nextUrl.searchParams.get("fetch");
    const shouldFetch = fetchParam !== "0";
    let fetchError: string | undefined;
    if (shouldFetch) {
      const creds = await getUserCredentials(userId);
      if (creds.githubAccessToken) {
        const cur = await getCurrentBranch(id);
        const branch = cur.ok && cur.branch ? cur.branch : (proj.githubDefaultBranch ?? "main");
        const fetched = await fetchOrigin(id, {
          token: creds.githubAccessToken,
          owner: proj.githubRepoOwner,
          name: proj.githubRepoName,
          branch,
        });
        if (!fetched.ok) {
          // Non-fatal: fall back to local-only status. Surface the stderr
          // so the panel can hint the user (e.g. token expired).
          fetchError = fetched.stderr || fetched.message;
        }
      }
    }

    const res = await getStatus(id);
    if (!res.ok) {
      return NextResponse.json({ error: res.message, stderr: res.stderr }, { status: 500 });
    }
    return NextResponse.json({ ok: true, status: res.status, fetched: shouldFetch && !fetchError, fetchError });
  } catch (err) {
    console.error("POST /github/sandbox/status failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Status failed" },
      { status: 500 },
    );
  }
}
