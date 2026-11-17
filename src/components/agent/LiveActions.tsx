"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { formatToolName } from '@/lib/agent/tool-labels';
import type { ToolCallData } from '@/lib/agent/ui-types';
import { ChevronDown, ChevronRight, Loader2, Check } from 'lucide-react';

type Props = {
  actions: ToolCallData[];
  onClear?: () => void;
  className?: string;
};

export function LiveActions({ actions: allActions, onClear, className }: Props) {
  // endTurn is a control-flow signal the agent calls to mark "done", not a
  // user-visible action. Never render it — defends against any stray 'invoked'
  // endTurn entry (which would otherwise spin forever, since it's fire-and-forget).
  const actions = useMemo(() => allActions.filter((a) => a.toolName !== 'endTurn'), [allActions]);
  const fileActions = actions.filter((a) => Boolean(a.fileChange));
  const totals = useMemo(() => (
    fileActions.reduce(
      (acc, a) => {
        acc.files += 1;
        acc.additions += a.fileChange!.additions;
        acc.deletions += a.fileChange!.deletions;
        return acc;
      },
      { files: 0, additions: 0, deletions: 0 }
    )
  ), [fileActions]);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [actions.length]);

  if (!actions.length) return null;

  return (
    <div className={cn('rounded-lg border border-border bg-elevated p-2 space-y-1', className)}>
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-medium text-muted">Activity</span>
        <div className="flex items-center gap-2">
          {totals.files > 0 && (
            <span className="text-[11px] text-muted tabular-nums">
              {totals.files} file{totals.files !== 1 ? 's' : ''}
              <span className="text-success ml-1">+{totals.additions}</span>
              <span className="text-danger ml-1">-{totals.deletions}</span>
            </span>
          )}
          {onClear && (
            <button
              className="rounded-sm text-xs text-muted transition-colors hover:text-fg"
              onClick={onClear}
              type="button"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="modern-scrollbar max-h-28 overflow-auto pl-1 pr-1">
        {actions.map((a, i) => (
          <LiveActionStep key={a.toolCallId} action={a} isLast={i === actions.length - 1} />
        ))}
      </div>
    </div>
  );
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Plain-language kinds of shell command, matched on the first recognisable verb. */
const COMMAND_KINDS: Array<[RegExp, string]> = [
  [/\b(pnpm|npm|yarn|bun)\s+(install|add|i|ci)\b/, 'Install packages'],
  [/\b(pnpm|npm|yarn|bun)\s+(run\s+)?build\b|\b(vite|next)\s+build\b/, 'Build the project'],
  [/\b(pnpm|npm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|check)\b|\b(tsc|eslint|vitest|jest)\b/, 'Check the code'],
  [/\bnpx\s+convex\b|\bconvex\s+(dev|deploy)\b/, 'Update the backend'],
  [/^\s*git\b/, 'Use git'],
  [/^\s*(curl|wget)\b/, 'Fetch a URL'],
  [/^\s*(ls|cat|head|tail|find|grep|rg|wc|tree|stat|file|pwd)\b/, 'Inspect project files'],
  [/^\s*(mkdir|cp|mv|rm|touch|chmod)\b/, 'Organise files'],
  [/^\s*(python3?|node|tsx|deno|bash|sh)\b/, 'Run a script'],
];

function describeCommand(command: string): string | null {
  for (const [pattern, label] of COMMAND_KINDS) if (pattern.test(command)) return label;
  return null;
}

/**
 * How a step reads in the list. When the agent said what a command was for,
 * that sentence is the title; otherwise the title is the tool's name followed
 * by what it acted on (file, search, command). Nothing is cut here — the row
 * truncates visually and the expanded view shows everything.
 */
function actionSummary(action: ToolCallData): { title: string; detail: string | null; command: string | null } {
  const args = action.args ?? {};
  const command = str(args.command);
  const description = str(args.description);
  if (command && description) return { title: description, detail: null, command };
  // No description from the agent: say what kind of command it was in plain
  // words. The command itself is one click away in the expanded row.
  const kind = command ? describeCommand(command) : null;
  if (command && kind) return { title: kind, detail: null, command };
  let detail: string | null = command ? command.split('\n')[0] : null;
  for (const key of ['file_path', 'filePath', 'path', 'pattern', 'query', 'url']) {
    if (detail) break;
    detail = str(args[key]);
  }
  return { title: formatToolName(action.toolName), detail, command };
}

function LiveActionStep({ action, isLast }: { action: ToolCallData; isLast: boolean }) {
  const [open, setOpen] = useState(false);
  const isDone = action.status !== 'invoked';
  const isEdit = Boolean(action.fileChange);
  const summary = actionSummary(action);
  const detail = isEdit ? null : summary.detail;

  return (
    <div className="relative flex gap-2.5">
      {/* Vertical connector */}
      {!isLast && (
        <div className="absolute left-[7px] top-[18px] bottom-0 w-px bg-border" />
      )}

      {/* Step indicator */}
      {isDone ? (
        <div className="relative z-10 mt-[3px] flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] border-border bg-bg">
          <Check size={9} className="text-muted" />
        </div>
      ) : (
        <div className="relative z-10 mt-[3px] flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] border-border bg-bg">
          <Loader2 size={9} className="animate-spin text-muted" />
        </div>
      )}

      {/* Content */}
      <div className="flex-1 pb-2 min-w-0">
        <button
          type="button"
          className="flex w-full items-center gap-1.5 rounded-sm text-left text-xs transition-colors"
          onClick={() => setOpen(v => !v)}
        >
          <span className={cn('truncate text-[13px]', detail ? 'shrink-0' : 'min-w-0', isEdit && 'min-w-0 shrink font-mono text-xs', isDone ? 'text-muted' : 'text-fg')}>
            {isEdit ? action.fileChange!.filePath : summary.title}
          </span>
          {detail && (
            <code className="min-w-0 truncate font-mono text-xs text-subtle" title={detail}>
              {detail}
            </code>
          )}
          {isEdit && (
            <span className="shrink-0 text-[11px] tabular-nums">
              <span className="text-success">+{action.fileChange!.additions}</span>
              <span className="text-danger ml-0.5">-{action.fileChange!.deletions}</span>
            </span>
          )}
          {open ? <ChevronDown size={10} className="text-muted shrink-0 ml-auto" /> : <ChevronRight size={10} className="text-muted shrink-0 ml-auto" />}
        </button>
        {open && (
          <div className="mt-1.5">
            {isEdit ? (
              <FileChange before={action.fileChange!.before} after={action.fileChange!.after} />
            ) : (
              <>
                {summary.command && (
                  <pre className="mb-1 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-soft p-1.5 font-mono text-[11px] text-fg">
                    {summary.command}
                  </pre>
                )}
              <pre className="text-[11px] overflow-auto bg-soft p-1.5 rounded border border-border whitespace-pre-wrap break-words max-h-24">
                {action.resultPreview ?? ''}
              </pre>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function FileChange({ before, after }: { before: string; after: string }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <div>
        <div className="text-[11px] mb-1 text-muted">Before</div>
        <pre className="text-[11px] overflow-auto bg-soft p-1.5 rounded border border-border whitespace-pre max-h-24">{before}</pre>
      </div>
      <div>
        <div className="text-[11px] mb-1 text-muted">After</div>
        <pre className="text-[11px] overflow-auto bg-soft p-1.5 rounded border border-border whitespace-pre max-h-24">{after}</pre>
      </div>
    </div>
  );
}
