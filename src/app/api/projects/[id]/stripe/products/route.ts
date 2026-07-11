/**
 * /api/projects/[id]/stripe/products
 *
 * Agent-facing endpoint for listing and creating Stripe Products (with a
 * default recurring or one-time Price) on the calling user's connected
 * account. Backs the getStripeProducts / createStripeProduct agent tools so
 * the agent can discover or mint a `price_…` id itself instead of asking the
 * user to paste one out of the Stripe Dashboard.
 *
 * Auth: Clerk session (this is called host-side by the agent tool with the
 * user's auth headers, NOT from inside the sandbox). We verify project
 * ownership + the Pro/Max tier gate, then act with the platform master key +
 * the Stripe-Account header.
 *
 * GET  → { ok, mode, products: [{ productId, name, active, prices: [...] }] }
 * POST → { ok, mode, productId, priceId, name, ... }  (body below)
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { userStripeIdentity } from '@/db/schema';
import { requireProjectAccess } from '@/lib/project-access';
import { canUseStripeConnect } from '@/lib/tier';
import { getStripe, isStripeConfigured, type StripeMode } from '@/lib/stripe';
import { makeStripeLookupKey } from '@/lib/stripe-scaffold';
import { STRIPE_CONNECT_ENABLED } from '@/lib/feature-flags';

export const runtime = 'nodejs';
export const maxDuration = 30;

interface ResolvedContext {
  accountId: string;
  mode: StripeMode;
  projectId: string;
}

/**
 * Shared preflight: Clerk auth → project ownership → tier gate → mode +
 * connected account id. Returns either the resolved context or a ready-to-send
 * error response.
 */
async function resolveContext(
  req: NextRequest,
  projectId: string,
): Promise<{ ok: true; ctx: ResolvedContext } | { ok: false; res: NextResponse }> {
  if (!STRIPE_CONNECT_ENABLED) {
    return {
      ok: false,
      res: NextResponse.json(
        { ok: false, error: 'Stripe Connect is not enabled on this deployment.' },
        { status: 404 },
      ),
    };
  }

  const { userId } = await auth();
  if (!userId) {
    return {
      ok: false,
      res: NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 }),
    };
  }

  const db = getDb();
  const access = await requireProjectAccess(projectId, userId);
  if (!access) {
    return {
      ok: false,
      res: NextResponse.json({ ok: false, error: 'Project not found' }, { status: 404 }),
    };
  }
  const project = access.project;

  const gate = await canUseStripeConnect(userId);
  if (!gate.allowed) {
    return {
      ok: false,
      res: NextResponse.json(
        { ok: false, status: 'tier-blocked', error: gate.reason, tier: gate.tier },
        { status: 402 },
      ),
    };
  }

  const mode: StripeMode = project.stripePaymentMode === 'live' ? 'live' : 'test';
  if (!isStripeConfigured(mode)) {
    return {
      ok: false,
      res: NextResponse.json(
        { ok: false, error: `Stripe keys for ${mode} mode are not configured` },
        { status: 500 },
      ),
    };
  }

  const [identity] = await db
    .select()
    .from(userStripeIdentity)
    .where(eq(userStripeIdentity.userId, userId))
    .limit(1);
  const accountId =
    identity && mode === 'live' ? identity.liveAccountId : identity?.testAccountId;
  if (!accountId) {
    return {
      ok: false,
      res: NextResponse.json(
        {
          ok: false,
          status: 'not-connected',
          error:
            'The user has not linked a Stripe account for this mode yet. Call initializeStripePayments first.',
        },
        { status: 412 },
      ),
    };
  }

  return { ok: true, ctx: { accountId, mode, projectId } };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  const resolved = await resolveContext(req, projectId);
  if (!resolved.ok) return resolved.res;
  const { accountId, mode } = resolved.ctx;

  const stripe = getStripe(mode);
  try {
    // Expand default_price so the agent gets a usable price_… id directly.
    const list = await stripe.products.list(
      { active: true, limit: 50, expand: ['data.default_price'] },
      { stripeAccount: accountId },
    );

    const products = await Promise.all(
      list.data.map(async (p) => {
        // Pull all active prices for the product so the agent can choose.
        const prices = await stripe.prices.list(
          { product: p.id, active: true, limit: 20 },
          { stripeAccount: accountId },
        );
        return {
          productId: p.id,
          name: p.name,
          description: p.description ?? null,
          active: p.active,
          prices: prices.data.map((pr) => ({
            priceId: pr.id,
            lookupKey: pr.lookup_key ?? null,
            unitAmount: pr.unit_amount,
            currency: pr.currency,
            recurring: pr.recurring
              ? { interval: pr.recurring.interval, intervalCount: pr.recurring.interval_count }
              : null,
          })),
        };
      }),
    );

    return NextResponse.json({ ok: true, mode, products });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[stripe/products GET] threw:', err);
    return NextResponse.json(
      { ok: false, error: `Failed to list Stripe products: ${message}` },
      { status: 502 },
    );
  }
}

interface CreateBody {
  name?: string;
  description?: string;
  /** Price in the smallest currency unit (cents). e.g. 1500 = $15.00 */
  unitAmount?: number;
  currency?: string;
  /** When set, creates a recurring price. Omit for a one-time price. */
  interval?: 'day' | 'week' | 'month' | 'year';
  intervalCount?: number;
  /** Optional human-readable hint for the generated lookup key (e.g. "pro_monthly"). */
  lookupKey?: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  const resolved = await resolveContext(req, projectId);
  if (!resolved.ok) return resolved.res;
  const { accountId, mode } = resolved.ctx;

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const name = body.name?.trim();
  const unitAmount = body.unitAmount;
  if (!name) {
    return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });
  }
  if (typeof unitAmount !== 'number' || !Number.isInteger(unitAmount) || unitAmount <= 0) {
    return NextResponse.json(
      { ok: false, error: 'unitAmount (a positive integer in cents) is required' },
      { status: 400 },
    );
  }
  const currency = (body.currency ?? 'usd').toLowerCase();

  // Stable, mode-agnostic handle. The app stores THIS (not price_…); the
  // checkout proxy resolves it to the right price in the active mode, and the
  // mirror routine recreates it under the same key in the other mode.
  const lookupKey = makeStripeLookupKey(projectId, body.lookupKey || name);

  const stripe = getStripe(mode);
  try {
    const priceData: import('stripe').Stripe.PriceCreateParams = {
      currency,
      unit_amount: unitAmount,
      lookup_key: lookupKey,
      transfer_lookup_key: true,
      product_data: {
        name,
        metadata: {
          botflow_project_id: projectId,
          botflow_managed: '1',
          botflow_lookup_key: lookupKey,
        },
      },
    };
    if (body.interval) {
      priceData.recurring = {
        interval: body.interval,
        interval_count: Math.max(1, body.intervalCount ?? 1),
      };
    }

    // Creating a Price with inline product_data mints both the Product and the
    // Price in one call. Simpler + atomic vs. separate product+price calls.
    const price = await stripe.prices.create(priceData, { stripeAccount: accountId });

    return NextResponse.json({
      ok: true,
      mode,
      productId: typeof price.product === 'string' ? price.product : price.product.id,
      priceId: price.id,
      lookupKey,
      name,
      unitAmount,
      currency,
      recurring: price.recurring
        ? { interval: price.recurring.interval, intervalCount: price.recurring.interval_count }
        : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[stripe/products POST] threw:', err);
    return NextResponse.json(
      { ok: false, error: `Failed to create Stripe product: ${message}` },
      { status: 502 },
    );
  }
}
