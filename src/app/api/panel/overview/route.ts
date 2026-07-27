import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAdmin } from '@/lib/panel/auth';
import { panelCached } from '@/lib/panel/cache';
import { getPanelUserDirectory } from '@/lib/panel/clerk-users';
import {
  getUsageOverview,
  getPerUserUsage,
  getProjectAggregates,
  getConvexAggregates,
  getWebhookHealth,
} from '@/lib/panel/queries';
import { planPriceUsd, creditsToUsd } from '@/lib/panel/pricing';
import { getStripeRevenue } from '@/lib/panel/stripe';
import { getMonthlyLimit } from '@/lib/credits';
import type { Tier } from '@/lib/tier-shared';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export interface PanelAlert {
  severity: 'warning' | 'serious';
  label: string;
  detail: string;
}

async function computeOverview() {
  const [directory, usage, perUser, projects, convex, webhooks, stripe] =
    await Promise.all([
      getPanelUserDirectory(),
      getUsageOverview(),
      getPerUserUsage(),
      getProjectAggregates(),
      getConvexAggregates(),
      getWebhookHealth(),
      getStripeRevenue(),
    ]);

  // ── Subscribers & estimated MRR ───────────────────────────────────────────
  // Beta users get a pro-tier FLOOR but pay nothing — MRR counts only users
  // whose publicMetadata.plan is literally 'pro' | 'max'.
  const paidPro = directory.users.filter((u) => u.plan === 'pro').length;
  const paidMax = directory.users.filter((u) => u.plan === 'max').length;
  const betaUsers = directory.users.filter((u) => u.isBeta).length;
  const mrrUsd = paidPro * planPriceUsd('pro') + paidMax * planPriceUsd('max');

  const now = Date.now();
  const signups7d = directory.users.filter(
    (u) => now - Date.parse(u.createdAt) < 7 * 864e5,
  ).length;
  const signups30d = directory.users.filter(
    (u) => now - Date.parse(u.createdAt) < 30 * 864e5,
  ).length;

  // ── Margin ────────────────────────────────────────────────────────────────
  // Prefer Stripe's real MRR for THIS platform (legacy products on the same
  // account are excluded upstream — counting them would flatter the margin
  // with revenue this product never earned). Falls back to the plan-price
  // estimate when Stripe has no attributed subscription yet.
  const llmCostThisMonth = usage.thisMonth.costUsd;
  const mrrForMargin = stripe.configured && stripe.mrrUsd > 0 ? stripe.mrrUsd : mrrUsd;
  const grossMarginUsd = mrrForMargin - llmCostThisMonth;

  // ── Budget pressure: paying users near their monthly credit ceiling ───────
  const tierOf = new Map(directory.users.map((u) => [u.userId, u.tier]));
  let usersOver80Pct = 0;
  for (const [userId, u] of perUser) {
    const tier: Tier = tierOf.get(userId) ?? 'free';
    const limit = getMonthlyLimit(tier);
    if (limit > 0 && u.monthCredits / limit >= 0.8) usersOver80Pct++;
  }

  // ── Alerts ────────────────────────────────────────────────────────────────
  const alerts: PanelAlert[] = [];
  const stripeExhausted = webhooks.stripe
    .filter((s) => s.status === 'exhausted')
    .reduce((a, s) => a + s.count, 0);
  const stripeFailed = webhooks.stripe
    .filter((s) => s.status === 'failed')
    .reduce((a, s) => a + s.count, 0);
  const rcBad = webhooks.revenuecat
    .filter((s) => s.status === 'failed' || s.status === 'exhausted')
    .reduce((a, s) => a + s.count, 0);
  if (stripeExhausted > 0)
    alerts.push({
      severity: 'serious',
      label: 'Stripe deliveries exhausted',
      detail: `${stripeExhausted} payment event(s) permanently failed delivery to project backends.`,
    });
  if (stripeFailed > 0)
    alerts.push({
      severity: 'warning',
      label: 'Stripe deliveries retrying',
      detail: `${stripeFailed} payment event(s) currently in the retry queue.`,
    });
  if (rcBad > 0)
    alerts.push({
      severity: 'warning',
      label: 'RevenueCat delivery issues',
      detail: `${rcBad} entitlement event(s) failed or exhausted.`,
    });
  const convexPaused = convex.byStatus.find((s) => s.status === 'paused')?.count ?? 0;
  if (convexPaused > 0)
    alerts.push({
      severity: 'warning',
      label: 'Convex backends paused',
      detail: `${convexPaused} managed backend(s) paused (usage spike / abuse / spend cap).`,
    });
  if (convex.orphanedInstances > 0)
    alerts.push({
      severity: 'warning',
      label: 'Orphaned Convex instances',
      detail: `${convex.orphanedInstances} platform backend(s) belong to soft-deleted projects.`,
    });
  if (usersOver80Pct > 0)
    alerts.push({
      severity: 'warning',
      label: 'Users near credit ceiling',
      detail: `${usersOver80Pct} user(s) have used ≥80% of their monthly credit budget.`,
    });
  if (stripe.error)
    alerts.push({
      severity: 'warning',
      label: 'Stripe unreachable',
      detail: stripe.error,
    });
  if (stripe.subscriptions.pastDue > 0)
    alerts.push({
      severity: 'serious',
      label: 'Subscriptions past due',
      detail: `${stripe.subscriptions.pastDue} live subscription(s) are past_due — payment is failing.`,
    });
  if (stripe.health.failedChargesLast30d > 0)
    alerts.push({
      severity: 'warning',
      label: 'Failed charges',
      detail: `${stripe.health.failedChargesLast30d} charge(s) failed in the last 30 days.`,
    });
  // NB: no alert for the legacy products sharing this Stripe account — they
  // belong to an unrelated older venture and are expected. They're excluded
  // from every headline figure and shown in their own block instead.

  return {
    revenue: {
      mrrUsd,
      estimated: true,
      proPriceUsd: planPriceUsd('pro'),
      maxPriceUsd: planPriceUsd('max'),
      paidPro,
      paidMax,
      subscribers: paidPro + paidMax,
      betaUsers,
      grossMarginUsd,
      marginBasis: stripe.configured && stripe.mrrUsd > 0 ? 'stripe' : 'estimate',
      llmCostThisMonthUsd: llmCostThisMonth,
    },
    stripe: {
      configured: stripe.configured,
      error: stripe.error ?? null,
      account: stripe.account ?? null,
      mrrUsd: stripe.mrrUsd,
      subscriptions: stripe.subscriptions,
      revenue: stripe.revenue,
      legacy: stripe.legacy,
      accountTotals: stripe.accountTotals,
      health: stripe.health,
      attributedUsers: Object.keys(stripe.byClerkUserId).length,
      truncated: stripe.truncated,
    },
    users: {
      total: directory.totalCount,
      truncated: directory.truncated,
      free: directory.users.length - paidPro - paidMax,
      pro: paidPro,
      max: paidMax,
      signups7d,
      signups30d,
      activeThisMonth: usage.thisMonth.activeUsers,
      activeLastMonth: usage.lastMonth.activeUsers,
      usersOver80PctBudget: usersOver80Pct,
    },
    usage: {
      thisMonth: usage.thisMonth,
      lastMonth: usage.lastMonth,
      momCreditsGrowthPct:
        usage.lastMonth.credits > 0
          ? ((usage.thisMonth.credits - usage.lastMonth.credits) /
              usage.lastMonth.credits) *
            100
          : null,
      monthlyTrend: usage.monthlyTrend,
      byModelThisMonth: usage.byModelThisMonth,
      lifetimeCostUsd: creditsToUsd(
        usage.monthlyTrend.reduce((a, m) => a + m.credits, 0),
      ),
    },
    activity: {
      liveSessions: projects.liveSessionCount,
      activeProjects: projects.active,
      totalProjects: projects.total,
      projectsCreatedByMonth: projects.createdByMonth,
    },
    alerts,
    generatedAt: new Date().toISOString(),
  };
}

export async function GET(req: NextRequest) {
  const adminId = await requirePanelAdmin();
  if (!adminId) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    const refresh = req.nextUrl.searchParams.get('refresh') === '1';
    const data = await panelCached('overview', 120, refresh, computeOverview);
    return NextResponse.json(data);
  } catch (error) {
    console.error('[panel/overview] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load overview' },
      { status: 500 },
    );
  }
}
