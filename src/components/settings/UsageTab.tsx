'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { tableHeadRowClass } from '@/components/ui/table';

interface ModelRow {
  model: string;
  credits: number;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  cachedTokensRead: number;
  cachedTokensWrite: number;
}

interface CreditsData {
  tier: string;
  weeklyUsed: number;
  weeklyLimit: number;
  monthlyUsed: number;
  monthlyLimit: number;
  pct: number;
  monthlyPct: number;
  models: ModelRow[];
}

function fmt(n: number): string {
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, '');
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}K`;
  return String(n);
}

const MODEL_DISPLAY: Record<string, string> = {
  'fireworks-minimax-m3': 'MiniMax M3',
  'fireworks-minimax-m2p7': 'MiniMax M2.7', // legacy usage records
  // 'fireworks-glm-5': 'GLM-5',
  'fireworks-glm-5p2': 'GLM-5.2',
  'fireworks-glm-5p1': 'GLM-5.1', // historical usage records
  'fireworks-kimi-k2p7': 'Kimi K2.7',
  'fireworks-kimi-k2p6': 'Kimi K2.6', // historical usage records
  'fireworks-kimi-k3': 'Kimi K3',

  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-fable-5-1': 'Claude Fable 5.1',
  'claude-sonnet-5': 'Claude Sonnet 5', // historical usage records
  'claude-sonnet-4.5': 'Claude Sonnet 4', // legacy usage records
  'claude-sonnet-4.6': 'Claude Sonnet 4.6', // legacy usage records
  'claude-sonnet-4-6': 'Claude Sonnet 4.6', // legacy usage records
  'claude-opus-4.5': 'Claude Opus 4.7',
  'claude-opus-4.6': 'Claude Opus 4.7',
  'claude-opus-4.7': 'Claude Opus 4.7',
  'claude-opus-4-1': 'Claude Opus 4.7',
  'claude-opus-4-7': 'Claude Opus 4.7',
  'claude-opus-4-8': 'Claude Opus 4.8', // historical usage records
  'claude-opus-5': 'Claude Opus 5',
  'claude-fable-5': 'Claude Fable 5',
  'gpt-6-astra': 'GPT-6 Astra',
  'gpt-6.1-sol': 'GPT-6.1 Sol',
  'gpt-6-luna': 'GPT-6 Luna',
  'gpt-5.6-sol': 'GPT-5.6 Sol', // historical usage records (5.6 family + 5.5)
  'gpt-5.6-terra': 'GPT-5.6 Terra',
  'gpt-5.6-luna': 'GPT-5.6 Luna',
  'gpt-5.3-codex': 'GPT-5.3',  // historical usage rows
  'gpt-5.4': 'GPT-5.4',        // historical usage rows
  'gpt-5.5': 'GPT-5.5',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
  'grok-4.7': 'Grok 4.7',
  'grok-4.5': 'Grok 4.5', // historical usage records
};

function UsageMeter({ label, used, limit, pct }: { label: string; used: number; limit: number; pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[13px] font-medium text-fg">{label}</p>
        <p className="text-xs tabular-nums text-muted">{Math.round(clamped)}% used</p>
      </div>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-soft"
        role="progressbar"
        aria-label={`Credits used ${label.toLowerCase()}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped)}
      >
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${clamped}%`,
            backgroundColor:
              clamped >= 80 ? 'var(--danger-solid)' : clamped >= 60 ? 'var(--warning-solid)' : 'var(--success-solid)',
          }}
        />
      </div>
      <p className="mt-2 text-xs tabular-nums text-muted">
        <span className="font-medium text-fg">{fmt(used)}</span> of {fmt(limit)} credits
      </p>
    </div>
  );
}

export function UsageTab() {
  const [data, setData] = useState<CreditsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch('/api/usage/credits')
      .then(r => r.ok ? r.json() : null)
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="py-10 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted" />
      </div>
    );
  }

  if (!data) {
    return <p className="text-sm text-muted py-4">Could not load usage data.</p>;
  }

  // Totals for cache summary
  const totalCachedRead = data.models.reduce((s, r) => s + r.cachedTokensRead, 0);
  const totalCachedWrite = data.models.reduce((s, r) => s + r.cachedTokensWrite, 0);
  const hasCacheData = totalCachedRead > 0 || totalCachedWrite > 0;

  return (
    <div className="space-y-6">
      {/* The two allowances, each named, with its own bar and percentage. */}
      <div>
        <div className="grid gap-5 sm:grid-cols-2">
          <UsageMeter label="This week" used={data.weeklyUsed} limit={data.weeklyLimit} pct={data.pct} />
          <UsageMeter label="This month" used={data.monthlyUsed} limit={data.monthlyLimit} pct={data.monthlyPct} />
        </div>
        <p className="mt-4 text-xs leading-relaxed text-muted">
          <span className="font-medium text-fg">{data.tier.charAt(0).toUpperCase() + data.tier.slice(1)} plan.</span>{' '}
          Credits measure model use billed to Botflow, and reset every Monday and every month. Turns that run on
          your own subscription or API keys don&apos;t use credits.
        </p>
      </div>

      {/* Cache summary */}
      {hasCacheData && (
        <div className="space-y-2 rounded-lg border border-border px-4 py-3.5">
          <p className="text-xs font-medium text-muted">Prompt cache this month</p>
          <div className="flex gap-6 text-sm">
            <div>
              <span className="text-muted text-xs">Cached input tokens</span>
              <p className="font-medium text-fg tabular-nums">{fmt(totalCachedRead)}</p>
            </div>
            <div>
              <span className="text-muted text-xs">Cache write tokens</span>
              <p className="font-medium text-fg tabular-nums">{fmt(totalCachedWrite)}</p>
            </div>
            <div>
              <span className="text-muted text-xs">Hit rate</span>
              <p className="font-medium text-fg tabular-nums">
                {totalCachedRead + totalCachedWrite > 0
                  ? `${Math.round((totalCachedRead / (totalCachedRead + totalCachedWrite)) * 100)}%`
                  : '—'}
              </p>
            </div>
          </div>
          <p className="text-xs text-muted">Cached input tokens are billed at a fraction of the normal input rate, which saves credits.</p>
        </div>
      )}

      {/* Model breakdown */}
      {data.models.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-muted mb-2">This month by model</h3>
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className={tableHeadRowClass}>
                  <th className="text-left px-3 py-2 text-xs font-medium text-muted">Model</th>
                  <th className="text-right px-3 py-2 text-xs font-medium text-muted">Credits</th>
                  <th className="text-right px-3 py-2 text-xs font-medium text-muted">Tokens</th>
                  <th className="text-right px-3 py-2 text-xs font-medium text-muted">Cached tokens</th>
                  <th className="text-right px-3 py-2 text-xs font-medium text-muted">Turns</th>
                </tr>
              </thead>
              <tbody>
                {data.models.map((row, i) => (
                  <tr key={row.model} className={i < data.models.length - 1 ? 'border-b border-border' : ''}>
                    <td className="px-3 py-2 text-fg">
                      {MODEL_DISPLAY[row.model] ?? row.model}
                    </td>
                    <td className="px-3 py-2 text-right text-muted tabular-nums">{fmt(row.credits)}</td>
                    <td className="px-3 py-2 text-right text-muted tabular-nums">{fmt(row.tokensIn + row.tokensOut)}</td>
                    <td className="px-3 py-2 text-right text-muted tabular-nums">
                      {row.cachedTokensRead > 0 ? fmt(row.cachedTokensRead) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-muted tabular-nums">{row.turns}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data.models.length === 0 && (
        <p className="text-sm text-muted">No usage this month yet.</p>
      )}
    </div>
  );
}
