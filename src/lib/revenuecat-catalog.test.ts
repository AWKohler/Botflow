/**
 * Creating a product end to end and diagnosing a catalog: the two operations
 * behind the agent's create_revenuecat_product / get_revenuecat_products tools
 * and the Payments tab's "What your app sells".
 */
import { describe, expect, test } from 'vitest';
import { fakeRevenueCat, type FakeRevenueCat } from '@/test/revenuecat-fake';
import {
  parseProvisionInput,
  provisionProduct,
  readCatalog,
  type CatalogContext,
  type ProvisionInput,
} from './revenuecat-catalog';

function ctxFor(rc: FakeRevenueCat): CatalogContext {
  return {
    secretKey: 'sk_full',
    rcProjectId: rc.projectId,
    testStoreAppId: rc.apps.find((a) => a.type === 'test_store')?.id ?? null,
    appStoreAppId: rc.apps.find((a) => a.type === 'app_store')?.id ?? null,
  };
}

const MONTHLY: ProvisionInput = {
  storeIdentifier: 'pro_monthly',
  type: 'subscription',
  displayName: 'Pro (monthly)',
  priceUsd: 4.99,
  subscriptionDuration: 'P1M',
  entitlement: 'pro',
  package: '$rc_monthly',
};

async function catalogOf(rc: FakeRevenueCat) {
  const result = await readCatalog(ctxFor(rc));
  if (!result.ok) throw new Error(result.error);
  return result.catalog;
}

describe('create_revenuecat_product', () => {
  test('with only a Test Store: one call makes a purchasable, priced product on the paywall', async () => {
    const rc = fakeRevenueCat();
    const result = await provisionProduct(ctxFor(rc), MONTHLY);
    expect(result).toMatchObject({
      ok: true,
      identifiers: { product: 'pro_monthly', entitlement: 'pro', offering: 'default', package: '$rc_monthly' },
      created: { testStoreProduct: true, appStoreProduct: false, entitlement: true, offering: true, package: true },
      testStore: { ready: true, price: '$4.99' },
      appStore: { ready: false },
    });

    const catalog = await catalogOf(rc);
    expect(catalog.readyForTestPurchases).toBe(true);
    expect(catalog.issues).toEqual([]);
    expect(catalog.products).toEqual([
      {
        identifier: 'pro_monthly',
        type: 'subscription',
        displayName: 'Pro (monthly)',
        duration: 'P1M',
        stores: ['test_store'],
        testPrice: { currency: 'USD', amount: 4.99 },
        entitlements: ['pro'],
      },
    ]);
    expect(catalog.offerings).toEqual([
      {
        identifier: 'default',
        displayName: 'Default',
        isCurrent: true,
        packages: [{ identifier: '$rc_monthly', displayName: 'Pro (monthly)', products: ['pro_monthly'] }],
      },
    ]);
  });

  test('calling it again with the same input changes nothing', async () => {
    const rc = fakeRevenueCat();
    await provisionProduct(ctxFor(rc), MONTHLY);
    const writesAfterFirst = rc.writes();
    const productsAfterFirst = rc.products.length;

    const second = await provisionProduct(ctxFor(rc), MONTHLY);
    expect(second).toMatchObject({
      ok: true,
      created: { testStoreProduct: false, entitlement: false, offering: false, package: false },
      testStore: { price: '$4.99' },
    });
    expect(rc.products).toHaveLength(productsAfterFirst);
    expect(rc.entitlements).toHaveLength(1);
    expect(rc.offerings).toHaveLength(1);
    expect(rc.packages).toHaveLength(1);
    // Only the two idempotent attach calls are repeated.
    expect(rc.writes() - writesAfterFirst).toBe(2);
  });

  test('with an App Store app too: the same id is registered in both stores and shares the package', async () => {
    const rc = fakeRevenueCat({ appStore: true });
    const result = await provisionProduct(ctxFor(rc), MONTHLY);
    expect(result).toMatchObject({ ok: true, created: { testStoreProduct: true, appStoreProduct: true } });
    expect(rc.products.map((p) => p.app_id).sort()).toEqual(['app_ios', 'app_test']);
    expect(rc.packages[0].productIds).toHaveLength(2);
    expect(rc.entitlements[0].productIds).toHaveLength(2);
    expect((await catalogOf(rc)).products[0].stores.sort()).toEqual(['app_store', 'test_store']);
  });

  test('an App Store app added later: calling again registers the App Store product', async () => {
    const rc = fakeRevenueCat();
    await provisionProduct(ctxFor(rc), MONTHLY);
    rc.apps.push({ id: 'app_ios', name: 'iOS', type: 'app_store' });

    expect((await catalogOf(rc)).issues.map((i) => i.code)).toContain('product-not-in-app-store');
    const again = await provisionProduct(ctxFor(rc), MONTHLY);
    expect(again).toMatchObject({ ok: true, created: { testStoreProduct: false, appStoreProduct: true } });
    expect((await catalogOf(rc)).issues).toEqual([]);
  });

  test('a monthly and a yearly plan share one entitlement and one offering', async () => {
    const rc = fakeRevenueCat();
    await provisionProduct(ctxFor(rc), MONTHLY);
    await provisionProduct(ctxFor(rc), {
      ...MONTHLY,
      storeIdentifier: 'pro_yearly',
      displayName: 'Pro (yearly)',
      priceUsd: 39.99,
      subscriptionDuration: 'P1Y',
      package: '$rc_annual',
    });
    const catalog = await catalogOf(rc);
    expect(catalog.entitlements).toEqual([
      { identifier: 'pro', displayName: 'pro', products: ['pro_monthly', 'pro_yearly'] },
    ]);
    expect(catalog.offerings[0].packages.map((p) => p.identifier)).toEqual(['$rc_monthly', '$rc_annual']);
    expect(catalog.readyForTestPurchases).toBe(true);
  });

  test('a Test Store price cannot change: the same id keeps its price and the result says how to re-price', async () => {
    const rc = fakeRevenueCat();
    await provisionProduct(ctxFor(rc), MONTHLY);
    const result = await provisionProduct(ctxFor(rc), { ...MONTHLY, priceUsd: 6.99 });
    expect(result).toMatchObject({ ok: true, testStore: { price: '$4.99' } });
    expect(result.ok ? result.notes.join(' ') : '').toMatch(/does not allow changing a Test Store price/);
  });

  test('re-pricing with a new id replaces the old product in its package', async () => {
    const rc = fakeRevenueCat();
    await provisionProduct(ctxFor(rc), MONTHLY);
    const result = await provisionProduct(ctxFor(rc), { ...MONTHLY, storeIdentifier: 'pro_monthly_v2', priceUsd: 6.99 });
    expect(result).toMatchObject({ ok: true, testStore: { price: '$6.99' } });
    expect(result.ok ? result.notes.join(' ') : '').toMatch(/Replaced "pro_monthly" in package "\$rc_monthly"/);
    expect((await catalogOf(rc)).offerings[0].packages).toEqual([
      { identifier: '$rc_monthly', displayName: 'Pro (monthly)', products: ['pro_monthly_v2'] },
    ]);
  });

  test('an offering that is not current is reported, and the current one is left alone', async () => {
    const rc = fakeRevenueCat();
    await provisionProduct(ctxFor(rc), MONTHLY);
    const result = await provisionProduct(ctxFor(rc), {
      ...MONTHLY,
      storeIdentifier: 'promo_monthly',
      offering: 'winter_sale',
    });
    expect(result.ok ? result.notes.join(' ') : '').toMatch(/"winter_sale" is not the current offering \("default" is\)/);
    expect(rc.offerings.find((o) => o.is_current)?.lookup_key).toBe('default');
  });

  test('with no offering named, the product goes where the paywall already looks', async () => {
    const rc = fakeRevenueCat();
    // A RevenueCat project that already has a current offering under another name.
    rc.offerings.push({ id: 'ofrng_existing', lookup_key: 'launch', display_name: 'Launch', is_current: true });
    const result = await provisionProduct(ctxFor(rc), MONTHLY);
    expect(result).toMatchObject({ ok: true, identifiers: { offering: 'launch' }, created: { offering: false } });
    expect(rc.offerings).toHaveLength(1);
    expect((await catalogOf(rc)).readyForTestPurchases).toBe(true);
  });

  test('a consumable needs no entitlement or duration', async () => {
    const rc = fakeRevenueCat();
    const result = await provisionProduct(ctxFor(rc), {
      storeIdentifier: 'coins_100',
      type: 'consumable',
      displayName: '100 coins',
      priceUsd: 0.99,
      package: 'coins_100',
    });
    expect(result).toMatchObject({ ok: true, identifiers: { entitlement: null, package: 'coins_100' } });
    expect(rc.products[0].subscription).toBeNull();
  });

  test('no Test Store and no App Store app: nothing can be created, and the error says what to add', async () => {
    const rc = fakeRevenueCat({ testStore: false });
    const result = await provisionProduct(ctxFor(rc), MONTHLY);
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(result.ok ? '' : result.error).toMatch(/add a Test Store/);
    expect(rc.writes()).toBe(0);
  });

  test('a read-only key fails on the first write with RevenueCat\'s permission message', async () => {
    const rc = fakeRevenueCat();
    const result = await provisionProduct({ ...ctxFor(rc), secretKey: 'sk_readonly' }, MONTHLY);
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(result.ok ? '' : result.error).toMatch(/products:read_write/);
  });
});

describe('get_revenuecat_products diagnosis', () => {
  test('an empty project: one blocker, nothing to sell', async () => {
    const catalog = await catalogOf(fakeRevenueCat());
    expect(catalog.issues.map((i) => i.code)).toEqual(['no-products']);
    expect(catalog.readyForTestPurchases).toBe(false);
  });

  test('no Test Store is a blocker on its own', async () => {
    const catalog = await catalogOf(fakeRevenueCat({ testStore: false }));
    expect(catalog.issues.map((i) => i.code)).toEqual(['no-test-store', 'no-products']);
  });

  test('a product on no paywall and unlocking nothing is called out', async () => {
    const rc = fakeRevenueCat();
    await provisionProduct(ctxFor(rc), { storeIdentifier: 'pro_monthly', type: 'subscription' });
    const catalog = await catalogOf(rc);
    expect(catalog.issues.map((i) => i.code)).toEqual(['no-current-offering', 'no-entitlement', 'missing-test-price']);
    expect(catalog.readyForTestPurchases).toBe(false);
  });

  test('a package that only has an App Store product will not show in the simulator', async () => {
    const rc = fakeRevenueCat({ appStore: true });
    await provisionProduct({ ...ctxFor(rc), testStoreAppId: null }, MONTHLY);
    const catalog = await catalogOf(rc);
    expect(catalog.issues.map((i) => i.code)).toEqual(['package-missing-test-product']);
    expect(catalog.readyForTestPurchases).toBe(false);
  });

  test('a missing price is a warning, not a blocker', async () => {
    const rc = fakeRevenueCat();
    await provisionProduct(ctxFor(rc), { ...MONTHLY, priceUsd: undefined });
    const catalog = await catalogOf(rc);
    expect(catalog.issues).toEqual([expect.objectContaining({ severity: 'warning', code: 'missing-test-price' })]);
    expect(catalog.readyForTestPurchases).toBe(true);
  });
});

describe('tool input validation', () => {
  test('accepts the documented shape', () => {
    expect(parseProvisionInput({ ...MONTHLY })).toEqual({ ok: true, input: expect.objectContaining(MONTHLY) });
  });

  test.each([
    [{ type: 'subscription' }, /storeIdentifier and type are required/],
    [{ storeIdentifier: 'pro', type: 'rental' }, /type is one of/],
    [{ storeIdentifier: 'pro monthly!', type: 'subscription' }, /letters, digits/],
    [{ storeIdentifier: 'pro', type: 'subscription', priceUsd: -1 }, /priceUsd/],
    [{ storeIdentifier: 'pro', type: 'subscription', priceUsd: 'free' }, /priceUsd/],
    [{ storeIdentifier: 'pro', type: 'subscription', subscriptionDuration: 'P2W' }, /subscriptionDuration/],
  ])('%j is rejected', (body, message) => {
    const parsed = parseProvisionInput(body);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.error).toMatch(message);
  });
});
