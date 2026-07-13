import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireProjectAccess } from "@/lib/project-access";
import { swiftProjectForbidden } from "@/lib/swift-access";
import { MAX_ICON_UPLOAD_BYTES, setUploadedAppIcon } from "@/lib/app-store-readiness/app-icon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/projects/[id]/app-store-readiness/icon-upload
 * multipart/form-data: file=<image>
 * Sets the app icon from a user-provided image (normalized to 1024² opaque PNG,
 * written into the asset catalog). No credits — no model runs.
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
  if (await swiftProjectForbidden(project)) {
    return NextResponse.json(
      { error: "Swift projects are currently in private beta." },
      { status: 403 },
    );
  }

  // Coarse DoS guard: refuse an oversized body before buffering it. The precise
  // per-file check still runs below (multipart framing inflates this slightly).
  const declaredLen = Number(req.headers.get("content-length") ?? 0);
  if (declaredLen > MAX_ICON_UPLOAD_BYTES + 1_000_000) {
    return NextResponse.json({ error: "That image is too large (max 12 MB)." }, { status: 413 });
  }

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return NextResponse.json({ error: "Expected a multipart file upload." }, { status: 400 });
  }
  if (!file) {
    return NextResponse.json({ error: "No image provided." }, { status: 400 });
  }
  if (file.size > MAX_ICON_UPLOAD_BYTES) {
    return NextResponse.json({ error: "That image is too large (max 12 MB)." }, { status: 400 });
  }

  const imageBuffer = Buffer.from(await file.arrayBuffer());
  const result = await setUploadedAppIcon({ projectId, imageBuffer });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ iconDataUrl: result.iconDataUrl, writtenTo: result.writtenTo });
}
