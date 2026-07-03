/**
 * /api/projects/[id]/revenuecat/products — Phase 3 product provisioning.
 *
 * GET  — catalog snapshot: apps, products, entitlements, offerings (each with
 *        its packages). The agent calls this (getRevenueCatProducts) to learn
 *        real identifiers before wiring entitlement checks / paywalls.
 *
 * POST — idempotent ensure-chain (createRevenueCatProduct): given a store
 *        identifier, make sure the product exists and is reachable through the
 *        paywall graph — product → entitlement (attach) → offering (made
 *        current if none is) → package (attach). Every step lists first and
 *        tolerates 409s, so re-running with the same body is safe.
 *
 * Reality boundary (also in the tool text): this provisions the REVENUECAT
 * side only. The matching App Store Connect in-app product (same product id)
 * must exist and pass App Review before real purchases work — Apple's side
 * stays manual until App Store Connect automation ships.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { userRevenueCatIdentity } from '@/db/schema';
import { requireProjectAccess } from '@/lib/project-access';
import { canUseRevenueCat } from '@/lib/tier';
import { decryptSecret } from '@/lib/secrets';
import {
  attachProductsToEntitlement,
  attachProductsToPackage,
  createEntitlement,
  createOffering,
  createPackage,
  createProduct,
  listApps,
  listEntitlements,
  listOfferings,
  listPackages,
  listProducts,
  setOfferingCurrent,
  type RevenueCatProductType,
  type RevenueCatResult,
  type RevenueCatTestDuration,
} from '@/lib/revenuecat';
import { REVENUECAT_ENABLED } from '@/lib/feature-flags';

export const runtime = 'nodejs';
export const maxDuration = 60;

const PRODUCT_TYPES: readonly RevenueCatProductType[] = [
  'subscription',
  'one_time',
  'consumable',
  'non_consumable',
  'non_renewing_subscription',
];

interface Ctx {
  secretKey: string;
  rcProjectId: string;
  /** Cached Test Store app id (discovered during scaffold), null when the RC
   *  project has no Test Store enabled. */
  testStoreAppId: string | null;
}

const TEST_DURATIONS: readonly RevenueCatTestDuration[] = ['P1W', 'P1M', 'P2M', 'P3M', 'P6M', 'P1Y'];

/** Shared preflight: flag, auth, ownership, linked + connected RevenueCat. */
async function preflight(
  params: Promise<{ id: string }>,
): Promise<{ ok: true; ctx: Ctx; projectId: string; userId: string } | { ok: false; res: NextResponse }> {
  if (!REVENUECAT_ENABLED) {
    return {
      ok: false,
      res: NextResponse.json(
        { ok: false, error: 'RevenueCat is not enabled on this deployment.' },
        { status: 404 },
      ),
    };
  }
  const { userId } = await auth();
  if (!userId) {
    return { ok: false, res: NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 }) };
  }
  const { id: projectId } = await params;
  const db = getDb();
  const access = await requireProjectAccess(projectId, userId);
  if (!access) {
    return { ok: false, res: NextResponse.json({ ok: false, error: 'Project not found' }, { status: 404 }) };
  }
  const project = access.project;

  const [identity] = await db
    .select()
    .from(userRevenueCatIdentity)
    .where(eq(userRevenueCatIdentity.userId, userId))
    .limit(1);
  const secretKey = decryptSecret(identity?.rcSecretKey);
  const rcProjectId = identity?.rcProjectId ?? project.revenuecatProjectId ?? null;
  if (project.revenuecatStatus !== 'connected' || !secretKey || !rcProjectId) {
    return {
      ok: false,
      res: NextResponse.json(
        {
          ok: false,
          status: 'needs-connect',
          error:
            'RevenueCat is not connected on this project yet. Call initializeRevenueCatPayments first; the user completes setup in the Payments tab.',
        },
        { status: 409 },
      ),
    };
  }
  return {
    ok: true,
    ctx: { secretKey, rcProjectId, testStoreAppId: identity?.rcTestStoreAppId ?? null },
    projectId,
    userId,
  };
}

function rcError(step: string, result: { status: number; error: string }): NextResponse {
  return NextResponse.json(
    { ok: false, error: `RevenueCat ${step} failed: ${result.error}` },
    // 4xx from RC = bad request/config the caller can fix; else upstream error.
    { status: result.status >= 400 && result.status < 500 ? 400 : 502 },
  );
}

// ─── GET: catalog ───────────────────────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const pre = await preflight(params);
  if (!pre.ok) return pre.res;
  const { secretKey, rcProjectId } = pre.ctx;

  const [apps, products, entitlements, offerings] = await Promise.all([
    listApps(secretKey, rcProjectId),
    listProducts(secretKey, rcProjectId),
    listEntitlements(secretKey, rcProjectId),
    listOfferings(secretKey, rcProjectId),
  ]);
  if (!apps.ok) return rcError('list apps', apps);
  if (!products.ok) return rcError('list products', products);
  if (!entitlements.ok) return rcError('list entitlements', entitlements);
  if (!offerings.ok) return rcError('list offerings', offerings);

  const offeringsWithPackages = await Promise.all(
    offerings.data.items.map(async (offering) => {
      const packages = await listPackages(secretKey, rcProjectId, offering.id);
      return { ...offering, packages: packages.ok ? packages.data.items : [] };
    }),
  );

  return NextResponse.json({
    ok: true,
    catalog: {
      apps: apps.data.items,
      products: products.data.items,
      entitlements: entitlements.data.items,
      offerings: offeringsWithPackages,
    },
  });
}

// ─── POST: idempotent provision chain ───────────────────────────────────────

interface ProvisionBody {
  storeIdentifier?: string;
  type?: string;
  displayName?: string;
  appId?: string;
  entitlementLookupKey?: string;
  entitlementDisplayName?: string;
  offeringLookupKey?: string;
  offeringDisplayName?: string;
  packageLookupKey?: string;
  packageDisplayName?: string;
  /** Test Store subscription duration (P1W|P1M|P2M|P3M|P6M|P1Y). Default P1M. */
  subscriptionDuration?: string;
}

/** On create-409 (someone else won the race), re-list and find by key. */
async function ensure<T>(
  find: () => Promise<RevenueCatResult<{ items: T[] }>>,
  match: (item: T) => boolean,
  create: () => Promise<RevenueCatResult<T>>,
): Promise<{ ok: true; item: T; created: boolean } | { ok: false; status: number; error: string }> {
  const listed = await find();
  if (!listed.ok) return listed;
  const existing = listed.data.items.find(match);
  if (existing) return { ok: true, item: existing, created: false };

  const created = await create();
  if (created.ok) return { ok: true, item: created.data, created: true };
  if (created.status === 409) {
    const relisted = await find();
    if (relisted.ok) {
      const raced = relisted.data.items.find(match);
      if (raced) return { ok: true, item: raced, created: false };
    }
  }
  return created;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const pre = await preflight(params);
  if (!pre.ok) return pre.res;
  const { secretKey, rcProjectId } = pre.ctx;

  const gate = await canUseRevenueCat(pre.userId);
  if (!gate.allowed) {
    return NextResponse.json(
      { ok: false, status: 'tier-blocked', error: gate.reason, tier: gate.tier },
      { status: 402 },
    );
  }

  let body: ProvisionBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const storeIdentifier = body.storeIdentifier?.trim();
  const type = body.type?.trim() as RevenueCatProductType | undefined;
  if (!storeIdentifier || !type || !PRODUCT_TYPES.includes(type)) {
    return NextResponse.json(
      {
        ok: false,
        error: `storeIdentifier and type are required (type one of: ${PRODUCT_TYPES.join(', ')}).`,
      },
      { status: 400 },
    );
  }
  if (body.packageLookupKey && !body.offeringLookupKey) {
    return NextResponse.json(
      { ok: false, error: 'packageLookupKey requires offeringLookupKey (a package lives inside an offering).' },
      { status: 400 },
    );
  }

  const created = {
    product: false,
    testStoreProduct: false,
    entitlement: false,
    offering: false,
    package: false,
  };

  // 1. Resolve the RC app the product belongs to.
  const apps = await listApps(secretKey, rcProjectId);
  if (!apps.ok) return rcError('list apps', apps);
  let appId = body.appId?.trim();
  if (appId) {
    if (!apps.data.items.some((a) => a.id === appId)) {
      return NextResponse.json(
        { ok: false, error: `appId "${appId}" not found in this RevenueCat project.`, apps: apps.data.items },
        { status: 400 },
      );
    }
  } else {
    const appStoreApps = apps.data.items.filter((a) => a.type === 'app_store');
    if (appStoreApps.length === 1) {
      appId = appStoreApps[0].id;
    } else {
      return NextResponse.json(
        {
          ok: false,
          error:
            appStoreApps.length === 0
              ? 'No App Store app exists in this RevenueCat project. The user must add one (RevenueCat → Project settings → Apps) before products can be created.'
              : 'Multiple App Store apps exist in this RevenueCat project — pass appId to pick one.',
          apps: apps.data.items,
        },
        { status: 400 },
      );
    }
  }

  const subscriptionDuration = (body.subscriptionDuration?.trim() || 'P1M') as RevenueCatTestDuration;
  if (!TEST_DURATIONS.includes(subscriptionDuration)) {
    return NextResponse.json(
      { ok: false, error: `subscriptionDuration must be one of: ${TEST_DURATIONS.join(', ')}.` },
      { status: 400 },
    );
  }

  // 2. Product (matched by store_identifier within the app).
  const product = await ensure(
    () => listProducts(secretKey, rcProjectId),
    (p) => p.store_identifier === storeIdentifier && p.app_id === appId,
    () =>
      createProduct(secretKey, rcProjectId, {
        store_identifier: storeIdentifier,
        app_id: appId,
        type,
        ...(body.displayName?.trim() ? { display_name: body.displayName.trim() } : {}),
      }),
  );
  if (!product.ok) return rcError('create product', product);
  created.product = product.created;

  // 2b. Twin product in the Test Store, so dev builds (which run on the Test
  // Store key) resolve the SAME offering/packages with simulated purchases.
  // Same store_identifier; the SDK picks the product matching its store.
  let testStoreProduct = null;
  const { testStoreAppId } = pre.ctx;
  if (testStoreAppId) {
    const twin = await ensure(
      () => listProducts(secretKey, rcProjectId),
      (p) => p.store_identifier === storeIdentifier && p.app_id === testStoreAppId,
      () =>
        createProduct(secretKey, rcProjectId, {
          store_identifier: storeIdentifier,
          app_id: testStoreAppId,
          type,
          title: body.displayName?.trim() || storeIdentifier,
          ...(body.displayName?.trim() ? { display_name: body.displayName.trim() } : {}),
          ...(type === 'subscription' ? { subscription: { duration: subscriptionDuration } } : {}),
        }),
    );
    if (!twin.ok) return rcError('create test-store product', twin);
    created.testStoreProduct = twin.created;
    testStoreProduct = twin.item;
  }

  const productIds = [product.item.id, ...(testStoreProduct ? [testStoreProduct.id] : [])];

  // 3. Entitlement + attach.
  let entitlement = null;
  const entitlementLookupKey = body.entitlementLookupKey?.trim();
  if (entitlementLookupKey) {
    const ensured = await ensure(
      () => listEntitlements(secretKey, rcProjectId),
      (e) => e.lookup_key === entitlementLookupKey,
      () =>
        createEntitlement(secretKey, rcProjectId, {
          lookup_key: entitlementLookupKey,
          display_name: body.entitlementDisplayName?.trim() || entitlementLookupKey,
        }),
    );
    if (!ensured.ok) return rcError('create entitlement', ensured);
    created.entitlement = ensured.created;
    entitlement = ensured.item;

    const attached = await attachProductsToEntitlement(secretKey, rcProjectId, ensured.item.id, productIds);
    // 409 = already attached — the idempotent outcome we want.
    if (!attached.ok && attached.status !== 409) return rcError('attach product to entitlement', attached);
  }

  // 4. Offering (made current when no current offering exists, so
  //    RevenueCatUI's PaywallView actually shows it).
  let offering = null;
  const offeringLookupKey = body.offeringLookupKey?.trim();
  if (offeringLookupKey) {
    const offerings = await listOfferings(secretKey, rcProjectId);
    if (!offerings.ok) return rcError('list offerings', offerings);
    const ensured = await ensure(
      () => listOfferings(secretKey, rcProjectId),
      (o) => o.lookup_key === offeringLookupKey,
      () =>
        createOffering(secretKey, rcProjectId, {
          lookup_key: offeringLookupKey,
          display_name: body.offeringDisplayName?.trim() || offeringLookupKey,
        }),
    );
    if (!ensured.ok) return rcError('create offering', ensured);
    created.offering = ensured.created;
    offering = ensured.item;

    const hasCurrent = offerings.data.items.some((o) => o.is_current);
    if (!offering.is_current && !hasCurrent) {
      const madeCurrent = await setOfferingCurrent(secretKey, rcProjectId, offering.id);
      if (madeCurrent.ok) offering = madeCurrent.data;
      // Best-effort: a failure here still leaves a usable offering.
    }

    // 5. Package inside the offering + attach.
    const packageLookupKey = body.packageLookupKey?.trim();
    if (packageLookupKey) {
      const offeringId = offering.id;
      const pkg = await ensure(
        () => listPackages(secretKey, rcProjectId, offeringId),
        (p) => p.lookup_key === packageLookupKey,
        () =>
          createPackage(secretKey, rcProjectId, offeringId, {
            lookup_key: packageLookupKey,
            display_name: body.packageDisplayName?.trim() || packageLookupKey,
          }),
      );
      if (!pkg.ok) return rcError('create package', pkg);
      created.package = pkg.created;

      const attached = await attachProductsToPackage(secretKey, rcProjectId, pkg.item.id, productIds);
      if (!attached.ok && attached.status !== 409) return rcError('attach product to package', attached);

      return NextResponse.json({
        ok: true,
        created,
        product: product.item,
        testStoreProduct,
        testStore: testStoreNote(testStoreAppId),
        entitlement,
        offering,
        package: pkg.item,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    created,
    product: product.item,
    testStoreProduct,
    testStore: testStoreNote(testStoreAppId),
    entitlement,
    offering,
    package: null,
  });
}

function testStoreNote(testStoreAppId: string | null): { enabled: boolean; note: string } {
  return testStoreAppId
    ? {
        enabled: true,
        note:
          'A Test Store twin product was provisioned — simulator preview builds can make simulated purchases immediately (no real money, no Apple setup).',
      }
    : {
        enabled: false,
        note:
          'No Test Store exists in this RevenueCat project, so simulator builds cannot make test purchases yet. Tell the user to enable the Test Store in the RevenueCat dashboard (Project settings → Apps), then re-run setup from the Payments tab.',
      };
}
