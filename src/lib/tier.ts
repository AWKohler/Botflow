/**
 * Tier detection and plan limits.
 *
 * Tiers: 'free' | 'pro' | 'max'
 *
 * Tier is read from Clerk user publicMetadata.plan.
 * All numeric limits are env-var driven so they can be tuned without a deploy.
 */

import { auth, clerkClient } from '@clerk/nextjs/server';
import { redis } from './redis';

export type Tier = 'free' | 'pro' | 'max';

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
        maxProjects: 3,
        maxAgentTurnsPerDay: 0, // no daily turn cap — credit budget handles it
        monthlyCreditBudget: envInt('CREDITS_FREE_MONTHLY', 500_000),
        maxConvexProjects: 1,
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
        maxProjects: 15,
        maxAgentTurnsPerDay: 0,
        monthlyCreditBudget: envInt('CREDITS_PRO_MONTHLY', 10_000_000),
        maxConvexProjects: 3,
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
        maxProjects: Infinity,
        maxAgentTurnsPerDay: 0,
        monthlyCreditBudget: envInt('CREDITS_MAX_MONTHLY', 50_000_000),
        maxConvexProjects: 10,
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

// Short TTL — Clerk's PricingTable updates the JWT immediately after purchase,
// so a 60s cache is safe and avoids hammering Clerk's API.
const TIER_CACHE_TTL = 60;
const BETA_CACHE_TTL = 60;

/**
 * One Clerk round-trip that returns BOTH the manually-set plan and beta status.
 * Sharing this read is the whole reason `getUserTier` never fetches Clerk twice
 * to resolve tier + beta — they both live in publicMetadata.
 *
 * NB: beta status is cached as the string 'yes'/'no' (not 'true'/'false' or
 * '1'/'0') because @upstash/redis JSON-parses values on read — those literals
 * would come back as a boolean/number and break the equality checks. The tier
 * cache relies on the same "non-JSON string" trick.
 */
async function fetchClerkUserAttrs(
  userId: string,
): Promise<{ plan?: string; isBeta: boolean }> {
  const client = await clerkClient();
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
  // ── Primary: auth().has({ plan }) ────────────────────────────────────────
  // Reads the JWT session token that Clerk refreshes automatically after a
  // subscription change. This is the source-of-truth for Clerk built-in billing.
  // Falls through to the publicMetadata fallback if called outside request context.
  const cacheKey = `tier:${userId}`;

  try {
    const { has } = await auth();
    // Paid plans short-circuit with NO Clerk fetch — beta can only raise a free
    // user to pro, so a confirmed pro/max user never needs a beta lookup.
    if (has({ plan: 'max' })) {
      await redis.setex(cacheKey, TIER_CACHE_TTL, 'max').catch(() => {});
      return 'max';
    }
    if (has({ plan: 'pro' })) {
      await redis.setex(cacheKey, TIER_CACHE_TTL, 'pro').catch(() => {});
      return 'pro';
    }
    // has() is false for both — one fetch yields the manual plan AND beta flag.
    // (This fetch already happened pre-beta to read publicMetadata.plan; reading
    // isBeta off the same object adds zero round-trips.)
    const { plan, isBeta } = await fetchClerkUserAttrs(userId);
    const tier = resolveTier(plan, isBeta);
    await Promise.all([
      redis.setex(cacheKey, TIER_CACHE_TTL, tier).catch(() => {}),
      // Warm the beta cache so a same-request isBetaUser() (e.g. the Swift gate)
      // is a free cache hit instead of a second Clerk fetch.
      redis.setex(`beta:${userId}`, BETA_CACHE_TTL, isBeta ? 'yes' : 'no').catch(() => {}),
    ]);
    return tier;
  } catch {
    // ── Fallback: Redis cache → Clerk backend API ─────────────────────────
    // Used when auth() context is not available (e.g. webhook handlers).
    const cached = await redis.get<string>(cacheKey);
    if (cached === 'free' || cached === 'pro' || cached === 'max') return cached;

    const { plan, isBeta } = await fetchClerkUserAttrs(userId);
    const tier = resolveTier(plan, isBeta);
    await Promise.all([
      redis.setex(cacheKey, TIER_CACHE_TTL, tier).catch(() => {}),
      redis.setex(`beta:${userId}`, BETA_CACHE_TTL, isBeta ? 'yes' : 'no').catch(() => {}),
    ]);
    return tier;
  }
}

/** Get tier + limits together (most callers need both) */
export async function getUserTierAndLimits(userId: string): Promise<TierLimits> {
  const tier = await getUserTier(userId);
  return getLimitsForTier(tier);
}

/** Invalidate the tier cache for a user (call after subscription change webhook) */
export async function invalidateTierCache(userId: string): Promise<void> {
  await redis.del(`tier:${userId}`);
}

// ─── Beta access ────────────────────────────────────────────────────────────

/**
 * Whether the user is a beta tester (publicMetadata.isBeta === true). Beta users
 * get early features (currently: Swift projects) and an automatic Pro tier floor
 * via {@link getUserTier}. Cached 60s; warmed for free as a side effect of
 * getUserTier's metadata fetch, so the common path is a single Clerk round-trip.
 */
export async function isBetaUser(userId: string): Promise<boolean> {
  const cacheKey = `beta:${userId}`;
  const cached = await redis.get<string>(cacheKey);
  if (cached === 'yes') return true;
  if (cached === 'no') return false;
  const { isBeta } = await fetchClerkUserAttrs(userId);
  await redis.setex(cacheKey, BETA_CACHE_TTL, isBeta ? 'yes' : 'no').catch(() => {});
  return isBeta;
}

/** Invalidate the beta cache for a user (call after a publicMetadata change). */
export async function invalidateBetaCache(userId: string): Promise<void> {
  await redis.del(`beta:${userId}`);
}

// ─── Model → tier requirement ─────────────────────────────────────────────────

/** Which tier is required to use a model on server-side keys */
export const MODEL_TIER_REQUIREMENT: Record<string, Tier> = {
  'fireworks-minimax-m2p7': 'free',
  'fireworks-glm-5p1': 'free',
  'fireworks-kimi-k2p6': 'free',
  'gpt-5.3-codex': 'pro',            // Pro+ for server key; free requires BYOK/OAuth
  'gpt-5.4': 'pro',                  // Pro+ for server key
  'gpt-5.5': 'pro',                  // Pro+ for server key
  'claude-sonnet-4-6': 'pro',        // Pro+ for server key
  'claude-opus-4-7': 'pro',          // Pro+ for server key
  'claude-fable-5': 'max',           // Max-only on server key; free/pro require BYOK/OAuth
  'gemini-3.1-pro-preview': 'pro',   // Pro+ for server key; free requires BYOK
};

const TIER_RANK: Record<Tier, number> = { free: 0, pro: 1, max: 2 };

export function tierMeetsRequirement(userTier: Tier, required: Tier): boolean {
  return TIER_RANK[userTier] >= TIER_RANK[required];
}

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
