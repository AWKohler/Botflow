/**
 * POST /api/projects/[id]/revenuecat/connect
 *
 * Called by the payments tab's setup wizard (NOT a modal). Receives the user's
 * pasted RevenueCat keys, validates the secret key against the RevenueCat API,
 * stores everything encrypted in user_revenuecat_identity (reused across the
 * user's projects), and flips this project to 'connected'.
 *
 * Replaces Stripe's OAuth callback — here the user supplies credentials directly
 * because RevenueCat has no self-service OAuth for platforms.
 *
 * Body: { rcSecretKey, rcPublicSdkKey, rcProjectId }
 * (The wizard no longer collects an App Store Connect .p8 — ASC automation
 * will reuse the Apple Developer credential from Settings instead.)
 */
import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { and, eq } from 'drizzle-orm';
import { randomBytes, createHash } from 'node:crypto';
import { getDb } from '@/db';
import { projects, userRevenueCatIdentity } from '@/db/schema';
import { canUseRevenueCat } from '@/lib/tier';
import { encryptSecret } from '@/lib/secrets';
import { validateConnection } from '@/lib/revenuecat';
import { scaffoldRevenueCatIntoProject } from '@/lib/revenuecat-scaffold';
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

  // One RevenueCat identity per Botflow user: pasting a different RC project
  // here silently repoints every other connected project's management calls
  // and dashboard links. Allowed (the user may genuinely be switching), but
  // must be surfaced — never silent.
  let identitySwitchWarning: string | null = null;
  if (existing?.rcProjectId && existing.rcProjectId !== rcProjectId) {
    const others = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(eq(projects.userId, userId), eq(projects.revenuecatStatus, 'connected')));
    const affected = others.filter((p) => p.id !== projectId);
    if (affected.length > 0) {
      const names = affected.map((p) => p.name).slice(0, 3).join(', ');
      identitySwitchWarning =
        `Botflow stores one RevenueCat connection per account. Connecting this RevenueCat project ` +
        `also repoints your ${affected.length} other connected project${affected.length === 1 ? '' : 's'} ` +
        `(${names}${affected.length > 3 ? ', …' : ''}) to it. If those apps sell products under the ` +
        `previous RevenueCat project, reconnect them or move their products over.`;
    }
  }
  const rcInboundWebhookSecret =
    existing?.rcInboundWebhookSecret ?? `bfrcin_${randomBytes(24).toString('hex')}`;
  // Indexed digest so the inbound webhook can resolve the owner by O(1) lookup.
  const rcInboundWebhookSecretDigest = createHash('sha256')
    .update(rcInboundWebhookSecret)
    .digest('hex');

  const now = new Date();
  const values = {
    userId,
    rcSecretKey: encryptSecret(rcSecretKey),
    rcPublicSdkKey,
    rcProjectId,
    rcInboundWebhookSecret,
    rcInboundWebhookSecretDigest,
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

  // Scaffold the Convex receiver + set BOTFLOW_REVENUECAT_WEBHOOK_SECRET on the
  // deployment in the background, so the app can actually verify the platform's
  // signed webhook deliveries. Best-effort — failures are logged, not fatal.
  after(async () => {
    try {
      const result = await scaffoldRevenueCatIntoProject(projectId);
      console.log(
        '[revenuecat/connect] background scaffold',
        projectId,
        'files=', result.filesWritten,
        'envSet=', result.envSet,
        result.envError ? `envError=${result.envError}` : '',
        result.filesError ? `filesError=${result.filesError}` : '',
      );
    } catch (err) {
      console.error('[revenuecat/connect] background scaffold threw:', err);
    }
    // Bake the freshly-stored public SDK key into RevenueCatConfig.swift now,
    // so the sandbox reflects it immediately (builds re-materialize anyway).
    try {
      const { materializeSwiftRevenueCatConfig } = await import('@/lib/sandbox-env');
      await materializeSwiftRevenueCatConfig(projectId);
    } catch (err) {
      console.error('[revenuecat/connect] RevenueCatConfig.swift write failed:', err);
    }
  });

  return NextResponse.json({
    ok: true,
    status: 'connected',
    rcProjectId,
    projectName: validation.data.name,
    ...(identitySwitchWarning ? { warning: identitySwitchWarning } : {}),
  });
}
