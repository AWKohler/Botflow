/**
 * POST /api/projects/[id]/snapshot
 *
 * Stores the "last seen" preview snapshot for a project:
 *   - html: the rendered DOM grabbed from the live preview iframe (via the
 *     injected runtime's BF_SNAPSHOT_REQUEST/RESULT postMessage pair). Shown
 *     blurred in the preview pane while the dev server is off.
 *   - thumbnailDataUrl: a JPEG rasterization of that same HTML (client-side
 *     html2canvas), used as the project thumbnail in lists/showcase.
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

const utapi = new UTApi();

const MAX_HTML_BYTES = 8 * 1024 * 1024; // generous — inlined images add up
const MAX_THUMB_BYTES = 2 * 1024 * 1024;

export const runtime = "nodejs";

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

    if (typeof body.thumbnailDataUrl === "string" && body.thumbnailDataUrl.trim()) {
      const match = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(body.thumbnailDataUrl);
      if (!match) {
        return NextResponse.json({ error: "thumbnailDataUrl must be a base64 image data URL" }, { status: 400 });
      }
      const buf = Buffer.from(match[2], "base64");
      if (buf.byteLength > MAX_THUMB_BYTES) {
        return NextResponse.json({ error: "Thumbnail too large" }, { status: 413 });
      }
      const file = new File([new Uint8Array(buf)], `thumbnail-${id}.${match[1] === "jpeg" ? "jpg" : match[1]}`, {
        type: `image/${match[1]}`,
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
    });
  } catch (e) {
    console.error("[snapshot] error:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
