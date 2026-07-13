import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { requireProjectAccess } from "@/lib/project-access";
import { sandboxReadFile, sandboxWriteFile } from "@/lib/vercel-sandbox";
import { swiftProjectForbidden } from "@/lib/swift-access";
import {
  setClassNameAtLoc,
  parseLoc,
  VisualEditError,
} from "@/lib/preview-editor/apply-edit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function getAuthorizedProject(projectId: string, userId: string) {
  const access = await requireProjectAccess(projectId, userId);
  if (!access) return null;
  const { project } = access;
  if (project.platform !== "swift" && project.platform !== "sandboxed-web") {
    return null;
  }
  if (await swiftProjectForbidden(project)) return null;
  return project;
}

interface VisualEditBody {
  loc: string;
  op: "className";
  className: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const project = await getAuthorizedProject(id, userId);
  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let body: VisualEditBody;
  try {
    body = (await req.json()) as VisualEditBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.op !== "className") {
    return NextResponse.json(
      { error: `Unsupported op: ${body.op}` },
      { status: 400 },
    );
  }
  if (typeof body.loc !== "string" || typeof body.className !== "string") {
    return NextResponse.json(
      { error: "loc and className are required" },
      { status: 400 },
    );
  }
  // Guard against pathological class strings.
  if (body.className.length > 2000) {
    return NextResponse.json({ error: "className too long" }, { status: 400 });
  }

  const parsed = parseLoc(body.loc);
  if (!parsed) {
    return NextResponse.json({ error: "Malformed loc" }, { status: 400 });
  }

  // Defense-in-depth: keep edits inside the project tree.
  if (parsed.file.includes("..") || parsed.file.startsWith("/")) {
    return NextResponse.json({ error: "Illegal path" }, { status: 400 });
  }

  try {
    const read = await sandboxReadFile(project.id, parsed.file);
    if (!read || read.binary) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
    const next = setClassNameAtLoc(
      read.content,
      parsed.line,
      parsed.column,
      body.className,
    );
    if (next !== read.content) {
      await sandboxWriteFile(project.id, parsed.file, next);
    }
    return NextResponse.json({ ok: true, file: parsed.file });
  } catch (error) {
    if (error instanceof VisualEditError) {
      return NextResponse.json(
        { error: error.message, kind: error.kind },
        { status: error.status },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Edit failed" },
      { status: 500 },
    );
  }
}
