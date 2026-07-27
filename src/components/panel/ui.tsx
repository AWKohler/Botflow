'use client';

/**
 * Shared building blocks for the /panel admin dashboard. All charts here are
 * single-series (one accent hue) with direct text labels — identity never
 * rides on color. Status colors are reserved for state and always ship with a
 * text label, never color alone.
 */

import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-react';

// ─── Formatters ──────────────────────────────────────────────────────────────

export function fmtUsd(v: number, opts?: { cents?: boolean }): string {
  const abs = Math.abs(v);
  const cents = opts?.cents ?? abs < 100;
  return v.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });
}

export function fmtNum(v: number): string {
  if (Math.abs(v) >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 10_000) return `${(v / 1_000).toFixed(0)}K`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function fmtPct(v: number): string {
  return `${v.toFixed(v >= 10 ? 0 : 1)}%`;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (ms < 0) return 'now';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

// ─── Data hook ───────────────────────────────────────────────────────────────

export function usePanelData<T>(path: string): {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  refreshing: boolean;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (force: boolean) => {
      if (force) setRefreshing(true);
      try {
        const res = await fetch(`${path}${force ? '?refresh=1' : ''}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error ?? `Request failed (${res.status})`);
        } else {
          setData((await res.json()) as T);
          setError(null);
        }
      } catch {
        setError('Network error');
      }
      setLoading(false);
      setRefreshing(false);
    },
    [path],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  return {
    data,
    loading,
    error,
    refresh: () => void load(true),
    refreshing,
  };
}

// ─── Page chrome ─────────────────────────────────────────────────────────────

export function PageHeader({
  title,
  subtitle,
  onRefresh,
  refreshing,
  generatedAt,
}: {
  title: string;
  subtitle?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  generatedAt?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
        {subtitle && <p className="text-sm text-muted mt-1">{subtitle}</p>}
      </div>
      {onRefresh && (
        <div className="flex items-center gap-3 shrink-0">
          {generatedAt && (
            <span className="text-xs text-muted hidden sm:inline">
              as of {timeAgo(generatedAt)}
            </span>
          )}
          <button
            onClick={onRefresh}
            disabled={refreshing}
            className={cn(
              'flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5',
              'text-sm text-fg hover:bg-elevated transition-colors disabled:opacity-50',
            )}
          >
            <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
            Refresh
          </button>
        </div>
      )}
    </div>
  );
}

export function Section({
  title,
  hint,
  children,
  className,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('mb-8', className)}>
      <div className="flex items-baseline gap-2 mb-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
          {title}
        </h2>
        {hint && <span className="text-xs text-muted/70">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

export function LoadingState() {
  return (
    <div className="flex items-center justify-center py-24 text-muted">
      <Loader2 className="w-5 h-5 animate-spin mr-2" />
      Loading…
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-red-600/30 bg-red-600/5 px-4 py-3 text-sm text-red-700 dark:text-red-400">
      <XCircle className="w-4 h-4 shrink-0" />
      {message}
    </div>
  );
}

// ─── Stat tile (hero number) ─────────────────────────────────────────────────

export function StatTile({
  label,
  value,
  sub,
  accent,
  warn,
}: {
  label: string;
  value: string;
  sub?: string;
  /** Highlight the value in the accent color (use sparingly — one per row). */
  accent?: boolean;
  /** Negative/at-risk numbers. */
  warn?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3.5">
      <div className="text-xs text-muted mb-1">{label}</div>
      <div
        className={cn(
          'text-2xl font-semibold tracking-tight tabular-nums',
          accent ? 'text-accent' : warn ? 'text-red-600 dark:text-red-400' : 'text-fg',
        )}
      >
        {value}
      </div>
      {sub && <div className="text-xs text-muted mt-1">{sub}</div>}
    </div>
  );
}

export function StatGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
      {children}
    </div>
  );
}

// ─── Utilization meter ───────────────────────────────────────────────────────

export function Meter({ pct, label }: { pct: number; label?: string }) {
  const clamped = Math.min(100, Math.max(0, pct));
  const state = pct >= 95 ? 'critical' : pct >= 80 ? 'warning' : 'ok';
  return (
    <div className="flex items-center gap-2 min-w-[110px]">
      <div className="h-1.5 flex-1 rounded-full bg-soft overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full',
            state === 'critical'
              ? 'bg-red-500'
              : state === 'warning'
                ? 'bg-amber-500'
                : 'bg-accent',
          )}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-muted w-10 text-right">
        {label ?? fmtPct(pct)}
      </span>
    </div>
  );
}

// ─── Single-series bar chart (accent hue, hover tooltip per bar) ─────────────

export function MiniBars({
  data,
  height = 96,
  formatValue = fmtNum,
}: {
  data: Array<{ label: string; value: number }>;
  height?: number;
  formatValue?: (v: number) => string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="flex items-end gap-[2px]" style={{ height }} role="img"
      aria-label={data.map((d) => `${d.label}: ${formatValue(d.value)}`).join(', ')}>
      {data.map((d) => (
        <div key={d.label} className="group relative flex-1 flex flex-col justify-end h-full min-w-[6px]">
          <div
            className="rounded-t-[4px] bg-accent/80 group-hover:bg-accent transition-colors"
            style={{ height: `${Math.max(2, (d.value / max) * 100)}%` }}
          />
          <div
            className={cn(
              'pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 hidden group-hover:block z-10',
              'whitespace-nowrap rounded-md border border-border bg-elevated px-2 py-1 text-xs text-fg shadow-sm',
            )}
          >
            <span className="text-muted">{d.label}</span>{' '}
            <span className="font-medium tabular-nums">{formatValue(d.value)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Horizontal labeled bars (per-row identity from the label, one hue) ──────

export function HBarList({
  rows,
  formatValue = fmtNum,
}: {
  rows: Array<{ label: string; value: number; sub?: string }>;
  formatValue?: (v: number) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-3">
          <div className="w-44 shrink-0 truncate text-sm text-fg" title={r.label}>
            {r.label}
          </div>
          <div className="flex-1 h-4 rounded-[4px] bg-soft/50 overflow-hidden">
            <div
              className="h-full rounded-[4px] bg-accent/80"
              style={{ width: `${(r.value / max) * 100}%` }}
            />
          </div>
          <div className="w-20 shrink-0 text-right text-sm tabular-nums text-fg">
            {formatValue(r.value)}
          </div>
          {r.sub !== undefined && (
            <div className="w-24 shrink-0 text-right text-xs text-muted tabular-nums">
              {r.sub}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Status pill (state = reserved colors + label + icon, never color alone) ─

export type StatusKind = 'good' | 'warning' | 'serious' | 'neutral';

export function StatusPill({ kind, label }: { kind: StatusKind; label: string }) {
  const Icon =
    kind === 'good' ? CheckCircle2 : kind === 'neutral' ? CheckCircle2 : kind === 'warning' ? AlertTriangle : XCircle;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        kind === 'good' && 'bg-emerald-600/10 text-emerald-700 dark:text-emerald-400',
        kind === 'warning' && 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
        kind === 'serious' && 'bg-red-600/10 text-red-700 dark:text-red-400',
        kind === 'neutral' && 'bg-soft text-muted',
      )}
    >
      <Icon className="w-3 h-3" />
      {label}
    </span>
  );
}

// ─── Card ────────────────────────────────────────────────────────────────────

export function Card({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('rounded-xl border border-border bg-surface p-4', className)}>
      {children}
    </div>
  );
}
