import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAdmin } from '@/lib/panel/auth';
import { panelCached } from '@/lib/panel/cache';
import { getPanelUserDirectory } from '@/lib/panel/clerk-users';
import { getPerUserUsage, getPerUserProjects } from '@/lib/panel/queries';
import { planPriceUsd, creditsToUsd } from '@/lib/panel/pricing';
import { getMonthlyLimit } from '@/lib/credits';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function computeUsers() {
  const [directory, usageByUser, projectsByUser] = await Promise.all([
    getPanelUserDirectory(),
    getPerUserUsage(),
    getPerUserProjects(),
  ]);

  const rows = directory.users.map((u) => {
    const usage = usageByUser.get(u.userId);
    const proj = projectsByUser.get(u.userId);
    const monthCredits = usage?.monthCredits ?? 0;
    const monthCostUsd = creditsToUsd(monthCredits);
    // Beta-floored users pay $0 — revenue keys off the raw paid plan.
    const revenueUsd = u.plan === 'max' ? planPriceUsd('max') : u.plan === 'pro' ? planPriceUsd('pro') : 0;
    const monthlyLimit = getMonthlyLimit(u.tier);

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
