'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Lock } from 'lucide-react';
import { MODEL_CONFIGS, isModelDisabled, modelDisabledReason, type ModelId } from '@/lib/agent/models';
import { cn } from '@/lib/utils';
import { chipClass } from './button';
import { useToast } from '@/components/ui/toast';
import type { LimitReachedPayload } from '@/components/ui/LimitModal';
import { useClampToViewport } from '@/components/ui/use-clamp-to-viewport';
import { BottomSheet, useIsPhone } from '@/components/ui/sheet';

export interface ModelSelectorProps {
  value: ModelId;
  onChange: (model: ModelId) => void;
  providerAccess: Record<string, boolean | null>; // provider → has credentials
  /** Current user tier — used to show/block tier-locked models */
  userTier?: 'free' | 'pro' | 'max';
  /** Called when user selects a tier-locked model — triggers upsell modal */
  onTierLocked?: (payload: LimitReachedPayload) => void;
  size?: 'sm' | 'md';
  /** 'composer' renders a borderless, fully-rounded trigger that sits inside a
   *  prompt box next to its round icon buttons (attach, send). */
  variant?: 'default' | 'composer';
  className?: string;
  /** Optional content rendered inside the trigger pill, left of the model
   *  name and separated by a divider — e.g. the agent backend glyph, so the
   *  agent identity and the model read as one body. */
  leading?: ReactNode;
  /** Which way the dropdown opens. 'up' (bottom-full) for bottom toolbars like
   *  the landing prompt box, where a downward menu is clipped by the hero's
   *  overflow-hidden; 'down' (default) for top toolbars like the agent panel,
   *  where opening upward would run off the top of the panel. */
  openDirection?: 'up' | 'down';
  /** Which trigger edge the dropdown lines up with. Defaults to 'end' for the
   *  small size and 'start' otherwise. */
  align?: 'start' | 'end';
}

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  fireworks: 'Fireworks',
  google: 'Google',
  xai: 'xAI',
};

/** Minimum tier required to use a model on server-side keys (must match backend MODEL_TIER_REQUIREMENT) */
const MODEL_SERVER_TIER: Partial<Record<ModelId, 'free' | 'pro' | 'max'>> = {
  'fireworks-deepseek-v4p1-flash': 'free',
  'fireworks-kimi-k3p1-pro': 'pro', // Pro+ for server key; free requires BYOK (Fireworks)
  'gpt-6.2-astra': 'max',           // Max-only
  'gpt-6.2-sol': 'pro',             // Pro+ for server key; free requires BYOK/OAuth
  'gpt-6-luna': 'free',             // free — default model, served on the platform key
  'claude-sonnet-5-5': 'pro',       // Pro+
  'claude-opus-5-5': 'pro',         // Pro+
  'claude-fable-5-2': 'max',        // Max-only
  'gemini-4-neon': 'pro',           // Pro+ for server key; free requires BYOK
  'grok-4.7': 'pro',                // Pro+ for server key; free requires BYOK (xAI)
};

/**
 * Models served via platform server keys — BYOK not required for eligible tiers.
 * Selecting these skips the "missing API key" BYOK check.
 */
const SERVER_KEY_MODELS = new Set<ModelId>([
  'fireworks-deepseek-v4p1-flash',
  'fireworks-kimi-k3p1-pro',
  'gpt-6.2-astra',
  'gpt-6.2-sol',
  'gpt-6-luna',
  'claude-sonnet-5-5',
  'claude-opus-5-5',
  'claude-fable-5-2',
  'gemini-4-neon',
  'grok-4.7',
]);

/** Per-model cost hint ("x6", "x0.3") — derived from pricing; see ModelConfig.costMultiplier. */
/** How fast a model spends credits relative to the baseline, e.g. "6× credits". */
function costLabel(modelId: ModelId): string {
  return `${MODEL_CONFIGS[modelId].costMultiplier}× credits`;
}

const TIER_RANK: Record<string, number> = { free: 0, pro: 1, max: 2 };
const TIER_LABELS: Record<string, string> = { pro: 'Pro', max: 'Max' };

function formatContextSize(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`;
  return String(tokens);
}

// Order: cheapest → most expensive (by cost multiplier; stable for ties)
const MODEL_ORDER: ModelId[] = (Object.keys(MODEL_CONFIGS) as ModelId[])
  .sort((a, b) => MODEL_CONFIGS[a].costMultiplier - MODEL_CONFIGS[b].costMultiplier);

export function ModelSelector({ value, onChange, providerAccess, userTier = 'free', onTierLocked, size = 'md', variant = 'default', className, leading, openDirection = 'down', align }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Keep the menu inside the window (it's right- or left-aligned to the trigger).
  const dropdownRef = useClampToViewport<HTMLDivElement>(open);
  const { toast } = useToast();
  // On a phone the list is a bottom sheet: anchored to its button it runs
  // under the header or off the side of the screen.
  const isPhone = useIsPhone();

  /** Provider label for the dropdown badge. */
  const providerLabel = (modelId: ModelId) => PROVIDER_LABELS[MODEL_CONFIGS[modelId].provider];

  const currentConfig = MODEL_CONFIGS[value];

  const handleSelect = useCallback((modelId: ModelId) => {
    const config = MODEL_CONFIGS[modelId];

    // Globally disabled model (e.g. rescinded by the provider) — never selectable
    // for any user/tier/auth path. The option stays visible but inert.
    if (isModelDisabled(modelId)) {
      toast({
        title: `${config.displayName} unavailable`,
        description: modelDisabledReason(modelId),
      });
      return;
    }

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
    // The phone sheet lives outside this container and has its own backdrop.
    if (!open || isPhone) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, isPhone]);

  // Close on Escape (the phone sheet handles its own)
  useEffect(() => {
    if (!open || isPhone) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, isPhone]);

  const options = (
    <>
      {MODEL_ORDER.map((modelId) => {
        const config = MODEL_CONFIGS[modelId];
        const hasAccess = providerAccess[config.provider];
        const isCredentialMissing = hasAccess === false;
        const requiredTier = MODEL_SERVER_TIER[modelId] ?? 'free';
        const userTierRank = TIER_RANK[userTier] ?? 0;
        const requiredTierRank = TIER_RANK[requiredTier] ?? 0;
        const isTierLocked = requiredTierRank > userTierRank && !hasAccess;
        const isSelected = modelId === value;
        const isDisabled = isModelDisabled(modelId);
        const disabledReason = isDisabled ? modelDisabledReason(modelId) : '';

        const tierBadge = requiredTierRank > 0 ? TIER_LABELS[requiredTier] : null;
        const modelCostLabel = costLabel(modelId);

        return (
          <button
            key={modelId}
            type="button"
            onClick={() => handleSelect(modelId)}
            disabled={isDisabled}
            aria-disabled={isDisabled}
            title={isDisabled ? disabledReason : undefined}
            className={cn(
              'flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors max-sm:min-h-14 max-sm:rounded-lg max-sm:px-3',
              isSelected ? 'bg-elevated dark:bg-soft' : 'hover:bg-elevated dark:hover:bg-soft',
              isTierLocked && 'opacity-50',
              isDisabled && 'opacity-50 cursor-not-allowed hover:bg-transparent',
            )}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[13px] font-medium text-fg max-sm:text-[15px]">
                  {config.displayName}
                </span>
                {/* Provider is plain text; only the plan requirement is a tag. */}
                <span className="text-xs text-muted max-sm:text-[13px]">{providerLabel(modelId)}</span>
                {/* A locked row already says which plan it needs, beside its lock. */}
                {tierBadge && !isTierLocked && (
                  <span className={cn(
                    'inline-flex items-center rounded-full border px-1.5 py-px text-[11px] font-medium',
                    // Plan tags are tinted so they never read as a provider tag.
                    'border-accent/25 bg-accent-soft text-accent'
                  )}>
                    {tierBadge}
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-muted max-sm:text-[13px]">
                <span>{formatContextSize(config.maxContextTokens)} context</span>
                <span className="text-subtle">·</span>
                <span>{modelCostLabel}</span>
              </div>
              {isDisabled && (
                <div className="mt-0.5 text-xs text-muted">{disabledReason}</div>
              )}
            </div>
            {isSelected && !isDisabled && <Check className="h-4 w-4 shrink-0 text-fg" aria-label="Selected" />}
            {isDisabled && (
              <div className="flex items-center gap-1 text-muted">
                <Lock className="h-3 w-3" />
                <span className="text-[11px]">Unavailable</span>
              </div>
            )}
            {(!isDisabled && isCredentialMissing && !isTierLocked && !SERVER_KEY_MODELS.has(modelId)) && (
              <div className="flex items-center gap-1 text-muted">
                <Lock className="h-3 w-3" />
                <span className="text-[11px]">No key</span>
              </div>
            )}
            {!isDisabled && isTierLocked && (
              <div className="flex items-center gap-1 text-muted">
                <Lock className="h-3 w-3" />
                <span className="text-[11px]">{tierBadge}</span>
              </div>
            )}
          </button>
        );
      })}
    </>
  );
  // Says what the multiplier is relative to.
  const note = (className: string) => (
    <p className={className}>
      Rates compare models for the same token use: a 6× model costs six times the credits of a 1× model.
    </p>
  );

  const isSm = size === 'sm';
  const isComposer = variant === 'composer';
  const dropdownAlign = align ?? (isSm ? 'end' : 'start');

  return (
    <div ref={containerRef} className={cn('relative pointer-events-auto', className)}>
      {/* Trigger button */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'inline-flex items-center gap-1.5 transition min-w-0',
          isComposer
            ? cn(
                'h-11 max-w-[200px] rounded-md pl-1.5 pr-2 text-[13px] font-medium text-muted hover:bg-elevated hover:text-fg md:h-7 md:text-xs',
                open && 'bg-elevated text-fg',
              )
            : isSm
              ? 'max-w-[180px] rounded-md border border-border bg-linear-to-b from-bg to-surface inset-shadow-bevel dark:from-elevated dark:to-surface px-2 py-1 text-xs text-muted shadow-xs hover:border-border-strong pointer-coarse:h-9 pointer-coarse:px-2.5 pointer-coarse:text-[13px]'
              : cn(
                  chipClass,
                  'pointer-events-auto max-w-[120px] justify-start sm:max-w-[200px] pointer-coarse:max-w-[150px] pointer-coarse:max-[359px]:max-w-[100px] pointer-coarse:max-[359px]:px-3',
                ),
        )}
      >
        {leading != null && (
          <>
            {leading}
            {/* In the composer the glyph and model name read as one chip, so
                spacing alone separates them — no divider. */}
            {!isComposer && <span aria-hidden className="h-4 w-px shrink-0 bg-border" />}
          </>
        )}
        <span className="truncate">{currentConfig.displayName}</span>
        <ChevronDown
          className={cn(
            isSm || isComposer ? 'h-3 w-3' : 'h-3.5 w-3.5',
            'opacity-50 shrink-0 transition-transform',
            open && isComposer && 'rotate-180',
          )}
        />
      </button>

      {/* Phone: a bottom sheet */}
      {open && isPhone && (
        <BottomSheet open onClose={() => setOpen(false)} title="Choose a model" trigger={triggerRef}>
          <div role="group" aria-label="Models" className="px-2 pb-1">
            {options}
          </div>
          {note('border-t border-border px-5 py-3 text-[13px] leading-relaxed text-muted')}
        </BottomSheet>
      )}

      {/* Dropdown */}
      {open && !isPhone && (
        <div
          ref={dropdownRef}
          className={cn(
            // A column: the list scrolls if it must, the note below it never does.
            'absolute z-50 flex max-h-[calc(100dvh-7rem)] min-w-[min(288px,calc(100vw-16px))] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-xl border border-border bg-bg shadow-lg dark:border-border-strong dark:bg-elevated inset-shadow-bevel-top',
            // 'up' opens above the trigger (bottom toolbars like the landing
            // prompt box, where a downward menu is clipped by the hero's
            // overflow-hidden); 'down' opens below (top toolbars like the agent
            // panel, where opening upward would run off the top of the panel).
            openDirection === 'up' ? (isComposer ? 'bottom-full mb-2' : 'bottom-full mb-1') : 'top-full mt-1',
            dropdownAlign === 'end' ? 'right-0' : 'left-0',
          )}
        >
          <div className="modern-scrollbar min-h-0 flex-1 overflow-y-auto p-1">{options}</div>
          {note('shrink-0 border-t border-border px-3.5 py-2.5 text-xs leading-relaxed text-muted')}
        </div>
      )}
    </div>
  );
}
