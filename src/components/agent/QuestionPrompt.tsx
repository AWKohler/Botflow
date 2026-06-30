"use client";

/**
 * Inline in-chat question UI surfaced by the agent's `askQuestion` tool.
 * Renders inside the assistant's message timeline (NOT a modal). Replaces
 * the default ToolStep when the tool's state is `input-available` (still
 * waiting on the user) and collapses to a one-line summary once answered.
 *
 * Skinned for the project's tan/sand design tokens: bg-surface / bg-elevated /
 * bg-accent / border-border / text-fg / text-muted. No `dark:` variants —
 * the CSS variables already flip with the theme.
 *
 * Reused by:
 *   • Botflow agent (Vercel AI SDK) — resolved via AgentPanel.onToolCall →
 *     addToolOutput.
 *   • Claude Code agent — answer is POSTed to
 *     /api/projects/:id/chat/questions/answer; the bridge's blocking poll
 *     unblocks and returns the structured answer to Claude.
 */
import { Input } from "@/components/ui/input";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

const QUESTION_CUSTOM_ID = "__custom__";

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface QuestionConfig {
  id: string;
  header?: string;
  question: string;
  options: QuestionOption[];
  multiSelect?: boolean;
  allowCustom?: boolean;
  customPlaceholder?: string;
}

export interface QuestionAnswerPayload {
  kind: "single" | "multi" | "skip";
  selectedIds?: string[];
  text?: string;
}

interface QuestionPromptProps {
  questions: QuestionConfig[];
  /** Active question index (1-based). Defaults to 1. */
  questionIndex?: number;
  /** When set, renders the collapsed summary instead of the input form. */
  output?: QuestionAnswerPayload;
  /** Called with the answer when the user submits a question. */
  onSubmit: (answer: QuestionAnswerPayload) => void;
  /** Optional cancel/skip callback. When omitted, the skip button is hidden. */
  onSkip?: () => void;
  /** Disables interaction (e.g. tool already resolved). */
  disabled?: boolean;
  className?: string;
}

function optionBadge(idx: number) {
  return String.fromCharCode(65 + idx);
}

export function QuestionPrompt({
  questions,
  questionIndex = 1,
  output,
  onSubmit,
  onSkip,
  disabled = false,
  className,
}: QuestionPromptProps) {
  const total = Array.isArray(questions) ? questions.length : 0;
  const clampedIndex = Math.max(1, Math.min(questionIndex, Math.max(total, 1)));
  const active = total > 0 ? questions[clampedIndex - 1] : undefined;
  // Defend against partial / malformed input: during `input-streaming` the
  // tool's args arrive piece-by-piece and `options` may be missing or not yet
  // an array. Treating `options` as the canonical "is this question ready?"
  // signal lets the UI render a tiny placeholder until it is.
  const options = Array.isArray(active?.options) ? active!.options : null;

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [customText, setCustomText] = useState("");

  // Reset state when the question changes.
  useEffect(() => {
    setSelectedIds([]);
    setCustomText("");
  }, [active?.id]);

  const customEnabled = active?.allowCustom ?? false;

  const canSubmit = useMemo(() => {
    if (!active || !options) return false;
    const nonCustom = selectedIds.filter((id) => id !== QUESTION_CUSTOM_ID).length;
    const hasCustomText = customText.trim().length > 0;
    const total = nonCustom + (hasCustomText ? 1 : 0);
    if (active.multiSelect) return total >= 1;
    return total === 1;
  }, [active, options, selectedIds, customText]);

  // ── Collapsed summary mode ────────────────────────────────────────────
  if (output) {
    return <CollapsedSummary questions={questions} output={output} className={className} />;
  }

  if (!active || !options) {
    // Partial / streaming state. Render a minimal placeholder so the agent
    // panel doesn't crash mid-stream.
    return (
      <div className={cn("rounded-xl border border-border bg-elevated/60 px-3 py-2 text-[11px] text-muted", className)}>
        Preparing question…
      </div>
    );
  }

  const toggleMulti = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handlePick = (id: string) => {
    if (disabled) return;
    if (active.multiSelect) {
      toggleMulti(id);
    } else {
      setSelectedIds([id]);
      if (customEnabled) setCustomText("");
    }
  };

  const handleCustomChange = (next: string) => {
    if (disabled) return;
    setCustomText(next);
    if (!active.multiSelect) {
      setSelectedIds(next.trim().length > 0 ? [QUESTION_CUSTOM_ID] : []);
    } else {
      setSelectedIds((prev) => {
        const has = prev.includes(QUESTION_CUSTOM_ID);
        if (next.trim().length > 0 && !has) return [...prev, QUESTION_CUSTOM_ID];
        if (next.trim().length === 0 && has) return prev.filter((id) => id !== QUESTION_CUSTOM_ID);
        return prev;
      });
    }
  };

  const handleSubmit = () => {
    if (!canSubmit || disabled) return;
    const nonCustom = selectedIds.filter((id) => id !== QUESTION_CUSTOM_ID);
    const answerText = customText.trim() || undefined;
    onSubmit({
      kind: active.multiSelect ? "multi" : "single",
      selectedIds: nonCustom,
      ...(answerText ? { text: answerText } : {}),
    });
  };

  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-elevated overflow-hidden",
        className,
      )}
    >
      {/* Title row */}
      <div className="px-3 pt-2.5 pb-2 space-y-0.5">
        {active.header && (
          <div className="text-[10px] uppercase tracking-wider text-muted">
            {active.header}
          </div>
        )}
        <div className="text-sm text-fg">{active.question}</div>
        {total > 1 && (
          <div className="text-[10px] text-muted">
            Question {clampedIndex} of {total}
          </div>
        )}
      </div>

      {/* Options */}
      <div className="px-2 pb-2 space-y-px">
        {options.map((option, idx) => {
          const checked = selectedIds.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => handlePick(option.id)}
              disabled={disabled}
              className={cn(
                "w-full text-left rounded-md px-2 py-1.5 flex items-center gap-2",
                "hover:bg-surface transition-colors",
                disabled && "opacity-60 cursor-not-allowed",
              )}
            >
              <span
                className={cn(
                  "h-5 min-w-5 px-1 rounded-[4px] inline-flex items-center justify-center text-xs font-medium border",
                  checked
                    ? "bg-accent text-accent-foreground border-accent"
                    : "bg-transparent text-muted border-border",
                )}
              >
                {optionBadge(idx)}
              </span>
              <span className="text-sm text-fg">
                {option.label}
                {option.description && (
                  <span className="text-muted"> {option.description}</span>
                )}
              </span>
            </button>
          );
        })}

        {customEnabled && (
          <div className="flex items-center gap-2 pt-1 px-2 pb-1">
            <span
              className={cn(
                "h-5 min-w-5 px-1 rounded-[4px] inline-flex items-center justify-center text-xs font-medium border",
                selectedIds.includes(QUESTION_CUSTOM_ID)
                  ? "bg-accent text-accent-foreground border-accent"
                  : "bg-transparent text-muted border-border",
              )}
            >
              {optionBadge(options.length)}
            </span>
            <Input
              type="text"
              value={customText}
              onChange={(e) => handleCustomChange(e.target.value)}
              placeholder={active.customPlaceholder ?? "Type your answer"}
              disabled={disabled}
              className="flex-1 h-7 rounded-md border border-border bg-surface px-2 text-sm text-fg outline-none focus:border-accent disabled:opacity-50"
            />
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-1.5 px-3 pb-2 pt-1 border-t border-border">
        {onSkip && (
          <button
            type="button"
            onClick={onSkip}
            disabled={disabled}
            className="h-6 px-2 rounded-[4px] text-xs text-muted hover:text-fg hover:bg-surface disabled:opacity-50 transition-colors"
          >
            Skip
          </button>
        )}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit || disabled}
          className="h-6 px-2.5 rounded-[4px] text-xs font-medium bg-accent text-accent-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
        >
          {clampedIndex < total ? "Next" : "Send"}
        </button>
      </div>
    </div>
  );
}

// ── Collapsed summary (rendered when state === output-available) ──────────
function CollapsedSummary({
  questions,
  output,
  className,
}: {
  questions: QuestionConfig[];
  output: QuestionAnswerPayload;
  className?: string;
}) {
  // Build a human-readable summary
  const summary = useMemo(() => {
    if (output.kind === "skip") return "Skipped";
    const selectedLabels: string[] = [];
    for (const q of questions ?? []) {
      for (const opt of (q?.options ?? [])) {
        if (output.selectedIds?.includes(opt.id)) selectedLabels.push(opt.label);
      }
    }
    if (output.text) selectedLabels.push(`"${output.text}"`);
    return selectedLabels.length > 0 ? selectedLabels.join(", ") : "Answered";
  }, [questions, output]);

  return (
    <div
      className={cn(
        // Fully opaque bg so the timeline rail behind this card is masked.
        "rounded-xl border border-border bg-elevated px-3 py-1.5",
        className,
      )}
    >
      <div className="text-[11px] text-muted">Answered: {summary}</div>
    </div>
  );
}
