/**
 * POST /api/internal/agent/turn-progress  { tool, detail?, steps? }
 *   Authorization: Bearer <turn tool token>
 *
 * A throttled heartbeat from an in-sandbox agent bridge: "I just started this
 * step". It exists for one reason: to move the iOS app's Live Activity while
 * the app itself is suspended. The bridge only sends it when the turn was
 * started by someone with the iOS app (BOTFLOW_PROGRESS_BEACON), and this
 * route does nothing unless that person's app registered an activity for the
 * thread. Nothing is stored in the conversation.
 */
import { NextResponse } from "next/server";
import { resolveToolToken } from "@/lib/agent/claude-code/tool-token";
import { enforce, identifierFor } from "@/lib/rate-limit";
import { pushTurnProgress } from "@/lib/native/agent-push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: Request) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!match) return NextResponse.json({ ok: false, error: "Missing bearer token" }, { status: 401 });
  const binding = await resolveToolToken(match[1]);
  if (!binding) return NextResponse.json({ ok: false, error: "Invalid or expired token" }, { status: 401 });
  if (!binding.threadId) return NextResponse.json({ ok: false, error: "Token is not bound to a thread" }, { status: 400 });

  const blocked = await enforce(identifierFor(binding.userId, req), "toolCallback");
  if (blocked) return blocked;

  const body = (await req.json().catch(() => ({}))) as { tool?: unknown; detail?: unknown; steps?: unknown };
  const tool = typeof body.tool === "string" ? body.tool.slice(0, 80) : "";
  if (!tool) return NextResponse.json({ ok: false, error: "tool is required" }, { status: 400 });

  const pushed = await pushTurnProgress({
    userId: binding.userId,
    threadId: binding.threadId,
    tool,
    detail: typeof body.detail === "string" ? body.detail.slice(0, 200) : "",
    steps: typeof body.steps === "number" && Number.isFinite(body.steps) ? Math.max(0, Math.floor(body.steps)) : 0,
  });
  return NextResponse.json({ ok: true, pushed });
}
