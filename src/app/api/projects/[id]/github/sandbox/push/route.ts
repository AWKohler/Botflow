/**
 * Push the linked repository's working branch to GitHub.
 *
 * Returns 409 with `code: "non-fast-forward"` when the remote has diverged —
 * the panel surfaces this as "Get latest first" so the user pulls before
 * retrying.
 *
 * `force: true` runs --force-with-lease (safer than --force; refuses if the
 * remote moved further than we knew about). Reserved for the conflict modal's
 * escape hatch.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { requireProjectAccess } from "@/lib/project-access";
import { getUserCredentials } from "@/lib/user-credentials";
import { getCurrentBranch, hasGitDir, pushBranch } from "@/lib/sandbox-git";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

interface PushBody {
  force?: boolean;
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
    // Sharing: editors may push/commit only when the owner enabled the
    // share-sheet switch (plan §3.3 role matrix).
    if (access.role === "editor" && !access.project.editorsCanPush) {
      return NextResponse.json(
        { error: "The project owner hasn't enabled Git push for editors." },
        { status: 403 },
      );
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

    const body = (await req.json().catch(() => ({}))) as PushBody;

    // Push the current branch — `proj.githubDefaultBranch` is the linked-time
    // default, but the working tree might be on a different branch (Phase F).
    const cur = await getCurrentBranch(id);
    const branch = cur.ok && cur.branch ? cur.branch : (proj.githubDefaultBranch ?? "main");

    const res = await pushBranch(id, {
      token: creds.githubAccessToken,
      owner: proj.githubRepoOwner,
      name: proj.githubRepoName,
      branch,
      force: body.force === true,
    });
    if (!res.ok) {
      const status = res.code === "non-fast-forward" ? 409 : res.code === "auth" ? 403 : 500;
      return NextResponse.json(
        { error: res.message, stderr: res.stderr, code: res.code ?? null },
        { status },
      );
    }

    // Mirror lastPushedSha for compatibility with downstream consumers that
    // read it (e.g. PR creation in Phase F).
    if (res.newSha) {
      await db
        .update(projects)
        .set({ githubLastPushedSha: res.newSha, updatedAt: new Date() })
        .where(eq(projects.id, id));
    }

    return NextResponse.json({ ok: true, newSha: res.newSha ?? null, branch });
  } catch (err) {
    console.error("POST /github/sandbox/push failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Push failed" },
      { status: 500 },
    );
  }
}
