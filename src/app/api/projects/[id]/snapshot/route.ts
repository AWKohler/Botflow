/**
 * POST /api/projects/[id]/snapshot
 *
 * Stores the "last seen" preview snapshot for a project:
 *   - html: the rendered DOM grabbed from the live preview iframe (via the
 *     injected runtime's BF_SNAPSHOT_REQUEST/RESULT postMessage pair). Shown
 *     blurred in the preview pane while the dev server is off.
 *   - thumbnail: rendered SERVER-SIDE from that same HTML with puppeteer-core
 *     + @sparticuz/chromium (the revived pre-sandbox implementation — see
 *     future/thumbnail-and-preview-snapshot.md), rate-limited per tier via the
 *     daily screenshot counter. A client-supplied thumbnailDataUrl is still
 *     accepted and skips the server render (used by the Swift simulator flow).
 *
 * Only ONE snapshot per kind is kept: each new upload evicts the previous
 * UploadThing file before the DB row is updated. Server-side UTApi (instead of
 * client file routes) keeps upload + eviction + DB update in one place.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { UTApi } from "uploadthing/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { requireProjectAccess } from "@/lib/project-access";
import { renderHtmlToThumbnail } from "@/lib/server-screenshot";
import { getUserTierAndLimits } from "@/lib/tier";
import { getDailyScreenshots, incrementDailyScreenshots } from "@/lib/usage";

const utapi = new UTApi();

const MAX_HTML_BYTES = 8 * 1024 * 1024; // generous — inlined images add up
const MAX_THUMB_BYTES = 2 * 1024 * 1024;

export const runtime = "nodejs";
export const maxDuration = 30; // headless Chromium cold start + render

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const access = await requireProjectAccess(id, userId);
    if (!access) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const { project } = access;

    const body = (await req.json().catch(() => null)) as {
      html?: string;
      thumbnailDataUrl?: string;
    } | null;
    if (!body || (typeof body.html !== "string" && typeof body.thumbnailDataUrl !== "string")) {
      return NextResponse.json({ error: "Provide html and/or thumbnailDataUrl" }, { status: 400 });
    }

    const updates: Partial<typeof projects.$inferInsert> = {};
    const staleKeys: string[] = [];

    if (typeof body.html === "string" && body.html.trim()) {
      const bytes = Buffer.byteLength(body.html, "utf-8");
      if (bytes > MAX_HTML_BYTES) {
        return NextResponse.json({ error: "Snapshot HTML too large" }, { status: 413 });
      }
      const file = new File([body.html], `snapshot-${id}.html`, { type: "text/html" });
      const uploaded = await utapi.uploadFiles(file);
      if (uploaded.error || !uploaded.data) {
        console.error("[snapshot] html upload failed:", uploaded.error);
        return NextResponse.json({ error: "Upload failed" }, { status: 500 });
      }
      updates.htmlSnapshotUrl = uploaded.data.ufsUrl ?? uploaded.data.url;
      updates.htmlSnapshotKey = uploaded.data.key;
      if (project.htmlSnapshotKey) staleKeys.push(project.htmlSnapshotKey);
    }

    // Resolve the thumbnail bytes: an explicit client-supplied image wins;
    // otherwise rasterize the freshly-captured HTML with headless Chromium,
    // gated by the per-tier daily screenshot budget. A skipped/failed render
    // never fails the request — the HTML snapshot is the important part.
    let thumb: { buf: Buffer; ext: string; mime: string } | null = null;
    let thumbnailSkipped: string | null = null;

    if (typeof body.thumbnailDataUrl === "string" && body.thumbnailDataUrl.trim()) {
      const match = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(body.thumbnailDataUrl);
      if (!match) {
        return NextResponse.json({ error: "thumbnailDataUrl must be a base64 image data URL" }, { status: 400 });
      }
      const buf = Buffer.from(match[2], "base64");
      if (buf.byteLength > MAX_THUMB_BYTES) {
        return NextResponse.json({ error: "Thumbnail too large" }, { status: 413 });
      }
      thumb = { buf, ext: match[1] === "jpeg" ? "jpg" : match[1], mime: `image/${match[1]}` };
    } else if (typeof body.html === "string" && body.html.trim()) {
      const limits = await getUserTierAndLimits(userId);
      if (isFinite(limits.maxScreenshotsPerDay)) {
        const used = await getDailyScreenshots(userId);
        if (used >= limits.maxScreenshotsPerDay) {
          thumbnailSkipped = "rate_limited";
        } else {
          await incrementDailyScreenshots(userId);
        }
      }
      if (!thumbnailSkipped) {
        const rendered = await renderHtmlToThumbnail(body.html);
        if (rendered) thumb = { buf: rendered, ext: "jpg", mime: "image/jpeg" };
        else thumbnailSkipped = "render_failed";
      }
    }

    if (thumb) {
      const file = new File([new Uint8Array(thumb.buf)], `thumbnail-${id}.${thumb.ext}`, {
        type: thumb.mime,
      });
      const uploaded = await utapi.uploadFiles(file);
      if (uploaded.error || !uploaded.data) {
        console.error("[snapshot] thumbnail upload failed:", uploaded.error);
        return NextResponse.json({ error: "Upload failed" }, { status: 500 });
      }
      updates.thumbnailUrl = uploaded.data.ufsUrl ?? uploaded.data.url;
      updates.thumbnailKey = uploaded.data.key;
      if (project.thumbnailKey) staleKeys.push(project.thumbnailKey);
    }

    if (Object.keys(updates).length > 0) {
      await getDb().update(projects).set(updates).where(eq(projects.id, id));
    }

    // Evict the previous files AFTER the row points at the new ones, so a
    // mid-flight failure never leaves the project referencing a deleted file.
    if (staleKeys.length) {
      await utapi.deleteFiles(staleKeys).catch((e) => {
        console.warn("[snapshot] failed to evict stale files:", e);
      });
    }

    return NextResponse.json({
      ok: true,
      htmlSnapshotUrl: updates.htmlSnapshotUrl ?? project.htmlSnapshotUrl,
      thumbnailUrl: updates.thumbnailUrl ?? project.thumbnailUrl,
      ...(thumbnailSkipped ? { thumbnailSkipped } : {}),
    });
  } catch (e) {
    console.error("[snapshot] error:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
