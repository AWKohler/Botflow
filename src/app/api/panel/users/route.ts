import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAdmin } from '@/lib/panel/auth';
import { panelCached } from '@/lib/panel/cache';
import { getPanelUserDirectory } from '@/lib/panel/clerk-users';
import { getPerUserUsage, getPerUserProjects } from '@/lib/panel/queries';
import { planPriceUsd, creditsToUsd } from '@/lib/panel/pricing';
import { getStripeRevenue } from '@/lib/panel/stripe';
import { getMonthlyLimit } from '@/lib/credits';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function computeUsers() {
  const [directory, usageByUser, projectsByUser, stripe] = await Promise.all([
    getPanelUserDirectory(),
    getPerUserUsage(),
    getPerUserProjects(),
    getStripeRevenue(),
  ]);

  const rows = directory.users.map((u) => {
    const usage = usageByUser.get(u.userId);
    const proj = projectsByUser.get(u.userId);
    const monthCredits = usage?.monthCredits ?? 0;
    const monthCostUsd = creditsToUsd(monthCredits);
    // Beta-floored users pay $0 — revenue keys off the raw paid plan.
    const planRevenueUsd = u.plan === 'max' ? planPriceUsd('max') : u.plan === 'pro' ? planPriceUsd('pro') : 0;
    const monthlyLimit = getMonthlyLimit(u.tier);

    // Real Stripe money for this user, when their customer record carries a
    // Clerk id. A live subscription is authoritative for monthly revenue;
    // otherwise fall back to the plan sticker price.
    const sr = stripe.byClerkUserId[u.userId];
    const revenueUsd = sr?.subscription ? sr.subscription.monthlyUsd : planRevenueUsd;

    return {
      userId: u.userId,
      email: u.email,
      name: u.name,
      imageUrl: u.imageUrl,
      tier: u.tier,
      plan: u.plan,
      isBeta: u.isBeta,
      joinedAt: u.createdAt,
      lastSignInAt: u.lastSignInAt,
      lastActiveAt: proj?.lastActiveAt ?? null,
      liveNow: proj?.liveNow ?? false,
      projectCount: proj?.projectCount ?? 0,
      convexInstances: proj?.convexPlatformCount ?? 0,
      convexPaused: proj?.convexPausedCount ?? 0,
      cfDeployments: proj?.cfDeployments ?? 0,
      vercelSandboxes: proj?.vercelSandboxes ?? 0,
      sandboxHostSandboxes: proj?.sandboxHostSandboxes ?? 0,
      stripeLiveProjects: proj?.stripeLiveProjects ?? 0,
      revenuecatProjects: proj?.revenuecatProjects ?? 0,
      managedDomains: proj?.managedDomains ?? 0,
      monthCredits,
      monthCostUsd,
      monthTurns: usage?.monthTurns ?? 0,
      lifetimeCredits: usage?.lifetimeCredits ?? 0,
      lifetimeCostUsd: creditsToUsd(usage?.lifetimeCredits ?? 0),
      lifetimeTurns: usage?.lifetimeTurns ?? 0,
      models: usage?.models ?? [],
      budgetUtilPct: monthlyLimit > 0 ? (monthCredits / monthlyLimit) * 100 : 0,
      monthRevenueUsd: revenueUsd,
      revenueBasis: sr?.subscription ? ('stripe' as const) : ('estimate' as const),
      // Real money, straight from Stripe (net of refunds). 0 when the user has
      // never paid or their customer record carries no Clerk id.
      lifetimeRevenueUsd: sr?.lifetimeNetUsd ?? 0,
      stripeMonthRevenueUsd: sr?.monthNetUsd ?? 0,
      stripeSubscription: sr?.subscription ?? null,
      // The number that matters: what this user pays vs what their LLM usage
      // costs the platform this month. Sandbox/Convex costs aren't metered
      // per-user yet, so margin is an upper bound.
      monthMarginUsd: revenueUsd - monthCostUsd,
    };
  });

  return {
    rows,
    totalCount: directory.totalCount,
    truncated: directory.truncated,
    stripe: {
      configured: stripe.configured,
      error: stripe.error ?? null,
      // How much of Stripe's realized revenue we could attribute to a Clerk
      // user — the rest sits behind customers with no user_id metadata.
      attributedUsers: Object.keys(stripe.byClerkUserId).length,
      lifetimeNetUsd: stripe.revenue.lifetimeNetUsd,
    },
    generatedAt: new Date().toISOString(),
  };
}

export async function GET(req: NextRequest) {
  const adminId = await requirePanelAdmin();
  if (!adminId) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    const refresh = req.nextUrl.searchParams.get('refresh') === '1';
    const data = await panelCached('users', 120, refresh, computeUsers);
    return NextResponse.json(data);
  } catch (error) {
    console.error('[panel/users] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load users' },
      { status: 500 },
    );
  }
}
