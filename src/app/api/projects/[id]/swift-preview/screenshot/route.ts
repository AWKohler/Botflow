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
 *
 * Each upload also refreshes the PROJECT THUMBNAIL: the screengrab is
 * composited into the device bezel mockup over a blurred backdrop
 * (src/lib/swift-thumbnail.ts). iPhone frames are preferred — an iPad frame
 * only becomes the thumbnail when no iPhone screengrab exists.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { UTApi } from "uploadthing/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { requireProjectAccess } from "@/lib/project-access";
import { canUseSwift, swiftProjectForbidden } from "@/lib/swift-access";
import { composeSwiftThumbnail } from "@/lib/swift-thumbnail";

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
    const access = await requireProjectAccess(id, userId);
    if (!access || access.project.platform !== "swift") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { project } = access;
    if (await swiftProjectForbidden(project)) {
      return NextResponse.json(
        { error: "Swift projects are currently in private beta." },
        { status: 403 },
      );
    }

    // Simulator streaming is a per-ACTOR entitlement even on shared projects:
    // editors need their own Pro/Max plan to use the sim; device builds stay
    // open to free editors (sharing decision 2026-07-06).
    if (access.role !== "owner" && !(await canUseSwift(userId))) {
      return NextResponse.json(
        { error: "The iOS simulator requires a Pro or Max plan. You can still build to your own device." },
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
    const staleKeys: string[] = [];
    const staleKey = isIpad ? project.swiftScreenshotIpadKey : project.swiftScreenshotIphoneKey;
    if (staleKey) staleKeys.push(staleKey);

    const updates: Partial<typeof projects.$inferInsert> = isIpad
      ? { swiftScreenshotIpadUrl: url, swiftScreenshotIpadKey: key }
      : { swiftScreenshotIphoneUrl: url, swiftScreenshotIphoneKey: key };

    // Refresh the project thumbnail from this frame. Prefer iPhone: an iPad
    // frame is only used when no iPhone screengrab exists (i.e. nothing
    // better has been — or will be — captured). Failures are non-fatal.
    const useForThumbnail = !isIpad || !project.swiftScreenshotIphoneUrl;
    if (useForThumbnail) {
      const screengrab = Buffer.from(await file.arrayBuffer());
      const thumb = await composeSwiftThumbnail(screengrab, isIpad ? "ipad" : "iphone");
      if (thumb) {
        const thumbFile = new File([new Uint8Array(thumb)], `thumbnail-${id}.jpg`, {
          type: "image/jpeg",
        });
        const thumbUploaded = await utapi.uploadFiles(thumbFile);
        if (thumbUploaded.data) {
          updates.thumbnailUrl = thumbUploaded.data.ufsUrl ?? thumbUploaded.data.url;
          updates.thumbnailKey = thumbUploaded.data.key;
          if (project.thumbnailKey) staleKeys.push(project.thumbnailKey);
        } else {
          console.warn("[swift-screenshot] thumbnail upload failed:", thumbUploaded.error);
        }
      }
    }

    await db.update(projects).set(updates).where(eq(projects.id, id));

    // Evict AFTER the row points at the new files.
    if (staleKeys.length) {
      await utapi.deleteFiles(staleKeys).catch((e) => {
        console.warn("[swift-screenshot] failed to evict stale files:", e);
      });
    }

    return NextResponse.json({ ok: true, url, thumbnailUrl: updates.thumbnailUrl ?? null });
  } catch (e) {
    console.error("[swift-screenshot] error:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
