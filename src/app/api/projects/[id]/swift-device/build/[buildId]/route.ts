import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireProjectAccess } from "@/lib/project-access";
import { getDeviceBuild } from "@/lib/sim-platform";
import { swiftRuntimeForbidden } from "@/lib/swift-access";
import {
  ownsSwiftDeviceBuild,
  swiftDeviceBuildDownloadToken,
} from "@/lib/swift-device-build-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; buildId: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: projectId, buildId } = await params;
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
  if (!(await ownsSwiftDeviceBuild(buildId, userId, projectId))) {
    return NextResponse.json({ error: "Device build not found" }, { status: 404 });
  }

  try {
    const build = await getDeviceBuild(buildId);
    return NextResponse.json(await withDownloadUrl(build, req, projectId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Device build status failed";
    console.error("[swift-device/build/status]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function withDownloadUrl<T extends { buildId: string; state: string; ipaUrl: string | null }>(
  build: T,
  req: NextRequest,
  projectId: string,
): Promise<T> {
  if (build.state !== "succeeded") return { ...build, ipaUrl: null };
  const token = await swiftDeviceBuildDownloadToken(build.buildId);
  if (!token) return { ...build, ipaUrl: null };
  const url = new URL(
    `/api/projects/${projectId}/swift-device/build/${build.buildId}/ipa`,
    req.url,
  );
  url.searchParams.set("token", token);
  return { ...build, ipaUrl: url.toString() };
}
