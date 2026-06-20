/**
 * POST /api/projects/[id]/swift-preview/screenshot
 *
 * Stores the "last seen" simulator frame for one device family. The browser
 * grabs it straight from the stream canvas (canvas.toBlob) — no mac-runtime
 * involvement — periodically while live and right before Stop.
 *
 * multipart/form-data: file (image/jpeg|png), deviceModel ("iPhone-16-Pro" |
 * "iPad-Pro"). One file kept per device: each upload evicts the previous
 * UploadThing file for that device.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { UTApi } from "uploadthing/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { swiftRuntimeForbidden } from "@/lib/swift-access";

const utapi = new UTApi();

const MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const db = getDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    if (!project || project.userId !== userId || project.platform !== "swift") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (await swiftRuntimeForbidden(project.platform, userId)) {
      return NextResponse.json(
        { error: "Swift projects are currently in private beta." },
        { status: 403 },
      );
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const deviceModel = formData.get("deviceModel") as string | null;
    if (!file || !deviceModel) {
      return NextResponse.json({ error: "Missing file or deviceModel" }, { status: 400 });
    }
    const isIpad = deviceModel === "iPad-Pro";
    if (!isIpad && deviceModel !== "iPhone-16-Pro") {
      return NextResponse.json({ error: "Unknown deviceModel" }, { status: 400 });
    }
    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json({ error: "Invalid file type" }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: "File too large" }, { status: 413 });
    }

    const uploaded = await utapi.uploadFiles(file);
    if (uploaded.error || !uploaded.data) {
      console.error("[swift-screenshot] upload failed:", uploaded.error);
      return NextResponse.json({ error: "Upload failed" }, { status: 500 });
    }

    const url = uploaded.data.ufsUrl ?? uploaded.data.url;
    const key = uploaded.data.key;
    const staleKey = isIpad ? project.swiftScreenshotIpadKey : project.swiftScreenshotIphoneKey;

    await db
      .update(projects)
      .set(
        isIpad
          ? { swiftScreenshotIpadUrl: url, swiftScreenshotIpadKey: key }
          : { swiftScreenshotIphoneUrl: url, swiftScreenshotIphoneKey: key },
      )
      .where(eq(projects.id, id));

    // Evict AFTER the row points at the new file.
    if (staleKey) {
      await utapi.deleteFiles([staleKey]).catch((e) => {
        console.warn("[swift-screenshot] failed to evict stale file:", e);
      });
    }

    return NextResponse.json({ ok: true, url });
  } catch (e) {
    console.error("[swift-screenshot] error:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
