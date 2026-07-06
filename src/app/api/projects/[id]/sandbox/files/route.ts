import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireProjectAccess } from "@/lib/project-access";
import { recordFileVersion, sha256Hex, touchWriteBreadcrumb } from "@/lib/file-versions";
import {
  getOrCreatePersistentSandbox,
  sandboxListFiles,
  sandboxReadFile,
  sandboxTreeSignature,
  sandboxWriteFile,
} from "@/lib/vercel-sandbox";
import { swiftRuntimeForbidden } from "@/lib/swift-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function getAuthorizedProject(projectId: string, userId: string) {
  const access = await requireProjectAccess(projectId, userId);
  if (!access) return null;
  const { project } = access;
  if (project.platform !== "swift" && project.platform !== "sandboxed-web") return null;
  // Swift's runtime is beta-only; deny non-beta owners of legacy swift projects.
  if (await swiftRuntimeForbidden(project.platform, userId)) return null;
  return project;
}

// GET: list all files recursively, or read a single file when ?path= is present
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const project = await getAuthorizedProject(id, userId);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const filePath = req.nextUrl.searchParams.get("path");
  const wantsSignature = req.nextUrl.searchParams.get("signature") !== null;

  try {
    if (wantsSignature) {
      // Cheap change-detection probe the client polls to decide whether to
      // re-fetch the full tree. See sandboxTreeSignature for the rationale.
      const signature = await sandboxTreeSignature(project.id);
      return NextResponse.json({ signature });
    }

    if (filePath) {
      const result = await sandboxReadFile(project.id, filePath);
      if (!result) return NextResponse.json({ error: "File not found" }, { status: 404 });
      // hash = the CAS base for a later save (plan §6.1). Text files only.
      return NextResponse.json({
        content: result.content,
        binary: result.binary,
        ...(result.binary ? {} : { hash: sha256Hex(result.content) }),
      });
    }

    // Ensure the sandbox is up before listing
    await getOrCreatePersistentSandbox(project.id);
    const entries = await sandboxListFiles(project.id, "/", true);
    const files: Record<string, { type: "file" | "folder" }> = {};
    for (const entry of entries) {
      files[entry.path] = { type: entry.type };
    }
    return NextResponse.json({ files });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read sandbox" },
      { status: 500 },
    );
  }
}

// PUT: write a file (creates parent dirs as needed)
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const project = await getAuthorizedProject(id, userId);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { path: filePath, content, baseHash, force } = await req.json() as {
    path: string;
    content: string;
    /** sha256 of the content this save was edited FROM (returned by the file
     *  GET). When present and `force` is not set, the save is rejected with
     *  409 if the file changed underneath — compare-and-swap (plan §6.1).
     *  Omitted → legacy last-write-wins (non-editor callers unchanged). */
    baseHash?: string;
    force?: boolean;
  };
  if (!filePath) return NextResponse.json({ error: "path required" }, { status: 400 });
  if (typeof content !== "string") {
    return NextResponse.json({ error: "content must be a string" }, { status: 400 });
  }

  try {
    if (baseHash && !force) {
      // Authoritative check against the ACTUAL sandbox content — breadcrumbs
      // are advisory only, because agents/terminal/build tools write outside
      // instrumented paths. A save↔save race remains possible in the
      // milliseconds between this read and the write below (accepted: the
      // window shrinks from minutes to ms, and version history restores the
      // loser — plan §6.1/§6.5).
      const current = await sandboxReadFile(project.id, filePath);
      if (current && !current.binary && sha256Hex(current.content) !== baseHash) {
        return NextResponse.json(
          {
            error: "conflict",
            message: "This file changed since you opened it.",
            currentHash: sha256Hex(current.content),
          },
          { status: 409 },
        );
      }
    }

    await sandboxWriteFile(project.id, filePath, content);
    // Version + breadcrumb are best-effort — never fail a completed save.
    const actor = { type: "user" as const, userId };
    void recordFileVersion({ projectId: project.id, path: filePath, content, actor });
    void touchWriteBreadcrumb(project.id, filePath, actor);
    return NextResponse.json({ ok: true, hash: sha256Hex(content) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to write file" },
      { status: 500 },
    );
  }
}
