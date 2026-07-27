/**
 * Panel-side money constants.
 *
 * Plan prices are NOT in this repo (they live in Clerk Billing's dashboard
 * config), so MRR and per-user revenue are ESTIMATES: subscriber count × the
 * env-configured sticker price. When real Stripe access to the Clerk Billing
 * account exists, swap these for invoice-derived numbers.
 */

import type { Tier } from '@/lib/tier-shared';

function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseFloat(v);
  return isNaN(n) ? fallback : n;
}

/**
 * Monthly sticker price per tier, USD. The defaults are the real published
 * prices (confirmed 2026-07-27); env vars exist to retune them without a
 * deploy if pricing changes, not because the defaults are placeholders.
 */
export function planPriceUsd(tier: Tier): number {
  switch (tier) {
    case 'free':
      return 0;
    case 'pro':
      return envNum('PANEL_PRICE_PRO_USD', 20);
    case 'max':
      return envNum('PANEL_PRICE_MAX_USD', 50);
  }
}

// 1 credit = 1 MiniMax uncached input token = $0.30 / 1M tokens. Matches
// BASE_PRICE in src/lib/credits.ts — credits are USD-denominated by design.
export const COST_PER_CREDIT_USD = 0.3 / 1_000_000;

export function creditsToUsd(credits: number): number {
  return credits * COST_PER_CREDIT_USD;
}
