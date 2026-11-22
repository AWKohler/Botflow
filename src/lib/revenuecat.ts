/**
 * RevenueCat v2 REST client — server-side.
 *
 * BYO model: each Botflow project is connected to the user's own RevenueCat
 * project with a project-scoped **V2 secret key** (`sk_…`). We never hold a
 * platform-wide RevenueCat account; every call here is made with that project's
 * key, which is stored encrypted (src/lib/secrets.ts) and decrypted only at
 * call time.
 *
 * A secret key can manage everything inside its RevenueCat project (apps, SDK
 * keys, products, entitlements, offerings, webhooks) but cannot create the
 * project itself — the user creates it in the RevenueCat dashboard.
 *
 * Docs: https://www.revenuecat.com/docs/api-v2
 */

const RC_API_BASE = 'https://api.revenuecat.com/v2';
const RC_DASHBOARD_BASE = 'https://app.revenuecat.com';

export type RevenueCatResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

/** Low-level authenticated fetch against the RevenueCat v2 API. Never throws. */
async function rcFetch<T>(
  secretKey: string,
  path: string,
  init?: { method?: string; body?: unknown; timeoutMs?: number },
): Promise<RevenueCatResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? 15_000);
  try {
    const res = await fetch(`${RC_API_BASE}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
      cache: 'no-store',
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      const message =
        (json as { message?: string } | null)?.message ||
        `RevenueCat API ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`;
      return { ok: false, status: res.status, error: message };
    }
    return { ok: true, data: (json as T) ?? ({} as T) };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      status: aborted ? 504 : 502,
      error: aborted
        ? 'RevenueCat API timed out'
        : `RevenueCat request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface RevenueCatProject {
  object: 'project';
  id: string;
  name: string;
  created_at: number;
}

/**
 * The projects this key can see. A secret key is scoped to the one project it
 * was created in, so this is how we learn the project id from the key alone
 * (API v2 has no "get one project" endpoint — `GET /projects/{id}` is a 404).
 */
export async function listProjects(
  secretKey: string,
): Promise<RevenueCatResult<RcList<RevenueCatProject>>> {
  return rcFetch(secretKey, '/projects?limit=100');
}

/** Why a key cannot be used, in terms the user can act on. */
export type RevenueCatKeyProblem =
  | 'not-secret-key'
  | 'legacy-key'
  | 'invalid-key'
  | 'missing-permission'
  | 'read-only'
  | 'no-project'
  | 'unreachable';

export const REVENUECAT_KEY_HELP =
  'Create a new secret key in RevenueCat (API keys → New secret API key), choose API version V2, ' +
  'and set "Project configuration permissions" to "Read & write".';

/**
 * Turn a failed RevenueCat API call into a message that says what to change.
 * RevenueCat's own messages are precise ("The API key needs at least the
 * project_configuration:apps:read permission defined") but assume the reader
 * knows where permissions live.
 */
export function explainRevenueCatError(
  result: { status: number; error: string },
): { problem: RevenueCatKeyProblem; message: string } {
  const raw = result.error ?? '';
  if (/legacy API key/i.test(raw)) {
    return {
      problem: 'legacy-key',
      message: `That is a V1 (legacy) secret key, which cannot manage products or webhooks. ${REVENUECAT_KEY_HELP}`,
    };
  }
  if (result.status === 401) {
    return {
      problem: 'invalid-key',
      message:
        'RevenueCat does not recognise that secret key. It may have been deleted, or part of it was cut off when copying. ' +
        'Copy the whole key (it starts with "sk_") or create a new one.',
    };
  }
  if (result.status === 403) {
    const permission = raw.match(/needs at least the ([a-z_]+:[a-z_]+:[a-z_]+) permission/i)?.[1];
    if (permission) {
      const readOnly = permission.endsWith(':read_write');
      return {
        problem: readOnly ? 'read-only' : 'missing-permission',
        message:
          `That key is missing a permission Botflow needs (${permission}). ` +
          'In RevenueCat, keys cannot be edited after they are created. ' +
          REVENUECAT_KEY_HELP,
      };
    }
    return { problem: 'missing-permission', message: `RevenueCat refused that key: ${raw}. ${REVENUECAT_KEY_HELP}` };
  }
  if (result.status === 429) {
    return { problem: 'unreachable', message: 'RevenueCat is rate-limiting requests right now. Wait a minute and try again.' };
  }
  return {
    problem: 'unreachable',
    message: `RevenueCat could not be reached (${raw || `HTTP ${result.status}`}). Try again in a moment.`,
  };
}

/** Shape check before any network call, so the common paste mistakes get a specific answer. */
export function checkSecretKeyShape(secretKey: string): { ok: true } | { ok: false; message: string } {
  if (/^(test|appl|goog|amzn|strp|rcb)_/.test(secretKey)) {
    return {
      ok: false,
      message:
        'That is an SDK key (public), not a secret key. Botflow finds the SDK keys by itself; it needs the secret key, which starts with "sk_". ' +
        'In RevenueCat, open API keys and create one under "Secret API keys".',
    };
  }
  if (!secretKey.startsWith('sk_')) {
    return {
      ok: false,
      message: 'That does not look like a RevenueCat secret key. It should start with "sk_". ' + REVENUECAT_KEY_HELP,
    };
  }
  return { ok: true };
}

// ─── Provisioning (agent product tools + the /revenuecat/products route) ────────
//
// Endpoint paths + request bodies verified against RevenueCat's published
// OpenAPI spec (docs/redocusaurus/openapi-v2.yaml, fetched 2026-07-02). Two
// asymmetries worth remembering:
//   • entitlement attach takes { product_ids: [...] }, but PACKAGE attach takes
//     { products: [{ product_id, eligibility_criteria }] } and lives at
//     /projects/{id}/packages/{package_id}/... (NOT nested under offerings);
//   • offerings/packages are keyed by lookup_key (there is no `identifier`);
//   • attaching is idempotent (200 when already attached), but a package holds
//     ONE product per app: attaching a second from the same app is a 422.

export type RevenueCatProductType =
  | 'subscription'
  | 'one_time'
  | 'consumable'
  | 'non_consumable'
  | 'non_renewing_subscription';

/** v2 list envelope. We request limit=100; callers get first-page items. */
interface RcList<T> {
  items: T[];
  next_page: string | null;
}

export interface RevenueCatApp {
  object: 'app';
  id: string;
  name: string;
  type: string; // 'app_store' | 'test_store' | 'play_store' | 'stripe' | ...
  /** Present on App Store apps. */
  app_store?: { bundle_id?: string | null } | null;
}

export interface RevenueCatPublicApiKey {
  object: 'public_api_key';
  id: string;
  key: string;
  environment: string;
  app_id: string;
}

/** Test-store subscription durations the v2 API accepts (ISO 8601 subset). */
export type RevenueCatTestDuration = 'P1W' | 'P1M' | 'P2M' | 'P3M' | 'P6M' | 'P1Y';

export interface RevenueCatProduct {
  object: 'product';
  id: string;
  store_identifier: string;
  type: RevenueCatProductType;
  display_name: string | null;
  app_id: string;
  state?: string;
  subscription?: { duration: string | null } | null;
}

export interface RevenueCatEntitlement {
  object: 'entitlement';
  id: string;
  lookup_key: string;
  display_name: string;
  /** Present with expand=items.product. */
  products?: RcList<RevenueCatProduct>;
}

export interface RevenueCatPackage {
  object: 'package';
  id: string;
  lookup_key: string;
  display_name: string;
  position: number | null;
  /** Present with expand=items.package.product. */
  products?: RcList<{ eligibility_criteria: string; product: RevenueCatProduct }>;
}

export interface RevenueCatOffering {
  object: 'offering';
  id: string;
  lookup_key: string;
  display_name: string;
  is_current: boolean;
  /** Present with expand=items.package[.product]. */
  packages?: RcList<RevenueCatPackage>;
}

function listPath(projectId: string, resource: string): string {
  return `/projects/${encodeURIComponent(projectId)}/${resource}?limit=100`;
}

export async function listApps(
  secretKey: string,
  projectId: string,
): Promise<RevenueCatResult<RcList<RevenueCatApp>>> {
  return rcFetch(secretKey, listPath(projectId, 'apps'));
}

/**
 * Public SDK keys for an app. This is how the platform learns the Test Store
 * key (`test_…`) it bakes into dev builds and the App Store key (`appl_…`) it
 * bakes into release builds, so the user never pastes either. Do not filter on
 * `environment`: the Test Store's key reports "production".
 */
export async function listPublicApiKeys(
  secretKey: string,
  projectId: string,
  appId: string,
): Promise<RevenueCatResult<RcList<RevenueCatPublicApiKey>>> {
  return rcFetch(
    secretKey,
    `/projects/${encodeURIComponent(projectId)}/apps/${encodeURIComponent(appId)}/public_api_keys?limit=100`,
  );
}

export async function listProducts(
  secretKey: string,
  projectId: string,
): Promise<RevenueCatResult<RcList<RevenueCatProduct>>> {
  return rcFetch(secretKey, listPath(projectId, 'products'));
}

export async function listEntitlements(
  secretKey: string,
  projectId: string,
  opts?: { withProducts?: boolean },
): Promise<RevenueCatResult<RcList<RevenueCatEntitlement>>> {
  return rcFetch(
    secretKey,
    listPath(projectId, 'entitlements') + (opts?.withProducts ? '&expand=items.product' : ''),
  );
}

export async function listOfferings(
  secretKey: string,
  projectId: string,
  opts?: { withPackages?: boolean },
): Promise<RevenueCatResult<RcList<RevenueCatOffering>>> {
  return rcFetch(
    secretKey,
    listPath(projectId, 'offerings') + (opts?.withPackages ? '&expand=items.package.product' : ''),
  );
}

export async function listPackages(
  secretKey: string,
  projectId: string,
  offeringId: string,
): Promise<RevenueCatResult<RcList<RevenueCatPackage>>> {
  return rcFetch(
    secretKey,
    `/projects/${encodeURIComponent(projectId)}/offerings/${encodeURIComponent(offeringId)}/packages?limit=100`,
  );
}

export async function createEntitlement(
  secretKey: string,
  projectId: string,
  body: { lookup_key: string; display_name: string },
): Promise<RevenueCatResult<RevenueCatEntitlement>> {
  return rcFetch(secretKey, `/projects/${encodeURIComponent(projectId)}/entitlements`, {
    method: 'POST',
    body,
  });
}

export async function createOffering(
  secretKey: string,
  projectId: string,
  body: { lookup_key: string; display_name: string },
): Promise<RevenueCatResult<RevenueCatOffering>> {
  return rcFetch(secretKey, `/projects/${encodeURIComponent(projectId)}/offerings`, {
    method: 'POST',
    body,
  });
}

/** Make an offering the CURRENT one — RevenueCatUI's PaywallView shows it. */
export async function setOfferingCurrent(
  secretKey: string,
  projectId: string,
  offeringId: string,
): Promise<RevenueCatResult<RevenueCatOffering>> {
  return rcFetch(
    secretKey,
    `/projects/${encodeURIComponent(projectId)}/offerings/${encodeURIComponent(offeringId)}`,
    { method: 'POST', body: { is_current: true } },
  );
}

export async function createProduct(
  secretKey: string,
  projectId: string,
  body: {
    store_identifier: string;
    app_id: string;
    type: RevenueCatProductType;
    display_name?: string;
    /** Required by the API for Test Store products. */
    title?: string;
    /** Only supported for Test Store products; required there for subscriptions. */
    subscription?: { duration: RevenueCatTestDuration };
  },
): Promise<RevenueCatResult<RevenueCatProduct>> {
  return rcFetch(secretKey, `/projects/${encodeURIComponent(projectId)}/products`, {
    method: 'POST',
    body,
  });
}

export async function createPackage(
  secretKey: string,
  projectId: string,
  offeringId: string,
  body: { lookup_key: string; display_name: string; position?: number },
): Promise<RevenueCatResult<RevenueCatPackage>> {
  return rcFetch(
    secretKey,
    `/projects/${encodeURIComponent(projectId)}/offerings/${encodeURIComponent(offeringId)}/packages`,
    { method: 'POST', body },
  );
}

export async function attachProductsToEntitlement(
  secretKey: string,
  projectId: string,
  entitlementId: string,
  productIds: string[],
): Promise<RevenueCatResult<RevenueCatEntitlement>> {
  return rcFetch(
    secretKey,
    `/projects/${encodeURIComponent(projectId)}/entitlements/${encodeURIComponent(entitlementId)}/actions/attach_products`,
    { method: 'POST', body: { product_ids: productIds } },
  );
}

export async function attachProductsToPackage(
  secretKey: string,
  projectId: string,
  packageId: string,
  productIds: string[],
): Promise<RevenueCatResult<RevenueCatPackage>> {
  return rcFetch(
    secretKey,
    `/projects/${encodeURIComponent(projectId)}/packages/${encodeURIComponent(packageId)}/actions/attach_products`,
    {
      method: 'POST',
      body: { products: productIds.map((id) => ({ product_id: id, eligibility_criteria: 'all' })) },
    },
  );
}

export async function detachProductsFromPackage(
  secretKey: string,
  projectId: string,
  packageId: string,
  productIds: string[],
): Promise<RevenueCatResult<RevenueCatPackage>> {
  return rcFetch(
    secretKey,
    `/projects/${encodeURIComponent(projectId)}/packages/${encodeURIComponent(packageId)}/actions/detach_products`,
    { method: 'POST', body: { product_ids: productIds } },
  );
}

/** Remove a package (a paywall slot) from its offering. The products stay in the catalog. */
export async function deletePackage(
  secretKey: string,
  projectId: string,
  packageId: string,
): Promise<RevenueCatResult<unknown>> {
  return rcFetch(
    secretKey,
    `/projects/${encodeURIComponent(projectId)}/packages/${encodeURIComponent(packageId)}`,
    { method: 'DELETE' },
  );
}

// ─── Webhook integrations ───────────────────────────────────────────────────────

export interface RevenueCatWebhookIntegration {
  object: 'webhook_integration';
  id: string;
  name: string;
  url: string;
  environment: 'production' | 'sandbox' | null;
  app_id: string | null;
  status?: 'active' | 'disabled';
}

export async function listWebhookIntegrations(
  secretKey: string,
  projectId: string,
): Promise<RevenueCatResult<RcList<RevenueCatWebhookIntegration>>> {
  return rcFetch(secretKey, listPath(projectId, 'integrations/webhooks'));
}

/**
 * Create the webhook RevenueCat calls for every purchase event. `environment`
 * and `event_types` are left unset so both sandbox (Test Store) and production
 * events of every type arrive; the receiver ignores the types it has no use for.
 */
export async function createWebhookIntegration(
  secretKey: string,
  projectId: string,
  body: { name: string; url: string; authorization_header: string },
): Promise<RevenueCatResult<RevenueCatWebhookIntegration>> {
  return rcFetch(secretKey, `/projects/${encodeURIComponent(projectId)}/integrations/webhooks`, {
    method: 'POST',
    body,
  });
}

export async function updateWebhookIntegration(
  secretKey: string,
  projectId: string,
  integrationId: string,
  body: { name?: string; url?: string; authorization_header?: string; status?: 'active' | 'disabled' },
): Promise<RevenueCatResult<RevenueCatWebhookIntegration>> {
  return rcFetch(
    secretKey,
    `/projects/${encodeURIComponent(projectId)}/integrations/webhooks/${encodeURIComponent(integrationId)}`,
    { method: 'POST', body },
  );
}

export async function deleteWebhookIntegration(
  secretKey: string,
  projectId: string,
  integrationId: string,
): Promise<RevenueCatResult<unknown>> {
  return rcFetch(
    secretKey,
    `/projects/${encodeURIComponent(projectId)}/integrations/webhooks/${encodeURIComponent(integrationId)}`,
    { method: 'DELETE' },
  );
}

// ─── Test Store prices ──────────────────────────────────────────────────────────
//
// "Create a product" has no price field, and a Test Store product without a
// price shows up in the app with nothing to charge. Prices are set through the
// product's store state (the endpoint behind RevenueCat's own product editor
// and MCP tools). It is asynchronous and, for the Test Store, create-only: a
// currency that already has a price cannot be changed, so a different price
// means a new product.

export interface RevenueCatProductStoreState {
  store: string;
  common?: { pricing?: { currency_prices?: Record<string, { amount_micros: number }> } };
}

export async function getProductStoreState(
  secretKey: string,
  projectId: string,
  productId: string,
): Promise<RevenueCatResult<RevenueCatProductStoreState>> {
  return rcFetch(
    secretKey,
    `/projects/${encodeURIComponent(projectId)}/products/${encodeURIComponent(productId)}/store_state`,
  );
}

export async function setTestStorePrice(
  secretKey: string,
  projectId: string,
  productId: string,
  price: { currency: string; amountMicros: number },
): Promise<RevenueCatResult<{ operation_id?: string; status?: string }>> {
  return rcFetch(
    secretKey,
    `/projects/${encodeURIComponent(projectId)}/products/${encodeURIComponent(productId)}/store_state`,
    {
      method: 'POST',
      body: {
        store: 'test_store',
        common: { pricing: { currency_prices: { [price.currency]: { amount_micros: price.amountMicros } } } },
      },
    },
  );
}

// ─── Dashboard deep-links ───────────────────────────────────────────────────────

/** Dashboard URLs use the project id WITHOUT the API's "proj" prefix. */
function dashboardProjectSlug(projectId: string): string {
  return encodeURIComponent(projectId.replace(/^proj/, ''));
}

/**
 * Deep-link into the user's RevenueCat project, with a safe fallback to the
 * dashboard root when we don't have a project id. The payments tab opens these
 * in a new tab (RevenueCat's dashboard cannot be iframed — X-Frame-Options:
 * DENY).
 */
export function dashboardUrl(
  projectId: string | null | undefined,
  page: 'overview' | 'api-keys' | 'product-catalog/products' | 'integrations' | 'apps' | 'customers' = 'overview',
): string {
  if (projectId) return `${RC_DASHBOARD_BASE}/projects/${dashboardProjectSlug(projectId)}/${page}`;
  return RC_DASHBOARD_BASE;
}
