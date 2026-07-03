/**
 * Apply conflict resolutions and finalize the merge.
 *
 * Body: { resolutions: [{ path, side: "ours" | "theirs" } | { path, content }],
 *         finalizeMessage?: string }
 *
 * Each resolution is applied in order. After all resolutions are applied, if
 * the working tree is conflict-marker-free, the merge is finalized with a
 * commit. The caller can then push.
 *
 * If the working tree still has conflict markers after applying the given
 * resolutions (e.g. agent-led merge produced partial content), returns 200
 * with `{ ok: true, finalized: false, remainingConflicts: [...] }` so the UI
 * knows to keep the modal open.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireProjectAccess } from "@/lib/project-access";
import {
  finalizeMerge,
  getStatus,
  hasGitDir,
  resolveWithContent,
  resolveWithSide,
} from "@/lib/sandbox-git";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

type Resolution =
  | { path: string; side: "ours" | "theirs" }
  | { path: string; content: string };

interface ResolveBody {
  resolutions: Resolution[];
  finalizeMessage?: string;
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
    if (!(await hasGitDir(id))) {
      return NextResponse.json(
        { error: "Sandbox has no .git directory." },
        { status: 409 },
      );
    }

    const body = (await req.json()) as ResolveBody;
    if (!Array.isArray(body.resolutions) || body.resolutions.length === 0) {
      return NextResponse.json({ error: "resolutions array is required" }, { status: 400 });
    }

    for (const raw of body.resolutions) {
      const r = raw as { path?: string; side?: "ours" | "theirs"; content?: string };
      if (!r.path) {
        return NextResponse.json({ error: "Each resolution needs a path." }, { status: 400 });
      }
      if (r.side === "ours" || r.side === "theirs") {
        const sideRes = await resolveWithSide(id, r.path, r.side);
        if (!sideRes.ok) {
          return NextResponse.json(
            { error: `Failed to resolve ${r.path}: ${sideRes.message}`, stderr: sideRes.stderr },
            { status: 500 },
          );
        }
      } else if (typeof r.content === "string") {
        const contentRes = await resolveWithContent(id, r.path, r.content);
        if (!contentRes.ok) {
          return NextResponse.json(
            { error: `Failed to resolve ${r.path}: ${contentRes.message}`, stderr: contentRes.stderr },
            { status: 500 },
          );
        }
      } else {
        return NextResponse.json(
          { error: `Resolution for ${r.path} must include either "side" or "content".` },
          { status: 400 },
        );
      }
    }

    // Check whether anything still has markers / unmerged paths.
    const status = await getStatus(id);
    if (!status.ok) {
      return NextResponse.json({ error: status.message }, { status: 500 });
    }
    if (status.status && status.status.files.conflicted.length > 0) {
      return NextResponse.json({
        ok: true,
        finalized: false,
        remainingConflicts: status.status.files.conflicted,
      });
    }

    const finalize = await finalizeMerge(id, body.finalizeMessage);
    if (!finalize.ok) {
      return NextResponse.json({ error: finalize.message, stderr: finalize.stderr }, { status: 500 });
    }
    return NextResponse.json({ ok: true, finalized: true, sha: finalize.sha ?? null });
  } catch (err) {
    console.error("POST /github/sandbox/resolve failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Resolve failed" },
      { status: 500 },
    );
  }
}
