'use client';

import { ArrowRight, Camera, Coins, Database, FolderClosed, Gauge, Globe, Zap, type LucideIcon } from 'lucide-react';
import { Button } from './button';
import { Dialog } from './dialog';

export interface LimitReachedPayload {
  error: 'limit_reached';
  limitType: string;
  current: number;
  limit: number;
  tier: 'free' | 'pro' | 'max';
  upgradeTarget: 'pro' | 'max' | null;
  model?: string | null;
  message: string;
}

interface Props {
  payload: LimitReachedPayload;
  onClose: () => void;
}

const TIER_NAMES: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  max: 'Max',
};

const TIER_PRICES: Record<string, string> = {
  pro: '$20 / month',
  max: '$60 / month',
};

const LIMIT_TYPE_ICONS: Record<string, LucideIcon> = {
  project_count: FolderClosed,
  agent_turns_daily: Zap,
  token_budget: Coins,
  convex_project_count: Database,
  cf_pages_count: Globe,
  screenshot_daily: Camera,
};

/** Parse a 402 API response body into a LimitReachedPayload, or null if not a limit error */
export function parseLimitPayload(body: unknown): LimitReachedPayload | null {
  if (
    body &&
    typeof body === 'object' &&
    (body as Record<string, unknown>).error === 'limit_reached'
  ) {
    return body as LimitReachedPayload;
  }
  return null;
}

export function LimitModal({ payload, onClose }: Props) {
  const { upgradeTarget, message, limitType, current, limit, tier } = payload;
  const Icon = LIMIT_TYPE_ICONS[limitType] ?? Gauge;
  const targetName = upgradeTarget ? TIER_NAMES[upgradeTarget] : null;
  const targetPrice = upgradeTarget ? TIER_PRICES[upgradeTarget] : null;

  const handleUpgrade = () => {
    // Open settings modal to subscription tab
    window.dispatchEvent(new CustomEvent('open-settings', { detail: { tab: 'subscription' } }));
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={
        <span className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated text-muted">
            <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
          </span>
          <span>
            <span className="block text-xs font-normal text-muted">Limit reached</span>
            {TIER_NAMES[tier]} plan limit
          </span>
        </span>
      }
      footer={
        upgradeTarget ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Maybe later
            </Button>
            <Button variant="primary" onClick={handleUpgrade}>
              Upgrade to {targetName}
              <ArrowRight className="h-4 w-4" />
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onClose}>
            Got it
          </Button>
        )
      }
    >
      <p className="text-sm leading-relaxed text-muted">{message}</p>

      {/* Usage bar (only show when there's meaningful progress to show) */}
      {limit > 0 && current > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 flex justify-between text-xs text-muted">
            <span>{current.toLocaleString()} used</span>
            <span>{limit === Infinity ? '∞' : limit.toLocaleString()} limit</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-soft">
            <div
              className="h-full rounded-full bg-fg transition-all"
              style={{ width: limit === Infinity ? '0%' : `${Math.min((current / limit) * 100, 100)}%` }}
            />
          </div>
        </div>
      )}

      {upgradeTarget && (
        <div className="mt-5 rounded-lg border border-border bg-surface p-4">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-medium text-fg">{targetName}</p>
            {targetPrice && <p className="text-xs text-muted">{targetPrice}</p>}
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            {upgradeTarget === 'pro'
              ? 'More projects, server-side AI and higher limits.'
              : 'Sonnet, Opus and the highest limits available.'}
          </p>
        </div>
      )}
    </Dialog>
  );
}
