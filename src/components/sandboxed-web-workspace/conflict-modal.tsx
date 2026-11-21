"use client";

/**
 * Conflict resolution modal for the sandboxed-web GitHub flow.
 *
 * Two modes share the same modal:
 *
 *   Default (non-developer view):
 *     • Per-file: Let assistant fix this / Use mine / Use GitHub's
 *     • Top-level: "Let assistant fix all" pre-populates the agent's input
 *     • Escape hatches: discard local (abort merge) and "Fix manually (advanced)"
 *
 *   Manual (advanced):
 *     • Three-pane editor: Remote | Local | Resolved (editable)
 *     • Per-file choices: Use Remote / Use Local / Custom edit
 *
 * The "Let assistant fix this" path dispatches a custom event that AgentPanel
 * listens for; AgentPanel pre-fills the chat input with a directed prompt
 * naming the file(s) and the gitResolveConflict tool. The user clicks send.
 */
import { useCallback, useMemo, useState } from "react";
import { useModal } from "@/components/ui/use-modal";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  Check,
  FileText,
  GitMerge,
  Loader2,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";

export interface ConflictBlob {
  marked: string;
  ours: string | null;
  theirs: string | null;
  base: string | null;
}

interface ConflictModalProps {
  projectId: string;
  branch: string;
  conflicts: string[];
  conflictBlobs: Record<string, ConflictBlob>;
  onClose: () => void;
  onResolved: () => void;
}

type ResolutionChoice =
  | { kind: "ours" }
  | { kind: "theirs" }
  | { kind: "agent"; pending: true }
  | { kind: "manual"; content: string };

type Mode = "default" | "manual";

// ── Top-level ─────────────────────────────────────────────────────────────

export function ConflictModal({
  projectId,
  branch,
  conflicts,
  conflictBlobs,
  onClose,
  onResolved,
}: ConflictModalProps) {
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>("default");
  const [choices, setChoices] = useState<Record<string, ResolutionChoice>>({});
  const [finalizing, setFinalizing] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [delegating, setDelegating] = useState(false);

  // Track which files have been claimed by the agent (so the user knows not
  // to act on them and the Complete Merge button doesn't require a fake
  // resolution). Cleared if the user manually picks something else.
  const agentClaimed = useMemo(
    () => Object.entries(choices).filter(([, c]) => c.kind === "agent").map(([p]) => p),
    [choices],
  );

  const allResolved = useMemo(() => {
    return conflicts.every((p) => {
      const c = choices[p];
      if (!c) return false;
      if (c.kind === "agent") return false; // Agent must finish first
      return true;
    });
  }, [conflicts, choices]);

  const setChoice = useCallback((path: string, choice: ResolutionChoice) => {
    setChoices((prev) => ({ ...prev, [path]: choice }));
  }, []);

  const askAgentForAll = useCallback(() => {
    setDelegating(true);
    // Mark all unresolved files as agent-claimed so the UI doesn't ask the
    // user to also pick a side. The agent will write to disk via
    // gitResolveConflict; the user finishes with Complete Merge once those
    // tool calls land.
    setChoices((prev) => {
      const next = { ...prev };
      for (const p of conflicts) {
        if (!next[p]) next[p] = { kind: "agent", pending: true };
      }
      return next;
    });
    // Dispatch an event AgentPanel listens for. The handler pre-fills the
    // chat input; the user reviews and sends.
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("github-conflict-delegate", {
          detail: {
            projectId,
            branch,
            paths: conflicts,
            // Pre-built prompt the AgentPanel can splice into the input.
            prompt: buildAgentPrompt(conflicts),
          },
        }),
      );
    }
    toast({
      title: "Sent to the assistant",
      description: "Review the prepared prompt in the chat and send it.",
    });
    setTimeout(() => setDelegating(false), 800);
  }, [branch, conflicts, projectId, toast]);

  const askAgentForFile = useCallback(
    (path: string) => {
      setChoice(path, { kind: "agent", pending: true });
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("github-conflict-delegate", {
            detail: {
              projectId,
              branch,
              paths: [path],
              prompt: buildAgentPrompt([path]),
            },
          }),
        );
      }
      toast({
        title: "Sent to the assistant",
        description: `Review the prompt about \`${path}\` and send it.`,
      });
    },
    [branch, projectId, setChoice, toast],
  );

  const completeMerge = useCallback(async () => {
    setFinalizing(true);
    try {
      const resolutions = conflicts
        .map((path) => {
          const c = choices[path];
          if (!c) return null;
          if (c.kind === "ours") return { path, side: "ours" as const };
          if (c.kind === "theirs") return { path, side: "theirs" as const };
          if (c.kind === "manual") return { path, content: c.content };
          return null; // agent kind — file already written by the tool
        })
        .filter((r): r is { path: string; side: "ours" | "theirs" } | { path: string; content: string } => r !== null);

      const res = await fetch(`/api/projects/${projectId}/github/sandbox/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resolutions,
          finalizeMessage: `Merge branch '${branch}' into ${branch}`,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      if (!data.finalized) {
        const remaining = (data.remainingConflicts as string[] | undefined) ?? [];
        toast({
          title: "Some files still have conflict markers",
          description: remaining.length > 0
            ? `Remaining: ${remaining.join(", ")}`
            : "Resolve the rest before completing the merge.",
        });
        // Drop the agent-claim on any path that's still conflicted so the
        // user can act on it directly.
        setChoices((prev) => {
          const next = { ...prev };
          for (const p of remaining) {
            if (next[p]?.kind === "agent") delete next[p];
          }
          return next;
        });
        return;
      }
      toast({ title: "Merge complete", description: "You can push now." });
      onResolved();
      onClose();
    } catch (e) {
      toast({ title: "Resolve failed", description: e instanceof Error ? e.message : String(e) });
    } finally {
      setFinalizing(false);
    }
  }, [branch, choices, conflicts, onClose, onResolved, projectId, toast]);

  const discardLocalChanges = useCallback(async () => {
    if (!confirm("This discards all your local changes and uses GitHub's version of every file. Continue?")) return;
    setAborting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/github/sandbox/abort-merge`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      toast({ title: "Merge aborted", description: "Local changes restored to pre-pull state." });
      onResolved();
      onClose();
    } catch (e) {
      toast({ title: "Abort failed", description: e instanceof Error ? e.message : String(e) });
    } finally {
      setAborting(false);
    }
  }, [onClose, onResolved, projectId, toast]);

  // No Escape-to-close here: closing by accident would throw away choices.
  const modalRef = useModal<HTMLDivElement>(true);

  const modal = (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black/40 backdrop-blur-[2px]">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Resolve changes from GitHub"
        tabIndex={-1}
        className={cn(
          "rounded-2xl border border-border bg-bg shadow-2xl overflow-hidden flex flex-col outline-none",
          mode === "manual" ? "w-[92vw] max-w-5xl h-[85vh]" : "w-full max-w-xl max-h-[80vh]",
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2.5">
            <GitMerge size={16} className="text-accent" />
            <div>
              <h2 className="text-sm font-medium text-fg">
                {mode === "default"
                  ? "Some files were also changed on GitHub."
                  : "Resolve conflicts (advanced)"}
              </h2>
              <p className="text-[11px] text-muted mt-0.5">
                {mode === "default"
                  ? "Pick how to handle each one, then complete the merge."
                  : `Editing ${conflicts.length} file${conflicts.length === 1 ? "" : "s"} on branch ${branch}.`}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted hover:text-fg"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        {mode === "default" ? (
          <DefaultModeBody
            conflicts={conflicts}
            conflictBlobs={conflictBlobs}
            choices={choices}
            setChoice={setChoice}
            askAgentForFile={askAgentForFile}
          />
        ) : (
          <ManualModeBody
            conflicts={conflicts}
            conflictBlobs={conflictBlobs}
            choices={choices}
            setChoice={setChoice}
          />
        )}

        {/* Footer */}
        <div className="border-t border-border p-3 space-y-2 shrink-0">
          {/* Banner when the agent has claimed some files. */}
          {agentClaimed.length > 0 && (
            <div className="rounded-md bg-accent/10 border border-accent/30 px-2.5 py-2 text-[11px] text-fg">
              The assistant is working on{" "}
              {agentClaimed.length === 1
                ? <code className="font-mono">{agentClaimed[0]}</code>
                : `${agentClaimed.length} file${agentClaimed.length === 1 ? "" : "s"}`}
              . Send the prompt in chat; once it finishes resolving, click Complete merge here.
            </div>
          )}

          <div className="flex items-center gap-2">
            {mode === "default" && (
              <Button
                onClick={askAgentForAll}
                disabled={delegating || finalizing || agentClaimed.length === conflicts.length}
                size="sm"
                className="flex-1"
                variant={agentClaimed.length > 0 ? "outline" : "default"}
              >
                <Sparkles size={11} className="mr-1.5" />
                Let assistant fix all
              </Button>
            )}
            <Button
              onClick={completeMerge}
              disabled={!allResolved || finalizing}
              size="sm"
              className={mode === "default" ? "flex-1" : "min-w-[140px]"}
            >
              {finalizing ? <Loader2 size={12} className="animate-spin" /> : "Complete merge"}
            </Button>
            <Button onClick={onClose} variant="ghost" size="sm" disabled={finalizing}>
              Cancel
            </Button>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <button
              type="button"
              onClick={() => setMode(mode === "default" ? "manual" : "default")}
              className="text-muted hover:text-fg"
            >
              {mode === "default" ? "Fix manually (advanced)" : "Back to simple view"}
            </button>
            <button
              type="button"
              onClick={discardLocalChanges}
              disabled={aborting}
              className="text-muted hover:text-danger"
            >
              {aborting ? "Aborting…" : "Discard my changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(modal, document.body);
}

// ── Default-mode body ─────────────────────────────────────────────────────

function DefaultModeBody({
  conflicts,
  conflictBlobs,
  choices,
  setChoice,
  askAgentForFile,
}: {
  conflicts: string[];
  conflictBlobs: Record<string, ConflictBlob>;
  choices: Record<string, ResolutionChoice>;
  setChoice: (path: string, c: ResolutionChoice) => void;
  askAgentForFile: (path: string) => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto modern-scrollbar p-3 space-y-2">
      {conflicts.map((path) => (
        <ConflictFileCard
          key={path}
          path={path}
          blob={conflictBlobs[path]}
          choice={choices[path] ?? null}
          onChoose={(c) => setChoice(path, c)}
          onAskAgent={() => askAgentForFile(path)}
        />
      ))}
    </div>
  );
}

function ConflictFileCard({
  path,
  blob,
  choice,
  onChoose,
  onAskAgent,
}: {
  path: string;
  blob: ConflictBlob | undefined;
  choice: ResolutionChoice | null;
  onChoose: (c: ResolutionChoice) => void;
  onAskAgent: () => void;
}) {
  const previewLines = blob?.marked.split("\n").slice(0, 8).join("\n");

  return (
    <div className="rounded-lg border border-border bg-elevated p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-xs text-fg truncate">{path}</div>
        {choice && (
          <span className="inline-flex items-center gap-1 text-[11px] text-accent">
            <Check size={10} />
            {labelForChoice(choice)}
          </span>
        )}
      </div>

      {previewLines && (
        <pre className="mt-2 text-[11px] text-muted bg-surface border border-border rounded p-2 max-h-24 overflow-hidden whitespace-pre-wrap">
          {previewLines}
          {(blob?.marked.split("\n").length ?? 0) > 8 ? "\n…" : ""}
        </pre>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant={choice?.kind === "agent" ? "default" : "outline"}
          onClick={onAskAgent}
          disabled={choice?.kind === "agent"}
        >
          <Sparkles size={11} className="mr-1" />
          {choice?.kind === "agent" ? "Assistant working…" : "Let assistant fix this"}
        </Button>
        <Button
          size="sm"
          variant={choice?.kind === "ours" ? "default" : "outline"}
          onClick={() => onChoose({ kind: "ours" })}
        >
          Use mine
        </Button>
        <Button
          size="sm"
          variant={choice?.kind === "theirs" ? "default" : "outline"}
          onClick={() => onChoose({ kind: "theirs" })}
        >
          Use GitHub&apos;s
        </Button>
      </div>
    </div>
  );
}

// ── Manual-mode body (three-pane editor) ──────────────────────────────────

function ManualModeBody({
  conflicts,
  conflictBlobs,
  choices,
  setChoice,
}: {
  conflicts: string[];
  conflictBlobs: Record<string, ConflictBlob>;
  choices: Record<string, ResolutionChoice>;
  setChoice: (path: string, c: ResolutionChoice) => void;
}) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const path = conflicts[selectedIdx];
  const blob = conflictBlobs[path];
  const choice = choices[path];

  // Local custom-content draft for whichever file is selected.
  const [draftByPath, setDraftByPath] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const p of conflicts) {
      const c = choices[p];
      if (c?.kind === "manual") init[p] = c.content;
      else init[p] = conflictBlobs[p]?.marked ?? "";
    }
    return init;
  });

  const setDraft = (next: string) => {
    setDraftByPath((prev) => ({ ...prev, [path]: next }));
    // Manual draft replaces any other choice.
    setChoice(path, { kind: "manual", content: next });
  };

  return (
    <div className="flex flex-1 min-h-0">
      {/* File sidebar */}
      <div className="w-56 border-r border-border flex flex-col shrink-0 overflow-y-auto modern-scrollbar">
        <div className="px-3 py-2 text-[11px] font-medium text-muted uppercase tracking-wider border-b border-border/60">
          Conflicted files
        </div>
        {conflicts.map((p, i) => {
          const c = choices[p];
          const resolved =
            c?.kind === "ours" ||
            c?.kind === "theirs" ||
            (c?.kind === "manual" && c.content.trim().length > 0) ||
            c?.kind === "agent";
          return (
            <button
              key={p}
              type="button"
              onClick={() => setSelectedIdx(i)}
              className={cn(
                "flex items-start gap-2 px-3 py-2.5 text-left transition-colors border-b border-border/40",
                i === selectedIdx
                  ? "bg-accent/10 text-fg"
                  : "hover:bg-soft/40 text-muted hover:text-fg",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 w-3 h-3 rounded-full border shrink-0 flex items-center justify-center",
                  resolved
                    ? "border-success-border bg-success-soft"
                    : "border-warning-border bg-warning-soft",
                )}
              >
                {resolved && <Check size={7} className="text-success" />}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-xs font-medium truncate">
                  {filename(p)}
                </span>
                <span className="block text-[11px] opacity-60 truncate">
                  {dirname(p)}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {/* Right pane */}
      {blob ? (
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          {/* Path header */}
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/60 shrink-0 bg-elevated/30">
            <FileText size={12} className="text-muted" />
            <span className="text-xs text-muted font-mono truncate">{path}</span>
          </div>

          {/* Three-pane diff */}
          <div className="flex flex-1 min-h-0 border-b border-border/60">
            <DiffPane label="GitHub (theirs)" color="blue" content={blob.theirs} fallback="Not present remotely" />
            <DiffPane label="Mine (ours)" color="green" content={blob.ours} fallback="Not present locally" border />
          </div>

          {/* Resolution editor */}
          <div className="flex flex-col shrink-0" style={{ height: "35%" }}>
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/40 bg-elevated/30 shrink-0">
              <span className="text-[11px] font-medium text-muted uppercase tracking-wider">
                Resolved content
              </span>
              <div className="flex items-center gap-1 ml-auto">
                <button
                  type="button"
                  onClick={() => {
                    if (blob.theirs !== null) {
                      setDraftByPath((prev) => ({ ...prev, [path]: blob.theirs ?? "" }));
                    }
                    setChoice(path, { kind: "theirs" });
                  }}
                  className={cn(
                    "px-2 py-0.5 rounded text-[11px] font-medium transition-colors",
                    choice?.kind === "theirs"
                      ? "bg-info-soft text-info"
                      : "hover:bg-soft/60 text-muted",
                  )}
                >
                  Use GitHub&apos;s
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (blob.ours !== null) {
                      setDraftByPath((prev) => ({ ...prev, [path]: blob.ours ?? "" }));
                    }
                    setChoice(path, { kind: "ours" });
                  }}
                  className={cn(
                    "px-2 py-0.5 rounded text-[11px] font-medium transition-colors",
                    choice?.kind === "ours"
                      ? "bg-success-soft text-success"
                      : "hover:bg-soft/60 text-muted",
                  )}
                >
                  Use mine
                </button>
              </div>
            </div>
            <textarea
              className={cn(
                "flex-1 resize-none p-3 text-[11px] font-mono leading-relaxed",
                "bg-bg text-fg",
                "focus:outline-none focus:ring-1 focus:ring-accent/40 rounded-none",
                "modern-scrollbar",
              )}
              value={draftByPath[path] ?? ""}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              placeholder="Edit the merged content. Remove conflict markers."
            />
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">
          Select a file
        </div>
      )}
    </div>
  );
}

function DiffPane({
  label,
  color,
  content,
  fallback,
  border,
}: {
  label: string;
  color: "blue" | "green";
  content: string | null;
  fallback: string;
  border?: boolean;
}) {
  return (
    <div className={cn("flex-1 flex flex-col min-w-0", border && "border-r border-border/60")}>
      <div className={cn(
        "flex items-center gap-1.5 px-3 py-1.5 border-b border-border/40 shrink-0",
        color === "blue" ? "bg-info-soft" : "bg-success-soft",
      )}>
        <span className={cn(
          "w-2 h-2 rounded-full opacity-70",
          color === "blue" ? "bg-info-solid" : "bg-success-solid",
        )} />
        <span className={cn(
          "text-[11px] font-medium uppercase tracking-wider",
          color === "blue" ? "text-info" : "text-success",
        )}>
          {label}
        </span>
      </div>
      {content === null ? (
        <div className="flex items-center justify-center flex-1 text-xs text-muted opacity-60">
          {fallback}
        </div>
      ) : (
        <pre className="flex-1 overflow-auto p-3 text-[11px] font-mono leading-relaxed text-fg/80 modern-scrollbar whitespace-pre">
          {content}
        </pre>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function labelForChoice(c: ResolutionChoice): string {
  switch (c.kind) {
    case "ours":
      return "Using mine";
    case "theirs":
      return "Using GitHub's";
    case "agent":
      return "Assistant working";
    case "manual":
      return "Manually edited";
  }
}

function filename(path: string) {
  return path.split("/").pop() ?? path;
}

function dirname(path: string) {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/") || "/";
}

function buildAgentPrompt(paths: string[]): string {
  if (paths.length === 1) {
    return [
      `Please resolve the merge conflict in \`${paths[0]}\`. Use the gitResolveConflict tool — read both sides (run gitDiff if you need them) and write a merged version that preserves both intents using \`content\`, OR pick one side with \`side: "ours"\` or \`side: "theirs"\` if combining doesn't make sense. After resolving, summarize what you did in one sentence.`,
    ].join(" ");
  }
  return [
    `Please resolve the merge conflicts in these files:`,
    ...paths.map((p) => `  - \`${p}\``),
    "",
    "For each file, call gitResolveConflict with a thoughtful merge: prefer combining both sides via `content` when both intents matter; pick `side: \"ours\"` or `side: \"theirs\"` only when one clearly supersedes the other. Don't call gitCommit — the user will finalize the merge from the panel.",
  ].join("\n");
}
