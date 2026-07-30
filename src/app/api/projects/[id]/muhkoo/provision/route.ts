import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { ensureMuhkooProvisioned } from "@/lib/muhkoo-provision";
import { materializeFrontendEnv } from "@/lib/sandbox-env";
import { muhkooForbidden } from "@/lib/muhkoo-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/projects/[id]/muhkoo/provision
 *
 * Ensure the project's platform-managed MuhKoo backend exists, then re-inject
 * the frontend env (VITE_MUHKOO_KEY / VITE_WORKER_URL) into the sandbox. The
 * MuhKoo analogue of the Convex auto-provision path. Idempotent.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: projectId } = await params;
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  if (project.backendType !== "muhkoo") {
    return NextResponse.json(
      {
        error: "not_muhkoo",
        message: "This project does not use a MuhKoo backend.",
      },
      { status: 400 },
    );
  }
  if (await muhkooForbidden(project.backendType, userId)) {
    return NextResponse.json(
      {
        error: "beta",
        message: "MuhKoo backends are currently in private beta.",
      },
      { status: 403 },
    );
  }

  try {
    const result = await ensureMuhkooProvisioned(projectId);
    // Best-effort: push VITE_MUHKOO_KEY into the sandbox .env if it exists yet.
    await materializeFrontendEnv(projectId).catch(() => {});
    return NextResponse.json({
      success: true,
      provisioned: result.provisioned,
      appId: result.appId,
      slug: result.slug,
      hostingUrl: result.hostingUrl,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[muhkoo/provision] provisioning failed:", msg);
    return NextResponse.json(
      { error: "Failed to provision a MuhKoo backend. Please try again." },
      { status: 500 },
    );
  }
}
