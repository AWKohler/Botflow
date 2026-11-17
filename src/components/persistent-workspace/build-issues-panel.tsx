"use client";

// Structured "Issues" view for iOS build output. Replaces the raw xcodebuild
// log dump on failure. Diagnostics arrive already-sanitized from the host
// (paths project-relative; no session ids, host UDIDs, /Users/<name>, etc.).
//
// Layout principles (see plan): severity-first, progressive disclosure, real
// selectable text, errors-first then warnings, file groups. Click a row to
// open the file at that line via `onOpenFile`. "Copy all" produces a
// plaintext digest.

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { SimBuildDiagnostic } from "./swift-stream-client";

interface BuildIssuesPanelProps {
  diagnostics: SimBuildDiagnostic[];
  /** Sanitized raw xcodebuild log. Behind an opt-in disclosure. */
  rawLog: { line: string; stream: "stdout" | "stderr" }[];
  /** True after the final xcresult-extracted set has replaced the live ones. */
  finalized: boolean;
  /** Last build state — drives fallback rendering on `failed` with zero diags. */
  buildState: "started" | "succeeded" | "failed" | null;
  failureMessage?: string;
  onOpenFile?: (path: string, line: number) => void;
  /** Toast helper. Wrap so the panel doesn't need to know the IDE's toast lib. */
  onCopied?: (count: number) => void;
}

interface FileGroup {
  file: string; // "" used for unattributed diagnostics
  errors: SimBuildDiagnostic[];
  warnings: SimBuildDiagnostic[];
}

function groupByFile(diags: SimBuildDiagnostic[]): FileGroup[] {
  const map = new Map<string, FileGroup>();
  for (const d of diags) {
    const key = d.file ?? "";
    let g = map.get(key);
    if (!g) {
      g = { file: key, errors: [], warnings: [] };
      map.set(key, g);
    }
    if (d.severity === "error") g.errors.push(d);
    else g.warnings.push(d);
  }
  // Files with errors first.
  return [...map.values()].sort((a, b) => {
    if ((b.errors.length > 0 ? 1 : 0) !== (a.errors.length > 0 ? 1 : 0)) {
      return (b.errors.length > 0 ? 1 : 0) - (a.errors.length > 0 ? 1 : 0);
    }
    return a.file.localeCompare(b.file);
  });
}

function digestForClipboard(diags: SimBuildDiagnostic[]): string {
  const ordered = [...diags].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
    return (a.file ?? "").localeCompare(b.file ?? "");
  });
  return ordered
    .map((d) => {
      const loc =
        d.file && d.line && d.column
          ? `${d.file}:${d.line}:${d.column}`
          : d.file ?? "<unknown>";
      return `${loc}: ${d.severity}: ${d.message}`;
    })
    .join("\n");
}

export function BuildIssuesPanel({
  diagnostics,
  rawLog,
  finalized,
  buildState,
  failureMessage,
  onOpenFile,
  onCopied,
}: BuildIssuesPanelProps) {
  const [rawOpen, setRawOpen] = useState(false);
  const [expandedSnippets, setExpandedSnippets] = useState<Set<string>>(new Set());
  const [warningsExpanded, setWarningsExpanded] = useState<Set<string>>(new Set());

  const groups = useMemo(() => groupByFile(diagnostics), [diagnostics]);
  const errorCount = diagnostics.filter((d) => d.severity === "error").length;
  const warningCount = diagnostics.filter((d) => d.severity === "warning").length;

  // Fallback: failed build with zero structured diagnostics (linker / codesign /
  // toolchain). Surface the sanitized raw log directly with a note.
  const showRawFallback =
    buildState === "failed" && finalized && diagnostics.length === 0;

  const handleCopyAll = async (): Promise<void> => {
    const text = digestForClipboard(diagnostics);
    try {
      await navigator.clipboard.writeText(text);
      onCopied?.(diagnostics.length);
    } catch {
      /* clipboard blocked — silent */
    }
  };

  const handleCopyRow = async (d: SimBuildDiagnostic): Promise<void> => {
    const loc =
      d.file && d.line && d.column ? `${d.file}:${d.line}:${d.column}` : d.file ?? "";
    try {
      await navigator.clipboard.writeText(`${loc}: ${d.severity}: ${d.message}`);
      onCopied?.(1);
    } catch {
      /* silent */
    }
  };

  const toggleSnippet = (key: string): void => {
    setExpandedSnippets((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleWarnings = (file: string): void => {
    setWarningsExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  };

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-elevated/80">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-3 py-2 text-xs">
        {errorCount > 0 && (
          <span className="flex items-center gap-1.5 text-danger">
            <span className="inline-block h-2 w-2 rounded-full bg-danger-solid" />
            {errorCount} {errorCount === 1 ? "error" : "errors"}
          </span>
        )}
        {warningCount > 0 && (
          <span className="flex items-center gap-1.5 text-warning">
            <AlertTriangle size={12} />
            {warningCount} {warningCount === 1 ? "warning" : "warnings"}
          </span>
        )}
        {errorCount === 0 && warningCount === 0 && !showRawFallback && (
          <span className="text-muted">
            {buildState === "started" ? "Building…" : "No issues"}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {diagnostics.length > 0 && (
            <button
              type="button"
              onClick={handleCopyAll}
              className="flex items-center gap-1 rounded-md border border-border bg-elevated px-2 py-1 text-[11px] text-muted hover:text-fg"
              title="Copy all issues as plaintext"
            >
              <Copy size={11} /> Copy all
            </button>
          )}
          {rawLog.length > 0 && (
            <button
              type="button"
              onClick={() => setRawOpen((v) => !v)}
              className="flex items-center gap-1 rounded-md border border-border bg-elevated px-2 py-1 text-[11px] text-muted hover:text-fg"
              title={rawOpen ? "Hide raw build log" : "Show raw build log"}
            >
              Raw log {rawOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="max-h-72 overflow-y-auto">
        {showRawFallback ? (
          <div className="px-3 py-2">
            <p className="mb-2 text-[11px] text-warning">
              {failureMessage ??
                "Build failed but no structured errors were extracted. Showing sanitized build log."}
            </p>
            <RawLogView lines={rawLog} />
          </div>
        ) : groups.length === 0 ? (
          <div className="px-3 py-3 text-center text-[11px] text-muted">
            {buildState === "started"
              ? "Waiting for issues…"
              : finalized
                ? "Build produced no issues."
                : "No issues yet."}
          </div>
        ) : (
          <ul className="divide-y divide-border/40">
            {groups.map((g) => (
              <li key={g.file || "_unattributed"}>
                <div className="bg-elevated/40 px-3 py-1.5 font-mono text-[11px] text-fg/70">
                  {g.file || "<no file>"}
                </div>
                {g.errors.map((d, i) => (
                  <DiagnosticRow
                    key={`e-${g.file}-${i}`}
                    diag={d}
                    rowKey={`e-${g.file}-${i}`}
                    snippetOpen={expandedSnippets.has(`e-${g.file}-${i}`)}
                    onToggleSnippet={() => toggleSnippet(`e-${g.file}-${i}`)}
                    onOpenFile={onOpenFile}
                    onCopyRow={handleCopyRow}
                  />
                ))}
                {g.warnings.length > 0 && (
                  <>
                    {/* If there are errors in this file, hide warnings behind a toggle. */}
                    {g.errors.length > 0 && !warningsExpanded.has(g.file) ? (
                      <button
                        type="button"
                        onClick={() => toggleWarnings(g.file)}
                        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] text-muted hover:bg-elevated/40"
                      >
                        <ChevronRight size={11} />
                        Show {g.warnings.length}{" "}
                        {g.warnings.length === 1 ? "warning" : "warnings"} in this file
                      </button>
                    ) : (
                      <>
                        {g.errors.length > 0 && (
                          <button
                            type="button"
                            onClick={() => toggleWarnings(g.file)}
                            className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-[11px] text-muted hover:bg-elevated/40"
                          >
                            <ChevronDown size={11} />
                            Hide warnings
                          </button>
                        )}
                        {g.warnings.map((d, i) => (
                          <DiagnosticRow
                            key={`w-${g.file}-${i}`}
                            diag={d}
                            rowKey={`w-${g.file}-${i}`}
                            snippetOpen={expandedSnippets.has(`w-${g.file}-${i}`)}
                            onToggleSnippet={() => toggleSnippet(`w-${g.file}-${i}`)}
                            onOpenFile={onOpenFile}
                            onCopyRow={handleCopyRow}
                          />
                        ))}
                      </>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        {/* Raw log disclosure */}
        {rawOpen && !showRawFallback && rawLog.length > 0 && (
          <div className="border-t border-border bg-elevated/40 px-3 py-2">
            <RawLogView lines={rawLog} />
          </div>
        )}
      </div>
    </div>
  );
}

function DiagnosticRow({
  diag,
  rowKey,
  snippetOpen,
  onToggleSnippet,
  onOpenFile,
  onCopyRow,
}: {
  diag: SimBuildDiagnostic;
  rowKey: string;
  snippetOpen: boolean;
  onToggleSnippet: () => void;
  onOpenFile?: (path: string, line: number) => void;
  onCopyRow: (d: SimBuildDiagnostic) => void;
}) {
  const isError = diag.severity === "error";
  const canJump = !!(onOpenFile && diag.file && diag.line);
  const hasSnippet = !!(diag.snippet && diag.snippet.length > 0);

  return (
    <div className="group px-3 py-1.5">
      <div className="flex items-start gap-2">
        {/* Severity icon */}
        <div className={cn("mt-[2px] shrink-0", isError ? "text-danger" : "text-warning")}>
          {isError ? <XCircle size={13} /> : <AlertTriangle size={13} />}
        </div>
        {/* Snippet toggle */}
        {hasSnippet && (
          <button
            type="button"
            onClick={onToggleSnippet}
            className="mt-[3px] shrink-0 text-muted hover:text-fg"
            title={snippetOpen ? "Hide source context" : "Show source context"}
          >
            {snippetOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
        )}
        {/* Locator + message */}
        <div className="min-w-0 flex-1 text-[11.5px] leading-snug">
          {diag.file && diag.line && (
            <button
              type="button"
              disabled={!canJump}
              onClick={() => canJump && onOpenFile?.(diag.file!, diag.line!)}
              className={cn(
                "mr-2 font-mono text-[11px]",
                canJump
                  ? "text-accent hover:underline"
                  : "cursor-default text-muted",
              )}
              title={canJump ? "Open in editor" : undefined}
            >
              :{diag.line}
              {diag.column ? `:${diag.column}` : ""}
            </button>
          )}
          <span className={cn("select-text", isError ? "text-fg" : "text-fg/85")}>
            {diag.message}
          </span>
        </div>
        {/* Per-row copy (hover) */}
        <button
          type="button"
          onClick={() => onCopyRow(diag)}
          className="invisible shrink-0 self-start text-muted hover:text-fg group-hover:visible"
          title="Copy this issue"
        >
          <Copy size={11} />
        </button>
      </div>
      {snippetOpen && diag.snippet && (
        <pre className="ml-7 mt-1 select-text whitespace-pre overflow-x-auto rounded-md bg-elevated/60 px-2 py-1 font-mono text-[11px] leading-tight text-fg/80">
          {diag.snippet.join("\n")}
        </pre>
      )}
      {/* If we can't jump but we have a file name (no line), still show it for context. */}
      {!diag.line && diag.file && (
        <div className="ml-7 mt-0.5 font-mono text-[11px] text-muted">{diag.file}</div>
      )}
      {/* Used for stable React keys; suppress unused. */}
      <span className="hidden">{rowKey}</span>
    </div>
  );
}

function RawLogView({
  lines,
}: {
  lines: { line: string; stream: "stdout" | "stderr" }[];
}) {
  return (
    <div className="max-h-48 overflow-y-auto font-mono text-[11px] leading-snug">
      {lines.length === 0 ? (
        <div className="text-muted">No build output yet.</div>
      ) : (
        lines.map((l, i) => (
          <div
            key={i}
            className={l.stream === "stderr" ? "text-danger" : "text-fg/80"}
          >
            {l.line}
          </div>
        ))
      )}
    </div>
  );
}
