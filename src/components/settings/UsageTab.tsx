'use client';

import { useEffect, useState } from 'react';
import { CreditGauge } from '@/components/ui/CreditGauge';
import { Loader2, Info } from 'lucide-react';

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
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
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

  'claude-sonnet-5': 'Claude Sonnet 5',
  'claude-sonnet-4.5': 'Claude Sonnet 4', // legacy usage records
  'claude-sonnet-4.6': 'Claude Sonnet 4.6', // legacy usage records
  'claude-sonnet-4-6': 'Claude Sonnet 4.6', // legacy usage records
  'claude-opus-4.5': 'Claude Opus 4.7',
  'claude-opus-4.6': 'Claude Opus 4.7',
  'claude-opus-4.7': 'Claude Opus 4.7',
  'claude-opus-4-1': 'Claude Opus 4.7',
  'claude-opus-4-7': 'Claude Opus 4.7',
  'claude-opus-4-8': 'Claude Opus 4.8',
  'claude-fable-5': 'Claude Fable 5',
  'gpt-5.6-sol': 'GPT-5.6 Sol',
  'gpt-5.6-terra': 'GPT-5.6 Terra',
  'gpt-5.6-luna': 'GPT-5.6 Luna',
  'gpt-5.3-codex': 'GPT-5.3',  // historical usage rows
  'gpt-5.4': 'GPT-5.4',        // historical usage rows
  'gpt-5.5': 'GPT-5.5',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
  'grok-4.5': 'Grok 4.5',
};

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
      {/* Credits ≠ tokens note */}
      <div className="flex gap-2 items-start rounded-lg bg-soft border border-border px-3 py-2.5">
        <Info className="h-3.5 w-3.5 text-muted mt-0.5 shrink-0" />
        <p className="text-xs text-muted leading-relaxed">
          <span className="font-medium text-fg">Credits ≠ tokens.</span>{' '}
          Credits are normalized across models — 1 MiniMax token = 1 credit. Cached input tokens cost significantly less.
          Your own API keys (OAuth / BYOK) don&apos;t count toward your platform budget.
        </p>
      </div>

      {/* Weekly gauge + stats */}
      <div className="flex items-center gap-8">
        <CreditGauge pct={data.pct} size="lg" />
        <div className="space-y-3 flex-1">
          <div>
            <p className="text-xs text-muted mb-1">Weekly credits</p>
            <p className="text-sm font-medium text-fg">
              {fmt(data.weeklyUsed)} <span className="text-muted font-normal">/ {fmt(data.weeklyLimit)}</span>
            </p>
            <div className="mt-1.5 h-1.5 rounded-full bg-soft overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${data.pct}%`,
                  backgroundColor: data.pct >= 80 ? '#ef4444' : data.pct >= 60 ? '#f59e0b' : '#22c55e',
                }}
              />
            </div>
          </div>
          <div>
            <p className="text-xs text-muted mb-1">Monthly credits</p>
            <p className="text-sm font-medium text-fg">
              {fmt(data.monthlyUsed)} <span className="text-muted font-normal">/ {fmt(data.monthlyLimit)}</span>
            </p>
            <div className="mt-1.5 h-1.5 rounded-full bg-soft overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${data.monthlyPct}%`,
                  backgroundColor: data.monthlyPct >= 80 ? '#ef4444' : data.monthlyPct >= 60 ? '#f59e0b' : '#22c55e',
                }}
              />
            </div>
          </div>
          <p className="text-xs text-muted">
            Plan: <span className="capitalize font-medium text-fg">{data.tier}</span>
            {' · '}Credits reset weekly (Mon) and monthly.
          </p>
        </div>
      </div>

      {/* Cache summary */}
      {hasCacheData && (
        <div className="rounded-xl border border-border px-3 py-3 space-y-1.5">
          <p className="text-xs font-semibold text-muted uppercase tracking-wide">Prompt cache this month</p>
          <div className="flex gap-6 text-sm">
            <div>
              <span className="text-muted text-xs">Cache hits</span>
              <p className="font-medium text-fg tabular-nums">{fmt(totalCachedRead)}</p>
            </div>
            <div>
              <span className="text-muted text-xs">Cache writes</span>
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
          <p className="text-xs text-muted">Cache hits are billed at a fraction of normal input cost, saving credits.</p>
        </div>
      )}

      {/* Model breakdown */}
      {data.models.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">This month by model</h3>
          <div className="rounded-xl border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface">
                  <th className="text-left px-3 py-2 text-xs font-medium text-muted">Model</th>
                  <th className="text-right px-3 py-2 text-xs font-medium text-muted">Credits</th>
                  <th className="text-right px-3 py-2 text-xs font-medium text-muted">Tokens</th>
                  <th className="text-right px-3 py-2 text-xs font-medium text-muted">Cache hits</th>
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
