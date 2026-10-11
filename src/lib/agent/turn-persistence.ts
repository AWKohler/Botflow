/**
 * Server-side persistence of in-sandbox agent turns.
 *
 * Threads keep running when nobody is watching them (the user switched to
 * another thread, or closed the tab), so the browser can't be the only thing
 * that saves the agent's reply. When a turn ends, the bridge calls
 * /api/internal/agent/turn-finished; that route reads the turn's NDJSON event
 * file from the sandbox and this module rebuilds the assistant message with
 * the SAME translator the live stream used, then upserts it.
 *
 * The message id is derived from the turn id, and every producer — the live
 * POST stream, a reattach replay, this module — uses it, so the browser's own
 * save and the server's save upsert one row instead of creating duplicates.
 */
import { createUIMessageStream, readUIMessageStream, type UIMessage } from "ai";
import { getDb } from "@/db";
import { chatMessages } from "@/db/schema";
import { createTranslator, type BridgeEvent } from "./claude-code/translator";
import { createOpenCodeTranslator, type OpenCodeBridgeEvent } from "./opencode/translator";

export function assistantMessageIdForTurn(turnId: string): string {
  return `turn-${turnId}`;
}

export interface AssembledTurn {
  message: UIMessage | null;
  sawEndTurn: boolean;
  /** Text of a bridge `error` event, if the turn ended in one. */
  errorText: string | null;
}

/** Rebuild a turn's assistant message from its raw NDJSON event lines. */
export async function assembleTurnMessage(
  ndjson: string,
  backend: "claude-code" | "opencode",
  turnId: string,
): Promise<AssembledTurn> {
  let sawEndTurn = false;
  let errorText: string | null = null;
  const messageId = assistantMessageIdForTurn(turnId);

  const stream = createUIMessageStream<UIMessage>({
    execute: ({ writer }) => {
      const translator =
        backend === "opencode"
          ? createOpenCodeTranslator(writer, { messageId })
          : createTranslator(writer, { messageId });
      try {
        for (const line of ndjson.split("\n")) {
          if (!line.trim()) continue;
          let event: BridgeEvent | OpenCodeBridgeEvent;
          try {
            event = JSON.parse(line) as BridgeEvent | OpenCodeBridgeEvent;
          } catch {
            continue; // torn final line on a killed bridge
          }
          (translator.push as (e: BridgeEvent | OpenCodeBridgeEvent) => void)(event);
          if (event.type === "end_turn") {
            sawEndTurn = true;
            break;
          }
          if (event.type === "error") {
            errorText = String((event as { error?: unknown }).error ?? "Agent error");
            break;
          }
        }
      } finally {
        translator.end();
      }
    },
  });

  let message: UIMessage | null = null;
  for await (const snapshot of readUIMessageStream<UIMessage>({ stream })) {
    message = snapshot;
  }
  return { message, sawEndTurn, errorText };
}

/** Upsert the assembled assistant message into the thread. */
export async function saveAssistantMessage(
  threadId: string,
  segmentId: string | null,
  message: UIMessage,
): Promise<void> {
  const content = { parts: message.parts };
  await getDb()
    .insert(chatMessages)
    .values({
      sessionId: threadId,
      messageId: message.id,
      role: "assistant",
      content,
      segmentId,
    })
    .onConflictDoUpdate({
      target: [chatMessages.sessionId, chatMessages.messageId],
      set: { content },
    });
}

/** Upsert the user message that started a turn, attributed to its author.
 *  The browser saves it too; same (thread, message id) row either way. */
export async function saveUserMessage(
  threadId: string,
  segmentId: string | null,
  message: UIMessage,
  userId: string,
): Promise<void> {
  const content = { parts: message.parts };
  await getDb()
    .insert(chatMessages)
    .values({
      sessionId: threadId,
      messageId: message.id,
      role: "user",
      content,
      segmentId,
      userId,
    })
    .onConflictDoUpdate({
      target: [chatMessages.sessionId, chatMessages.messageId],
      set: { content, userId },
    });
}
