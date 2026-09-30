import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth/server";
import { requireProjectAccess } from "@/lib/project-access";
import { tarSandboxProject } from "@/lib/vercel-sandbox";
import { materializeSwiftBuildConfig } from "@/lib/sandbox-env";
import { canUseSwift, swiftProjectForbidden } from "@/lib/swift-access";
import { enforce, identifierFor } from "@/lib/rate-limit";
import { simulatorProvider } from "@/lib/simulator-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// The authenticated browser transports these bytes to its own Companion.
// Never ask the server to fetch an arbitrary localhost URL or give Companion
// the user's Clerk cookies / the cloud controller's platform token.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const blocked = await enforce(identifierFor(userId, req), "deploy");
  if (blocked) return blocked;
  const { id } = await params;
  const access = await requireProjectAccess(id, userId);
  if (!access || access.project.platform !== "swift") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (await swiftProjectForbidden(access.project)) {
    return NextResponse.json({ error: "Swift projects are currently in private beta." }, { status: 403 });
  }
  if (access.role !== "owner" && !(await canUseSwift(userId))) {
    return NextResponse.json({ error: "The iOS simulator requires a Pro or Max plan." }, { status: 403 });
  }
  try {
    if (simulatorProvider() !== "local") {
      return NextResponse.json({ error: "Local simulator previews are not enabled." }, { status: 409 });
    }
    await materializeSwiftBuildConfig(id);
    const tarball = await tarSandboxProject(id, { excludeConvex: true });
    if (tarball.length > 100 * 1024 * 1024) {
      return NextResponse.json({ error: "This project exceeds the 100 MB local preview limit." }, { status: 413 });
    }
    return new NextResponse(new Uint8Array(tarball), { headers: {
      "Content-Type": "application/gzip",
      "Content-Length": String(tarball.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    console.error("[swift-preview/source]", error);
    return NextResponse.json({ error: "Could not prepare the project for local preview. Please retry." }, { status: 500 });
  }
}
