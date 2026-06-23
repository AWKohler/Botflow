"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
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
        <span className="text-xs font-medium text-muted">Live Actions</span>
        <div className="flex items-center gap-2">
          {totals.files > 0 && (
            <span className="text-[10px] text-muted tabular-nums">
              {totals.files} file{totals.files !== 1 ? 's' : ''}
              <span className="text-green-500 ml-1">+{totals.additions}</span>
              <span className="text-red-500 ml-1">-{totals.deletions}</span>
            </span>
          )}
          {onClear && (
            <button
              className="text-[10px] text-muted hover:text-fg transition"
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

function LiveActionStep({ action, isLast }: { action: ToolCallData; isLast: boolean }) {
  const [open, setOpen] = useState(false);
  const isDone = action.status !== 'invoked';
  const isEdit = Boolean(action.fileChange);

  return (
    <div className="relative flex gap-2.5">
      {/* Vertical connector */}
      {!isLast && (
        <div className="absolute left-[7px] top-[18px] bottom-0 w-px bg-border" />
      )}

      {/* Step indicator */}
      {isDone ? (
        <div className="relative z-10 flex shrink-0 items-center justify-center size-4 rounded-full bg-fg mt-[3px]">
          <Check size={9} className="text-bg" />
        </div>
      ) : (
        <div className="relative z-10 flex shrink-0 items-center justify-center size-4 rounded-full border-[1.5px] border-border bg-surface mt-[3px]">
          <Loader2 size={9} className="animate-spin text-accent" />
        </div>
      )}

      {/* Content */}
      <div className="flex-1 pb-2 min-w-0">
        <button
          type="button"
          className="flex items-center gap-1.5 text-xs hover:text-accent transition-colors w-full text-left"
          onClick={() => setOpen(v => !v)}
        >
          <span className={cn('font-medium truncate', isDone ? 'text-fg' : 'text-muted')}>
            {isEdit ? action.fileChange!.filePath : action.toolName}
          </span>
          {isEdit && (
            <span className="shrink-0 text-[10px] tabular-nums">
              <span className="text-green-500">+{action.fileChange!.additions}</span>
              <span className="text-red-500 ml-0.5">-{action.fileChange!.deletions}</span>
            </span>
          )}
          {open ? <ChevronDown size={10} className="text-muted shrink-0 ml-auto" /> : <ChevronRight size={10} className="text-muted shrink-0 ml-auto" />}
        </button>
        {open && (
          <div className="mt-1.5">
            {isEdit ? (
              <FileChange before={action.fileChange!.before} after={action.fileChange!.after} />
            ) : (
              <pre className="text-[10px] overflow-auto bg-soft p-1.5 rounded border border-border whitespace-pre-wrap break-words max-h-24">
                {action.resultPreview ?? ''}
              </pre>
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
        <div className="text-[10px] mb-1 text-muted">Before</div>
        <pre className="text-[10px] overflow-auto bg-soft p-1.5 rounded border border-border whitespace-pre max-h-24">{before}</pre>
      </div>
      <div>
        <div className="text-[10px] mb-1 text-muted">After</div>
        <pre className="text-[10px] overflow-auto bg-soft p-1.5 rounded border border-border whitespace-pre max-h-24">{after}</pre>
      </div>
    </div>
  );
}
