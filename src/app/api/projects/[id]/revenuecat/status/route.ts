/**
 * GET /api/projects/[id]/revenuecat/status
 *
 * Drives the payments tab: the setup-wizard step checklist and the "Verify
 * connection" button, plus the webhook details the user must paste into
 * RevenueCat. Performs a live RevenueCat API check when a secret key is present.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { projects, userRevenueCatIdentity } from '@/db/schema';
import { decryptSecret } from '@/lib/secrets';
import { validateConnection, dashboardUrl } from '@/lib/revenuecat';
import { REVENUECAT_ENABLED } from '@/lib/feature-flags';

export const runtime = 'nodejs';
export const maxDuration = 20;

export async function GET(
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

  const [identity] = await db
    .select()
    .from(userRevenueCatIdentity)
    .where(eq(userRevenueCatIdentity.userId, userId))
    .limit(1);

  const secretKey = decryptSecret(identity?.rcSecretKey);
  const rcProjectId = identity?.rcProjectId ?? project.revenuecatProjectId ?? null;

  // Live verification when we have credentials.
  let connectionValid = false;
  let connectionError: string | null = null;
  if (secretKey && rcProjectId) {
    const result = await validateConnection(secretKey, rcProjectId);
    connectionValid = result.ok;
    if (!result.ok) connectionError = result.error;
  }

  // Prefer the canonical public origin — behind a proxy/rewrite the request
  // URL's origin can differ, and the user pastes this into RevenueCat.
  const origin = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || new URL(req.url).origin;

  const scaffold = project.revenuecatScaffoldState ?? null;

  return NextResponse.json({
    ok: true,
    status: project.revenuecatStatus, // 'none' | 'connecting' | 'connected'
    environment: project.revenuecatEnvironment, // 'sandbox' | 'production'
    rcProjectId,
    dashboardUrl: dashboardUrl(rcProjectId),
    // Wizard checklist signals.
    checklist: {
      keysProvided: Boolean(secretKey && identity?.rcPublicSdkKey && rcProjectId),
      connectionValid,
      // Test Store discovered + sandbox key cached → simulator test purchases
      // work. When false, the user enables Test Store in the RC dashboard and
      // re-runs setup.
      testStoreReady: Boolean(identity?.rcTestStoreSdkKey),
      // The Convex-side scaffold (receiver files + env + http route) actually
      // landed — without it, entitlement events can't reach the app's backend.
      backendReady: scaffold?.ok === true,
    },
    // Last scaffold attempt, so the tab can explain *why* backendReady is
    // false and offer a retry (re-POST /revenuecat/initialize re-scaffolds).
    scaffold,
    connectionError,
    // Webhook details to paste into the RevenueCat dashboard.
    webhook: {
      url: `${origin}/api/webhooks/revenuecat`,
      authorizationHeader: identity?.rcInboundWebhookSecret ?? null,
    },
  });
}
