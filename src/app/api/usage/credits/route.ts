import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/server';
import { getUserTier } from '@/lib/tier';
import {
  getWeeklyCredits,
  getMonthlyCredits,
  getWeeklyLimit,
  getMonthlyLimit,
} from '@/lib/credits';
import { getDb } from '@/db';
import { usageRecords } from '@/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { currentPeriod } from '@/lib/usage';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const tier = await getUserTier(userId);
  const weeklyLimit = getWeeklyLimit(tier);
  const monthlyLimit = getMonthlyLimit(tier);

  const [weeklyUsed, monthlyUsed] = await Promise.all([
    getWeeklyCredits(userId),
    getMonthlyCredits(userId),
  ]);

  const weeklyPct = weeklyLimit > 0 ? Math.min(100, Math.round((weeklyUsed / weeklyLimit) * 100)) : 0;
  const monthlyPct = monthlyLimit > 0 ? Math.min(100, Math.round((monthlyUsed / monthlyLimit) * 100)) : 0;

  // Per-model breakdown for this period
  const db = getDb();
  const modelRows = await db
    .select({
      model: usageRecords.model,
      credits: sql<number>`COALESCE(SUM(credits), 0)::int`,
      turns: sql<number>`COALESCE(SUM(agent_turns), 0)::int`,
      tokensIn: sql<number>`COALESCE(SUM(tokens_in), 0)::int`,
      tokensOut: sql<number>`COALESCE(SUM(tokens_out), 0)::int`,
      cachedTokensRead: sql<number>`COALESCE(SUM(cached_tokens_read), 0)::int`,
      cachedTokensWrite: sql<number>`COALESCE(SUM(cached_tokens_write), 0)::int`,
    })
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.userId, userId),
        eq(usageRecords.period, currentPeriod())
      )
    )
    .groupBy(usageRecords.model)
    .orderBy(sql`SUM(credits) DESC`);

  return NextResponse.json({
    tier,
    weeklyUsed,
    weeklyLimit,
    monthlyUsed,
    monthlyLimit,
    pct: weeklyPct,
    monthlyPct,
    models: modelRows.map(r => ({
      model: r.model,
      credits: Number(r.credits),
      turns: Number(r.turns),
      tokensIn: Number(r.tokensIn),
      tokensOut: Number(r.tokensOut),
      cachedTokensRead: Number(r.cachedTokensRead),
      cachedTokensWrite: Number(r.cachedTokensWrite),
    })),
  });
}
