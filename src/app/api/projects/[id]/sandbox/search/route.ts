import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireProjectAccess } from "@/lib/project-access";
import { sandboxGrep } from "@/lib/vercel-sandbox";
import { swiftProjectForbidden } from "@/lib/swift-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const access = await requireProjectAccess(id, userId);
  if (!access || (access.project.platform !== "swift" && access.project.platform !== "sandboxed-web")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { project } = access;
  // Swift's runtime is beta-only; deny non-beta owners of legacy swift projects.
  if (await swiftProjectForbidden(project)) {
    return NextResponse.json(
      { error: "Swift projects are currently in private beta." },
      { status: 403 },
    );
  }

  const body = await req.json() as {
    pattern: string;
    path?: string;
    glob?: string;
    caseInsensitive?: boolean;
    maxResults?: number;
  };

  if (!body.pattern) {
    return NextResponse.json({ error: "pattern required" }, { status: 400 });
  }

  try {
    const results = await sandboxGrep(project.id, body.pattern, {
      path: body.path,
      glob: body.glob,
      caseInsensitive: body.caseInsensitive,
      maxResults: body.maxResults,
    });
    return NextResponse.json({ results });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Search failed" },
      { status: 500 },
    );
  }
}
