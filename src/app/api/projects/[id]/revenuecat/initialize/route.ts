/**
 * POST /api/projects/[id]/revenuecat/initialize
 *
 * Agent-triggered RevenueCat (iOS in-app purchases) setup. Unlike the Stripe
 * equivalent, this is NON-BLOCKING: the RevenueCat BYO connection is a
 * multi-step, off-platform manual flow (create an RC account/project, paste
 * keys, upload an Apple .p8, set a webhook), so we don't hold the tool call open
 * waiting for it. Instead we flip the project to 'connecting' so the payments
 * tab appears + auto-opens, and return immediately. The user completes setup in
 * the tab while the agent keeps building.
 *
 * Outcomes (returned to the agent):
 *   • already-connected — the user linked RevenueCat on a previous project; this
 *     project is enabled immediately. The agent proceeds.
 *   • needs-connect     — the payments tab is now open with the setup wizard.
 *     The agent should continue building (SDK + paywall) and tell the user to
 *     finish connecting in the tab.
 *   • backend-blocked / tier-blocked — preflight failures.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { getDb } from '@/db';
import { projects, userRevenueCatIdentity } from '@/db/schema';
import { canUseRevenueCat } from '@/lib/tier';
import { decryptSecret } from '@/lib/secrets';
import { REVENUECAT_ENABLED } from '@/lib/feature-flags';

export const runtime = 'nodejs';
export const maxDuration = 30;

async function setStatus(
  projectId: string,
  status: 'connecting' | 'connected',
  ensureWebhookSecret: string | null,
): Promise<string> {
  const db = getDb();
  const webhookSecret = ensureWebhookSecret ?? `bfrc_${randomBytes(32).toString('hex')}`;
  await db
    .update(projects)
    .set({
      revenuecatStatus: status,
      revenuecatWebhookSecret: webhookSecret,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, projectId));
  return webhookSecret;
}

export async function POST(
  req: NextRequest,
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

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);

  if (!project) {
    return NextResponse.json({ ok: false, error: 'Project not found' }, { status: 404 });
  }

  if (project.backendType === 'none') {
    return NextResponse.json(
      {
        ok: false,
        status: 'backend-blocked',
        error:
          'This project has no backend. In-app purchases require a Convex backend to receive webhook events and store entitlement state.',
      },
      { status: 400 },
    );
  }

  const gate = await canUseRevenueCat(userId);
  if (!gate.allowed) {
    return NextResponse.json(
      { ok: false, status: 'tier-blocked', error: gate.reason, tier: gate.tier },
      { status: 402 },
    );
  }

  // Already linked on a previous project? Enable immediately.
  const [identity] = await db
    .select()
    .from(userRevenueCatIdentity)
    .where(eq(userRevenueCatIdentity.userId, userId))
    .limit(1);
  const hasLinkedAccount = Boolean(
    identity && decryptSecret(identity.rcSecretKey) && identity.rcProjectId,
  );

  if (hasLinkedAccount && identity) {
    await setStatus(projectId, 'connected', project.revenuecatWebhookSecret);
    // Carry the user's RC project id onto this project for deep-links / proxy.
    await db
      .update(projects)
      .set({ revenuecatProjectId: identity.rcProjectId, updatedAt: new Date() })
      .where(eq(projects.id, projectId));
    return NextResponse.json({
      ok: true,
      status: 'already-connected',
      message:
        'The user has previously linked their RevenueCat account. This project is now enabled. Proceed to add the RevenueCat SDK + paywall to the Swift app. Remind the user that products must be created in App Store Connect and pass App Review before real purchases work in production.',
    });
  }

  // Not linked → open the tab with the setup wizard; don't block.
  await setStatus(projectId, 'connecting', project.revenuecatWebhookSecret);
  return NextResponse.json({
    ok: true,
    status: 'needs-connect',
    message:
      'Opened the Payments tab with the RevenueCat setup wizard. Tell the user to finish connecting there (create a RevenueCat project, paste their keys, upload their Apple key, set the webhook). Meanwhile, CONTINUE building: add the RevenueCat SDK + a paywall to the Swift app. Entitlements will not be live until the user completes setup and products clear App Review.',
  });
}
