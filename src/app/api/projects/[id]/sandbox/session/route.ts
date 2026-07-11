import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireProjectAccess } from "@/lib/project-access";
import { getOrCreatePersistentSandbox, SandboxAtCapacityError, SandboxRateLimitError } from "@/lib/vercel-sandbox";
import { swiftRuntimeForbidden } from "@/lib/swift-access";
import { enforce, identifierFor } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Cold-start sandbox creation (with ports declared) can take ~30-90s; the
// previous 60s cap occasionally tripped right at the finish line.
export const maxDuration = 180;

// Map sandbox-acquire failures to responses. Capacity / rate-limit become a
// clean 503 (with Retry-After) carrying a user-facing message so the workspace
// toast reads sensibly instead of showing raw JSON or a 15s-hung 500.
function sandboxErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof SandboxAtCapacityError) {
    return NextResponse.json(
      { error: "We're temporarily at capacity for free-tier workspaces. Please try again in a few minutes." },
      { status: 503, headers: { "Retry-After": "60" } },
    );
  }
  if (error instanceof SandboxRateLimitError) {
    return NextResponse.json(
      { error: "The sandbox service is busy. Please try again shortly." },
      { status: 503, headers: { "Retry-After": String(error.retryAfterSecs) } },
    );
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : fallback },
    { status: 500 },
  );
}

async function getAuthorizedProject(projectId: string, userId: string) {
  const access = await requireProjectAccess(projectId, userId);
  if (!access) return null;
  const { project } = access;
  if (project.platform !== "swift" && project.platform !== "sandboxed-web") return null;
  // Swift's runtime is beta-only; deny non-beta owners of legacy swift projects.
  if (await swiftRuntimeForbidden(project.platform, userId)) return null;
  return project;
}

// GET: get current sandbox status / info
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // GET also calls getOrCreatePersistentSandbox, so it can trigger cold-start
  // creation — limit it on the same expensive bucket as POST.
  const blocked = await enforce(identifierFor(userId, req), "expensive");
  if (blocked) return blocked;

  const { id } = await params;
  const project = await getAuthorizedProject(id, userId);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const sandbox = await getOrCreatePersistentSandbox(project.id);
    return NextResponse.json({
      sandboxName: sandbox.name,
      status: sandbox.status,
      runtime: sandbox.runtime,
    });
  } catch (error) {
    return sandboxErrorResponse(error, "Failed to get sandbox");
  }
}

// POST: ensure sandbox is running (creates if needed)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Cold-start sandbox creation is ~30-90s of compute.
  const blocked = await enforce(identifierFor(userId, req), "expensive");
  if (blocked) return blocked;

  const { id } = await params;
  const project = await getAuthorizedProject(id, userId);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const sandbox = await getOrCreatePersistentSandbox(project.id);
    return NextResponse.json({
      sandboxName: sandbox.name,
      status: sandbox.status,
      runtime: sandbox.runtime,
    });
  } catch (error) {
    return sandboxErrorResponse(error, "Failed to start sandbox");
  }
}
