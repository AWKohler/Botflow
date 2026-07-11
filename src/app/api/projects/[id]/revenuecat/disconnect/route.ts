/**
 * POST /api/projects/[id]/revenuecat/disconnect
 *
 * Turns RevenueCat off for THIS project (status → 'none', clears project-level
 * RC fields). Deliberately leaves user_revenuecat_identity intact — the user's
 * RevenueCat account is reused across their other projects, so disconnecting one
 * app must not wipe the shared credentials.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { requireProjectAccess } from '@/lib/project-access';
import { REVENUECAT_ENABLED } from '@/lib/feature-flags';

export const runtime = 'nodejs';
export const maxDuration = 20;

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
  const db = getDb();

  const access = await requireProjectAccess(projectId, userId, "owner");
  if (!access) {
    return NextResponse.json({ ok: false, error: 'Project not found' }, { status: 404 });
  }

  await db
    .update(projects)
    .set({
      revenuecatStatus: 'none',
      revenuecatProjectId: null,
      revenuecatWebhookSecret: null,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, projectId));

  return NextResponse.json({ ok: true, status: 'none' });
}
