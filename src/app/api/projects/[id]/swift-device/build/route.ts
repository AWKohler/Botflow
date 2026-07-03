import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireProjectAccess } from "@/lib/project-access";
import { materializeSwiftBuildConfig } from "@/lib/sandbox-env";
import { createDeviceBuild } from "@/lib/sim-platform";
import { swiftRuntimeForbidden } from "@/lib/swift-access";
import { recordSwiftDeviceBuild } from "@/lib/swift-device-build-store";
import { tarSandboxProject } from "@/lib/vercel-sandbox";
import { enforce, identifierFor } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Strictest per-user cap — kicks off an expensive Swift on-device IPA build.
  const blocked = await enforce(identifierFor(userId, req), "deploy");
  if (blocked) return blocked;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, userId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { project } = access;
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
    await materializeSwiftBuildConfig(projectId);
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
