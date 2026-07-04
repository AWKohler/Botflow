/**
 * GET /api/agent/claude-code/reattach?projectId=...
 *
 * Re-attach to the project's current Claude Code turn. The bridge runs
 * detached in the sandbox and tees every NDJSON event to a per-turn file, so
 * when the ORIGINAL streaming route dies at maxDuration (or the client's
 * connection drops) the turn keeps going — only the viewer's pipe broke.
 * This route replays that file from the beginning and keeps following it
 * while the bridge lives, translated into the same UIMessageStream the
 * original POST produced.
 *
 * The client (AgentPanel) calls this via useChat's resumeStream() after
 * dropping its partial assistant message, so the replay rebuilds the whole
 * turn's message in place — no auto-continue nudge, no second agent.
 *
 * Responses:
 *   204            — nothing to reattach to (no record, or the turn is dead)
 *   UIMessageStream — replay + live follow; ends when the bridge exits or
 *                     this route hits its own maxDuration (client re-calls)
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { getOrCreatePersistentSandbox } from "@/lib/vercel-sandbox";
import { createTranslator, type BridgeEvent } from "@/lib/agent/claude-code/translator";
import { buildTailTurnScript } from "@/lib/agent/claude-code/bridge-control";
import {
  getTurnRecord,
  markTurnDead,
  markTurnEnded,
} from "@/lib/agent/claude-code/turn-registry";
import { enforce, identifierFor } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const blocked = await enforce(identifierFor(userId, req), "pollHeavy");
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
  if (!record || record.dead) {
    // Nothing to resume — the AI SDK treats 204 as "no stream", and the
    // client falls back to its auto-continue path.
    return new Response(null, { status: 204 });
  }
  const { turnId, eventFile } = record;

  let sandbox: Awaited<ReturnType<typeof getOrCreatePersistentSandbox>>;
  try {
    sandbox = await getOrCreatePersistentSandbox(projectId);
  } catch {
    // Sandbox gone (expired/slept and failed to resume) → so is the bridge.
    await markTurnDead(projectId, turnId).catch(() => {});
    return new Response(null, { status: 204 });
  }

  // Replay-from-zero + follow. GNU `tail --pid` exits when the bridge does;
  // if the bridge is already gone this degrades to a one-shot cat.
  const cmd = await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", buildTailTurnScript(eventFile)],
  });

  const stream = createUIMessageStream<UIMessage>({
    execute: async ({ writer }) => {
      const translator = createTranslator(writer);
      let buffer = "";
      let sawEndTurn = false;

      try {
        for await (const log of cmd.logs()) {
          if (log.stream !== "stdout") continue;
          buffer += log.data;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line) continue;
            let event: BridgeEvent;
            try {
              event = JSON.parse(line) as BridgeEvent;
            } catch {
              // A torn final line (bridge killed mid-append) is expected on
              // crashed turns — skip silently rather than alarming the UI.
              continue;
            }
            translator.push(event);
            if (event.type === "end_turn") {
              sawEndTurn = true;
              break;
            }
            if (event.type === "error") {
              // Bridge exited with an error — the turn is over.
              break;
            }
          }
          if (sawEndTurn) break;
        }

        // The tail ended: either we saw a terminal event, or the bridge died
        // mid-turn (tail --pid exited without end_turn). Record which, so the
        // client's next recovery pass knows whether to reattach again or fall
        // back to an auto-continue. NOTE: this code simply never runs when
        // THIS route is the thing that died — that's the correct outcome (the
        // turn may still be alive; the record must stay reattachable).
        if (sawEndTurn) {
          await markTurnEnded(projectId, turnId).catch(() => {});
        } else {
          await markTurnDead(projectId, turnId).catch(() => {});
        }
      } finally {
        translator.end();
      }
    },
    onError: (err) => (err instanceof Error ? err.message : String(err)),
  });

  return createUIMessageStreamResponse({ stream });
}
