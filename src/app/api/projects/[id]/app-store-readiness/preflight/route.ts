import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { swiftRuntimeForbidden } from "@/lib/swift-access";
import { runPreflightChecks } from "@/lib/app-store-readiness/preflight";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/projects/[id]/app-store-readiness/preflight
 * Runs the App Store rejection checklist against the project's sandbox.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: projectId } = await params;
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project || project.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (project.platform !== "swift") {
    return NextResponse.json({ error: "Project platform must be 'swift'." }, { status: 400 });
  }
  if (await swiftRuntimeForbidden(project.platform, userId)) {
    return NextResponse.json(
      { error: "Swift projects are currently in private beta." },
      { status: 403 },
    );
  }

  try {
    const report = await runPreflightChecks(projectId, {
      swiftScreenshotIphoneUrl: project.swiftScreenshotIphoneUrl,
      swiftScreenshotIpadUrl: project.swiftScreenshotIpadUrl,
    });
    return NextResponse.json(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Pre-flight scan failed";
    console.error("[app-store-readiness/preflight]", message);
    return NextResponse.json({ error: "Couldn't run the pre-flight checks." }, { status: 500 });
  }
}
