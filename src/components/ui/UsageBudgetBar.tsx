'use client';

import { useState, useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';

interface BudgetStatus {
  model: string;
  used: number;
  limit: number;
  pct: number;
}

interface Props {
  projectId?: string;
  model: string;
}

/** Fetches and displays a budget bar when usage is ≥80% of the monthly token limit. */
export function UsageBudgetBar({ model }: Props) {
  const [status, setStatus] = useState<BudgetStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/usage/budget?model=${encodeURIComponent(model)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!cancelled && data && data.limit > 0) {
          setStatus(data as BudgetStatus);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [model]);

  if (!status || status.pct < 80) return null;

  const isAtLimit = status.pct >= 100;

  return (
    <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
      isAtLimit
        ? 'border-danger-border bg-danger-soft text-danger'
        : 'border-warning-border bg-warning-soft text-warning'
    }`}>
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="font-medium">
          {isAtLimit ? 'Token budget exhausted' : `${Math.round(status.pct)}% of monthly budget used`}
        </span>
        <span className="ml-1 opacity-70">
          ({(status.used / 1_000_000).toFixed(2)}M / {(status.limit / 1_000_000).toFixed(1)}M tokens)
        </span>
      </div>
      {/* Inline mini bar */}
      <div className="w-16 shrink-0">
        <div className="h-1 w-full overflow-hidden rounded-full bg-current opacity-20">
          <div
            className="h-full rounded-full bg-current opacity-80"
            style={{ width: `${Math.min(status.pct, 100)}%` }}
          />
        </div>
      </div>
    </div>
  );
}
