/**
 * What a connected project sells: reading the RevenueCat catalog, checking it
 * for the mistakes that leave a paywall empty or a purchase unlocking nothing,
 * and provisioning a product end to end in one idempotent call.
 *
 * Shared by the session routes (the Payments tab) and the agent's host tools,
 * so both see the same catalog and the same diagnosis.
 *
 * RevenueCat's model, for reference:
 *   product      one thing you can buy in ONE store (App Store / Test Store)
 *   entitlement  the access a purchase unlocks ("pro"); products attach to it
 *   offering     what the paywall shows; the CURRENT one is fetched by default
 *   package      a slot in an offering ($rc_monthly, $rc_annual, …) holding one
 *                product per store
 */
import {
  attachProductsToEntitlement,
  attachProductsToPackage,
  createEntitlement,
  createOffering,
  createPackage,
  createProduct,
  detachProductsFromPackage,
  getProductStoreState,
  listApps,
  listEntitlements,
  listOfferings,
  listProducts,
  setOfferingCurrent,
  setTestStorePrice,
  type RevenueCatProduct,
  type RevenueCatProductType,
  type RevenueCatResult,
  type RevenueCatTestDuration,
} from '@/lib/revenuecat';

export const REVENUECAT_PRODUCT_TYPES: readonly RevenueCatProductType[] = [
  'subscription',
  'consumable',
  'non_consumable',
  'non_renewing_subscription',
  'one_time',
];

export const REVENUECAT_TEST_DURATIONS: readonly RevenueCatTestDuration[] = [
  'P1W',
  'P1M',
  'P2M',
  'P3M',
  'P6M',
  'P1Y',
];

/** The credentials + cached app ids every catalog call needs. */
export interface CatalogContext {
  secretKey: string;
  rcProjectId: string;
  testStoreAppId: string | null;
  appStoreAppId: string | null;
}

type Failure = { ok: false; status: number; error: string };

// ─── Read ─────────────────────────────────────────────────────────────────────

export interface CatalogProduct {
  /** The id the app and the stores know it by (e.g. "pro_monthly"). */
  identifier: string;
  type: RevenueCatProductType;
  displayName: string | null;
  duration: string | null;
  /** Which stores carry it. */
  stores: Array<'test_store' | 'app_store' | 'other'>;
  /** Test Store price, when one is set. */
  testPrice: { currency: string; amount: number } | null;
  entitlements: string[];
}

export interface CatalogOffering {
  identifier: string;
  displayName: string;
  isCurrent: boolean;
  packages: Array<{ identifier: string; displayName: string; products: string[] }>;
}

export interface CatalogIssue {
  severity: 'blocker' | 'warning';
  /** Stable code, for tests and for the agent. */
  code:
    | 'no-test-store'
    | 'no-products'
    | 'no-entitlement'
    | 'no-current-offering'
    | 'empty-offering'
    | 'package-missing-test-product'
    | 'missing-test-price'
    | 'product-not-in-app-store';
  message: string;
}

export interface Catalog {
  products: CatalogProduct[];
  entitlements: Array<{ identifier: string; displayName: string; products: string[] }>;
  offerings: CatalogOffering[];
  issues: CatalogIssue[];
  /** True when a simulator purchase can work end to end. */
  readyForTestPurchases: boolean;
}

function storeOf(appId: string, ctx: CatalogContext, appTypes: Map<string, string>): 'test_store' | 'app_store' | 'other' {
  const type = appTypes.get(appId) ?? (appId === ctx.testStoreAppId ? 'test_store' : appId === ctx.appStoreAppId ? 'app_store' : '');
  return type === 'test_store' ? 'test_store' : type === 'app_store' ? 'app_store' : 'other';
}

/** Read the whole catalog (4 list calls + one price lookup per Test Store product). */
export async function readCatalog(ctx: CatalogContext): Promise<{ ok: true; catalog: Catalog } | Failure> {
  const { secretKey, rcProjectId } = ctx;
  const [apps, products, entitlements, offerings] = await Promise.all([
    listApps(secretKey, rcProjectId),
    listProducts(secretKey, rcProjectId),
    listEntitlements(secretKey, rcProjectId, { withProducts: true }),
    listOfferings(secretKey, rcProjectId, { withPackages: true }),
  ]);
  if (!apps.ok) return apps;
  if (!products.ok) return products;
  if (!entitlements.ok) return entitlements;
  if (!offerings.ok) return offerings;

  const appTypes = new Map(apps.data.items.map((a) => [a.id, a.type]));
  const hasTestStore = apps.data.items.some((a) => a.type === 'test_store');
  const hasAppStore = apps.data.items.some((a) => a.type === 'app_store');
  const active = products.data.items.filter((p) => p.state !== 'inactive');

  // Test Store prices live on the product's store state. Capped so a large
  // catalog cannot turn one tab load into dozens of RevenueCat calls.
  const testProducts = active.filter((p) => storeOf(p.app_id, ctx, appTypes) === 'test_store').slice(0, 12);
  const prices = new Map<string, { currency: string; amount: number } | null>();
  await Promise.all(
    testProducts.map(async (p) => {
      const state = await getProductStoreState(secretKey, rcProjectId, p.id);
      const entries = state.ok ? Object.entries(state.data.common?.pricing?.currency_prices ?? {}) : [];
      const usd = entries.find(([currency]) => currency === 'USD') ?? entries[0];
      prices.set(p.store_identifier, usd ? { currency: usd[0], amount: usd[1].amount_micros / 1_000_000 } : null);
    }),
  );

  const entitlementsByProduct = new Map<string, Set<string>>();
  for (const entitlement of entitlements.data.items) {
    for (const product of entitlement.products?.items ?? []) {
      const set = entitlementsByProduct.get(product.store_identifier) ?? new Set<string>();
      set.add(entitlement.lookup_key);
      entitlementsByProduct.set(product.store_identifier, set);
    }
  }

  // One row per store identifier: the same id exists once per store.
  const byIdentifier = new Map<string, CatalogProduct>();
  for (const p of active) {
    const store = storeOf(p.app_id, ctx, appTypes);
    const row = byIdentifier.get(p.store_identifier) ?? {
      identifier: p.store_identifier,
      type: p.type,
      displayName: p.display_name,
      duration: p.subscription?.duration ?? null,
      stores: [],
      testPrice: null,
      entitlements: [...(entitlementsByProduct.get(p.store_identifier) ?? [])],
    };
    if (!row.stores.includes(store)) row.stores.push(store);
    if (store === 'test_store') row.testPrice = prices.get(p.store_identifier) ?? null;
    byIdentifier.set(p.store_identifier, row);
  }
  const catalogProducts = [...byIdentifier.values()];

  const catalogOfferings: CatalogOffering[] = offerings.data.items.map((o) => ({
    identifier: o.lookup_key,
    displayName: o.display_name,
    isCurrent: o.is_current,
    packages: (o.packages?.items ?? []).map((pkg) => ({
      identifier: pkg.lookup_key,
      displayName: pkg.display_name,
      products: [...new Set((pkg.products?.items ?? []).map((x) => x.product.store_identifier))],
    })),
  }));

  const issues: CatalogIssue[] = [];
  if (!hasTestStore) {
    issues.push({
      severity: 'blocker',
      code: 'no-test-store',
      message:
        'This RevenueCat project has no Test Store, so the simulator cannot make test purchases. In RevenueCat open Apps, add a Test Store, then choose "Check again" in the Payments tab.',
    });
  }
  if (catalogProducts.length === 0) {
    issues.push({
      severity: 'blocker',
      code: 'no-products',
      message: 'There is nothing to sell yet. Create a product (the agent can do it with create_revenuecat_product).',
    });
  } else {
    const current = offerings.data.items.find((o) => o.is_current);
    if (!current) {
      issues.push({
        severity: 'blocker',
        code: 'no-current-offering',
        message: 'No offering is marked current, so the paywall has nothing to show. Put the products in an offering and make it current.',
      });
    } else {
      const packages = current.packages?.items ?? [];
      if (packages.length === 0) {
        issues.push({
          severity: 'blocker',
          code: 'empty-offering',
          message: `The current offering "${current.lookup_key}" has no packages, so the paywall is empty. Add each product to it as a package.`,
        });
      }
      if (hasTestStore) {
        for (const pkg of packages) {
          const inTestStore = (pkg.products?.items ?? []).some(
            (x) => storeOf(x.product.app_id, ctx, appTypes) === 'test_store',
          );
          if (!inTestStore) {
            issues.push({
              severity: 'blocker',
              code: 'package-missing-test-product',
              message: `Package "${pkg.lookup_key}" has no Test Store product, so it will not appear in the simulator.`,
            });
          }
        }
      }
    }
    for (const product of catalogProducts) {
      if (product.entitlements.length === 0) {
        issues.push({
          severity: 'blocker',
          code: 'no-entitlement',
          message: `"${product.identifier}" is not attached to an entitlement, so buying it unlocks nothing.`,
        });
      }
      if (product.stores.includes('test_store') && !product.testPrice) {
        issues.push({
          severity: 'warning',
          code: 'missing-test-price',
          message: `"${product.identifier}" has no Test Store price, so the simulator shows it without a real price.`,
        });
      }
      if (hasAppStore && !product.stores.includes('app_store')) {
        issues.push({
          severity: 'warning',
          code: 'product-not-in-app-store',
          message: `"${product.identifier}" exists only in the Test Store. Before publishing it also needs an App Store product with the same id.`,
        });
      }
    }
  }

  return {
    ok: true,
    catalog: {
      products: catalogProducts,
      entitlements: entitlements.data.items.map((e) => ({
        identifier: e.lookup_key,
        displayName: e.display_name,
        products: [...new Set((e.products?.items ?? []).map((p) => p.store_identifier))],
      })),
      offerings: catalogOfferings,
      issues,
      readyForTestPurchases: !issues.some((i) => i.severity === 'blocker'),
    },
  };
}

// ─── Provision ────────────────────────────────────────────────────────────────

export interface ProvisionInput {
  /** Product id shared by every store, e.g. "pro_monthly". */
  storeIdentifier: string;
  type: RevenueCatProductType;
  /** Name shown to the buyer, e.g. "StreakPal Pro (monthly)". */
  displayName?: string;
  /** Price for the Test Store, in USD. */
  priceUsd?: number;
  /** Billing period for subscriptions. Default one month. */
  subscriptionDuration?: RevenueCatTestDuration;
  entitlement?: string;
  entitlementDisplayName?: string;
  /** Offering to place it in. Defaults to the current offering (or a new "default"). */
  offering?: string;
  offeringDisplayName?: string;
  /** Package slot, e.g. "$rc_monthly", "$rc_annual", "$rc_lifetime" or a custom key. */
  package?: string;
  packageDisplayName?: string;
}

export interface ProvisionResult {
  ok: true;
  /** Use these exact identifiers in the app. */
  identifiers: {
    product: string;
    entitlement: string | null;
    offering: string | null;
    package: string | null;
  };
  created: { testStoreProduct: boolean; appStoreProduct: boolean; entitlement: boolean; offering: boolean; package: boolean };
  testStore: { ready: boolean; price: string | null };
  appStore: { ready: boolean };
  /** Things that did not go as asked but did not stop the product being usable. */
  notes: string[];
}

/** Find by key, else create; on a create race (409) look again. */
async function ensure<T>(
  find: () => Promise<RevenueCatResult<{ items: T[] }>>,
  match: (item: T) => boolean,
  create: () => Promise<RevenueCatResult<T>>,
): Promise<{ ok: true; item: T; created: boolean } | Failure> {
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

function step(name: string, failure: Failure): Failure {
  return { ok: false, status: failure.status, error: `Could not ${name}: ${failure.error}` };
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * Make a product purchasable: the product in each store this project has, its
 * Test Store price, the entitlement it unlocks, and its place on the paywall
 * (offering + package). Every step looks before it creates, so calling again
 * with the same input changes nothing.
 */
export async function provisionProduct(
  ctx: CatalogContext,
  input: ProvisionInput,
): Promise<ProvisionResult | Failure> {
  const { secretKey, rcProjectId } = ctx;
  const notes: string[] = [];
  const created = { testStoreProduct: false, appStoreProduct: false, entitlement: false, offering: false, package: false };

  if (!ctx.testStoreAppId && !ctx.appStoreAppId) {
    return {
      ok: false,
      status: 400,
      error:
        'This RevenueCat project has neither a Test Store nor an App Store app, so there is nowhere to create the product. ' +
        'In RevenueCat open Apps and add a Test Store, then choose "Check again" in the Payments tab.',
    };
  }

  const title = input.displayName?.trim() || input.storeIdentifier;
  const duration = input.subscriptionDuration ?? 'P1M';
  const productIds: string[] = [];
  const findProduct = (appId: string) => (p: RevenueCatProduct) =>
    p.store_identifier === input.storeIdentifier && p.app_id === appId;

  // 1. Test Store product (+ price): what the simulator buys.
  let testPrice: string | null = null;
  if (ctx.testStoreAppId) {
    const appId = ctx.testStoreAppId;
    const product = await ensure(
      () => listProducts(secretKey, rcProjectId),
      findProduct(appId),
      () =>
        createProduct(secretKey, rcProjectId, {
          store_identifier: input.storeIdentifier,
          app_id: appId,
          type: input.type,
          title,
          display_name: title,
          ...(input.type === 'subscription' ? { subscription: { duration } } : {}),
        }),
    );
    if (!product.ok) return step('create the Test Store product', product);
    created.testStoreProduct = product.created;
    productIds.push(product.item.id);

    const state = await getProductStoreState(secretKey, rcProjectId, product.item.id);
    const existingUsd = state.ok ? state.data.common?.pricing?.currency_prices?.USD?.amount_micros : undefined;
    if (existingUsd !== undefined) {
      testPrice = formatUsd(existingUsd / 1_000_000);
      if (input.priceUsd !== undefined && Math.round(input.priceUsd * 1_000_000) !== existingUsd) {
        notes.push(
          `"${input.storeIdentifier}" already costs ${testPrice} in the Test Store and RevenueCat does not allow changing a Test Store price. ` +
            `To charge ${formatUsd(input.priceUsd)}, create a product with a new id (for example "${input.storeIdentifier}_v2") in the same package; it replaces this one on the paywall.`,
        );
      }
    } else if (input.priceUsd !== undefined) {
      const priced = await setTestStorePrice(secretKey, rcProjectId, product.item.id, {
        currency: 'USD',
        amountMicros: Math.round(input.priceUsd * 1_000_000),
      });
      if (priced.ok) testPrice = formatUsd(input.priceUsd);
      else notes.push(`The Test Store price could not be set (${priced.error}). The product works but shows no real price in the simulator.`);
    } else {
      notes.push(`No priceUsd was given, so "${input.storeIdentifier}" has no Test Store price. Call again with priceUsd to set one.`);
    }
  } else {
    notes.push(
      'This RevenueCat project has no Test Store, so the simulator cannot make test purchases yet. The user adds one in RevenueCat (Apps), then chooses "Check again" in the Payments tab.',
    );
  }

  // 2. App Store product, when the project has an App Store app. RevenueCat
  //    only records the id here; the product itself is created in App Store Connect.
  if (ctx.appStoreAppId) {
    const appId = ctx.appStoreAppId;
    const product = await ensure(
      () => listProducts(secretKey, rcProjectId),
      findProduct(appId),
      () =>
        createProduct(secretKey, rcProjectId, {
          store_identifier: input.storeIdentifier,
          app_id: appId,
          type: input.type,
          display_name: title,
        }),
    );
    if (!product.ok) return step('create the App Store product', product);
    created.appStoreProduct = product.created;
    productIds.push(product.item.id);
  }

  // 3. Entitlement: what the purchase unlocks.
  const entitlementKey = input.entitlement?.trim() || null;
  if (entitlementKey) {
    const entitlement = await ensure(
      () => listEntitlements(secretKey, rcProjectId),
      (e) => e.lookup_key === entitlementKey,
      () =>
        createEntitlement(secretKey, rcProjectId, {
          lookup_key: entitlementKey,
          display_name: input.entitlementDisplayName?.trim() || entitlementKey,
        }),
    );
    if (!entitlement.ok) return step('create the entitlement', entitlement);
    created.entitlement = entitlement.created;
    const attached = await attachProductsToEntitlement(secretKey, rcProjectId, entitlement.item.id, productIds);
    if (!attached.ok && attached.status !== 409) return step('attach the product to the entitlement', attached);
  } else {
    notes.push('No entitlement was given, so buying this product unlocks nothing. Call again with entitlement.');
  }

  // 4. Offering + package: where it appears on the paywall. Unless told
  //    otherwise, use the offering the paywall already shows (the current
  //    one, whatever it is called), so the product is never created somewhere
  //    the app does not look.
  const packageKey = input.package?.trim() || null;
  let offeringKey = input.offering?.trim() || null;
  if (offeringKey || packageKey) {
    const before = await listOfferings(secretKey, rcProjectId);
    if (!before.ok) return step('read the offerings', before);
    offeringKey = offeringKey ?? before.data.items.find((o) => o.is_current)?.lookup_key ?? 'default';
    const key = offeringKey;
    const offering = await ensure(
      () => listOfferings(secretKey, rcProjectId),
      (o) => o.lookup_key === key,
      () =>
        createOffering(secretKey, rcProjectId, {
          lookup_key: key,
          display_name: input.offeringDisplayName?.trim() || (key === 'default' ? 'Default' : key),
        }),
    );
    if (!offering.ok) return step('create the offering', offering);
    created.offering = offering.created;

    // The paywall shows the CURRENT offering. Take the role only when nobody has it.
    const anotherIsCurrent = before.data.items.some((o) => o.is_current && o.lookup_key !== key);
    if (!offering.item.is_current && !anotherIsCurrent) {
      const madeCurrent = await setOfferingCurrent(secretKey, rcProjectId, offering.item.id);
      if (!madeCurrent.ok) notes.push(`The offering "${key}" could not be made current (${madeCurrent.error}).`);
    } else if (!offering.item.is_current && anotherIsCurrent) {
      const currentKey = before.data.items.find((o) => o.is_current)?.lookup_key;
      notes.push(
        `"${key}" is not the current offering ("${currentKey}" is), so a paywall that shows the current offering will not include this product.`,
      );
    }

    if (packageKey) {
      const offeringId = offering.item.id;
      const withPackages = await listOfferings(secretKey, rcProjectId, { withPackages: true });
      if (!withPackages.ok) return step('read the packages', withPackages);
      const packages = withPackages.data.items.find((o) => o.id === offeringId)?.packages?.items ?? [];
      const existingPackage = packages.find((p) => p.lookup_key === packageKey);
      let packageId = existingPackage?.id;
      if (!packageId) {
        const createdPackage = await createPackage(secretKey, rcProjectId, offeringId, {
          lookup_key: packageKey,
          display_name: input.packageDisplayName?.trim() || title,
        });
        if (!createdPackage.ok) return step('create the package', createdPackage);
        packageId = createdPackage.data.id;
        created.package = true;
      }

      // A package holds one product per store. A different product already in
      // this slot for one of our stores (an older price, say) is replaced.
      const ourApps = new Set([ctx.testStoreAppId, ctx.appStoreAppId].filter(Boolean));
      const displaced = (existingPackage?.products?.items ?? [])
        .map((x) => x.product)
        .filter((p) => ourApps.has(p.app_id) && !productIds.includes(p.id));
      if (displaced.length > 0) {
        const detached = await detachProductsFromPackage(secretKey, rcProjectId, packageId, displaced.map((p) => p.id));
        if (!detached.ok) return step('replace the product in the package', detached);
        notes.push(
          `Replaced ${[...new Set(displaced.map((p) => `"${p.store_identifier}"`))].join(', ')} in package "${packageKey}" with "${input.storeIdentifier}".`,
        );
      }
      const attached = await attachProductsToPackage(secretKey, rcProjectId, packageId, productIds);
      if (!attached.ok && attached.status !== 409) return step('attach the product to the package', attached);
    } else {
      notes.push('No package was given, so the product is in no paywall slot. Call again with package (for example "$rc_monthly").');
    }
  } else {
    notes.push('No offering or package was given, so the product does not appear on the paywall. Call again with package (for example "$rc_monthly").');
  }

  if (!ctx.appStoreAppId) {
    notes.push(
      'Test purchases work now. To sell for real the user later adds an App Store app in RevenueCat and creates a product with this same id in App Store Connect; then call this tool again to register it.',
    );
  }

  return {
    ok: true,
    identifiers: {
      product: input.storeIdentifier,
      entitlement: entitlementKey,
      offering: offeringKey,
      package: packageKey,
    },
    created,
    testStore: { ready: Boolean(ctx.testStoreAppId), price: testPrice },
    appStore: { ready: Boolean(ctx.appStoreAppId) },
    notes,
  };
}

/** Validate untrusted input (HTTP body or agent tool arguments) into a ProvisionInput. */
export function parseProvisionInput(
  body: Record<string, unknown>,
): { ok: true; input: ProvisionInput } | { ok: false; error: string } {
  const str = (key: string): string | undefined => {
    const value = body[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  const storeIdentifier = str('storeIdentifier');
  const type = str('type') as RevenueCatProductType | undefined;
  if (!storeIdentifier || !type || !REVENUECAT_PRODUCT_TYPES.includes(type)) {
    return {
      ok: false,
      error: `storeIdentifier and type are required (type is one of: ${REVENUECAT_PRODUCT_TYPES.join(', ')}).`,
    };
  }
  if (!/^[A-Za-z0-9._]{1,100}$/.test(storeIdentifier)) {
    return {
      ok: false,
      error: 'storeIdentifier may contain only letters, digits, "." and "_" (for example "pro_monthly"), which is what App Store Connect accepts.',
    };
  }
  let priceUsd: number | undefined;
  if (body.priceUsd !== undefined && body.priceUsd !== null) {
    priceUsd = Number(body.priceUsd);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0 || priceUsd > 9999) {
      return { ok: false, error: 'priceUsd must be a number above 0, in US dollars (for example 4.99).' };
    }
  }
  const duration = str('subscriptionDuration') as RevenueCatTestDuration | undefined;
  if (duration && !REVENUECAT_TEST_DURATIONS.includes(duration)) {
    return { ok: false, error: `subscriptionDuration must be one of: ${REVENUECAT_TEST_DURATIONS.join(', ')}.` };
  }
  return {
    ok: true,
    input: {
      storeIdentifier,
      type,
      displayName: str('displayName'),
      priceUsd,
      subscriptionDuration: duration,
      entitlement: str('entitlement'),
      entitlementDisplayName: str('entitlementDisplayName'),
      offering: str('offering'),
      offeringDisplayName: str('offeringDisplayName'),
      package: str('package'),
      packageDisplayName: str('packageDisplayName'),
    },
  };
}
