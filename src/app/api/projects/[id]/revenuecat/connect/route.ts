/**
 * POST /api/projects/[id]/revenuecat/connect
 *
 * The Payments tab's "Connect" button. Takes the one value the user pastes, the
 * V2 secret key of this app's RevenueCat project, and does the rest:
 * verifies it, finds the RevenueCat project and its SDK keys, creates the
 * webhook, stores the key encrypted and flips the project to 'connected'.
 *
 * Body: { rcSecretKey, allowSharedProject? }
 *
 * Errors carry a `code` (see ConnectResult) and a message that says what to
 * change, because RevenueCat keys cannot be edited after creation: almost every
 * failure here is fixed by creating a new key the right way.
 */
import { NextRequest, NextResponse, after } from 'next/server';
import { auth } from '@/lib/auth/server';
import { requireProjectAccess } from '@/lib/project-access';
import { canUseRevenueCat } from '@/lib/tier';
import { connectRevenueCat, takeAgentWaitingForConnect } from '@/lib/revenuecat-connection';
import { scaffoldRevenueCatIntoProject } from '@/lib/revenuecat-scaffold';
import { REVENUECAT_ENABLED } from '@/lib/feature-flags';

export const runtime = 'nodejs';
export const maxDuration = 60;

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
  const access = await requireProjectAccess(projectId, userId, 'owner');
  if (!access) {
    return NextResponse.json({ ok: false, error: 'Project not found' }, { status: 404 });
  }
  const project = access.project;

  if (project.platform !== 'swift' || project.backendType === 'none') {
    return NextResponse.json(
      {
        ok: false,
        code: 'backend-blocked',
        error:
          project.platform !== 'swift'
            ? 'RevenueCat in-app purchases are for Swift (iOS) projects.'
            : 'This project has no backend. In-app purchases need one to record what each user has bought.',
      },
      { status: 400 },
    );
  }

  const gate = await canUseRevenueCat(project.userId);
  if (!gate.allowed) {
    return NextResponse.json(
      { ok: false, status: 'tier-blocked', code: 'tier-blocked', error: gate.reason, tier: gate.tier },
      { status: 402 },
    );
  }

  let body: { rcSecretKey?: unknown; allowSharedProject?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }
  const rcSecretKey = typeof body.rcSecretKey === 'string' ? body.rcSecretKey.trim() : '';
  if (!rcSecretKey) {
    return NextResponse.json(
      { ok: false, code: 'not-secret-key', error: 'Paste the RevenueCat secret key (it starts with "sk_").' },
      { status: 400 },
    );
  }

  const result = await connectRevenueCat({
    projectId,
    projectName: project.name,
    userId: project.userId,
    secretKey: rcSecretKey,
    requestOrigin: new URL(req.url).origin,
    allowSharedProject: body.allowSharedProject === true,
  });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, code: result.code, error: result.error, ...(result.sharedWith ? { sharedWith: result.sharedWith } : {}) },
      { status: result.status },
    );
  }

  // The agent that asked for payments (if any) is told the connection is done.
  const agentThread = await takeAgentWaitingForConnect(projectId);

  // Add the receiver to the app's backend and write the SDK key into the
  // Swift source, so the very next build can make test purchases.
  after(async () => {
    try {
      await scaffoldRevenueCatIntoProject(projectId);
    } catch (err) {
      console.error('[revenuecat/connect] background scaffold threw:', err);
    }
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
    rcProjectId: result.rcProjectId,
    projectName: result.rcProjectName,
    testStoreReady: result.testStoreReady,
    appStoreReady: result.appStoreReady,
    webhook: result.webhook,
    // null = nobody is waiting; 'current' = the open chat; otherwise a thread id.
    agentThread,
  });
}
