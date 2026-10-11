'use client';

/**
 * Agent threads: the list hook and the sheet that shows it.
 *
 * The sheet slides over the agent column (it never pushes the panel — the
 * column is narrow), with a dimmed backdrop; clicking outside or pressing
 * Escape closes it. Threads are shared by every project member
 * (docs/features/multi-agent-threads.md).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArchiveRestore, ChevronDown, Pencil, Plus, Trash2, X as IconX } from 'lucide-react';
import type { ThreadStatus, ThreadSummary } from '@/lib/agent/threads';
import { MODEL_CONFIGS, type ModelId } from '@/lib/agent/models';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/ui/toast';

export type { ThreadSummary };

/** What the dot on the threads button reports about the OTHER threads. */
export type ThreadAttention = 'needs_input' | 'error' | 'unread' | 'running';

export const ATTENTION_DOT_CLASS: Record<ThreadAttention, string> = {
  needs_input: 'bg-amber-500',
  error: 'bg-red-500',
  unread: 'bg-accent',
  running: 'bg-accent animate-pulse',
};

const POLL_MS = 4000;

/** Most urgent state among `threads`: blocked on the user > failed > unread > running. */
export function threadAttention(threads: ThreadSummary[]): ThreadAttention | null {
  const open = threads.filter((t) => !t.archived);
  if (open.some((t) => t.status === 'needs_input')) return 'needs_input';
  if (open.some((t) => t.status === 'error')) return 'error';
  if (open.some((t) => t.unread)) return 'unread';
  if (open.some((t) => t.status === 'running')) return 'running';
  return null;
}

/** A thread nobody has used yet — "New chat" reuses it instead of piling up empties. */
export function isBlankThread(t: ThreadSummary): boolean {
  return !t.title && !t.lastTurnEndedAt && t.status === 'idle';
}

// ============================================================================
// useThreads — list + live status, polled while the tab is visible
// ============================================================================
export function useThreads(projectId: string) {
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/projects/${encodeURIComponent(projectId)}/threads`;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(base);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { threads: ThreadSummary[] };
      setThreads(data.threads);
      setError(null);
      return data.threads;
    } catch (err) {
      console.error('Failed to load threads:', err);
      setError('Could not load chats.');
      return null;
    }
  }, [base]);

  // Poll only while visible — this endpoint never touches the sandbox and
  // must not keep anything awake. Refresh immediately on becoming visible.
  useEffect(() => {
    void refresh();
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => void refresh(), POLL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  const create = useCallback(
    async (model?: ModelId): Promise<ThreadSummary | null> => {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(model ? { model } : {}),
      });
      if (!res.ok) return null;
      const { thread } = (await res.json()) as { thread: ThreadSummary };
      setThreads((prev) => [thread, ...(prev ?? [])]);
      return thread;
    },
    [base],
  );

  const update = useCallback(
    async (threadId: string, patch: { title?: string; archived?: boolean }): Promise<boolean> => {
      const res = await fetch(`${base}/${encodeURIComponent(threadId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (res.ok) void refresh();
      return res.ok;
    },
    [base, refresh],
  );

  const remove = useCallback(
    async (threadId: string): Promise<{ ok: boolean; error?: string }> => {
      const res = await fetch(`${base}/${encodeURIComponent(threadId)}`, { method: 'DELETE' });
      if (res.ok) {
        setThreads((prev) => (prev ?? []).filter((t) => t.id !== threadId));
        return { ok: true };
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error };
    },
    [base],
  );

  return { threads, error, refresh, create, update, remove };
}

// ============================================================================
// Sheet
// ============================================================================
function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const STATUS_LABEL: Partial<Record<ThreadStatus, string>> = {
  running: 'Working…',
  needs_input: 'Needs your input',
  error: 'Last run failed',
};

function StatusDot({ thread }: { thread: ThreadSummary }) {
  const cls =
    thread.status === 'running'
      ? 'bg-accent animate-pulse'
      : thread.status === 'needs_input'
        ? 'bg-amber-500'
        : thread.status === 'error'
          ? 'bg-red-500'
          : thread.unread
            ? 'bg-accent'
            : 'bg-transparent';
  return (
    <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
      <span className={cn('size-2 rounded-full', cls)} />
    </span>
  );
}

interface ThreadRowProps {
  thread: ThreadSummary;
  selected: boolean;
  onSelect: () => void;
  onRename: (title: string) => Promise<boolean>;
  onArchive: (archived: boolean) => void;
  onDelete: () => void;
}

function ThreadRow({ thread, selected, onSelect, onRename, onArchive, onDelete }: ThreadRowProps) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(thread.title ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  const label = thread.title ?? 'New chat';
  const statusText = STATUS_LABEL[thread.status];
  const modelName = MODEL_CONFIGS[thread.model]?.displayName ?? thread.model;

  const commitRename = async () => {
    const next = draft.trim();
    setRenaming(false);
    if (next && next !== thread.title) await onRename(next);
  };

  return (
    <div
      className={cn(
        'group/row relative flex items-center gap-2 rounded-xl px-2 py-2 transition-colors',
        selected ? 'bg-elevated' : 'hover:bg-elevated/60',
      )}
    >
      <StatusDot thread={thread} />
      {renaming ? (
        <input
          ref={inputRef}
          value={draft}
          maxLength={80}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitRename();
            if (e.key === 'Escape') {
              e.stopPropagation();
              setDraft(thread.title ?? '');
              setRenaming(false);
            }
          }}
          aria-label="Chat title"
          className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-sm text-fg outline-none focus:border-accent/60"
        />
      ) : (
        <button
          type="button"
          onClick={onSelect}
          className="min-w-0 flex-1 text-left"
          aria-current={selected ? 'true' : undefined}
        >
          <div className={cn('truncate text-sm', thread.unread || selected ? 'font-medium text-fg' : 'text-fg/90')}>
            {label}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted">
            {statusText ? (
              <span
                className={cn(
                  thread.status === 'needs_input' && 'text-amber-500',
                  thread.status === 'error' && 'text-red-400',
                  thread.status === 'running' && 'text-accent',
                )}
              >
                {statusText}
              </span>
            ) : (
              <span className="truncate">{modelName}</span>
            )}
            <span className="text-muted/50">·</span>
            <span className="shrink-0 tabular-nums">{relativeTime(thread.updatedAt)}</span>
          </div>
        </button>
      )}
      {!renaming && (
        <div
          className={cn(
            // Hover-revealed on desktop; always shown on touch screens, which can't hover.
            'flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100',
          )}
        >
          <RowAction label="Rename" onClick={() => setRenaming(true)}>
            <Pencil size={13} />
          </RowAction>
          <RowAction
            label={thread.archived ? 'Unarchive' : 'Archive'}
            onClick={() => onArchive(!thread.archived)}
          >
            {thread.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
          </RowAction>
          <RowAction label="Delete" onClick={onDelete} danger>
            <Trash2 size={13} />
          </RowAction>
        </div>
      )}
    </div>
  );
}

function RowAction({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'flex size-6 items-center justify-center rounded-full text-muted transition-colors hover:bg-soft',
        danger ? 'hover:text-red-400' : 'hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}

export interface ThreadsSheetProps {
  open: boolean;
  onClose: () => void;
  threads: ThreadSummary[] | null;
  error: string | null;
  currentThreadId: string | null;
  onSelect: (threadId: string) => void;
  onNewChat: () => void;
  onRename: (threadId: string, title: string) => Promise<boolean>;
  onArchive: (threadId: string, archived: boolean) => void;
  onDelete: (threadId: string) => void;
}

export function ThreadsSheet({
  open,
  onClose,
  threads,
  error,
  currentThreadId,
  onSelect,
  onNewChat,
  onRename,
  onArchive,
  onDelete,
}: ThreadsSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const [showArchived, setShowArchived] = useState(false);

  // Close on Escape and on ANY click outside the sheet — the backdrop only
  // covers the agent column, so clicks in the preview/editor count too.
  useEffect(() => {
    if (!open) return;
    sheetRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (sheetRef.current && !sheetRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, onClose]);

  const { active, recent, archived } = useMemo(() => {
    const all = threads ?? [];
    return {
      active: all.filter((t) => !t.archived && (t.status === 'running' || t.status === 'needs_input')),
      recent: all.filter((t) => !t.archived && t.status !== 'running' && t.status !== 'needs_input'),
      archived: all.filter((t) => t.archived),
    };
  }, [threads]);

  const renderRows = (list: ThreadSummary[]) =>
    list.map((t) => (
      <ThreadRow
        key={t.id}
        thread={t}
        selected={t.id === currentThreadId}
        onSelect={() => onSelect(t.id)}
        onRename={(title) => onRename(t.id, title)}
        onArchive={(a) => onArchive(t.id, a)}
        onDelete={() => onDelete(t.id)}
      />
    ));

  return (
    <div className={cn('absolute inset-0 z-40', open ? 'pointer-events-auto' : 'pointer-events-none')} aria-hidden={!open}>
      {/* Backdrop — dims the agent column (clicks outside the sheet close it
          via the document listener above). */}
      <div
        className={cn(
          'absolute inset-0 bg-black/30 transition-opacity duration-200',
          open ? 'opacity-100' : 'opacity-0',
        )}
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Chats"
        tabIndex={-1}
        className={cn(
          'absolute inset-y-0 left-0 flex w-[86%] max-w-[340px] flex-col rounded-r-2xl border-r border-border bg-surface shadow-2xl outline-none',
          'transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between px-4 pb-2 pt-3.5">
          <div className="text-sm font-semibold text-fg">Chats</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close chats"
            className="flex size-7 items-center justify-center rounded-full text-muted transition-colors hover:bg-soft hover:text-fg"
          >
            <IconX size={15} />
          </button>
        </div>

        <div className="px-3 pb-2">
          <button
            type="button"
            onClick={onNewChat}
            className="flex w-full items-center justify-center gap-1.5 rounded-full border border-border bg-elevated py-2 text-sm font-medium text-fg transition-colors hover:bg-soft"
          >
            <Plus size={15} />
            New chat
          </button>
        </div>

        <div className="modern-scrollbar flex-1 overflow-y-auto px-2 pb-3">
          {error && <p className="px-2 py-3 text-xs text-red-400">{error}</p>}
          {!threads && !error && (
            <div className="space-y-2 px-2 py-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-10 animate-pulse rounded-xl bg-elevated/70" />
              ))}
            </div>
          )}
          {active.length > 0 && (
            <section className="mb-2">
              <SectionLabel>Active</SectionLabel>
              {renderRows(active)}
            </section>
          )}
          {recent.length > 0 && (
            <section className="mb-2">
              <SectionLabel>Recent</SectionLabel>
              {renderRows(recent)}
            </section>
          )}
          {threads && active.length === 0 && recent.length === 0 && (
            <p className="px-2 py-3 text-xs text-muted">No chats yet.</p>
          )}
          {archived.length > 0 && (
            <section>
              <button
                type="button"
                onClick={() => setShowArchived((v) => !v)}
                className="flex w-full items-center gap-1 px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted hover:text-fg"
              >
                Archived ({archived.length})
                <ChevronDown size={12} className={cn('transition-transform', showArchived && 'rotate-180')} />
              </button>
              {showArchived && renderRows(archived)}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted">{children}</div>
  );
}

/** Toast when a thread you're NOT looking at starts needing you or fails. */
export function useBackgroundThreadAlerts(threads: ThreadSummary[] | null, currentThreadId: string | null) {
  const { toast } = useToast();
  const previous = useRef<Map<string, ThreadStatus> | null>(null);
  useEffect(() => {
    if (!threads) return;
    const prev = previous.current;
    const next = new Map(threads.map((t) => [t.id, t.status]));
    previous.current = next;
    if (!prev) return; // first load: don't announce existing states
    for (const t of threads) {
      if (t.id === currentThreadId || t.archived) continue;
      const before = prev.get(t.id);
      if (before === t.status) continue;
      const name = t.title ?? 'A chat';
      if (t.status === 'needs_input') toast({ title: `“${name}” needs your input` });
      else if (t.status === 'error') toast({ title: `“${name}” stopped with an error` });
    }
  }, [threads, currentThreadId, toast]);
}
