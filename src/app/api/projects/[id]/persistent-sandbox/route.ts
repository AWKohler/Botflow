import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireProjectAccess } from "@/lib/project-access";
import {
  getSandboxName,
  runPersistentSandboxSmokeTest,
} from "@/lib/vercel-sandbox";
import { swiftProjectForbidden } from "@/lib/swift-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const access = await requireProjectAccess(id, userId);
    if (!access) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { project } = access;

    if (project.platform !== "swift" && project.platform !== "sandboxed-web") {
      return NextResponse.json(
        { error: "Project is not using the persistent runtime" },
        { status: 400 },
      );
    }
    // Swift's runtime is beta-only; deny non-beta owners of legacy swift projects.
    if (await swiftProjectForbidden(project)) {
      return NextResponse.json(
        { error: "Swift projects are currently in private beta." },
        { status: 403 },
      );
    }

    const result = await runPersistentSandboxSmokeTest(project.id);

    return NextResponse.json({
      ok: result.exitCode === 0,
      projectId: project.id,
      sandboxName: result.sandboxName,
      expectedSandboxName: getSandboxName(project.id),
      runtime: result.runtime,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    });
  } catch (error) {
    console.error("Persistent sandbox smoke test failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Persistent sandbox smoke test failed",
      },
      { status: 500 },
    );
  }
}
