/**
 * In-memory stand-in for RevenueCat's REST API v2, served through msw.
 *
 * It models the behaviour the integration depends on, as observed against the
 * real API (2026-11): keys are project-scoped; `GET /projects/{id}` does not
 * exist; a V1 key is refused with a "legacy API key" 403; a missing permission
 * is a 403 naming it; attaching is idempotent; a package holds one product per
 * app (a second is a 422); the Test Store's SDK key reports environment
 * "production"; Test Store prices are create-only.
 */
import { http, HttpResponse } from 'msw';
import { server } from './network';

const BASE = 'https://api.revenuecat.com/v2';

type KeyKind = 'full' | 'read-only' | 'legacy';

interface FakeProduct {
  id: string;
  store_identifier: string;
  app_id: string;
  type: string;
  display_name: string | null;
  state: string;
  subscription: { duration: string } | null;
}

export interface FakeRevenueCat {
  projectId: string;
  projectName: string;
  keys: Map<string, KeyKind>;
  apps: Array<{ id: string; name: string; type: string }>;
  sdkKeys: Map<string, string>;
  products: FakeProduct[];
  prices: Map<string, Record<string, { amount_micros: number }>>;
  entitlements: Array<{ id: string; lookup_key: string; display_name: string; productIds: string[] }>;
  offerings: Array<{ id: string; lookup_key: string; display_name: string; is_current: boolean }>;
  packages: Array<{ id: string; offeringId: string; lookup_key: string; display_name: string; productIds: string[] }>;
  webhooks: Array<{ id: string; name: string; url: string; authorization_header: string | null; status: string }>;
  /** "METHOD /path" of every request, in order. */
  calls: string[];
  /**
   * Make matching requests fail, to model RevenueCat being briefly unavailable.
   * `match` is tested against "METHOD /path"; `times` defaults to forever.
   */
  failures: Array<{ match: RegExp; status: number; times?: number }>;
  /** Number of state-changing requests, to assert idempotency. */
  writes(): number;
}

const list = (items: unknown[]) => ({ object: 'list', items, next_page: null });
const error = (status: number, message: string, type = 'authorization_error') =>
  HttpResponse.json({ object: 'error', type, message, retryable: false }, { status });

/** Install the fake and return its state for arranging and asserting. */
export function fakeRevenueCat(
  init: { testStore?: boolean; appStore?: boolean; projectName?: string } = {},
): FakeRevenueCat {
  let seq = 0;
  const id = (prefix: string) => `${prefix}${(++seq).toString(16).padStart(8, '0')}`;
  const rc: FakeRevenueCat = {
    projectId: 'proj1a2b3c4d',
    projectName: init.projectName ?? 'StreakPal',
    keys: new Map<string, KeyKind>([
      ['sk_full', 'full'],
      ['sk_readonly', 'read-only'],
      ['sk_legacy', 'legacy'],
    ]),
    apps: [],
    sdkKeys: new Map(),
    products: [],
    prices: new Map(),
    entitlements: [],
    offerings: [],
    packages: [],
    webhooks: [],
    calls: [],
    failures: [],
    writes: () => rc.calls.filter((c) => !c.startsWith('GET ')).length,
  };
  if (init.testStore !== false) {
    rc.apps.push({ id: 'app_test', name: 'Test Store', type: 'test_store' });
    rc.sdkKeys.set('app_test', 'test_PUBLICKEY');
  }
  if (init.appStore) {
    rc.apps.push({ id: 'app_ios', name: 'StreakPal (iOS)', type: 'app_store' });
    rc.sdkKeys.set('app_ios', 'appl_PUBLICKEY');
  }

  /** Run `handler` when the key may do this; otherwise answer like RevenueCat does. */
  const guard = (
    permission: string,
    handler: (ctx: { params: Record<string, string>; body: Record<string, unknown>; url: URL }) => Response | Promise<Response>,
  ) =>
    async ({ request, params }: { request: Request; params: Record<string, string | readonly string[] | undefined> }) => {
      const url = new URL(request.url);
      const signature = `${request.method} ${url.pathname.replace('/v2', '')}`;
      rc.calls.push(signature);
      const failing = rc.failures.find((f) => f.match.test(signature) && (f.times === undefined || f.times > 0));
      if (failing) {
        if (failing.times !== undefined) failing.times -= 1;
        return error(failing.status, `simulated ${failing.status}`, 'server_error');
      }
      const key = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
      const kind = rc.keys.get(key);
      if (!kind) return error(401, 'Invalid API key.', 'authentication_error');
      if (kind === 'legacy') {
        return error(403, "You're trying to use a legacy API key to access API v2. Please create a new API key for v2.");
      }
      if (params.projectId && params.projectId !== rc.projectId) {
        return error(404, 'Resource not found', 'resource_missing');
      }
      if (kind === 'read-only' && permission.endsWith(':read_write')) {
        return error(403, `The API key needs at least the ${permission} permission defined`);
      }
      const body = request.method === 'GET' || request.method === 'DELETE' ? {} : await request.json().catch(() => ({}));
      return handler({ params: params as Record<string, string>, body: body as Record<string, unknown>, url });
    };

  const productJson = (p: FakeProduct) => ({ object: 'product', ...p });
  const packageJson = (pkg: FakeRevenueCat['packages'][number], expand: boolean) => ({
    object: 'package',
    id: pkg.id,
    lookup_key: pkg.lookup_key,
    display_name: pkg.display_name,
    position: 1,
    ...(expand
      ? {
          products: list(
            pkg.productIds.map((pid) => ({
              eligibility_criteria: 'all',
              product: productJson(rc.products.find((p) => p.id === pid)!),
            })),
          ),
        }
      : {}),
  });

  const P = `${BASE}/projects/:projectId`;
  server.use(
    http.get(`${BASE}/projects`, guard('project_configuration:projects:read', () =>
      HttpResponse.json(list([{ object: 'project', id: rc.projectId, name: rc.projectName, created_at: 1 }])),
    )),
    // API v2 has no "get one project": this 404 is what the old integration hit.
    http.get(P, guard('project_configuration:projects:read', () => error(404, 'Resource not found', 'resource_missing'))),

    http.get(`${P}/apps`, guard('project_configuration:apps:read', () =>
      HttpResponse.json(list(rc.apps.map((a) => ({ object: 'app', ...a })))),
    )),
    http.get(`${P}/apps/:appId/public_api_keys`, guard('project_configuration:apps:read', ({ params }) => {
      const key = rc.sdkKeys.get(params.appId);
      return HttpResponse.json(
        list(key ? [{ object: 'public_api_key', id: 'apikey1', key, environment: 'production', app_id: params.appId }] : []),
      );
    })),

    http.get(`${P}/products`, guard('project_configuration:products:read', () =>
      HttpResponse.json(list(rc.products.map(productJson))),
    )),
    http.post(`${P}/products`, guard('project_configuration:products:read_write', ({ body }) => {
      const app = rc.apps.find((a) => a.id === body.app_id);
      if (!app) return error(400, 'app not found', 'parameter_error');
      if (app.type === 'test_store' && !body.title) {
        return error(400, "'title' is required for Test Store products", 'parameter_error');
      }
      if (rc.products.some((p) => p.app_id === body.app_id && p.store_identifier === body.store_identifier)) {
        return error(409, 'Product already exists', 'resource_already_exists');
      }
      const product: FakeProduct = {
        id: id('prod'),
        store_identifier: String(body.store_identifier),
        app_id: String(body.app_id),
        type: String(body.type),
        display_name: (body.display_name as string) ?? null,
        state: 'active',
        subscription: (body.subscription as { duration: string }) ?? null,
      };
      rc.products.push(product);
      return HttpResponse.json(productJson(product), { status: 201 });
    })),
    http.get(`${P}/products/:productId/store_state`, guard('project_configuration:products:read', ({ params }) =>
      HttpResponse.json({ store: 'test_store', common: { pricing: { currency_prices: rc.prices.get(params.productId) ?? {} } } }),
    )),
    http.post(`${P}/products/:productId/store_state`, guard('project_configuration:products:read_write', ({ params, body }) => {
      const incoming =
        (body.common as { pricing?: { currency_prices?: Record<string, { amount_micros: number }> } })?.pricing
          ?.currency_prices ?? {};
      const current = rc.prices.get(params.productId) ?? {};
      for (const currency of Object.keys(incoming)) {
        if (current[currency]) return error(422, 'Updating an existing currency is rejected', 'unprocessable_entity_error');
      }
      rc.prices.set(params.productId, { ...current, ...incoming });
      return HttpResponse.json({ operation_id: 'op1', status: 'pending' }, { status: 202 });
    })),

    http.get(`${P}/entitlements`, guard('project_configuration:entitlements:read', ({ url }) => {
      const expand = url.searchParams.get('expand') === 'items.product';
      return HttpResponse.json(
        list(
          rc.entitlements.map((e) => ({
            object: 'entitlement',
            id: e.id,
            lookup_key: e.lookup_key,
            display_name: e.display_name,
            ...(expand
              ? { products: list(e.productIds.map((pid) => productJson(rc.products.find((p) => p.id === pid)!))) }
              : {}),
          })),
        ),
      );
    })),
    http.post(`${P}/entitlements`, guard('project_configuration:entitlements:read_write', ({ body }) => {
      const entitlement = {
        id: id('entl'),
        lookup_key: String(body.lookup_key),
        display_name: String(body.display_name),
        productIds: [] as string[],
      };
      rc.entitlements.push(entitlement);
      return HttpResponse.json({ object: 'entitlement', ...entitlement }, { status: 201 });
    })),
    http.post(`${P}/entitlements/:entitlementId/actions/attach_products`, guard('project_configuration:entitlements:read_write', ({ params, body }) => {
      const entitlement = rc.entitlements.find((e) => e.id === params.entitlementId)!;
      for (const pid of body.product_ids as string[]) {
        if (!entitlement.productIds.includes(pid)) entitlement.productIds.push(pid);
      }
      return HttpResponse.json({ object: 'entitlement', id: entitlement.id, lookup_key: entitlement.lookup_key });
    })),

    http.get(`${P}/offerings`, guard('project_configuration:offerings:read', ({ url }) => {
      const expand = url.searchParams.get('expand') === 'items.package.product';
      return HttpResponse.json(
        list(
          rc.offerings.map((o) => ({
            object: 'offering',
            ...o,
            ...(expand
              ? { packages: list(rc.packages.filter((p) => p.offeringId === o.id).map((p) => packageJson(p, true))) }
              : {}),
          })),
        ),
      );
    })),
    http.post(`${P}/offerings`, guard('project_configuration:offerings:read_write', ({ body }) => {
      const offering = {
        id: id('ofrng'),
        lookup_key: String(body.lookup_key),
        display_name: String(body.display_name),
        // RevenueCat makes a project's first offering current by itself.
        is_current: rc.offerings.length === 0,
      };
      rc.offerings.push(offering);
      return HttpResponse.json({ object: 'offering', ...offering }, { status: 201 });
    })),
    http.post(`${P}/offerings/:offeringId`, guard('project_configuration:offerings:read_write', ({ params, body }) => {
      const offering = rc.offerings.find((o) => o.id === params.offeringId)!;
      if (body.is_current === true) {
        for (const o of rc.offerings) o.is_current = o.id === offering.id;
      }
      return HttpResponse.json({ object: 'offering', ...offering });
    })),
    http.post(`${P}/offerings/:offeringId/packages`, guard('project_configuration:packages:read_write', ({ params, body }) => {
      const pkg = {
        id: id('pkge'),
        offeringId: params.offeringId,
        lookup_key: String(body.lookup_key),
        display_name: String(body.display_name),
        productIds: [] as string[],
      };
      rc.packages.push(pkg);
      return HttpResponse.json(packageJson(pkg, false), { status: 201 });
    })),
    http.post(`${P}/packages/:packageId/actions/attach_products`, guard('project_configuration:packages:read_write', ({ params, body }) => {
      const pkg = rc.packages.find((p) => p.id === params.packageId)!;
      for (const { product_id } of body.products as Array<{ product_id: string }>) {
        if (pkg.productIds.includes(product_id)) continue;
        const appId = rc.products.find((p) => p.id === product_id)!.app_id;
        const clash = pkg.productIds.some((pid) => rc.products.find((p) => p.id === pid)!.app_id === appId);
        if (clash) {
          return error(
            422,
            `Cannot attach product \`${product_id}\` to this package because there is already another incompatible product from the same app \`${appId}\` attached to it.`,
            'unprocessable_entity_error',
          );
        }
        pkg.productIds.push(product_id);
      }
      return HttpResponse.json(packageJson(pkg, false));
    })),
    http.post(`${P}/packages/:packageId/actions/detach_products`, guard('project_configuration:packages:read_write', ({ params, body }) => {
      const pkg = rc.packages.find((p) => p.id === params.packageId)!;
      pkg.productIds = pkg.productIds.filter((pid) => !(body.product_ids as string[]).includes(pid));
      return HttpResponse.json(packageJson(pkg, false));
    })),

    http.delete(`${P}/packages/:packageId`, guard('project_configuration:packages:read_write', ({ params }) => {
      const before = rc.packages.length;
      rc.packages = rc.packages.filter((p) => p.id !== params.packageId);
      return before === rc.packages.length
        ? error(404, 'Resource not found', 'resource_missing')
        : HttpResponse.json({ object: 'package', id: params.packageId, deleted_at: 1 });
    })),

    http.get(`${P}/integrations/webhooks`, guard('project_configuration:integrations:read', () =>
      HttpResponse.json(list(rc.webhooks.map((w) => ({ object: "webhook_integration", id: w.id, name: w.name, url: w.url, status: w.status })))),
    )),
    http.post(`${P}/integrations/webhooks`, guard('project_configuration:integrations:read_write', ({ body }) => {
      const webhook = {
        id: id('wh'),
        name: String(body.name),
        url: String(body.url),
        authorization_header: (body.authorization_header as string) ?? null,
        status: 'active',
      };
      rc.webhooks.push(webhook);
      return HttpResponse.json({ object: 'webhook_integration', id: webhook.id, name: webhook.name, url: webhook.url }, { status: 201 });
    })),
    http.post(`${P}/integrations/webhooks/:webhookId`, guard('project_configuration:integrations:read_write', ({ params, body }) => {
      const webhook = rc.webhooks.find((w) => w.id === params.webhookId);
      if (!webhook) return error(404, 'Resource not found', 'resource_missing');
      Object.assign(webhook, body);
      return HttpResponse.json({ object: 'webhook_integration', id: webhook.id, name: webhook.name, url: webhook.url });
    })),
    http.delete(`${P}/integrations/webhooks/:webhookId`, guard('project_configuration:integrations:read_write', ({ params }) => {
      const before = rc.webhooks.length;
      rc.webhooks = rc.webhooks.filter((w) => w.id !== params.webhookId);
      return before === rc.webhooks.length
        ? error(404, 'Resource not found', 'resource_missing')
        : HttpResponse.json({ object: 'webhook_integration', id: params.webhookId, deleted_at: 1 });
    })),
  );
  return rc;
}
