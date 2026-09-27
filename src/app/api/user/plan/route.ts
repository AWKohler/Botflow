import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/server';
import { getUserTierAndLimits } from '@/lib/tier';

export const dynamic = 'force-dynamic';

/**
 * GET /api/user/plan
 * Returns the current user's tier and feature flags derived from it.
 * Uses the same getUserTierAndLimits() path as all server-side gating,
 * so manually-set publicMetadata.plan is honoured correctly.
 */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const limits = await getUserTierAndLimits(userId);

  return NextResponse.json({
    tier: limits.tier,
    canUseCustomDomain: limits.customDomain,
    managedDomains: limits.managedDomains,
    maxManagedDomains: limits.maxManagedDomains,
  });
}
