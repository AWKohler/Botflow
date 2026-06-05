'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Lock } from 'lucide-react';
import { MODEL_CONFIGS, type ModelId } from '@/lib/agent/models';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/ui/toast';
import type { LimitReachedPayload } from '@/components/ui/LimitModal';

export interface ModelSelectorProps {
  value: ModelId;
  onChange: (model: ModelId) => void;
  providerAccess: Record<string, boolean | null>; // provider → has credentials
  /** Current user tier — used to show/block tier-locked models */
  userTier?: 'free' | 'pro' | 'max';
  /** Called when user selects a tier-locked model — triggers upsell modal */
  onTierLocked?: (payload: LimitReachedPayload) => void;
  size?: 'sm' | 'md';
  className?: string;
  /** When true, Kimi K2.6 is served by Together AI (USE_TOGETHER_KIMI flag),
   *  so its provider badge reads "Together" instead of "Fireworks". */
  useTogetherKimi?: boolean;
  /** Optional content rendered inside the trigger pill, left of the model
   *  name and separated by a divider — e.g. the agent backend glyph, so the
   *  agent identity and the model read as one body. */
  leading?: ReactNode;
}

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  fireworks: 'Fireworks',
  together: 'Together',
  google: 'Google',
};

/** Minimum tier required to use a model on server-side keys (must match backend MODEL_TIER_REQUIREMENT) */
const MODEL_SERVER_TIER: Partial<Record<ModelId, 'free' | 'pro' | 'max'>> = {
  'fireworks-minimax-m2p7': 'free',
  'fireworks-glm-5p1': 'free',
  'fireworks-kimi-k2p6': 'free',
  'gpt-5.3-codex': 'pro',       // Pro+ for server key; free requires BYOK/OAuth
  'gpt-5.4': 'pro',             // Pro+
  'gpt-5.5': 'pro',             // Pro+
  'claude-sonnet-4-6': 'pro',   // Pro+
  'claude-opus-4-7': 'pro',     // Pro+
  'gemini-3.1-pro-preview': 'pro', // Pro+ for server key; free requires BYOK
};

/**
 * Models served via platform server keys — BYOK not required for eligible tiers.
 * Selecting these skips the "missing API key" BYOK check.
 */
const SERVER_KEY_MODELS = new Set<ModelId>([
  'fireworks-minimax-m2p7',
  'fireworks-glm-5p1',
  'fireworks-kimi-k2p6',
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.5',
  'claude-sonnet-4-6',
  'claude-opus-4-7',
  'gemini-3.1-pro-preview',
]);

/** Rounded per-model cost multiplier for user display */
const MODEL_COST_LABEL: Record<ModelId, string> = {
  'fireworks-minimax-m2p7': 'x1',
  'fireworks-glm-5p1': 'x3',
  'fireworks-kimi-k2p6': 'x3',
  'gpt-5.3-codex': 'x4',
  'gemini-3.1-pro-preview': 'x5',
  'claude-sonnet-4-6': 'x5',
  'gpt-5.4': 'x6',
  'claude-opus-4-7': 'x10',
  'gpt-5.5': 'x12',
};

const TIER_RANK: Record<string, number> = { free: 0, pro: 1, max: 2 };
const TIER_LABELS: Record<string, string> = { pro: 'Pro', max: 'Max' };

function formatContextSize(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`;
  return String(tokens);
}

// Order: cheapest → most expensive (by credit multiplier)
const MODEL_ORDER: ModelId[] = [
  'fireworks-minimax-m2p7',  // x1
  'fireworks-glm-5p1',         // x3
  'fireworks-kimi-k2p6',     // x3
  'gpt-5.3-codex',           // x4
  'gemini-3.1-pro-preview',  // x5
  'claude-sonnet-4-6',       // x5
  'gpt-5.4',                 // x6
  'claude-opus-4-7',         // x10
  'gpt-5.5',                 // x12
];

export function ModelSelector({ value, onChange, providerAccess, userTier = 'free', onTierLocked, size = 'md', className, useTogetherKimi = false, leading }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  /** Provider label for the dropdown badge — reflects the live Kimi→Together redirect. */
  const providerLabel = useCallback(
    (modelId: ModelId) => {
      if (modelId === 'fireworks-kimi-k2p6' && useTogetherKimi) return PROVIDER_LABELS.together;
      return PROVIDER_LABELS[MODEL_CONFIGS[modelId].provider];
    },
    [useTogetherKimi],
  );

  const currentConfig = MODEL_CONFIGS[value];

  const handleSelect = useCallback((modelId: ModelId) => {
    const config = MODEL_CONFIGS[modelId];
    const requiredTier = MODEL_SERVER_TIER[modelId] ?? 'free';
    const userTierRank = TIER_RANK[userTier] ?? 0;
    const requiredTierRank = TIER_RANK[requiredTier] ?? 0;

    // Check tier gate for server-key models (free users clicking Pro-only models, etc.)
    const isTierLocked = requiredTierRank > userTierRank && !providerAccess[config.provider];
    if (isTierLocked) {
      const upgradeTarget = requiredTier === 'pro' ? 'pro' : 'max';
      const payload: LimitReachedPayload = {
        error: 'limit_reached',
        limitType: 'agent_turns_daily',
        current: 0,
        limit: 0,
        tier: userTier,
        upgradeTarget,
        model: modelId,
        message: `${config.displayName} requires the ${TIER_LABELS[requiredTier]} plan. Upgrade to use it with your server-side budget, or add your own API key in Settings.`,
      };
      onTierLocked?.(payload);
      setOpen(false);
      return;
    }

    // BYOK credential check — skip for models served via platform keys
    if (!SERVER_KEY_MODELS.has(modelId) && providerAccess[config.provider] === false) {
      toast({
        title: 'Missing API key',
        description: `Please add your ${PROVIDER_LABELS[config.provider]} credentials in Settings.`,
      });
      return;
    }

    // Credits exhausted does NOT prevent selection — blocked at send time instead
    onChange(modelId);
    setOpen(false);
  }, [onChange, providerAccess, userTier, onTierLocked, toast]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const isSm = size === 'sm';

  return (
    <div ref={containerRef} className={cn('relative pointer-events-auto', className)}>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={cn(
          'inline-flex items-center gap-1.5 border transition min-w-0',
          isSm
            ? 'bg-elevated border-border rounded-md px-2 py-1 text-xs text-muted max-w-[180px]'
            : 'pointer-events-auto rounded-full border-border bg-elevated px-3 py-1.5 text-xs sm:text-sm font-medium text-[var(--sand-text)] shadow-sm shadow-soft hover:border-transparent hover:bg-accent/15 max-w-[120px] sm:max-w-[200px]',
        )}
      >
        {leading != null && (
          <>
            {leading}
            <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
          </>
        )}
        <span className="truncate">{currentConfig.displayName}</span>
        <ChevronDown className={cn(isSm ? 'h-3 w-3' : 'h-3.5 w-3.5', 'opacity-50 shrink-0')} />
      </button>

      {/* Dropdown */}
      {open && (
        <div
          className={cn(
            'absolute z-50 mt-1 min-w-[280px] rounded-xl border border-border bg-surface shadow-lg overflow-hidden',
            isSm ? 'right-0' : 'left-0',
          )}
        >
          {MODEL_ORDER.map((modelId) => {
            const config = MODEL_CONFIGS[modelId];
            const hasAccess = providerAccess[config.provider];
            const isCredentialMissing = hasAccess === false;
            const requiredTier = MODEL_SERVER_TIER[modelId] ?? 'free';
            const userTierRank = TIER_RANK[userTier] ?? 0;
            const requiredTierRank = TIER_RANK[requiredTier] ?? 0;
            const isTierLocked = requiredTierRank > userTierRank && !hasAccess;
            const isSelected = modelId === value;

            const tierBadge = requiredTierRank > 0 ? TIER_LABELS[requiredTier] : null;
            // Kimi K2.6 costs more on Together AI ($1.20 input → x4 vs x3 on Fireworks).
            const costLabel = modelId === 'fireworks-kimi-k2p6' && useTogetherKimi
              ? 'x4'
              : MODEL_COST_LABEL[modelId];

            return (
              <button
                key={modelId}
                type="button"
                onClick={() => handleSelect(modelId)}
                className={cn(
                  'flex w-full items-center gap-3 px-3 py-2.5 text-left transition',
                  isSelected ? 'bg-elevated' : 'hover:bg-elevated/60',
                  isTierLocked && 'opacity-50',
                )}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={cn('text-sm font-medium', isSelected ? 'text-foreground' : 'text-foreground')}>
                      {config.displayName}
                    </span>
                    <span className="inline-flex items-center rounded-full bg-soft px-1.5 py-0.5 text-[10px] font-medium text-muted">
                      {providerLabel(modelId)}
                    </span>
                    {tierBadge && (
                      <span className={cn(
                        'inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                        requiredTier === 'max'
                          ? 'bg-accent/10 text-accent'
                          : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                      )}>
                        {tierBadge}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-muted mt-0.5">
                    <span>{formatContextSize(config.maxContextTokens)} context</span>
                    <span className="text-muted/50">·</span>
                    <span className="font-medium">{costLabel}</span>
                  </div>
                </div>
                {(isCredentialMissing && !isTierLocked && !SERVER_KEY_MODELS.has(modelId)) && (
                  <div className="flex items-center gap-1 text-muted">
                    <Lock className="h-3 w-3" />
                    <span className="text-[10px]">no key</span>
                  </div>
                )}
                {isTierLocked && (
                  <div className="flex items-center gap-1 text-muted">
                    <Lock className="h-3 w-3" />
                    <span className="text-[10px]">{tierBadge}</span>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
