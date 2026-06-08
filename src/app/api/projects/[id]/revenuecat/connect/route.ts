/**
 * POST /api/projects/[id]/revenuecat/connect
 *
 * Called by the payments tab's setup wizard (NOT a modal). Receives the user's
 * pasted RevenueCat keys (and optionally their Apple App Store Connect API key),
 * validates the secret key against the RevenueCat API, stores everything
 * encrypted in user_revenuecat_identity (reused across the user's projects), and
 * flips this project to 'connected'.
 *
 * Replaces Stripe's OAuth callback — here the user supplies credentials directly
 * because RevenueCat has no self-service OAuth for platforms.
 *
 * Body: {
 *   rcSecretKey, rcPublicSdkKey, rcProjectId,
 *   ascIssuerId?, ascKeyId?, ascPrivateKeyP8?
 * }
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { getDb } from '@/db';
import { projects, userRevenueCatIdentity } from '@/db/schema';
import { canUseRevenueCat } from '@/lib/tier';
import { encryptSecret } from '@/lib/secrets';
import { validateConnection } from '@/lib/revenuecat';
import { REVENUECAT_ENABLED } from '@/lib/feature-flags';

export const runtime = 'nodejs';
export const maxDuration = 30;

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

  const gate = await canUseRevenueCat(userId);
  if (!gate.allowed) {
    return NextResponse.json(
      { ok: false, status: 'tier-blocked', error: gate.reason, tier: gate.tier },
      { status: 402 },
    );
  }

  let body: {
    rcSecretKey?: string;
    rcPublicSdkKey?: string;
    rcProjectId?: string;
    ascIssuerId?: string;
    ascKeyId?: string;
    ascPrivateKeyP8?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const rcSecretKey = body.rcSecretKey?.trim();
  const rcPublicSdkKey = body.rcPublicSdkKey?.trim();
  const rcProjectId = body.rcProjectId?.trim();

  if (!rcSecretKey || !rcPublicSdkKey || !rcProjectId) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'rcSecretKey, rcPublicSdkKey, and rcProjectId are all required. Find them in your RevenueCat project settings.',
      },
      { status: 400 },
    );
  }

  if (!rcPublicSdkKey.startsWith('appl_')) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'The public SDK key should start with "appl_" (the Apple app-specific key from RevenueCat → API Keys).',
      },
      { status: 400 },
    );
  }

  // Validate the secret key actually works against this project.
  const validation = await validateConnection(rcSecretKey, rcProjectId);
  if (!validation.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: `Could not verify your RevenueCat connection: ${validation.error}. Double-check the secret key and project id.`,
      },
      { status: validation.status >= 400 && validation.status < 500 ? 400 : 502 },
    );
  }

  // Preserve an existing inbound webhook secret so the user doesn't have to
  // re-paste it into RevenueCat when reconnecting.
  const [existing] = await db
    .select()
    .from(userRevenueCatIdentity)
    .where(eq(userRevenueCatIdentity.userId, userId))
    .limit(1);
  const rcInboundWebhookSecret =
    existing?.rcInboundWebhookSecret ?? `bfrcin_${randomBytes(24).toString('hex')}`;

  const now = new Date();
  const values = {
    userId,
    rcSecretKey: encryptSecret(rcSecretKey),
    rcPublicSdkKey,
    rcProjectId,
    rcInboundWebhookSecret,
    ...(body.ascIssuerId ? { ascIssuerId: body.ascIssuerId.trim() } : {}),
    ...(body.ascKeyId ? { ascKeyId: body.ascKeyId.trim() } : {}),
    ...(body.ascPrivateKeyP8
      ? { ascPrivateKeyP8: encryptSecret(body.ascPrivateKeyP8) }
      : {}),
    connectedAt: existing?.connectedAt ?? now,
    updatedAt: now,
  };

  await db
    .insert(userRevenueCatIdentity)
    .values(values)
    .onConflictDoUpdate({ target: userRevenueCatIdentity.userId, set: values });

  // Flip this project to connected and stamp the RC project id.
  const webhookSecret =
    project.revenuecatWebhookSecret ?? `bfrc_${randomBytes(32).toString('hex')}`;
  await db
    .update(projects)
    .set({
      revenuecatStatus: 'connected',
      revenuecatProjectId: rcProjectId,
      revenuecatWebhookSecret: webhookSecret,
      updatedAt: now,
    })
    .where(eq(projects.id, projectId));

  return NextResponse.json({
    ok: true,
    status: 'connected',
    rcProjectId,
    projectName: validation.data.name,
  });
}
