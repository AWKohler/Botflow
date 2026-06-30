/**
 * Lazily migrate a legacy WebContainer project (platform === "web") onto a
 * Vercel sandbox. Called by the workspace migration gate when such a project is
 * opened. Idempotent — returns { migrated: false } once the project is already
 * sandbox-based.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { migrateWebContainerProjectToSandbox } from "@/lib/webcontainer-migration";
import { enforce, identifierFor } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const blocked = await enforce(identifierFor(userId, _req), "deploy");
  if (blocked) return blocked;

  const { id } = await params;

  try {
    const result = await migrateWebContainerProjectToSandbox(id, userId);
    if (!result.migrated && result.reason === "not-found") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error(`[migrate-to-sandbox] failed for ${id}:`, error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Migration failed" },
      { status: 500 },
    );
  }
}
