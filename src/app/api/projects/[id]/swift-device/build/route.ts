import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { materializeSwiftConvexConfig } from "@/lib/sandbox-env";
import { createDeviceBuild } from "@/lib/sim-platform";
import { swiftRuntimeForbidden } from "@/lib/swift-access";
import { recordSwiftDeviceBuild } from "@/lib/swift-device-build-store";
import { tarSandboxProject } from "@/lib/vercel-sandbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(
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
    return NextResponse.json(
      { error: "Project platform must be 'swift'." },
      { status: 400 },
    );
  }
  if (await swiftRuntimeForbidden(project.platform, userId)) {
    return NextResponse.json(
      { error: "Swift projects are currently in private beta." },
      { status: 403 },
    );
  }

  try {
    await materializeSwiftConvexConfig(projectId);
    const tarball = await tarSandboxProject(projectId, { excludeConvex: true });
    const build = await createDeviceBuild(tarball);
    await recordSwiftDeviceBuild(build.buildId, userId, projectId);
    return NextResponse.json({ ...build, ipaUrl: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Device build failed";
    console.error("[swift-device/build]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
