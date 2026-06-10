/**
 * Translator: NDJSON events from the bridge script → AI SDK UIMessageChunk
 * stream, written to a `UIMessageStreamWriter`.
 *
 * The bridge emits SDK messages from `@anthropic-ai/claude-agent-sdk` wrapped
 * in `{ type: "sdk_message", message }`. We unwrap and translate so the
 * existing AgentPanel — which expects AI SDK protocol — renders identically
 * to the regular /api/agent flow.
 *
 * Tool names are normalized to lowercase native ("Read" → "read", "Bash" →
 * "bash", etc.) per the design decision; this keeps the UI labels visually
 * consistent with the rest of the app.
 */
import type { UIMessageChunk, UIMessageStreamWriter } from "ai";

/* ----------------------------- bridge events ----------------------------- */

export type BridgeEvent =
  | { type: "ready" }
  | { type: "session_started"; sessionId: string }
  | { type: "sdk_message"; message: SDKMessage }
  | { type: "tool_request"; reqId: number; tool: string; input: unknown }
  | {
      type: "usage";
      source: "assistant" | "result";
      tokens: number;
      breakdown: {
        input: number;
        output: number;
        cacheCreate: number;
        cacheRead: number;
      };
    }
  | { type: "compact_boundary"; trigger: "manual" | "auto"; preTokens: number }
  | { type: "compacting" }
  | { type: "end_turn" }
  | { type: "error"; error: string };

/** A best-effort shape for `SDKMessage` from @anthropic-ai/claude-agent-sdk.
 *  We don't depend on the SDK directly in our Next.js bundle, so we model
 *  only the fields we actually read. */
interface SDKMessage {
  type?: string; // "assistant" | "user" | "result" | "system" | ...
  subtype?: string;
  session_id?: string;
  message?: {
    role?: "assistant" | "user";
    content?: ContentBlock[];
    id?: string;
  };
  /** Set on assistant/user messages produced INSIDE a Task subagent. Its value
   *  is the `tool_use` id of the originating Task call, so we can group a
   *  subagent's inner work under the parent Task step in the UI instead of
   *  flattening it into the main thread. `null`/absent on the main thread. */
  parent_tool_use_id?: string | null;
  // Result message:
  result?: string;
  is_error?: boolean;
  usage?: unknown;
}

/** One step inside a subagent's inner timeline, surfaced to the UI as part of
 *  the `data-claude-code-subagent` payload keyed by the parent Task tool id. */
export type SubagentStep =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      input: unknown;
      status: "running" | "done" | "error";
      output?: string;
    };

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: "thinking"; thinking: string }
  | { type: string; [k: string]: unknown }; // unknown future block types

/* ----------------------------- name normalization ----------------------------- */

/**
 * Map Claude Code's PascalCase tool names to lowercase. Anything we don't
 * recognize passes through unchanged (already lowercase, MCP tools, etc.).
 */
export function normalizeToolName(name: string): string {
  switch (name) {
    case "Read":
    case "Edit":
    case "Bash":
    case "Write":
    case "Grep":
    case "Glob":
    case "Task":
    case "WebFetch":
    case "WebSearch":
    case "MultiEdit":
    case "NotebookEdit":
    case "TodoWrite":
    case "BashOutput":
    case "KillShell":
      return name.toLowerCase();
    case "AskUserQuestion":
      // Claude Code's native question tool. The bridge answers it through the
      // same host ask_question flow as the MCP tool; renaming it here lets the
      // AgentPanel render the same QuestionPrompt card for both.
      return "ask_question";
    default:
      return name;
  }
}

/**
 * Convert Claude Code's native AskUserQuestion input — { questions: [{
 * question, header?, options: [{ label, description? }], multiSelect? }] } —
 * into the shared QuestionConfig shape the QuestionPrompt UI expects (ids on
 * questions and options). Ids must match the bridge script's conversion
 * ("q-{i}" / "opt-{i}-{j}") so the user's selectedIds line up with the row
 * the bridge created on the host.
 */
function convertNativeQuestionInput(input: unknown): unknown {
  const raw = (input as { questions?: unknown })?.questions;
  if (!Array.isArray(raw)) return input;
  return {
    questions: raw.map((q, qi) => {
      const qq = (q ?? {}) as {
        question?: unknown;
        header?: unknown;
        options?: unknown;
        multiSelect?: unknown;
      };
      return {
        id: `q-${qi}`,
        ...(qq.header ? { header: String(qq.header) } : {}),
        question: typeof qq.question === "string" ? qq.question : "",
        options: (Array.isArray(qq.options) ? qq.options : []).map((opt, oi) => {
          const oo = (opt ?? {}) as { label?: unknown; description?: unknown };
          return {
            id: `opt-${qi}-${oi}`,
            label: typeof oo.label === "string" ? oo.label : `Option ${oi + 1}`,
            ...(oo.description ? { description: String(oo.description) } : {}),
          };
        }),
        multiSelect: qq.multiSelect === true,
      };
    }),
  };
}

/* --------------------------- translator state --------------------------- */

interface State {
  writer: UIMessageStreamWriter;
  /** True after we've emitted the first `start` chunk. */
  started: boolean;
  /** True once a `finish` chunk has been emitted (via end_turn / error / end()).
   *  Used to suppress duplicate finishes — a second `finish` in the stream
   *  causes AI SDK's useChat to split the assistant turn into multiple
   *  bubbles, which is exactly the "three greetings to one hello" bug. */
  finished: boolean;
  /** Set of text content-block ids we've already opened. */
  openTextIds: Set<string>;
  /** Set of tool-call ids we've already opened. */
  openToolIds: Set<string>;
  /** Tool name (normalized) for each tool-call id, so we can emit it on close. */
  toolNamesById: Map<string, string>;
  /** Raw inputs for each tool-call id so we can include them on tool-input-available. */
  toolInputsById: Map<string, unknown>;
  /** Accumulated inner steps for each Task subagent, keyed by the parent Task
   *  tool-use id. Emitted as a single reconciled `data-claude-code-subagent`
   *  part per subagent so the UI can nest the work under its Task step. */
  subagents: Map<string, SubagentStep[]>;
}

export function createTranslator(writer: UIMessageStreamWriter): {
  push: (event: BridgeEvent) => void;
  end: () => void;
} {
  const state: State = {
    writer,
    started: false,
    finished: false,
    openTextIds: new Set(),
    openToolIds: new Set(),
    toolNamesById: new Map(),
    toolInputsById: new Map(),
    subagents: new Map(),
  };

  function emitFinish(reason: "stop" | "error") {
    if (state.finished) return;
    state.finished = true;
    emit({ type: "finish-step" });
    emit({ type: "finish", finishReason: reason });
  }

  function ensureStarted() {
    if (state.started) return;
    state.started = true;
    writer.write({ type: "start" });
    writer.write({ type: "start-step" });
  }

  function emit(chunk: UIMessageChunk) {
    writer.write(chunk);
  }

  function handleAssistant(message: SDKMessage["message"]) {
    const blocks = message?.content ?? [];
    for (const block of blocks) {
      if (block.type === "text") {
        const textBlock = block as { type: "text"; text: string };
        const id = `t-${state.openTextIds.size}-${Date.now()}`;
        state.openTextIds.add(id);
        emit({ type: "text-start", id });
        if (textBlock.text) {
          emit({ type: "text-delta", id, delta: textBlock.text });
        }
        emit({ type: "text-end", id });
        state.openTextIds.delete(id);
      } else if (block.type === "tool_use") {
        const toolBlock = block as {
          type: "tool_use";
          id: string;
          name: string;
          input: unknown;
        };
        const toolCallId = toolBlock.id;
        const toolName = normalizeToolName(toolBlock.name);
        const input =
          toolBlock.name === "AskUserQuestion"
            ? convertNativeQuestionInput(toolBlock.input)
            : toolBlock.input;
        state.openToolIds.add(toolCallId);
        state.toolNamesById.set(toolCallId, toolName);
        state.toolInputsById.set(toolCallId, input);

        emit({ type: "tool-input-start", toolCallId, toolName });
        emit({
          type: "tool-input-available",
          toolCallId,
          toolName,
          input: input ?? {},
        });
      } else if (block.type === "thinking") {
        // Thinking tokens — surface as reasoning so the UI can display them
        // if it wants. Our current AgentPanel doesn't render reasoning
        // separately, so this is a no-op for now but future-proof.
        const id = `r-${Date.now()}`;
        const thinkingBlock = block as { type: "thinking"; thinking: string };
        emit({ type: "reasoning-start", id });
        if (thinkingBlock.thinking) {
          emit({ type: "reasoning-delta", id, delta: thinkingBlock.thinking });
        }
        emit({ type: "reasoning-end", id });
      }
    }
  }

  function handleUserMessage(message: SDKMessage["message"]) {
    // The SDK echoes tool_result blocks as user messages. We translate each
    // into a tool-output-available chunk so the UI shows the result attached
    // to its originating tool call.
    const blocks = message?.content ?? [];
    for (const block of blocks) {
      if (block.type === "tool_result") {
        const trBlock = block as {
          type: "tool_result";
          tool_use_id: string;
          content: unknown;
          is_error?: boolean;
        };
        const toolCallId = trBlock.tool_use_id;
        if (trBlock.is_error) {
          const errorText = stringifyContent(trBlock.content);
          emit({ type: "tool-output-error", toolCallId, errorText });
        } else {
          emit({
            type: "tool-output-available",
            toolCallId,
            output: trBlock.content ?? "",
          });
        }
        state.openToolIds.delete(toolCallId);
      }
    }
  }

  /* ----------------------------- subagents ----------------------------- */

  /** Cap on per-step output/text so a chatty subagent can't bloat the
   *  persisted message payload. The full output still lives in the sandbox; the
   *  UI only needs a preview. */
  const SUBAGENT_TEXT_CAP = 2000;

  function emitSubagent(parentId: string) {
    emit({
      type: "data-claude-code-subagent",
      // Stable id → AI SDK reconciles each snapshot in place rather than
      // appending a new part per update. One part per subagent.
      id: parentId,
      data: {
        parentToolUseId: parentId,
        steps: state.subagents.get(parentId) ?? [],
      },
    } as unknown as UIMessageChunk);
  }

  /** Assistant message emitted from inside a Task subagent. We accumulate its
   *  text / thinking / tool_use blocks into the subagent's step list instead of
   *  writing them to the main stream (which would attribute the subagent's work
   *  to the top-level assistant). */
  function handleSubagentAssistant(parentId: string, message: SDKMessage["message"]) {
    const steps = state.subagents.get(parentId) ?? [];
    for (const block of message?.content ?? []) {
      if (block.type === "text") {
        const text = (block as { text: string }).text;
        if (text) steps.push({ kind: "text", text: text.slice(0, SUBAGENT_TEXT_CAP) });
      } else if (block.type === "thinking") {
        const text = (block as { thinking: string }).thinking;
        if (text) steps.push({ kind: "thinking", text: text.slice(0, SUBAGENT_TEXT_CAP) });
      } else if (block.type === "tool_use") {
        const tb = block as { id: string; name: string; input: unknown };
        steps.push({
          kind: "tool",
          toolCallId: tb.id,
          toolName: normalizeToolName(tb.name),
          input: tb.input ?? {},
          status: "running",
        });
      }
    }
    state.subagents.set(parentId, steps);
    emitSubagent(parentId);
  }

  /** Tool_result echoed back inside a subagent — match it to its in-flight tool
   *  step by tool_use_id and attach the output. */
  function handleSubagentUser(parentId: string, message: SDKMessage["message"]) {
    const steps = state.subagents.get(parentId);
    if (!steps) return;
    for (const block of message?.content ?? []) {
      if (block.type !== "tool_result") continue;
      const tr = block as { tool_use_id: string; content: unknown; is_error?: boolean };
      const step = steps.find(
        (s) => s.kind === "tool" && s.toolCallId === tr.tool_use_id,
      );
      if (step && step.kind === "tool") {
        step.output = stringifyContent(tr.content).slice(0, SUBAGENT_TEXT_CAP);
        step.status = tr.is_error ? "error" : "done";
      }
    }
    emitSubagent(parentId);
  }

  function push(event: BridgeEvent) {
    ensureStarted();
    switch (event.type) {
      case "session_started":
        // Stored by the route; not surfaced to the UI.
        break;
      case "sdk_message": {
        const m = event.message;
        if (!m) return;
        const t = m.type;
        // Messages tagged with parent_tool_use_id originate inside a Task
        // subagent — route them to the nested subagent timeline rather than the
        // main thread.
        const parentId =
          typeof m.parent_tool_use_id === "string" && m.parent_tool_use_id
            ? m.parent_tool_use_id
            : null;
        if (t === "assistant") {
          if (parentId) handleSubagentAssistant(parentId, m.message);
          else handleAssistant(m.message);
        } else if (t === "user") {
          if (parentId) handleSubagentUser(parentId, m.message);
          else handleUserMessage(m.message);
        } else if (t === "result") {
          // Final result — we'll emit finish on end_turn.
          if (m.is_error && m.result) {
            emit({ type: "error", errorText: m.result });
          }
        }
        // "system", "stream_event", etc. → ignored for now.
        break;
      }
      case "tool_request":
        // Host RPC — not surfaced to the UI directly. The route handles it
        // and the response flows back through SDK messages.
        break;
      case "usage":
        // Forward the SDK's real token usage as a custom data part. The
        // AgentPanel reads these to drive the context-usage bar; everything
        // else ignores them.
        emit({
          type: "data-claude-code-usage",
          data: {
            source: event.source,
            tokens: event.tokens,
            breakdown: event.breakdown,
          },
          transient: true,
        } as UIMessageChunk);
        break;
      case "compact_boundary":
        // Auto- or user-initiated compaction. The next assistant usage will
        // be much smaller; the UI marks the boundary and resets the bar.
        emit({
          type: "data-claude-code-compact-boundary",
          data: {
            trigger: event.trigger,
            preTokens: event.preTokens,
            at: Date.now(),
          },
          transient: true,
        } as UIMessageChunk);
        break;
      case "compacting":
        // Transient status — the UI can show a "compacting…" hint while it
        // happens. Optional; ignored if the UI doesn't render it.
        emit({
          type: "data-claude-code-status",
          data: { status: "compacting" },
          transient: true,
        } as UIMessageChunk);
        break;
      case "end_turn":
        // Synthesize an endTurn tool call so the existing UI's end-of-turn
        // detection (which looks for a tool named "endTurn") fires. We pass a
        // stable id so re-renders don't dup it.
        emit({
          type: "tool-input-available",
          toolCallId: "claude-code-end-turn",
          toolName: "endTurn",
          input: { summary: "Done." },
        });
        emit({
          type: "tool-output-available",
          toolCallId: "claude-code-end-turn",
          output: "Done.",
        });
        emitFinish("stop");
        break;
      case "error":
        emit({ type: "error", errorText: event.error });
        emitFinish("error");
        break;
      case "ready":
        break;
    }
  }

  function end() {
    // Close any still-open text/tool blocks so the client doesn't hang on
    // dangling streams.
    for (const id of state.openTextIds) {
      try { emit({ type: "text-end", id }); } catch { /* ignore */ }
    }
    state.openTextIds.clear();
    state.openToolIds.clear();
    if (state.started) {
      // Backstop finish — no-ops if end_turn / error already emitted one.
      // A duplicate `finish` chunk causes useChat to split the turn into
      // multiple bubbles, so we MUST guard against double-emitting it.
      try { emitFinish("stop"); } catch { /* ignore */ }
    }
  }

  return { push, end };
}

/** Best-effort string-form for tool result content (which can be string,
 *  array of blocks, or arbitrary JSON). */
function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && "text" in c) {
          return String((c as { text: unknown }).text);
        }
        return JSON.stringify(c);
      })
      .join("");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}
