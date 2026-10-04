/**
 * Tier detection and plan limits.
 *
 * Tiers: 'free' | 'pro' | 'max'
 *
 * Tier combines Neon billing entitlements with explicit plan and beta grants.
 * All numeric limits are env-var driven so they can be tuned without a deploy.
 */

import { identityClient } from '@/lib/auth/server';
import { redis } from './redis';
import { getPaidTier } from '@/lib/billing/entitlements';

export type { Tier } from './tier-shared';
import type { Tier } from './tier-shared';

export interface TierLimits {
  tier: Tier;
  // Projects
  maxProjects: number;
  // Agent turns per day (server-side keys only; BYOK is unlimited)
  maxAgentTurnsPerDay: number;
  // Monthly credit budget in MiniMax-equivalent tokens
  monthlyCreditBudget: number;
  // Convex backends
  maxConvexProjects: number;
  // Cloudflare Pages live deployments
  maxCfPagesDeployments: number;
  // Screenshots per day
  maxScreenshotsPerDay: number;
  // Agent request timeout (seconds)
  maxAgentDurationSecs: number;
  // Whether to allow custom deploy domains (legacy CNAME approach)
  customDomain: boolean;
  // Whether to allow managed domains (CF-zone-controlled, full DNS management)
  managedDomains: boolean;
  // Cap on number of managed domains per user
  maxManagedDomains: number;
}

// ─── Env-var helpers ──────────────────────────────────────────────────────────

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

// ─── Plan limit tables ────────────────────────────────────────────────────────

export function getLimitsForTier(tier: Tier): TierLimits {
  switch (tier) {
    case 'free':
      return {
        tier: 'free',
        maxProjects: envInt('MAX_PROJECTS_FREE', 3),
        maxAgentTurnsPerDay: 0, // no daily turn cap — credit budget handles it
        monthlyCreditBudget: envInt('CREDITS_FREE_MONTHLY', 500_000),
        maxConvexProjects: envInt('MAX_CONVEX_FREE', 0),
        maxCfPagesDeployments: 1,
        maxScreenshotsPerDay: 5,
        maxAgentDurationSecs: 120,
        customDomain: false,
        managedDomains: false,
        maxManagedDomains: 0,
      };

    case 'pro':
      return {
        tier: 'pro',
        maxProjects: envInt('MAX_PROJECTS_PRO', 20),
        maxAgentTurnsPerDay: 0,
        monthlyCreditBudget: envInt('CREDITS_PRO_MONTHLY', 10_000_000),
        maxConvexProjects: envInt('MAX_CONVEX_PRO', 8),
        maxCfPagesDeployments: 5,
        maxScreenshotsPerDay: 50,
        maxAgentDurationSecs: 240,
        customDomain: true,
        managedDomains: true,
        maxManagedDomains: 3,
      };

    case 'max':
      return {
        tier: 'max',
        maxProjects: envInt('MAX_PROJECTS_MAX', 30),
        maxAgentTurnsPerDay: 0,
        monthlyCreditBudget: envInt('CREDITS_MAX_MONTHLY', 50_000_000),
        maxConvexProjects: envInt('MAX_CONVEX_MAX', 20),
        maxCfPagesDeployments: 20,
        maxScreenshotsPerDay: Infinity,
        maxAgentDurationSecs: 300,
        customDomain: true,
        managedDomains: true,
        maxManagedDomains: 20,
      };
  }
}

// ─── Tier detection ───────────────────────────────────────────────────────────

// Only beta access is cached; paid subscriptions are checked against their expiry.
const BETA_CACHE_TTL = 60;

async function fetchIdentityUserAttrs(
  userId: string,
): Promise<{ plan?: string; isBeta: boolean }> {
  const client = await identityClient();
  const user = await client.users.getUser(userId);
  const md = (user.publicMetadata ?? {}) as Record<string, unknown>;
  return { plan: md.plan as string | undefined, isBeta: md.isBeta === true };
}

/** Resolve effective tier from a plan string + beta flag. Beta is a FLOOR — it
 *  lifts free → pro but never caps a manually-set max down to pro. */
function resolveTier(plan: string | undefined, isBeta: boolean): Tier {
  if (plan === 'max') return 'max';
  if (plan === 'pro') return 'pro';
  return isBeta ? 'pro' : 'free';
}

export async function getUserTier(userId: string): Promise<Tier> {
  // Always resolve the requested user, including cron jobs and shared projects.
  // Paid entitlement is never inferred from the caller's session or a stale cache.
  const [paid, { plan, isBeta }] = await Promise.all([getPaidTier(userId), fetchIdentityUserAttrs(userId)]);
  const manual = resolveTier(plan, isBeta);
  if (paid === 'max' || manual === 'max') return 'max';
  return paid === 'pro' || manual === 'pro' ? 'pro' : 'free';
}

export async function getUserTierAndLimits(userId: string): Promise<TierLimits> {
  return getLimitsForTier(await getUserTier(userId));
}

export async function invalidateTierCache(userId: string): Promise<void> {
  await redis.del(`identity:tier:${userId}`);
}

// ─── Beta access ────────────────────────────────────────────────────────────

/**
 * Whether the user is a beta tester (publicMetadata.isBeta === true). Beta users
 * get early features (currently: Swift projects) and an automatic Pro tier floor
 * via {@link getUserTier}. Cached 60s; warmed for free as a side effect of
 * getUserTier's metadata fetch, using the Neon identity profile.
 */
export async function isBetaUser(userId: string): Promise<boolean> {
  const cacheKey = `identity:beta:${userId}`;
  const cached = await redis.get<string>(cacheKey);
  if (cached === 'yes') return true;
  if (cached === 'no') return false;
  const { isBeta } = await fetchIdentityUserAttrs(userId);
  await redis.setex(cacheKey, BETA_CACHE_TTL, isBeta ? 'yes' : 'no').catch(() => {});
  return isBeta;
}

/** Invalidate the beta cache for a user (call after a publicMetadata change). */
export async function invalidateBetaCache(userId: string): Promise<void> {
  await redis.del(`identity:beta:${userId}`);
}

// ─── Model → tier requirement ─────────────────────────────────────────────────
// Moved to tier-shared.ts (client-safe — the backend derivation needs it in
// the browser); imported + re-exported here so server imports are untouched.

import { MODEL_TIER_REQUIREMENT, tierMeetsRequirement } from './tier-shared';
export { MODEL_TIER_REQUIREMENT, tierMeetsRequirement };

// ─── Stripe Connect ───────────────────────────────────────────────────────────

/**
 * Whether the given user is allowed to use Stripe Connect on their projects.
 * Pro/Max only. Returns a user-facing message on the deny path so callers can
 * surface it directly in chat / modals without templating their own copy.
 */
export async function canUseStripeConnect(
  userId: string
): Promise<{ allowed: boolean; tier: Tier; reason?: string }> {
  const tier = await getUserTier(userId);
  if (tierMeetsRequirement(tier, 'pro')) {
    return { allowed: true, tier };
  }
  return {
    allowed: false,
    tier,
    reason:
      'Stripe payments are a Pro/Max feature. Upgrade your plan to accept payments through your project.',
  };
}

// ─── AI image generation ──────────────────────────────────────────────────────

/**
 * Whether the given user is allowed to generate images with the AI image tool
 * (FAL / Krea 2 Medium). Pro/Max only — mirrors {@link canUseStripeConnect}.
 * Returns a user-facing message on the deny path so callers can surface it
 * directly in chat.
 */
export async function canGenerateImages(
  userId: string
): Promise<{ allowed: boolean; tier: Tier; reason?: string }> {
  const tier = await getUserTier(userId);
  if (tierMeetsRequirement(tier, 'pro')) {
    return { allowed: true, tier };
  }
  return {
    allowed: false,
    tier,
    reason:
      'AI image generation is a Pro/Max feature. Upgrade your plan to generate images inside your project.',
  };
}

// ─── RevenueCat ─────────────────────────────────────────────────────────────────

/**
 * Whether the given user is allowed to use RevenueCat (iOS in-app purchases) on
 * their projects. Pro/Max only — mirrors {@link canUseStripeConnect}. Returns a
 * user-facing message on the deny path so callers can surface it directly.
 */
export async function canUseRevenueCat(
  userId: string
): Promise<{ allowed: boolean; tier: Tier; reason?: string }> {
  const tier = await getUserTier(userId);
  if (tierMeetsRequirement(tier, 'pro')) {
    return { allowed: true, tier };
  }
  return {
    allowed: false,
    tier,
    reason:
      'In-app purchases are a Pro/Max feature. Upgrade your plan to accept payments in your iOS app.',
  };
}
