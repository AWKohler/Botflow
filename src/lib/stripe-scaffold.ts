/**
 * Stripe scaffolding — the three files we drop into a Convex-backed project's
 * sandbox the first time initializeStripePayments resolves to connected /
 * already-connected.
 *
 * Two of these files (platformStripe.ts, stripeWebhook.ts) are intended to
 * remain untouched after generation — the agent's write-guards enforce that.
 * The third (billing.ts) is the agent's editable surface for reacting to
 * Stripe events (e.g. flipping a user row from "free" to "pro").
 *
 * The scaffolding also sets four env vars on the project's Convex deployment:
 *   BOTFLOW_PROJECT_ID
 *   BOTFLOW_STRIPE_PROXY_BASE
 *   BOTFLOW_STRIPE_WEBHOOK_SECRET
 *   STRIPE_MODE
 * so the scaffolded actions can reach the platform proxy and verify webhooks
 * without the agent needing to wire any of that up.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { projects } from '@/db/schema';
import { sandboxWriteFile } from '@/lib/vercel-sandbox';
import { getStripe, type StripeMode } from '@/lib/stripe';

/**
 * Stable lookup key for the out-of-the-box Demo Product. A Stripe Price's
 * `lookup_key` is the mode-agnostic handle we resolve to the real `price_…` id
 * at checkout time — so the same key works in BOTH test and live mode once the
 * demo price has been provisioned in each. Shared per connected account.
 */
export const BOTFLOW_DEMO_LOOKUP_KEY = 'botflow_demo';

/**
 * Build a per-project lookup key for a managed Price. Namespaced by project id
 * (one connected account is shared across all of a user's projects) and given a
 * short random suffix so repeated names never collide. The agent stores the
 * returned key in app code; it resolves to the correct mode's price at runtime.
 */
export function makeStripeLookupKey(projectId: string, nameOrKey: string): string {
  const pid = projectId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 32);
  const slug = nameOrKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'item';
  const rand = Math.random().toString(36).slice(2, 6);
  return `botflow_${pid}_${slug}_${rand}`;
}

/**
 * Idempotently ensure a "Demo Product" with an active $10 one-time price exists
 * on the connected account, so a freshly-scaffolded project has a working
 * checkout out of the box (no need for the user to paste a price id). Tagged
 * with metadata.botflow_demo_product so repeat calls reuse the same one.
 *
 * The demo price carries a stable lookup_key (BOTFLOW_DEMO_LOOKUP_KEY) so the
 * scaffolded checkout resolves it per-mode. Idempotent: reuses an existing demo
 * price, and backfills the lookup_key if an older demo price is missing it.
 *
 * Never throws — returns the demo lookup key on success or null on failure.
 */
export async function ensureDemoProductPrice(
  accountId: string,
  mode: StripeMode,
): Promise<string | null> {
  try {
    const stripe = getStripe(mode);

    // If a price already carries the demo lookup key in this mode, we're done.
    const byKey = await stripe.prices.list(
      { lookup_keys: [BOTFLOW_DEMO_LOOKUP_KEY], active: true, limit: 1 },
      { stripeAccount: accountId },
    );
    if (byKey.data[0]) return BOTFLOW_DEMO_LOOKUP_KEY;

    // Look for an existing demo product (active) and reuse / fix its price.
    const existing = await stripe.products.search(
      { query: "metadata['botflow_demo_product']:'1' AND active:'true'", limit: 1 },
      { stripeAccount: accountId },
    );
    const demoProduct = existing.data[0];
    if (demoProduct) {
      const prices = await stripe.prices.list(
        { product: demoProduct.id, active: true, limit: 1 },
        { stripeAccount: accountId },
      );
      if (prices.data[0]) {
        // Backfill the lookup key onto the existing demo price.
        await stripe.prices.update(
          prices.data[0].id,
          { lookup_key: BOTFLOW_DEMO_LOOKUP_KEY, transfer_lookup_key: true },
          { stripeAccount: accountId },
        );
        return BOTFLOW_DEMO_LOOKUP_KEY;
      }
      // Product exists but lost its price — mint a fresh one using it.
      await stripe.prices.create(
        {
          currency: 'usd',
          unit_amount: 1000,
          product: demoProduct.id,
          lookup_key: BOTFLOW_DEMO_LOOKUP_KEY,
          transfer_lookup_key: true,
        },
        { stripeAccount: accountId },
      );
      return BOTFLOW_DEMO_LOOKUP_KEY;
    }

    // None yet — create product + price in one call via inline product_data.
    await stripe.prices.create(
      {
        currency: 'usd',
        unit_amount: 1000,
        lookup_key: BOTFLOW_DEMO_LOOKUP_KEY,
        transfer_lookup_key: true,
        product_data: {
          name: 'Demo Product',
          metadata: { botflow_demo_product: '1' },
        },
      },
      { stripeAccount: accountId },
    );
    return BOTFLOW_DEMO_LOOKUP_KEY;
  } catch (err) {
    console.error('[stripe-scaffold] ensureDemoProductPrice failed:', err);
    return null;
  }
}

/**
 * Copy this project's managed Stripe Products (and the Demo Product) from one
 * mode's connected account into another, so a stable lookup key resolves to a
 * real price in BOTH modes. Idempotent: skips any lookup key already present in
 * the target. Best-effort — never throws; returns a summary for logging.
 *
 * Called when the user switches modes or connects a new mode, so a product
 * created in (say) test keeps working after flipping to live without anyone
 * re-creating it or editing code.
 */
export async function mirrorStripeProductsAcrossModes(opts: {
  projectId: string;
  fromMode: StripeMode;
  fromAccountId: string;
  toMode: StripeMode;
  toAccountId: string;
}): Promise<{ mirrored: number; errors: string[] }> {
  const errors: string[] = [];
  let mirrored = 0;

  // The demo product is shared per account (not project-scoped) — ensure it
  // exists in the target mode too.
  try {
    await ensureDemoProductPrice(opts.toAccountId, opts.toMode);
  } catch (err) {
    errors.push(`demo: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const src = getStripe(opts.fromMode);
    const dst = getStripe(opts.toMode);

    const products = await src.products.search(
      {
        query: `metadata['botflow_project_id']:'${opts.projectId}' AND active:'true'`,
        limit: 100,
      },
      { stripeAccount: opts.fromAccountId },
    );

    for (const product of products.data) {
      let prices;
      try {
        prices = await src.prices.list(
          { product: product.id, active: true, limit: 100 },
          { stripeAccount: opts.fromAccountId },
        );
      } catch (err) {
        errors.push(`prices(${product.id}): ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      for (const price of prices.data) {
        const key = price.lookup_key;
        if (!key) continue; // only mirror keyed prices
        try {
          const existing = await dst.prices.list(
            { lookup_keys: [key], active: true, limit: 1 },
            { stripeAccount: opts.toAccountId },
          );
          if (existing.data[0]) continue; // already present in target mode
          await dst.prices.create(
            {
              currency: price.currency,
              ...(price.unit_amount != null ? { unit_amount: price.unit_amount } : {}),
              ...(price.recurring
                ? {
                    recurring: {
                      interval: price.recurring.interval,
                      interval_count: price.recurring.interval_count,
                    },
                  }
                : {}),
              lookup_key: key,
              transfer_lookup_key: true,
              product_data: {
                name: product.name,
                metadata: {
                  botflow_project_id: opts.projectId,
                  botflow_managed: '1',
                  botflow_lookup_key: key,
                },
              },
            },
            { stripeAccount: opts.toAccountId },
          );
          mirrored++;
        } catch (err) {
          errors.push(`mirror(${key}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return { mirrored, errors };
}

// ───────────────────────── templates ──────────────────────────

export const PLATFORM_STRIPE_TS = `// AUTO-GENERATED by Botflow. Do not edit — the agent's write-guard will refuse changes.
//
// Stripe Connect (Standard) helper. Calls back to Botflow's platform proxy,
// which uses the platform's master Stripe key with the Stripe-Account header
// to act on behalf of the user's connected account.
//
// The agent imports these actions and calls them from React (e.g. a "Buy"
// button calls createCheckoutSession, then redirects window.location to the
// returned url).
"use node";

import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

const PROJECT_ID = process.env.BOTFLOW_PROJECT_ID;
const PROXY_BASE = process.env.BOTFLOW_STRIPE_PROXY_BASE ?? "https://botflow.io";
const PROJECT_SECRET = process.env.BOTFLOW_STRIPE_WEBHOOK_SECRET;
const MODE = (process.env.STRIPE_MODE ?? "test") as "test" | "live";

// Products are referenced by a stable "lookup key" — a mode-agnostic handle
// that resolves to the correct test/live Price id at runtime, so switching
// Stripe modes never breaks checkout. createStripeProduct returns one; pass it
// as lookupKey. A pre-created "Demo Product" ships under this key so checkout
// works out of the box before you create your own products.
const DEMO_LOOKUP_KEY = "botflow_demo";

// IMPORTANT: these actions NEVER throw. Convex serializes thrown action errors
// into an opaque "Server Error" on the client, which is impossible to debug.
// Instead they return { ok: true, ... } or { ok: false, error } so your React
// code can branch on result.ok and surface result.error to the user.

/**
 * Create a Stripe Checkout Session for the configured connected account.
 * Call from React with useAction (NOT useMutation — this uses fetch()).
 *
 * Returns { ok: true, url, sessionId } on success — redirect with
 * window.location.assign(url). On failure returns { ok: false, error }.
 * Pass lookupKey (from createStripeProduct) to pick the product — it resolves
 * to the right price in the current Stripe mode. Omit it to use the Demo
 * Product. (priceId is an advanced override for a specific test/live price id.)
 *
 * For subscriptions / paid tiers, ALSO pass metadata: { appUserId: <user._id> }
 * so the webhook (billing.ts) can map the subscription back to this user via
 * event.data.metadata.appUserId. Subscription events carry no email.
 */
export const createCheckoutSession = action({
  args: {
    lookupKey: v.optional(v.string()),
    priceId: v.optional(v.string()),
    successUrl: v.string(),
    cancelUrl: v.string(),
    customerEmail: v.optional(v.string()),
    quantity: v.optional(v.number()),
    metadata: v.optional(v.any()),
    /** 'payment' for one-time, 'subscription' for recurring. Default 'payment'. */
    checkoutMode: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    if (!PROJECT_ID || !PROJECT_SECRET) {
      return {
        ok: false as const,
        error:
          "Stripe is not initialized for this project. Ask the user to run 'set up Stripe' in chat.",
      };
    }
    // Default to the Demo Product's lookup key when neither a lookupKey nor an
    // explicit priceId override was provided.
    const lookupKey = args.priceId ? args.lookupKey : (args.lookupKey || DEMO_LOOKUP_KEY);
    try {
      const res = await fetch(
        \`\${PROXY_BASE}/api/projects/\${PROJECT_ID}/stripe/checkout-session\`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Botflow-Project-Secret": PROJECT_SECRET,
          },
          body: JSON.stringify({ ...args, lookupKey, mode: MODE }),
        },
      );
      const data = (await res.json().catch(() => null)) as
        | { url?: string; sessionId?: string; error?: string }
        | null;
      if (!res.ok || !data?.url) {
        return {
          ok: false as const,
          error: data?.error ?? \`Stripe checkout failed (HTTP \${res.status})\`,
        };
      }
      return { ok: true as const, url: data.url, sessionId: data.sessionId };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});

/**
 * Generate a link into the connected account's Stripe Dashboard.
 * Use this for "Open Stripe Dashboard" buttons. Call with useAction.
 *
 * Returns { ok: true, url } or { ok: false, error }.
 */
export const createDashboardLoginLink = action({
  args: {},
  handler: async () => {
    if (!PROJECT_ID || !PROJECT_SECRET) {
      return {
        ok: false as const,
        error:
          "Stripe is not initialized for this project. Ask the user to run 'set up Stripe' in chat.",
      };
    }
    try {
      const res = await fetch(
        \`\${PROXY_BASE}/api/projects/\${PROJECT_ID}/stripe/dashboard-link\`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Botflow-Project-Secret": PROJECT_SECRET,
          },
          body: JSON.stringify({ mode: MODE }),
        },
      );
      const data = (await res.json().catch(() => null)) as
        | { url?: string; error?: string }
        | null;
      if (!res.ok || !data?.url) {
        return {
          ok: false as const,
          error: data?.error ?? \`Stripe dashboard link failed (HTTP \${res.status})\`,
        };
      }
      return { ok: true as const, url: data.url };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});

/**
 * Pull-based reconcile — recognize a paying customer WITHOUT waiting on a
 * webhook. Call this from React right after Checkout returns (pass the
 * Checkout Session id from the success URL) and/or on app load (pass a stored
 * subscriptionId). It asks the platform to read the truth from Stripe, then
 * runs the SAME billing.applyStripeEvent your webhook uses — so the tier flips
 * identically. Returns { ok, active, status }.
 *
 * Wire your checkout successUrl with the session id placeholder so you can
 * read it back, e.g.:
 *   successUrl: window.location.origin + "/settings?session_id={CHECKOUT_SESSION_ID}"
 * Stripe substitutes the real id. On that page:
 *   const sid = new URLSearchParams(location.search).get("session_id");
 *   if (sid) await reconcileSubscription({ sessionId: sid });
 */
export const reconcileSubscription = action({
  args: {
    sessionId: v.optional(v.string()),
    subscriptionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!PROJECT_ID || !PROJECT_SECRET) {
      return {
        ok: false as const,
        error:
          "Stripe is not initialized for this project. Ask the user to run 'set up Stripe' in chat.",
      };
    }
    try {
      const res = await fetch(
        \`\${PROXY_BASE}/api/projects/\${PROJECT_ID}/stripe/subscription-status\`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Botflow-Project-Secret": PROJECT_SECRET,
          },
          body: JSON.stringify({ ...args, mode: MODE }),
        },
      );
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; active?: boolean; status?: string; event?: unknown; error?: string }
        | null;
      if (!res.ok || !data?.ok) {
        return {
          ok: false as const,
          error: data?.error ?? \`Reconcile failed (HTTP \${res.status})\`,
        };
      }
      // Apply the server-verified event through the same path the webhook
      // uses, so your billing.ts tier logic runs identically.
      if (data.event) {
        await ctx.runMutation(internal.billing.applyStripeEvent, { event: data.event });
      }
      return {
        ok: true as const,
        active: Boolean(data.active),
        status: data.status ?? null,
      };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});
`;

export const STRIPE_WEBHOOK_TS = `// AUTO-GENERATED by Botflow. Do not edit — the agent's write-guard will refuse changes.
//
// Convex HTTP endpoint that receives normalized Stripe events forwarded by
// the Botflow platform. Verifies the HMAC signature (so randoms can't spoof
// events), then hands off to billing.ts (which IS editable — that's where
// the agent writes "free → pro" mutations etc).
//
// To wire this up, ensure convex/http.ts contains:
//
//   import { httpRouter } from "convex/server";
//   import { stripeWebhook } from "./stripeWebhook";
//   const http = httpRouter();
//   http.route({ path: "/stripe/webhook", method: "POST", handler: stripeWebhook });
//   export default http;
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const PROJECT_SECRET = process.env.BOTFLOW_STRIPE_WEBHOOK_SECRET;

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export const stripeWebhook = httpAction(async (ctx, req) => {
  if (!PROJECT_SECRET) {
    return new Response("Stripe integration not configured", { status: 500 });
  }
  const raw = await req.text();

  // Require the timestamped V2 signature: HMAC("<timestamp>.<body>") with the
  // timestamp within 5 minutes. Binding a fresh timestamp blocks replay of a
  // captured request, and REQUIRING it (no body-only fallback) blocks a
  // signature-stripping downgrade. The Botflow platform always sends both
  // headers, so there is nothing to fall back to.
  const tsHeader = req.headers.get("X-Botflow-Timestamp");
  const sigV2 = req.headers.get("X-Botflow-Signature-V2");
  if (!tsHeader || !sigV2) {
    return new Response("missing signature", { status: 401 });
  }
  const ts = Number(tsHeader);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 300) {
    return new Response("stale or invalid timestamp", { status: 401 });
  }
  const expected = await hmacHex(PROJECT_SECRET, ts + "." + raw);
  if (!safeEqual(sigV2, expected)) {
    return new Response("bad signature", { status: 401 });
  }

  let event: { type: string; id: string; data?: unknown };
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  await ctx.runMutation(internal.billing.applyStripeEvent, { event });
  return new Response("ok", { status: 200 });
});
`;

export const BILLING_TS = `// EDITABLE — implement how Stripe events change your app's database here.
// stripeWebhook.ts (async webhooks) AND platformStripe.reconcileSubscription
// (the synchronous post-checkout reconcile) both call applyStripeEvent below,
// so this is the single place your tier/subscription logic lives.
//
// ⚠️ IDEMPOTENCY: the same event can arrive more than once — the webhook is
// at-least-once (delivery is retried until it succeeds) AND reconcile may apply
// it too. Setting a tier/status to a fixed value is naturally safe to repeat,
// but ADDITIVE actions (granting credits, sending an email, incrementing a
// counter) MUST be guarded. Record event.id (passed below) in a table and skip
// if you've already processed it.
//
// The payload is a NORMALIZED Botflow event — NOT a raw Stripe event. Handle
// these event.type values, with these event.data fields:
//
//   subscription.activated  — user just paid / started a plan
//       data: { subscriptionId, customerId, status, priceId, metadata }
//   subscription.updated    — plan or status changed. If the user scheduled a
//                             cancellation, cancelAtPeriodEnd is true and cancelAt
//                             is the unix time access ends — they KEEP access
//                             until then (don't downgrade early).
//       data: { subscriptionId, customerId, status, cancelAtPeriodEnd, cancelAt?, priceId?, metadata }
//   subscription.canceled   — actually ended (status 'canceled' / deleted)
//       data: { subscriptionId, customerId?, status?, metadata }
//   payment.succeeded       — one-time payment / first invoice cleared
//       data: { sessionId?, paymentIntentId?, amountTotal?, currency?, customerEmail?, metadata }
//   payment.failed          — a charge failed
//       data: { paymentIntentId?, metadata }
//
// ── LINKING AN EVENT TO ONE OF YOUR USERS ──────────────────────────────────
// Subscription events do NOT include an email, so do NOT try to match on
// customer_email. The reliable way to know which user an event belongs to is
// metadata you set at checkout time: when the UI calls createCheckoutSession,
// pass  metadata: { appUserId: <the signed-in user's _id> }  and read it back
// here as event.data.metadata.appUserId.

import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const applyStripeEvent = internalMutation({
  args: { event: v.any() },
  handler: async (ctx, { event }) => {
    const type = event.type as string;
    const data = (event.data ?? {}) as Record<string, any>;

    // Who does this belong to? Set metadata.appUserId at checkout (see note).
    const appUserId = data?.metadata?.appUserId as string | undefined;
    console.log("[stripeWebhook]", type, event.id, "appUserId:", appUserId);
    if (!appUserId) return; // can't map the event to a user without it

    // ── Adapt the lines below to YOUR schema. This example assumes a
    // ── "userProfiles" table indexed by userId ("by_userId") with a "tier".
    if (type === "subscription.activated" || type === "subscription.updated") {
      const isActive = data.status === "active" || data.status === "trialing";
      // const profile = await ctx.db.query("userProfiles")
      //   .withIndex("by_userId", (q) => q.eq("userId", appUserId as any))
      //   .unique();
      // if (profile) {
      //   await ctx.db.patch(profile._id, {
      //     tier: isActive ? "pro" : "free",
      //     stripeCustomerId: data.customerId,
      //     subscriptionId: data.subscriptionId,
      //     subscriptionStatus: data.status,
      //   });
      // }
      console.log("[stripeWebhook] would set tier", isActive ? "pro" : "free", appUserId);
    } else if (type === "subscription.canceled") {
      // const profile = await ctx.db.query("userProfiles")
      //   .withIndex("by_userId", (q) => q.eq("userId", appUserId as any))
      //   .unique();
      // if (profile) await ctx.db.patch(profile._id, { tier: "free", subscriptionStatus: "canceled" });
      console.log("[stripeWebhook] would revert tier free", appUserId);
    }
  },
});
`;

// Client-side redirect helper. Stripe Checkout (and the Connect dashboard)
// send frame-busting headers, so they cannot load inside an iframe — and in
// the Botflow workspace your app runs inside a preview iframe. A plain
// window.location redirect to Checkout therefore shows a blank/refused page
// there. This helper detects the iframe and hands the URL up to the Botflow
// shell, which opens it in a new tab. In your DEPLOYED app (top-level, not
// iframed) it just redirects normally — so it's safe to use everywhere.
export const CHECKOUT_HELPER_TS = `// AUTO-GENERATED by Botflow. You normally just import redirectToCheckout.
//
// Stripe Checkout can't load inside an iframe (it sends frame-busting headers).
// In the Botflow preview your app runs inside an iframe, so redirecting the
// page straight to Checkout shows a blank/refused frame. This helper detects
// that case and asks the Botflow workspace to open Checkout in a new tab. In
// your deployed app (not iframed) it just redirects normally — use it for
// every Stripe redirect (createCheckoutSession url, dashboard links, etc).
export function redirectToCheckout(url: string): void {
  if (typeof window === "undefined" || !url) return;
  const inIframe = window.self !== window.top;
  if (inIframe) {
    try {
      window.parent.postMessage({ type: "botflow:open-url", url }, "*");
      return;
    } catch {
      // Cross-origin parent rejected the post — fall back to a popup.
    }
    window.open(url, "_blank", "noopener");
    return;
  }
  window.location.assign(url);
}
`;

// ───────────────────────── apply to sandbox ──────────────────────────

/**
 * Drop the three Stripe files into the project's sandbox. Idempotent —
 * platformStripe.ts and stripeWebhook.ts are always overwritten (read-only
 * by intent), while billing.ts is only created if it doesn't already exist
 * (the agent edits it).
 *
 * Returns the list of paths actually written.
 */
export async function dropStripeFilesIntoSandbox(
  projectId: string,
  // opts retained for call-site compatibility; the demo product is now
  // referenced by a fixed lookup key baked into the template (no stamping).
  _opts: { demoPriceId?: string } = {},
): Promise<string[]> {
  const { sandboxReadFile } = await import('@/lib/vercel-sandbox');
  const written: string[] = [];

  // Always re-write the two read-only files. Safe — the agent's guard refuses
  // *user* edits, but our scaffolder is the source of truth.
  await sandboxWriteFile(projectId, '/convex/platformStripe.ts', PLATFORM_STRIPE_TS);
  written.push('/convex/platformStripe.ts');
  await sandboxWriteFile(projectId, '/convex/stripeWebhook.ts', STRIPE_WEBHOOK_TS);
  written.push('/convex/stripeWebhook.ts');

  // Client redirect helper — makes Checkout work from the preview iframe.
  // Always re-written (auto-generated, no user logic lives here).
  await sandboxWriteFile(projectId, '/src/lib/botflowCheckout.ts', CHECKOUT_HELPER_TS);
  written.push('/src/lib/botflowCheckout.ts');

  // Only seed billing.ts if missing — the agent owns this file.
  const existing = await sandboxReadFile(projectId, '/convex/billing.ts').catch(() => null);
  if (!existing || !existing.content) {
    await sandboxWriteFile(projectId, '/convex/billing.ts', BILLING_TS);
    written.push('/convex/billing.ts');
  }
  return written;
}

/** Promise.race-with-timeout, never throws — rejects-to-error are caught. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

/**
 * Set the Convex env vars the scaffolded files read. Idempotent. Mirrors
 * setEnvVarsViaDeployKey in convex-auth-setup.ts.
 */
export async function setStripeConvexEnv(
  projectId: string,
  opts: { mode: StripeMode; webhookSecret: string; proxyBase?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) return { ok: false, error: 'Project not found' };

  const deployUrl = project.backendType === 'user' ? project.userConvexUrl : project.convexDeployUrl;
  const deployKey = project.backendType === 'user' ? project.userConvexDeployKey : project.convexDeployKey;
  if (!deployUrl || !deployKey) {
    return { ok: false, error: 'Convex deployment is not configured for this project' };
  }

  const vars = {
    BOTFLOW_PROJECT_ID: projectId,
    BOTFLOW_STRIPE_PROXY_BASE: opts.proxyBase ?? 'https://botflow.io',
    BOTFLOW_STRIPE_WEBHOOK_SECRET: opts.webhookSecret,
    STRIPE_MODE: opts.mode,
  };
  const changes = Object.entries(vars).map(([name, value]) => ({ name, value }));
  const res = await fetch(`${deployUrl}/api/update_environment_variables`, {
    method: 'POST',
    headers: { Authorization: `Convex ${deployKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes }),
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: `Failed to set Convex env (${res.status}): ${text.slice(0, 300)}` };
  }
  return { ok: true };
}

/**
 * One-call helper: drop the files AND set the env vars. The initialize
 * endpoint calls this on connected / already-connected transitions.
 * Failures are logged but non-fatal — the agent can run the scaffold
 * manually if needed.
 */
export async function scaffoldStripeIntoProject(
  projectId: string,
  opts: { mode: StripeMode; webhookSecret: string; proxyBase?: string; demoPriceId?: string },
): Promise<{
  filesWritten: string[];
  envSet: boolean;
  envError?: string;
  filesError?: string;
}> {
  // Per-operation timeouts: a cold Vercel Sandbox can take 30s+ to provision,
  // and we don't want to block the agent's tool call that long. If file drop
  // times out we return early with filesError noted — the agent can retry
  // (idempotent) or proceed and let `convex_deploy` fail naturally.
  let filesWritten: string[] = [];
  let filesError: string | undefined;
  try {
    filesWritten = await withTimeout(
      dropStripeFilesIntoSandbox(projectId, { demoPriceId: opts.demoPriceId }),
      15_000,
      'dropStripeFilesIntoSandbox',
    );
  } catch (err) {
    filesError = err instanceof Error ? err.message : String(err);
    console.error('[stripe-scaffold] file drop failed:', err);
  }

  const envResult = await withTimeout(
    setStripeConvexEnv(projectId, opts),
    10_000,
    'setStripeConvexEnv',
  ).catch((err) => ({
    ok: false as const,
    error: err instanceof Error ? err.message : String(err),
  }));
  return {
    filesWritten,
    envSet: envResult.ok === true,
    ...(envResult.ok === true ? {} : { envError: envResult.error }),
    ...(filesError ? { filesError } : {}),
  };
}
