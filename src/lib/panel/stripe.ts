/**
 * Real revenue from the Botflow platform Stripe account (acct_1Nb5uf…),
 * read through a restricted read-only key (STRIPE_READ_ONLY_KEY).
 *
 * Everything here is provider-side truth, in contrast to the plan-price
 * ESTIMATES in ./pricing.ts. The two are reported side by side rather than
 * blended, because on this account they disagree: the only recurring
 * subscriptions are legacy products ("Botflow Standard/Pro/Enterprise") that
 * predate the current Free/Pro/Max tiers and carry no Clerk linkage, while the
 * Clerk-linked customers have only one-time charges. Silently picking one
 * number would hide exactly the discrepancy an admin needs to see.
 *
 * Customer → Clerk user mapping is `customer.metadata.user_id`, with a
 * `userId` camelCase fallback (both conventions exist on the account).
 *
 * THAT LINKAGE IS ALSO THE PRODUCT BOUNDARY. The account still carries
 * products from an older, unrelated venture ("Botflow Standard/Pro/
 * Enterprise"); their customers predate Clerk and carry no user id. So every
 * headline figure here — MRR, lifetime revenue, paying customers — counts
 * ONLY Clerk-attributed money, and the rest is reported separately under
 * `legacy` instead of being folded in. Counting the old products would
 * overstate this platform's revenue and, worse, flatter its margin.
 */

const API = 'https://api.stripe.com/v1';

/** Safety caps — this account is tiny, but never page unbounded. */
const MAX_PAGES = 25; // 100 per page
const CENTS = 100;

export interface StripeUserRevenue {
  lifetimeNetUsd: number;
  monthNetUsd: number;
  /** Active/trialing/past_due subscription, if any. */
  subscription: { status: string; product: string; monthlyUsd: number } | null;
}

export interface StripeRevenue {
  configured: boolean;
  error?: string;
  account?: { id: string; name: string | null };
  /** Monthly recurring revenue from THIS platform's subscriptions only
   *  (customer carries a Clerk user id). Excludes the legacy products. */
  mrrUsd: number;
  subscriptions: {
    total: number;
    byStatus: Array<{ status: string; count: number }>;
    pastDue: number;
    canceledLast30d: number;
    /** Live subs whose customer carries a Clerk id — i.e. this platform's. */
    linkedToClerk: number;
  };
  /** This platform's money — Clerk-attributed customers only. */
  revenue: {
    lifetimeNetUsd: number;
    last30dNetUsd: number;
    payingCustomers: number;
  };
  /** Unrelated older products living on the same Stripe account. Reported so
   *  the account reconciles, never added to the figures above. */
  legacy: {
    mrrUsd: number;
    lifetimeNetUsd: number;
    payingCustomers: number;
    productNames: string[];
  };
  /** Whole-account totals, for reconciling against the Stripe dashboard. */
  accountTotals: {
    lifetimeGrossUsd: number;
    lifetimeRefundedUsd: number;
    lifetimeNetUsd: number;
  };
  health: {
    failedChargesLast30d: number;
    /** Non-USD activity would make the sums above meaningless — flag it. */
    currencies: string[];
  };
  /** Clerk user id → their real Stripe revenue. */
  byClerkUserId: Record<string, StripeUserRevenue>;
  /** True if any list hit the page cap (numbers are then a lower bound). */
  truncated: boolean;
  products: Array<{ name: string; monthlyUsd: number; active: boolean }>;
}

interface StripeList<T> {
  data?: T[];
  has_more?: boolean;
}

async function stripeGet<T>(
  key: string,
  path: string,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const json = (await res.json().catch(() => ({}))) as
    | T
    | { error?: { message?: string; code?: string } };
  if (!res.ok) {
    const e = (json as { error?: { message?: string; code?: string } }).error;
    return {
      ok: false,
      error: `Stripe ${res.status}${e?.code ? ` (${e.code})` : ''}: ${
        e?.message?.slice(0, 200) ?? 'request failed'
      }`,
    };
  }
  return { ok: true, data: json as T };
}

/** Page a list endpoint to completion (or MAX_PAGES). */
async function stripeList<T extends { id: string }>(
  key: string,
  path: string,
): Promise<{ items: T[]; truncated: boolean; error?: string }> {
  const items: T[] = [];
  let startingAfter: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${path}${sep}limit=100${
      startingAfter ? `&starting_after=${startingAfter}` : ''
    }`;
    const res = await stripeGet<StripeList<T>>(key, url);
    if (!res.ok) return { items, truncated: false, error: res.error };
    const batch = res.data.data ?? [];
    items.push(...batch);
    if (!res.data.has_more || batch.length === 0) {
      return { items, truncated: false };
    }
    startingAfter = batch[batch.length - 1].id;
  }
  return { items, truncated: true };
}

/** Monthly-normalized amount for a recurring price, in cents. */
function monthlyCents(
  unitAmount: number | null | undefined,
  quantity: number | undefined,
  interval: string | undefined,
  intervalCount: number | undefined,
): number {
  const amount = (unitAmount ?? 0) * (quantity ?? 1);
  const n = intervalCount && intervalCount > 0 ? intervalCount : 1;
  switch (interval) {
    case 'year':
      return amount / (12 * n);
    case 'week':
      return (amount * 52) / (12 * n);
    case 'day':
      return (amount * 365) / (12 * n);
    case 'month':
    default:
      return amount / n;
  }
}

function clerkIdOf(metadata: Record<string, string> | undefined): string | null {
  if (!metadata) return null;
  const id = metadata.user_id ?? metadata.userId ?? null;
  // Guard against blank/placeholder metadata values.
  return id && id.startsWith('user_') ? id : null;
}

interface StripeCustomer {
  id: string;
  metadata?: Record<string, string>;
}
interface StripeSubscription {
  id: string;
  status: string;
  customer: string;
  canceled_at?: number | null;
  items?: {
    data?: Array<{
      quantity?: number;
      price?: {
        id?: string;
        unit_amount?: number | null;
        currency?: string;
        recurring?: { interval?: string; interval_count?: number } | null;
        product?: string;
      };
    }>;
  };
}
interface StripeCharge {
  id: string;
  status: string;
  paid: boolean;
  amount: number;
  amount_refunded?: number;
  currency: string;
  created: number;
  customer?: string | null;
}
interface StripePrice {
  id: string;
  active: boolean;
  unit_amount?: number | null;
  recurring?: { interval?: string; interval_count?: number } | null;
  product?: { name?: string } | string;
}

const LIVE_SUB_STATUSES = new Set(['active', 'trialing', 'past_due']);

export async function getStripeRevenue(): Promise<StripeRevenue> {
  const key = process.env.STRIPE_READ_ONLY_KEY;
  const empty: StripeRevenue = {
    configured: false,
    mrrUsd: 0,
    subscriptions: { total: 0, byStatus: [], pastDue: 0, canceledLast30d: 0, linkedToClerk: 0 },
    revenue: { lifetimeNetUsd: 0, last30dNetUsd: 0, payingCustomers: 0 },
    legacy: { mrrUsd: 0, lifetimeNetUsd: 0, payingCustomers: 0, productNames: [] },
    accountTotals: { lifetimeGrossUsd: 0, lifetimeRefundedUsd: 0, lifetimeNetUsd: 0 },
    health: { failedChargesLast30d: 0, currencies: [] },
    byClerkUserId: {},
    truncated: false,
    products: [],
  };
  if (!key) return empty;

  const [account, customersRes, subsRes, chargesRes, pricesRes] = await Promise.all([
    stripeGet<{ id: string; settings?: { dashboard?: { display_name?: string } } }>(key, '/account'),
    stripeList<StripeCustomer>(key, '/customers'),
    // NB: no expand on subscriptions — data.items.data.price.product is five
    // levels deep and Stripe caps expansion at four. Product names are
    // resolved from the prices list below instead.
    stripeList<StripeSubscription>(key, '/subscriptions?status=all'),
    stripeList<StripeCharge>(key, '/charges'),
    stripeList<StripePrice>(key, '/prices?expand[]=data.product'),
  ]);

  const firstError =
    customersRes.error ?? subsRes.error ?? chargesRes.error ?? pricesRes.error;
  if (firstError) return { ...empty, configured: true, error: firstError };

  const truncated =
    customersRes.truncated || subsRes.truncated || chargesRes.truncated;

  // ── customer → clerk id ────────────────────────────────────────────────────
  const clerkOfCustomer = new Map<string, string>();
  for (const c of customersRes.items) {
    const id = clerkIdOf(c.metadata);
    if (id) clerkOfCustomer.set(c.id, id);
  }

  // price id → product name, so subscriptions can be labelled without a
  // five-level expand. Covers inactive prices too (the live subscriptions on
  // this account run on legacy products).
  const productOfPrice = new Map<string, string>();
  for (const p of pricesRes.items) {
    const name =
      p.product && typeof p.product === 'object' && p.product.name
        ? p.product.name
        : typeof p.product === 'string'
          ? p.product
          : null;
    if (name) productOfPrice.set(p.id, name);
  }

  const byClerkUserId: Record<string, StripeUserRevenue> = {};
  const ensure = (clerkId: string): StripeUserRevenue => {
    byClerkUserId[clerkId] ??= {
      lifetimeNetUsd: 0,
      monthNetUsd: 0,
      subscription: null,
    };
    return byClerkUserId[clerkId];
  };

  // ── subscriptions → MRR ────────────────────────────────────────────────────
  const now = Date.now();
  const thirtyDaysAgo = now / 1000 - 30 * 86400;
  const monthStart = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    1,
  ) / 1000;

  let mrrCents = 0;
  let legacyMrrCents = 0;
  let pastDue = 0;
  let canceledLast30d = 0;
  let linkedToClerk = 0;
  const legacyProducts = new Set<string>();
  const statusCounts = new Map<string, number>();

  for (const s of subsRes.items) {
    statusCounts.set(s.status, (statusCounts.get(s.status) ?? 0) + 1);
    if (s.status === 'past_due') pastDue++;
    if (s.canceled_at && s.canceled_at >= thirtyDaysAgo) canceledLast30d++;
    if (!LIVE_SUB_STATUSES.has(s.status)) continue;

    let subMonthlyCents = 0;
    let productName = 'unknown';
    for (const item of s.items?.data ?? []) {
      const price = item.price;
      subMonthlyCents += monthlyCents(
        price?.unit_amount,
        item.quantity,
        price?.recurring?.interval,
        price?.recurring?.interval_count,
      );
      const named = price?.id ? productOfPrice.get(price.id) : undefined;
      if (named) productName = named;
    }
    const clerkId = clerkOfCustomer.get(s.customer);
    if (clerkId) {
      // This platform's revenue.
      mrrCents += subMonthlyCents;
      linkedToClerk++;
      ensure(clerkId).subscription = {
        status: s.status,
        product: productName,
        monthlyUsd: subMonthlyCents / CENTS,
      };
    } else {
      // Older, unrelated product on the same account — kept out of MRR.
      legacyMrrCents += subMonthlyCents;
      legacyProducts.add(productName);
    }
  }

  // ── charges → realized revenue ─────────────────────────────────────────────
  let grossCents = 0;
  let refundedCents = 0;
  let attributedNetCents = 0;
  let last30dNetCents = 0;
  let failedLast30d = 0;
  let legacyNetCents = 0;
  const payingCustomers = new Set<string>();
  const legacyPayers = new Set<string>();
  const currencies = new Set<string>();

  for (const ch of chargesRes.items) {
    if (ch.status === 'failed') {
      if (ch.created >= thirtyDaysAgo) failedLast30d++;
      continue;
    }
    if (ch.status !== 'succeeded' || !ch.paid) continue;
    currencies.add(ch.currency);

    const net = ch.amount - (ch.amount_refunded ?? 0);
    // Account-level totals cover every charge, related or not.
    grossCents += ch.amount;
    refundedCents += ch.amount_refunded ?? 0;

    if (!ch.customer) continue;
    const clerkId = clerkOfCustomer.get(ch.customer);
    if (!clerkId) {
      legacyNetCents += net;
      legacyPayers.add(ch.customer);
      continue;
    }
    // From here down: this platform's revenue only.
    payingCustomers.add(ch.customer);
    attributedNetCents += net;
    if (ch.created >= thirtyDaysAgo) last30dNetCents += net;
    const entry = ensure(clerkId);
    entry.lifetimeNetUsd += net / CENTS;
    if (ch.created >= monthStart) entry.monthNetUsd += net / CENTS;
  }

  return {
    configured: true,
    account: account.ok
      ? { id: account.data.id, name: account.data.settings?.dashboard?.display_name ?? null }
      : undefined,
    mrrUsd: mrrCents / CENTS,
    subscriptions: {
      total: subsRes.items.length,
      byStatus: [...statusCounts.entries()]
        .map(([status, count]) => ({ status, count }))
        .sort((a, b) => b.count - a.count),
      pastDue,
      canceledLast30d,
      linkedToClerk,
    },
    revenue: {
      lifetimeNetUsd: attributedNetCents / CENTS,
      last30dNetUsd: last30dNetCents / CENTS,
      payingCustomers: payingCustomers.size,
    },
    legacy: {
      mrrUsd: legacyMrrCents / CENTS,
      lifetimeNetUsd: legacyNetCents / CENTS,
      payingCustomers: legacyPayers.size,
      productNames: [...legacyProducts],
    },
    accountTotals: {
      lifetimeGrossUsd: grossCents / CENTS,
      lifetimeRefundedUsd: refundedCents / CENTS,
      lifetimeNetUsd: (grossCents - refundedCents) / CENTS,
    },
    health: { failedChargesLast30d: failedLast30d, currencies: [...currencies] },
    byClerkUserId,
    truncated,
    products: pricesRes.items
      // The full price list is fetched for name lookup; only surface the
      // active recurring plans as "products".
      .filter((p) => p.recurring && p.active)
      .map((p) => ({
        name:
          p.product && typeof p.product === 'object' && p.product.name
            ? p.product.name
            : String(p.product ?? p.id),
        monthlyUsd:
          monthlyCents(p.unit_amount, 1, p.recurring?.interval, p.recurring?.interval_count) /
          CENTS,
        active: p.active,
      }))
      .sort((a, b) => b.monthlyUsd - a.monthlyUsd),
  };
}
