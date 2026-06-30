import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import {
  findAppByBundleId,
  getUploadProcessingState,
  type AscAuth,
} from "@/lib/asc-publish";
import { getAppStoreBuildStatus, type AppStoreBuildSummary } from "@/lib/sim-platform";
import { swiftRuntimeForbidden } from "@/lib/swift-access";
import { ownsSwiftPublishBuild } from "@/lib/swift-publish-store";
import { getUserCredentials } from "@/lib/user-credentials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; buildId: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: projectId, buildId } = await params;
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
  if (!(await ownsSwiftPublishBuild(buildId, userId, projectId))) {
    return NextResponse.json({ error: "Publish build not found" }, { status: 404 });
  }

  try {
    const build = await getAppStoreBuildStatus(buildId);
    if (build.state !== "succeeded") {
      return NextResponse.json(build);
    }
    // 'succeeded' = Apple accepted the upload; it may still be PROCESSING at
    // Apple. Enrich with the ASC processing state — best-effort: any failure
    // here returns the controller summary alone.
    const apple = await appleProcessingState(userId, build);
    return NextResponse.json(apple ? { ...build, apple } : build);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Publish build status failed";
    console.error("[swift-publish/build/status]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function appleProcessingState(
  userId: string,
  build: AppStoreBuildSummary,
): Promise<{ processed: boolean; processingState?: string } | null> {
  try {
    if (!build.bundleId || !build.buildNumber) return null;
    const creds = await getUserCredentials(userId);
    if (!creds.appleAscIssuerId || !creds.appleAscKeyId || !creds.appleAscKeyP8) {
      return null;
    }
    const ascAuth: AscAuth = {
      issuerId: creds.appleAscIssuerId,
      keyId: creds.appleAscKeyId,
      p8: creds.appleAscKeyP8,
    };
    const app = await findAppByBundleId(ascAuth, build.bundleId);
    if (!app) return null;
    return await getUploadProcessingState(ascAuth, app.ascAppId, build.buildNumber);
  } catch {
    // Enrichment is best-effort; the controller summary stands on its own.
    return null;
  }
}
