import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireProjectAccess } from "@/lib/project-access";
import { swiftRuntimeForbidden } from "@/lib/swift-access";
import { generateAppIcon } from "@/lib/app-store-readiness/app-icon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/projects/[id]/app-store-readiness/icon
 * Body: { prompt: string }  (short — see MAX_ICON_PROMPT_CHARS)
 * Generates a 1024px app icon with GPT Image 2, writes it into the project's
 * asset catalog, and bills the user's credits.
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

  const body = (await req.json().catch(() => null)) as { prompt?: unknown } | null;
  const prompt = typeof body?.prompt === "string" ? body.prompt : "";

  const result = await generateAppIcon({ projectId, userId, userPrompt: prompt });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.insufficientCredits ? { insufficientCredits: true } : {}) },
      { status: result.status },
    );
  }
  return NextResponse.json({
    iconDataUrl: result.iconDataUrl,
    creditsCharged: result.creditsCharged,
    writtenTo: result.writtenTo,
  });
}
