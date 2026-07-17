/**
 * Link / unlink a GitHub repository to a sandboxed-web project.
 *
 * On link: clones (if repo is populated) or initializes-and-commits (if empty)
 * the project's sandbox at /vercel/sandbox to track the chosen repo. The
 * sandbox keeps a real `.git` directory; subsequent commit/push/pull use
 * the actual `git` binary.
 *
 * On unlink: clears the project's github_* columns. The sandbox's .git
 * directory is left intact so the working tree keeps working, but no further
 * remote operations happen until re-linked.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { requireProjectAccess } from "@/lib/project-access";
import { getUserCredentials } from "@/lib/user-credentials";
import {
  cloneRepoIntoSandbox,
  hasGitDir,
  initSandboxAsRepo,
  pushBranch,
} from "@/lib/sandbox-git";
import { getOrCreatePersistentSandbox } from "@/lib/vercel-sandbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

interface LinkBody {
  owner: string;
  name: string;
  defaultBranch?: string;
}

interface GitHubRepoInfo {
  default_branch: string;
  size: number;
  private: boolean;
  permissions?: { push?: boolean };
}

interface GitHubUserInfo {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
}

async function fetchRepoInfo(token: string, owner: string, name: string): Promise<GitHubRepoInfo | { error: string; status: number }> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${name}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    return { error: body.message ?? `GitHub returned ${res.status}`, status: res.status };
  }
  return (await res.json()) as GitHubRepoInfo;
}

async function fetchUserInfo(token: string): Promise<GitHubUserInfo | null> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as GitHubUserInfo;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const db = getDb();
    const access = await requireProjectAccess(id, userId);
    if (!access) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { project: proj } = access;
    // Any platform whose files live in the persistent Vercel Sandbox can use
    // the real-git link flow. Legacy 'web' (WebContainer) stays on the
    // DB-snapshot flow under /api/projects/[id]/git/*.
    if (proj.platform !== "sandboxed-web" && proj.platform !== "swift") {
      return NextResponse.json(
        { error: "This endpoint is for sandbox-backed projects only." },
        { status: 400 },
      );
    }

    const creds = await getUserCredentials(userId);
    if (!creds.githubAccessToken) {
      return NextResponse.json({ error: "GitHub not connected" }, { status: 400 });
    }
    const token = creds.githubAccessToken;

    const body = (await req.json()) as LinkBody;
    if (!body.owner || !body.name) {
      return NextResponse.json({ error: "owner and name are required" }, { status: 400 });
    }

    // Verify access and learn the repo's state (empty or populated).
    const repoInfo = await fetchRepoInfo(token, body.owner, body.name);
    if ("error" in repoInfo) {
      return NextResponse.json({ error: repoInfo.error }, { status: repoInfo.status });
    }
    if (repoInfo.permissions?.push === false) {
      return NextResponse.json(
        { error: "You don't have push access to this repository." },
        { status: 403 },
      );
    }

    const branch = body.defaultBranch ?? repoInfo.default_branch ?? "main";

    // Best-effort identity for git commits.
    const user = await fetchUserInfo(token);
    const identity = {
      name: user?.name || user?.login || "Botflow",
      email: user?.email
        || (user?.login ? `${user.id ?? user.login}+${user.login}@users.noreply.github.com` : "agent@botflow.dev"),
    };

    // Ensure the sandbox exists before we touch its filesystem.
    await getOrCreatePersistentSandbox(id);

    let headSha: string | null = null;
    let wasEmpty = false;

    // Strategy: try to clone. The clone fails with a specific error when the
    // repo has NO branches at all (truly empty: zero commits). In that case
    // fall back to init-then-push. The `size === 0` shortcut from earlier
    // was wrong because a repo with just an auto-generated README still has
    // commits — clone works fine on it.
    const clone = await cloneRepoIntoSandbox(id, {
      token,
      owner: body.owner,
      name: body.name,
      branch,
      // Layer the remote on top of the sandbox's existing template/working
      // files rather than wiping them. The sandbox's existing files become
      // uncommitted changes the user can save with one click. This is the
      // right default for "I just created a botflow project from a template
      // and now want to push it to GitHub."
      strategy: "preserve-local",
      identity,
    });

    if (clone.ok) {
      headSha = clone.info?.headSha ?? null;
    } else {
      const stderr = (clone.stderr ?? "").toLowerCase();
      const looksTrulyEmpty =
        stderr.includes("you appear to have cloned an empty repository")
        || stderr.includes("remote branch") && stderr.includes("not found")
        || stderr.includes("couldn't find remote ref")
        || stderr.includes("does not exist") && stderr.includes("upstream");
      if (!looksTrulyEmpty) {
        return NextResponse.json({ error: clone.message, stderr: clone.stderr }, { status: 500 });
      }

      // Truly empty repo — init the sandbox in place and push.
      wasEmpty = true;
      const init = await initSandboxAsRepo(id, {
        owner: body.owner,
        name: body.name,
        branch,
        identity,
      });
      if (!init.ok) {
        return NextResponse.json({ error: init.message, stderr: init.stderr }, { status: 500 });
      }
      if (init.headSha) {
        const push = await pushBranch(id, {
          token,
          owner: body.owner,
          name: body.name,
          branch,
          setUpstream: true,
        });
        if (!push.ok) {
          return NextResponse.json(
            { error: `Initial push failed: ${push.message}`, stderr: push.stderr },
            { status: 500 },
          );
        }
        headSha = push.newSha ?? init.headSha;
      }
    }

    // Persist link metadata.
    const [updated] = await db
      .update(projects)
      .set({
        githubRepoOwner: body.owner,
        githubRepoName: body.name,
        githubDefaultBranch: branch,
        githubLastPushedSha: headSha,
        // Reset autonomy so the agent re-asks the user on next turn.
        gitAutonomy: null,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, id))
      .returning();

    // The agent's autonomy question is triggered client-side after this
    // route returns: github-panel dispatches a `github-linked` event,
    // AgentPanel sends a [system-note] user message which both persists
    // and kicks off an agent turn. A DB-only insert here doesn't run the
    // agent, so it lived as a chip with no follow-up.

    return NextResponse.json({
      ok: true,
      project: updated,
      repo: {
        owner: body.owner,
        name: body.name,
        defaultBranch: branch,
        wasEmpty,
      },
    });
  } catch (err) {
    console.error("POST /github/sandbox/link failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Link failed" },
      { status: 500 },
    );
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const db = getDb();
    const access = await requireProjectAccess(id, userId);
    if (!access) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const [updated] = await db
      .update(projects)
      .set({
        githubRepoOwner: null,
        githubRepoName: null,
        githubDefaultBranch: "main",
        githubLastPushedSha: null,
        gitAutonomy: null,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, id))
      .returning();

    // The sandbox's .git directory is intentionally NOT removed — if the user
    // re-links to the same repo later they can keep their local history.
    const stillHasGit = await hasGitDir(id).catch(() => false);

    return NextResponse.json({ ok: true, project: updated, gitDirPreserved: stillHasGit });
  } catch (err) {
    console.error("DELETE /github/sandbox/link failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unlink failed" },
      { status: 500 },
    );
  }
}
