/**
 * Translator: NDJSON events from the OpenCode bridge → AI SDK UIMessageChunk
 * stream, written to a `UIMessageStreamWriter`.
 *
 * Mirrors the Claude Code translator's interface and stream discipline
 * (src/lib/agent/claude-code/translator.ts): single start/start-step on first
 * event, GUARDED single finish (a duplicate `finish` chunk makes useChat
 * split the assistant turn into multiple bubbles), and a synthetic `endTurn`
 * tool call on turn completion so AgentPanel's end-of-turn detection fires
 * identically for every backend.
 *
 * OpenCode specifics (event shapes verified against 1.17.13 — see
 * docs/features/opencode-agent.md):
 *  - Text/reasoning stream via `message.part.updated` carrying the part's
 *    ACCUMULATED text (+ an optional `delta`). We prefix-diff against what
 *    we've already emitted so either delivery shape produces clean deltas.
 *  - The user's own prompt echoes back as a text part too — parts are
 *    filtered by their parent message's role (tracked from `message.updated`).
 *  - Tool parts carry { callID, tool, state.status: pending|running|
 *    completed|error }. MCP platform tools arrive as `botflow_<name>` and are
 *    stripped back to the short names the UI already renders for the CC path.
 */
import type { UIMessageChunk, UIMessageStreamWriter } from "ai";

/* ----------------------------- bridge events ----------------------------- */

export interface OpenCodeUsageBreakdown {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

export type OpenCodeBridgeEvent =
  | { type: "ready" }
  | { type: "session_started"; sessionId: string }
  | { type: "oc_event"; event: OpenCodeEvent }
  | {
      type: "usage";
      source: string;
      tokens: number;
      breakdown: OpenCodeUsageBreakdown;
      cost?: number;
    }
  | { type: "compact_boundary"; trigger: "manual" | "auto"; preTokens: number }
  | { type: "end_turn"; aborted?: boolean }
  | { type: "error"; error: string };

/** Best-effort shapes for the opencode events we read. We model only the
 *  fields we touch (same approach as the CC translator's SDKMessage). */
interface OpenCodeEvent {
  type?: string;
  properties?: {
    part?: OpenCodePart;
    delta?: string;
    info?: { id?: string; role?: string; sessionID?: string };
    status?: { type?: string; message?: string; attempt?: number };
    [k: string]: unknown;
  };
}

interface OpenCodePart {
  id?: string;
  messageID?: string;
  type?: string; // "text" | "reasoning" | "tool" | "step-start" | ...
  text?: string;
  time?: { start?: number; end?: number };
  // tool parts:
  callID?: string;
  tool?: string;
  state?: {
    status?: "pending" | "running" | "completed" | "error";
    input?: unknown;
    output?: string;
    error?: string;
  };
}

/* --------------------------- name normalization --------------------------- */

/**
 * Strip our MCP server prefix so platform tools render under the same short
 * names the CC path uses (`botflow_convex_deploy` → `convex_deploy`).
 * opencode joins with `_` (verified in source at v1.17.13); the `.` variant
 * is accepted defensively. Native tools are already lowercase and pass
 * through unchanged.
 */
export function normalizeOpenCodeToolName(name: string): string {
  if (name.startsWith("botflow_")) return name.slice("botflow_".length);
  if (name.startsWith("botflow.")) return name.slice("botflow.".length);
  return name;
}

/* --------------------------- translator state --------------------------- */

interface StreamedTextState {
  /** Text we've already emitted for this part id. */
  emitted: string;
  closed: boolean;
}

interface State {
  writer: UIMessageStreamWriter;
  started: boolean;
  finished: boolean;
  /** message id → role, from message.updated — parts carry no role. */
  messageRoleById: Map<string, string>;
  textParts: Map<string, StreamedTextState>;
  reasoningParts: Map<string, StreamedTextState>;
  /** tool callID → how far the lifecycle has been emitted. */
  toolPhase: Map<string, "input-start" | "input-available" | "closed">;
}

export function createOpenCodeTranslator(writer: UIMessageStreamWriter): {
  push: (event: OpenCodeBridgeEvent) => void;
  end: () => void;
} {
  const state: State = {
    writer,
    started: false,
    finished: false,
    messageRoleById: new Map(),
    textParts: new Map(),
    reasoningParts: new Map(),
    toolPhase: new Map(),
  };

  function emit(chunk: UIMessageChunk) {
    state.writer.write(chunk);
  }

  function ensureStarted() {
    if (state.started) return;
    state.started = true;
    emit({ type: "start" });
    emit({ type: "start-step" });
  }

  function emitFinish(reason: "stop" | "error") {
    if (state.finished) return;
    state.finished = true;
    emit({ type: "finish-step" });
    emit({ type: "finish", finishReason: reason });
  }

  /** Emit the accumulated-vs-emitted diff for a text-ish part. Handles both
   *  delivery shapes: full accumulated text on the part, or an explicit
   *  delta on the event (already folded into part.text by opencode, so the
   *  prefix diff alone is correct — the delta parameter is only a fallback
   *  for a hypothetical part.text-less delivery). */
  function streamTextLike(
    map: Map<string, StreamedTextState>,
    part: OpenCodePart,
    delta: string | undefined,
    kind: "text" | "reasoning",
  ) {
    const id = part.id;
    if (!id) return;
    let entry = map.get(id);
    if (!entry) {
      entry = { emitted: "", closed: false };
      map.set(id, entry);
      emit(
        kind === "text"
          ? { type: "text-start", id }
          : { type: "reasoning-start", id },
      );
    }
    if (entry.closed) return;

    const full = typeof part.text === "string" ? part.text : undefined;
    let toEmit = "";
    if (full !== undefined) {
      if (full.startsWith(entry.emitted)) {
        toEmit = full.slice(entry.emitted.length);
      } else {
        // The part text diverged from what we emitted (revert/rewrite) —
        // emit the whole new text; the UI part id keeps it in one block.
        toEmit = full;
      }
      entry.emitted = full;
    } else if (delta) {
      toEmit = delta;
      entry.emitted += delta;
    }
    if (toEmit) {
      emit(
        kind === "text"
          ? { type: "text-delta", id, delta: toEmit }
          : { type: "reasoning-delta", id, delta: toEmit },
      );
    }
    if (part.time?.end) {
      entry.closed = true;
      emit(kind === "text" ? { type: "text-end", id } : { type: "reasoning-end", id });
    }
  }

  function handleToolPart(part: OpenCodePart) {
    const toolCallId = part.callID;
    const status = part.state?.status;
    if (!toolCallId || !status) return;
    const toolName = normalizeOpenCodeToolName(part.tool ?? "tool");
    const phase = state.toolPhase.get(toolCallId);
    if (phase === "closed") return;

    if (!phase) {
      emit({ type: "tool-input-start", toolCallId, toolName });
      state.toolPhase.set(toolCallId, "input-start");
    }
    if (status === "pending") return;

    if (state.toolPhase.get(toolCallId) === "input-start") {
      emit({
        type: "tool-input-available",
        toolCallId,
        toolName,
        input: part.state?.input ?? {},
      });
      state.toolPhase.set(toolCallId, "input-available");
    }
    if (status === "running") return;

    if (status === "completed") {
      emit({
        type: "tool-output-available",
        toolCallId,
        output: part.state?.output ?? "",
      });
      state.toolPhase.set(toolCallId, "closed");
    } else if (status === "error") {
      emit({
        type: "tool-output-error",
        toolCallId,
        errorText: part.state?.error ?? "Tool failed",
      });
      state.toolPhase.set(toolCallId, "closed");
    }
  }

  function handleOcEvent(event: OpenCodeEvent) {
    const t = event.type;
    const p = event.properties ?? {};

    if (t === "message.updated") {
      const info = p.info;
      if (info?.id && typeof info.role === "string") {
        state.messageRoleById.set(info.id, info.role);
      }
      return;
    }

    if (t === "message.part.updated") {
      const part = p.part;
      if (!part) return;
      // The user's prompt echoes back as parts too — only assistant-message
      // parts belong in the assistant stream. message.updated always precedes
      // its parts, so an unknown message id is treated as not-assistant.
      const role = part.messageID ? state.messageRoleById.get(part.messageID) : undefined;
      if (role !== "assistant") return;

      if (part.type === "text") {
        streamTextLike(state.textParts, part, p.delta, "text");
      } else if (part.type === "reasoning") {
        streamTextLike(state.reasoningParts, part, p.delta, "reasoning");
      } else if (part.type === "tool") {
        handleToolPart(part);
      }
      // step-start / step-finish / snapshot / file → nothing to render.
      return;
    }

    if (t === "session.status") {
      const status = p.status;
      if (status?.type === "retry") {
        emit({
          type: "data-opencode-status",
          data: {
            status: "retrying",
            ...(status.message ? { message: String(status.message) } : {}),
          },
          transient: true,
        } as unknown as UIMessageChunk);
      }
      return;
    }

    // session.updated / session.diff / session.idle / session.error /
    // permission.* are bridge- or route-level concerns — nothing to render.
  }

  function push(event: OpenCodeBridgeEvent) {
    ensureStarted();
    switch (event.type) {
      case "oc_event":
        if (event.event) handleOcEvent(event.event);
        break;
      case "usage":
        // Same consumer as the CC path's usage part: the context-usage bar.
        emit({
          type: "data-opencode-usage",
          data: {
            source: event.source,
            tokens: event.tokens,
            breakdown: event.breakdown,
            ...(typeof event.cost === "number" ? { cost: event.cost } : {}),
          },
          transient: true,
        } as unknown as UIMessageChunk);
        break;
      case "compact_boundary":
        emit({
          type: "data-opencode-compact-boundary",
          data: {
            trigger: event.trigger,
            preTokens: event.preTokens,
            at: Date.now(),
          },
          transient: true,
        } as unknown as UIMessageChunk);
        break;
      case "end_turn":
        // On a user abort there's no completed turn to mark — skip the
        // endTurn synthesis (in-sandbox turns are never auto-resubmitted, so
        // nothing loops) but still close the stream cleanly.
        if (!event.aborted) {
          emit({
            type: "tool-input-available",
            toolCallId: "opencode-end-turn",
            toolName: "endTurn",
            input: { summary: "Done." },
          });
          emit({
            type: "tool-output-available",
            toolCallId: "opencode-end-turn",
            output: "Done.",
          });
        }
        emitFinish("stop");
        break;
      case "error":
        emit({ type: "error", errorText: event.error });
        emitFinish("error");
        break;
      case "ready":
      case "session_started":
        // session_started is captured by the route; nothing to render.
        break;
    }
  }

  function end() {
    for (const [id, entry] of state.textParts) {
      if (!entry.closed) {
        try { emit({ type: "text-end", id }); } catch { /* ignore */ }
      }
    }
    for (const [id, entry] of state.reasoningParts) {
      if (!entry.closed) {
        try { emit({ type: "reasoning-end", id }); } catch { /* ignore */ }
      }
    }
    state.textParts.clear();
    state.reasoningParts.clear();
    state.toolPhase.clear();
    if (state.started) {
      try { emitFinish("stop"); } catch { /* ignore */ }
    }
  }

  return { push, end };
}
