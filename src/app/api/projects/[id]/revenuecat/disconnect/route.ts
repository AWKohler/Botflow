/**
 * POST /api/projects/[id]/revenuecat/disconnect
 *
 * Turns RevenueCat off for this project and removes what Botflow holds for it:
 * the stored secret key and the webhook Botflow created in RevenueCat. The
 * user's RevenueCat project, products and customers are untouched. Also used as
 * "Cancel setup" before a key was ever pasted.
 */
import { NextRequest, NextResponse, after } from 'next/server';
import { auth } from '@/lib/auth/server';
import { requireProjectAccess } from '@/lib/project-access';
import { disconnectRevenueCat } from '@/lib/revenuecat-connection';
import { REVENUECAT_ENABLED } from '@/lib/feature-flags';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!REVENUECAT_ENABLED) {
    return NextResponse.json(
      { ok: false, error: 'RevenueCat is not enabled on this deployment.' },
      { status: 404 },
    );
  }

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, userId, 'owner');
  if (!access) {
    return NextResponse.json({ ok: false, error: 'Project not found' }, { status: 404 });
  }

  const result = await disconnectRevenueCat(projectId);
  if (result === 'busy') {
    return NextResponse.json(
      { ok: false, error: "Another change to this project's payments is in progress. Wait a few seconds and try again." },
      { status: 409 },
    );
  }

  // The next build must not carry the old SDK key.
  after(async () => {
    try {
      const { materializeSwiftRevenueCatConfig } = await import('@/lib/sandbox-env');
      await materializeSwiftRevenueCatConfig(projectId);
    } catch (err) {
      console.error('[revenuecat/disconnect] RevenueCatConfig.swift rewrite failed:', err);
    }
  });

  return NextResponse.json({ ok: true, status: 'none', ...result });
}
