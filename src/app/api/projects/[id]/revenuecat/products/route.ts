/**
 * /api/projects/[id]/revenuecat/products
 *
 * GET  — what this app sells (products, entitlements, offerings and packages)
 *        plus a diagnosis of anything that would leave the paywall empty or a
 *        purchase unlocking nothing. Shown in the Payments tab.
 * POST — create or complete one product end to end (see provisionProduct).
 *        Idempotent: the same body twice changes nothing.
 *
 * The agent uses the same two operations through its host tools
 * (get_revenuecat_products / create_revenuecat_product).
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth/server';
import { requireProjectAccess } from '@/lib/project-access';
import { canUseRevenueCat } from '@/lib/tier';
import { explainRevenueCatError } from '@/lib/revenuecat';
import {
  catalogContext,
  getRevenueCatConnection,
  refreshRevenueCatConnection,
  type RevenueCatConnection,
} from '@/lib/revenuecat-connection';
import { parseProvisionInput, provisionProduct, readCatalog } from '@/lib/revenuecat-catalog';
import { REVENUECAT_ENABLED } from '@/lib/feature-flags';

export const runtime = 'nodejs';
export const maxDuration = 60;

async function preflight(
  params: Promise<{ id: string }>,
): Promise<{ ok: true; connection: RevenueCatConnection; projectId: string; ownerId: string } | { ok: false; res: NextResponse }> {
  if (!REVENUECAT_ENABLED) {
    return {
      ok: false,
      res: NextResponse.json({ ok: false, error: 'RevenueCat is not enabled on this deployment.' }, { status: 404 }),
    };
  }
  const { userId } = await auth();
  if (!userId) {
    return { ok: false, res: NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 }) };
  }
  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, userId);
  if (!access) {
    return { ok: false, res: NextResponse.json({ ok: false, error: 'Project not found' }, { status: 404 }) };
  }
  const connection =
    access.project.revenuecatStatus === 'connected' ? await getRevenueCatConnection(projectId) : null;
  if (!connection) {
    return {
      ok: false,
      res: NextResponse.json(
        {
          ok: false,
          status: 'needs-connect',
          error: 'RevenueCat is not connected on this project yet. Finish the setup in the Payments tab.',
        },
        { status: 409 },
      ),
    };
  }
  return { ok: true, connection, projectId, ownerId: access.project.userId };
}

function rcFailure(failure: { status: number; error: string }): NextResponse {
  // A permission or key problem gets the "what to change" wording; anything
  // else (validation, conflicts) is already specific.
  const keyProblem = failure.status === 401 || failure.status === 403;
  return NextResponse.json(
    { ok: false, error: keyProblem ? explainRevenueCatError(failure).message : failure.error },
    { status: failure.status >= 400 && failure.status < 500 ? 400 : 502 },
  );
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const pre = await preflight(params);
  if (!pre.ok) return pre.res;
  const result = await readCatalog(catalogContext(pre.connection));
  if (!result.ok) return rcFailure(result);
  return NextResponse.json({ ok: true, catalog: result.catalog });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const pre = await preflight(params);
  if (!pre.ok) return pre.res;

  const gate = await canUseRevenueCat(pre.ownerId);
  if (!gate.allowed) {
    return NextResponse.json(
      { ok: false, status: 'tier-blocked', error: gate.reason, tier: gate.tier },
      { status: 402 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = parseProvisionInput(body ?? {});
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });

  // Pick up a Test Store or App Store app added since connecting.
  await refreshRevenueCatConnection(pre.projectId);
  const connection = (await getRevenueCatConnection(pre.projectId)) ?? pre.connection;

  const result = await provisionProduct(catalogContext(connection), parsed.input);
  if (!result.ok) return rcFailure(result);
  return NextResponse.json(result);
}
