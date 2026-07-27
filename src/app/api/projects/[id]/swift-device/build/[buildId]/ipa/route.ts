import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireProjectAccess } from "@/lib/project-access";
import { downloadDeviceBuildIpa } from "@/lib/sim-platform";
import { swiftProjectForbidden } from "@/lib/swift-access";
import {
  ownsSwiftDeviceBuild,
  verifySwiftDeviceBuildDownloadToken,
} from "@/lib/swift-device-build-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; buildId: string }> },
) {
  const { id: projectId, buildId } = await params;
  const token = req.nextUrl.searchParams.get("token");
  const tokenAllowed = await verifySwiftDeviceBuildDownloadToken(buildId, projectId, token);

  if (!tokenAllowed) {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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
    if (await swiftProjectForbidden(project)) {
      return NextResponse.json(
        { error: "Swift projects are currently in private beta." },
        { status: 403 },
      );
    }
    if (!(await ownsSwiftDeviceBuild(buildId, userId, projectId))) {
      return NextResponse.json({ error: "Device build not found" }, { status: 404 });
    }
  }

  try {
    const artifact = await downloadDeviceBuildIpa(buildId);
    const headers = new Headers({
      "content-type": artifact.contentType,
      "cache-control": "private, max-age=300",
    });
    if (artifact.contentDisposition) {
      headers.set("content-disposition", artifact.contentDisposition);
    }
    return new NextResponse(artifact.bytes, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "IPA download failed";
    console.error("[swift-device/build/ipa]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
