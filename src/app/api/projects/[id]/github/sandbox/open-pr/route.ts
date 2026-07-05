/**
 * Open a pull request on GitHub for the linked project's working branch.
 *
 * Body: { title, body?, baseBranch?, headBranch? }
 *   • title — PR title; required.
 *   • body — markdown PR description; optional.
 *   • baseBranch — defaults to the linked default branch.
 *   • headBranch — defaults to the sandbox's current branch (rev-parse HEAD).
 *
 * Returns: { ok, url, number, alreadyExists? }.
 *
 * If a PR with the same head→base already exists, GitHub returns 422; we
 * surface that as ok:true, alreadyExists:true so the panel can just open
 * the existing PR.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireProjectAccess } from "@/lib/project-access";
import { getUserCredentials } from "@/lib/user-credentials";
import { getCurrentBranch } from "@/lib/sandbox-git";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface OpenPrBody {
  title: string;
  body?: string;
  baseBranch?: string;
  headBranch?: string;
  draft?: boolean;
}

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

    const creds = await getUserCredentials(userId);
    if (!creds.githubAccessToken) {
      return NextResponse.json({ error: "GitHub not connected" }, { status: 400 });
    }

    const body = (await req.json()) as OpenPrBody;
    const title = (body.title ?? "").trim();
    if (!title) return NextResponse.json({ error: "title is required" }, { status: 400 });

    // Default base branch: the linked default. Head branch: whatever the
    // sandbox is currently on (so single-branch projects pushing to main
    // will refuse with same-branch — we return that as an error).
    const baseBranch = (body.baseBranch ?? proj.githubDefaultBranch ?? "main").trim();
    let headBranch = (body.headBranch ?? "").trim();
    if (!headBranch) {
      const cur = await getCurrentBranch(id);
      headBranch = cur.ok && cur.branch ? cur.branch : (proj.githubDefaultBranch ?? "main");
    }

    if (baseBranch === headBranch) {
      return NextResponse.json(
        {
          error:
            "PR head and base are the same branch. Create a feature branch first (e.g. with `git checkout -b feature/x`) and push it before opening a PR.",
          code: "same-branch",
        },
        { status: 400 },
      );
    }

    const ghBody = {
      title,
      head: headBranch,
      base: baseBranch,
      body: body.body ?? undefined,
      draft: body.draft ?? false,
    };

    const res = await fetch(
      `https://api.github.com/repos/${proj.githubRepoOwner}/${proj.githubRepoName}/pulls`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.githubAccessToken}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(ghBody),
      },
    );

    if (res.ok) {
      const pr = (await res.json()) as { html_url: string; number: number };
      return NextResponse.json({ ok: true, url: pr.html_url, number: pr.number });
    }

    // 422 commonly means "already exists" — try to locate the existing PR.
    if (res.status === 422) {
      const listRes = await fetch(
        `https://api.github.com/repos/${proj.githubRepoOwner}/${proj.githubRepoName}/pulls?head=${encodeURIComponent(
          `${proj.githubRepoOwner}:${headBranch}`,
        )}&base=${encodeURIComponent(baseBranch)}&state=open`,
        {
          headers: {
            Authorization: `Bearer ${creds.githubAccessToken}`,
            Accept: "application/vnd.github.v3+json",
          },
        },
      );
      if (listRes.ok) {
        const list = (await listRes.json()) as Array<{ html_url: string; number: number }>;
        if (list.length > 0) {
          return NextResponse.json({
            ok: true,
            url: list[0].html_url,
            number: list[0].number,
            alreadyExists: true,
          });
        }
      }
    }

    const err = (await res.json().catch(() => ({}))) as { message?: string; errors?: unknown[] };
    return NextResponse.json(
      { error: err.message ?? `GitHub returned ${res.status}`, details: err.errors ?? null },
      { status: res.status },
    );
  } catch (err) {
    console.error("POST /github/sandbox/open-pr failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Open PR failed" },
      { status: 500 },
    );
  }
}
