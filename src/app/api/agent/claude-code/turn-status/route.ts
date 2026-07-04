/**
 * GET /api/agent/claude-code/turn-status?projectId=...
 *
 * Lightweight (Redis-only) check the AgentPanel runs when an in-sandbox
 * agent stream (Claude Code or OpenCode — one shared turn registry) settles
 * without an endTurn: is the turn actually still alive in the sandbox (or
 * already finished there)? If so, the client REATTACHES to the turn's event
 * stream instead of firing an auto-continue nudge — the nudge would spawn a
 * second agent against a turn that never actually stopped.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { getTurnRecord } from "@/lib/agent/claude-code/turn-registry";
import { enforce, identifierFor } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const blocked = await enforce(identifierFor(userId, req), "poll");
  if (blocked) return blocked;

  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ ok: false, error: "projectId required" }, { status: 400 });
  }

  const db = getDb();
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!project) {
    return NextResponse.json({ ok: false, error: "Project not found" }, { status: 404 });
  }

  const record = await getTurnRecord(projectId);
  // "active" = there is a turn worth reattaching to: either the bridge may
  // still be running, or it finished normally and the event file holds the
  // tail of the stream the client never saw. A dead record means the bridge
  // exited without finishing — reattaching is pointless, auto-continue instead.
  const active = Boolean(record && !record.dead);
  return NextResponse.json({
    ok: true,
    active,
    endedNormally: Boolean(record?.endedNormally),
    turnId: record?.turnId ?? null,
    startedAt: record?.startedAt ?? null,
  });
}
