import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/server';
import { getUserTierAndLimits } from '@/lib/tier';
import { getWeeklyCredits, getMonthlyCredits, getWeeklyLimit, getMonthlyLimit } from '@/lib/credits';
import { countUserConvexProjects } from '@/lib/usage';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const limits = await getUserTierAndLimits(userId);
  const tier = limits.tier;
  const weeklyLimit = getWeeklyLimit(tier);
  const monthlyLimit = getMonthlyLimit(tier);

  const [weeklyUsed, monthlyUsed, convexCount] = await Promise.all([
    getWeeklyCredits(userId),
    getMonthlyCredits(userId),
    countUserConvexProjects(userId),
  ]);

  const pct = weeklyLimit > 0 ? Math.min(100, Math.round((weeklyUsed / weeklyLimit) * 100)) : 0;

  return NextResponse.json({
    tier,
    weeklyUsed,
    weeklyLimit,
    monthlyUsed,
    monthlyLimit,
    pct,
    convexProjectsLeft: Math.max(0, limits.maxConvexProjects - convexCount),
  });
}
