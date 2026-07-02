/**
 * RevenueCat v2 REST client — server-side.
 *
 * BYO model: each Botflow user brings their own RevenueCat account and pastes a
 * project-scoped **secret key** (`sk_…`). We never hold a platform-wide
 * RevenueCat account; every call here is made with the calling user's key, which
 * is stored encrypted (src/lib/secrets.ts) and decrypted only at call time.
 *
 * Secret keys are project-scoped, so they can create entitlements/offerings/
 * products inside a project but cannot create the project itself — the user
 * creates the project in the RevenueCat dashboard during the tab setup wizard.
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
 * Validate a (secretKey, projectId) pair by reading the project. A 200 proves
 * the key is valid AND scoped to that project — exactly the check the tab's
 * "Verify connection" button needs.
 */
export async function validateConnection(
  secretKey: string,
  projectId: string,
): Promise<RevenueCatResult<RevenueCatProject>> {
  if (!secretKey.startsWith('sk_')) {
    return {
      ok: false,
      status: 400,
      error: 'That does not look like a RevenueCat secret key (expected to start with "sk_").',
    };
  }
  return rcFetch<RevenueCatProject>(secretKey, `/projects/${encodeURIComponent(projectId)}`);
}

export interface RevenueCatOverviewMetric {
  object: 'overview_metric';
  id: string;
  name: string;
  value: number;
  unit: string;
  period: string;
}

export interface RevenueCatOverview {
  object: 'overview_metrics';
  metrics: RevenueCatOverviewMetric[];
}

/** Overview metrics (MRR, active subscriptions, trials, revenue, …). */
export async function getOverviewMetrics(
  secretKey: string,
  projectId: string,
): Promise<RevenueCatResult<RevenueCatOverview>> {
  return rcFetch<RevenueCatOverview>(
    secretKey,
    `/projects/${encodeURIComponent(projectId)}/metrics/overview`,
  );
}

// ─── Provisioning (agent product tools + the /revenuecat/products route) ────────
//
// Endpoint paths + request bodies verified against RevenueCat's published
// OpenAPI spec (docs/redocusaurus/openapi-v2.yaml, fetched 2026-07-02). Two
// asymmetries worth remembering:
//   • entitlement attach takes { product_ids: [...] }, but PACKAGE attach takes
//     { products: [{ product_id, eligibility_criteria }] } and lives at
//     /projects/{id}/packages/{package_id}/... (NOT nested under offerings);
//   • offerings/packages are keyed by lookup_key (there is no `identifier`).

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
  type: string; // 'app_store' | 'play_store' | 'stripe' | 'amazon' | 'roku' | ...
}

export interface RevenueCatProduct {
  object: 'product';
  id: string;
  store_identifier: string;
  type: RevenueCatProductType;
  display_name: string | null;
  app_id: string;
}

export interface RevenueCatEntitlement {
  object: 'entitlement';
  id: string;
  lookup_key: string;
  display_name: string;
}

export interface RevenueCatOffering {
  object: 'offering';
  id: string;
  lookup_key: string;
  display_name: string;
  is_current: boolean;
}

export interface RevenueCatPackage {
  object: 'package';
  id: string;
  lookup_key: string;
  display_name: string;
  position: number | null;
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

export async function listProducts(
  secretKey: string,
  projectId: string,
): Promise<RevenueCatResult<RcList<RevenueCatProduct>>> {
  return rcFetch(secretKey, listPath(projectId, 'products'));
}

export async function listEntitlements(
  secretKey: string,
  projectId: string,
): Promise<RevenueCatResult<RcList<RevenueCatEntitlement>>> {
  return rcFetch(secretKey, listPath(projectId, 'entitlements'));
}

export async function listOfferings(
  secretKey: string,
  projectId: string,
): Promise<RevenueCatResult<RcList<RevenueCatOffering>>> {
  return rcFetch(secretKey, listPath(projectId, 'offerings'));
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
  body: { store_identifier: string; app_id: string; type: RevenueCatProductType; display_name?: string },
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

// ─── Dashboard deep-link ────────────────────────────────────────────────────────

/**
 * Deep-link to the user's RevenueCat project overview, with a safe fallback to
 * the dashboard root when we don't have a project id. The payments tab opens
 * this in a new tab (RevenueCat's dashboard cannot be iframed — X-Frame-Options:
 * DENY).
 */
export function dashboardUrl(projectId: string | null | undefined): string {
  if (projectId) {
    return `${RC_DASHBOARD_BASE}/projects/${encodeURIComponent(projectId)}/overview`;
  }
  return RC_DASHBOARD_BASE;
}
