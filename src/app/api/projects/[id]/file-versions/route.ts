/**
 * GET /api/projects/[id]/file-versions?path=/src/App.tsx        — version list
 * GET /api/projects/[id]/file-versions?versionId=<uuid>          — one version's content
 *
 * Conflict-safety backstop (plan §6.5): every INSTRUMENTED write (editor
 * saves, Botflow-agent write tools) is versioned; this is the read side.
 * Restore is client-driven: fetch a version's content, then save it through
 * the normal file PUT with force=true — which itself records a new version,
 * so a restore is never destructive.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projectFileVersions } from "@/db/schema";
import { requireProjectAccess } from "@/lib/project-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const access = await requireProjectAccess(id, userId);
  if (!access) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const db = getDb();
  const versionId = req.nextUrl.searchParams.get("versionId");
  if (versionId) {
    const [v] = await db
      .select()
      .from(projectFileVersions)
      .where(and(eq(projectFileVersions.id, versionId), eq(projectFileVersions.projectId, id)))
      .limit(1);
    if (!v) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({
      id: v.id,
      path: v.path,
      content: v.content,
      hash: v.hash,
      createdAt: v.createdAt,
    });
  }

  const path = req.nextUrl.searchParams.get("path");
  if (!path) return NextResponse.json({ error: "path or versionId required" }, { status: 400 });

  const rows = await db
    .select({
      id: projectFileVersions.id,
      hash: projectFileVersions.hash,
      size: projectFileVersions.size,
      actorType: projectFileVersions.actorType,
      actorUserId: projectFileVersions.actorUserId,
      createdAt: projectFileVersions.createdAt,
    })
    .from(projectFileVersions)
    .where(and(eq(projectFileVersions.projectId, id), eq(projectFileVersions.path, path)))
    .orderBy(desc(projectFileVersions.createdAt))
    .limit(50);

  return NextResponse.json({ path, versions: rows });
}
