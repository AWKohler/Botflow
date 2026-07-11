import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireProjectAccess } from "@/lib/project-access";
import { swiftRuntimeForbidden } from "@/lib/swift-access";
import { draftAppStoreMetadata } from "@/lib/app-store-readiness/metadata-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/projects/[id]/app-store-readiness/metadata
 * Body: { appName?: string }
 * Drafts App Store name/subtitle/description/keywords with Minimax, billed.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, userId);
  if (!access) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { project } = access;
  if (project.platform !== "swift") {
    return NextResponse.json({ error: "Project platform must be 'swift'." }, { status: 400 });
  }
  if (await swiftRuntimeForbidden(project.platform, userId)) {
    return NextResponse.json(
      { error: "Swift projects are currently in private beta." },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => null)) as { appName?: unknown } | null;
  const appName =
    typeof body?.appName === "string" && body.appName.trim()
      ? body.appName.trim().slice(0, 60)
      : project.name;

  const result = await draftAppStoreMetadata({ projectId, userId, appName });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.insufficientCredits ? { insufficientCredits: true } : {}) },
      { status: result.status },
    );
  }
  return NextResponse.json({ metadata: result.metadata, creditsCharged: result.creditsCharged });
}
