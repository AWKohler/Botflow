'use client';

/**
 * Shared building blocks for the /panel admin dashboard. All charts here are
 * single-series (one accent hue) with direct text labels — identity never
 * rides on color. Status colors are reserved for state and always ship with a
 * text label, never color alone.
 */

import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { buttonClass } from '@/components/ui/button';
import { MODEL_CONFIGS } from '@/lib/agent/models';
import { AlertTriangle, CheckCircle2, Loader2, MinusCircle, RefreshCw, XCircle } from 'lucide-react';

// ─── Formatters ──────────────────────────────────────────────────────────────

/**
 * Whole dollars by default, so a row of figures reads in one format; pass
 * `cents: true` in detail tables where the cents matter. Amounts under $1
 * always show cents (otherwise they would all read "$0").
 */
export function fmtUsd(v: number, opts?: { cents?: boolean }): string {
  const abs = Math.abs(v);
  const cents = opts?.cents ?? (abs > 0 && abs < 1);
  return v.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });
}

/**
 * One rule for every count in the panel: exact, with a thousands separator,
 * below 10,000 ("2,841"); compact from there up ("48K", "1.2M").
 */
export function fmtNum(v: number): string {
  const trim = (n: number) => n.toFixed(1).replace(/\.0$/, '');
  if (Math.abs(v) >= 1_000_000_000) return `${trim(v / 1_000_000_000)}B`;
  if (Math.abs(v) >= 1_000_000) return `${trim(v / 1_000_000)}M`;
  if (Math.abs(v) >= 10_000) return `${(v / 1_000).toFixed(0)}K`;
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

const NAMES: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  xai: 'xAI',
  fireworks: 'Fireworks',
  together: 'Together',
  moonshot: 'Moonshot',
  stripe: 'Stripe',
  revenuecat: 'RevenueCat',
  vercel: 'Vercel',
  byoc: 'BYOC',
};

/** Display name for a raw identifier: "openai" → "OpenAI", "sandbox-host" → "Sandbox host". */
export function displayName(raw: string): string {
  const known = NAMES[raw.toLowerCase()];
  if (known) return known;
  const words = raw.replace(/[-_.]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "claude-sonnet-5-5" → "Claude Sonnet 5.5"; unknown ids are shown as they are. */
export function modelName(id: string): string {
  return (MODEL_CONFIGS as Record<string, { displayName: string } | undefined>)[id]?.displayName ?? id;
}

export function fmtPct(v: number): string {
  // One decimal below 10%, and never a trailing ".0" ("9%", "8.4%", "0%").
  return `${v.toFixed(v >= 10 ? 0 : 1).replace(/\.0$/, '')}%`;
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
    <div className="mb-8 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
        {subtitle && <p className="mt-1.5 text-sm text-muted">{subtitle}</p>}
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
            className={buttonClass({ variant: 'secondary', size: 'sm' })}
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
        <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
        {hint && <span className="text-xs text-muted">{hint}</span>}
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
    <div className="flex items-center gap-2 rounded-lg border border-danger-border bg-danger-soft px-4 py-3 text-sm text-danger">
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
  warn,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  /** Negative/at-risk numbers. Colour is for state only, never decoration. */
  warn?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3.5">
      <div className="mb-1.5 text-xs text-muted">{label}</div>
      <div
        className={cn(
          'text-2xl font-semibold tracking-tight tabular-nums',
          warn ? 'text-danger' : 'text-fg',
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
              ? 'bg-danger-solid'
              : state === 'warning'
                ? 'bg-warning-solid'
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
  // With few bars there is room to label each one directly (value on top,
  // period underneath); dense series fall back to the hover tooltip.
  const labelled = data.length <= 14;
  return (
    <div role="img" aria-label={data.map((d) => `${d.label}: ${formatValue(d.value)}`).join(', ')}>
      <div className="flex items-end gap-1.5" style={{ height }}>
        {data.map((d) => (
          <div key={d.label} className="group relative flex h-full min-w-[6px] flex-1 flex-col justify-end">
            {labelled && (
              <span className="mb-1 text-center text-[11px] tabular-nums text-muted">
                {formatValue(d.value)}
              </span>
            )}
            <div
              className="rounded-t-[4px] bg-accent/80 transition-colors group-hover:bg-accent"
              style={{ height: `${Math.max(2, (d.value / max) * (labelled ? 82 : 100))}%` }}
            />
            {!labelled && (
              <div
                className={cn(
                  'pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 hidden -translate-x-1/2 group-hover:block',
                  'whitespace-nowrap rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg shadow-sm',
                )}
              >
                <span className="text-muted">{periodLabel(d.label)}</span>{' '}
                <span className="font-medium tabular-nums">{formatValue(d.value)}</span>
              </div>
            )}
          </div>
        ))}
      </div>
      {labelled ? (
        <div className="mt-1.5 flex gap-1.5 border-t border-border pt-1.5">
          {data.map((d) => (
            <span key={d.label} className="min-w-[6px] flex-1 truncate text-center text-[11px] text-muted">
              {periodLabel(d.label)}
            </span>
          ))}
        </div>
      ) : (
        // Dense series: first, middle and last period, plus the peak for scale.
        <div className="mt-1.5 flex justify-between border-t border-border pt-1.5 text-[11px] tabular-nums text-muted">
          <span>{periodLabel(data[0]?.label ?? '')}</span>
          <span>{periodLabel(data[Math.floor((data.length - 1) / 2)]?.label ?? '')}</span>
          <span>{periodLabel(data[data.length - 1]?.label ?? '')}</span>
        </div>
      )}
    </div>
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-06" → "Jun", "2026-11-03" → "Nov 3"; anything else is shown as is. */
function periodLabel(raw: string): string {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(raw);
  if (!m) return raw;
  const month = MONTHS[Number(m[2]) - 1] ?? raw;
  return m[3] ? `${month} ${Number(m[3])}` : month;
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
          <div className="w-40 shrink-0 truncate text-sm text-fg" title={r.label}>
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
            <div className="w-36 shrink-0 whitespace-nowrap text-right text-xs text-muted tabular-nums">
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
  // A tick means "good" and nothing else; neutral states get a neutral mark.
  const Icon =
    kind === 'good' ? CheckCircle2 : kind === 'neutral' ? MinusCircle : kind === 'warning' ? AlertTriangle : XCircle;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium',
        kind === 'good' && 'border-success-border bg-success-soft text-success',
        kind === 'warning' && 'border-warning-border bg-warning-soft text-warning',
        kind === 'serious' && 'border-danger-border bg-danger-soft text-danger',
        kind === 'neutral' && 'border-border bg-elevated text-muted',
      )}
    >
      <Icon className="w-3 h-3" />
      {label.charAt(0).toUpperCase() + label.slice(1)}
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
