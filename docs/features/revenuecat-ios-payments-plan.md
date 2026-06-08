# RevenueCat iOS Payments — Integration Plan

Status: **APPROVED — Model B (BYO RevenueCat key) locked for v1.** Model A (platform-hosted) deferred to a parallel business track (Phase 5).
Mirrors the existing Stripe Connect slice, but targets the **Swift / persistent workspace** instead of the sandboxed-web workspace.

---

## 0. Decisions locked (from product discussion)

| Dimension | Decision | Consequence |
|---|---|---|
| Payment rail | **RevenueCat** (hosted, not raw StoreKit) | RC does receipt validation, entitlements, webhooks; we build our own dashboard (their dashboard is `X-Frame-Options: DENY`, cannot iframe) |
| iOS distribution | **Ship to the user's own App Store Connect** | User owns the Apple Developer account, the money, the Paid Apps agreement, banking/tax. We can automate product creation + distribution via their App Store Connect API key, but **cannot bypass App Review** |
| Monetization scope | **Full** — auto-renewable subscriptions + non-consumables + consumables | Need the full Apple product graph (`subscriptionGroups`/`subscriptions` + `inAppPurchases` v2) and RC products/entitlements/offerings |
| Cross-platform entitlement | **Keep separate** | iOS is an independent track. No shared entitlement with web Stripe. Reuse the *pattern* of `convex/billing.ts` (normalized events) but with independent tables/keys |

---

## 1. CRITICAL FINDING — the multi-tenant blocker

The "mirror Stripe Connect exactly" dream (an OAuth popup that auto-provisions everything under **our** RevenueCat account) **is not buildable today** with RevenueCat's public API. Research confirmed:

1. **Project creation needs a developer-level OAuth token (`atk_`), not a secret key.** Secret keys (`sk_`) are *project-scoped* — they can create entitlements/offerings/products **inside** a project, but cannot create the project itself.
2. **OAuth client registration is manual** — you must contact RevenueCat support; there is no self-service OAuth app registration. This is the gate for any "create projects on behalf of customers" flow.
3. **Apple credential upload (.p8) appears dashboard-only** — not confirmed settable via the v2 App API.
4. **Webhook registration appears dashboard-only** — `integrations` OAuth scope exists, but the docs only describe dashboard config.
5. **MTR aggregation (per-account vs per-project) is unconfirmed** — if all customers' apps run under *our* account, we may owe RevenueCat ~1% on the **aggregate** tracked revenue across the whole platform. On native IAP we cannot offset that with an app fee (Apple pays the developer directly).
6. **No public reseller / platform terms** — this pattern likely requires an Enterprise/partnership conversation.

### The connection-model fork this forces

- **Model A — Platform-hosted (mirror Stripe Connect).** We own one RC account, auto-create a project per app, inject keys. Best UX. **Blocked on:** RevenueCat partnership + OAuth client registration + (unconfirmed) API support for credential/webhook upload. We also eat the MTR fee. → *Pursue as a business track; not buildable unilaterally now.*
- **Model B — BYO RevenueCat key (RECOMMENDED for v1).** The user creates their own RC account + project (one-time, guided), pastes their **secret key (`sk_`)** + **public SDK key (`appl_`)** into Botflow. We then use their `sk_` to provision entitlements/offerings/products via the v2 API (allowed — project-scoped). The user uploads their Apple `.p8` and sets the webhook in *their* RC dashboard (one-time, guided). **Sidesteps every blocker above**, and the MTR fee lands on the user's account, not ours. Cost: more visible setup; we can't fully hide RevenueCat.

**This plan is written for Model B.** It is the only path shippable without a RevenueCat deal, and it is consistent with "the user owns their App Store Connect" — they own the RC side too.

---

## 2. Architecture overview (Model B)

```
Swift workspace (persistent-workspace)
  │  agent tool: initializeRevenueCatPayments
  ▼
Botflow API  /api/projects/[id]/revenuecat/*        ← Clerk-session + proxy routes (mirror Stripe)
  │   - stores BYO keys in user_revenuecat_identity
  │   - provisions RC entitlements/offerings/products via user's sk_  (v2 API)
  │   - (optionally) creates Apple IAP products via user's App Store Connect key
  │   - scaffolds Swift SDK code + Convex billing files
  ▼
User's RevenueCat project (their account)
  │   webhooks → /api/webhooks/revenuecat  ← Authorization header secret
  ▼
Botflow webhook receiver → normalize → fan out (HMAC) → user's Convex /revenuecat/webhook
  ▼
convex/billing.ts (applyRevenueCatEvent)  → entitlement tables in user's Convex
  ▲
Custom dashboard tab (revenuecat-tab.tsx) ← reads RC v2 metrics/customers (proxied) + Convex
```

Key differences from Stripe slice:
- **No embedded dashboard** — we render our own UI from RC's v2 metrics/customers API + Convex (RC dashboard can't be iframed).
- **No `redirectToCheckout`** — purchases happen *in the native app* via the RevenueCat SDK / `RevenueCatUI` paywall, not a hosted web page.
- **"Mode" = Sandbox vs Production** — auto-detected by RC per purchase (`environment` field on every webhook), not a manual toggle. Plus a local `.storekit` file for simulator demos.

---

## 3. Data model (`src/db/schema.ts` + new `drizzle/00XX_add_revenuecat_integration.sql`)

Mirror the Stripe tables:

- **`projects`** new columns:
  - `revenuecat_status` text NOT NULL default `'none'` — `'none' | 'connecting' | 'connected'`. Drives the tab: the tab appears when status ≠ `'none'`; it shows the **setup wizard** while `'connecting'` and the **link-out page** when `'connected'`. (Replaces a simple boolean — the agent flips it to `'connecting'` so the tab appears immediately, before the user has pasted any keys.)
  - `revenuecat_project_id` text — the RC project id (`proj…`) for this app
  - `revenuecat_webhook_secret` text — per-project HMAC for Botflow→Convex fan-out (`bfrc_…`), mirrors `stripe_webhook_secret`
  - `revenuecat_environment` text default `'sandbox'` (`'sandbox'|'production'`) — display/filter only
- **`user_revenuecat_identity`** (mirror `user_stripe_identity`, PK `user_id`):
  - `rc_secret_key` (encrypted at rest), `rc_public_sdk_key` (`appl_…`), `rc_project_id`, `rc_inbound_webhook_secret` (the Authorization header value WE expect RC to send), `connected_at`, `updated_at`
  - Apple side: `asc_issuer_id`, `asc_key_id`, `asc_private_key_p8` (encrypted) — the App Store Connect API key (reused for distribution + IAP product creation)
- **`revenuecat_webhook_events`** (dedup; PK = RC event `id`)

> **No `revenuecat_connect_requests` table.** Unlike Stripe (whose modal needs a server↔client rendezvous row), the RevenueCat connection flow lives entirely in the tab. The `initialize` tool just sets `revenuecat_status = 'connecting'`; the existing enabled-poller surfaces + auto-opens the tab; the user completes setup there. No modal, no pending-request row, no blocking poll.

> Encryption: the `sk_` and `.p8` are long-lived secrets. Add envelope encryption (e.g. a KMS/`APP_SECRET_KEY`) rather than storing plaintext like the Stripe account ids (which aren't secret). This is a *new* requirement vs the Stripe slice.

---

## 4. Backend libs + API routes (mirror the Stripe slice)

New `src/lib/revenuecat*.ts`:
- `revenuecat.ts` — v2 REST client factory (`https://api.revenuecat.com/v2`, `Authorization: Bearer <sk_>`), helpers `getProjectMetrics`, `listCustomers`, `createEntitlement`, `createOffering`, `createPackage`, `createProduct`, `attachProductsToEntitlement`.
- `revenuecat-connect.ts` — connect-request lifecycle (mirror `stripe-connect.ts`): `createConnectRequest`, `cancelPendingConnectRequests`, `pollConnectRequest`. **No OAuth state** — replaced by a key-paste capture in the modal.
- `revenuecat-proxy-auth.ts` — clone of `stripe-proxy-auth.ts`; constant-time compare `X-Botflow-Project-Secret` against `projects.revenuecat_webhook_secret`.
- `revenuecat-scaffold.ts` — Convex templates + Swift snippets + env injection (see §5, §6).
- `appstore-connect.ts` — JWT (ES256) signer + App Store Connect API client for IAP product creation (see §7).

New route group `src/app/api/projects/[id]/revenuecat/` (gate on `REVENUECAT_ENABLED` flag + new `canUseRevenueCat(userId)` in `tier.ts`):
- `initialize` (POST) — agent-tool backing. **Non-blocking** (unlike Stripe's 5-min blocking poll). Runs gates, then returns one of: `already-connected` (user linked RC on a prior project → flip `revenuecat_status='connected'`, generate `revenuecat_webhook_secret`, scaffold via `after()`, agent proceeds) / `needs-connect` (set `revenuecat_status='connecting'` so the tab appears + auto-opens; agent continues building in parallel) / `backend-blocked` / `tier-blocked`. No `dismissed`/`timeout` outcomes — there's nothing to wait on.
- `connect` (POST) — called by the **tab wizard** (not a modal): receives the pasted `sk_`, `appl_`, RC project id, and (optionally) the Apple `.p8`; validates `sk_` by calling RC `GET /projects/{id}`; stores in `user_revenuecat_identity`; sets `revenuecat_status='connected'`; schedules scaffolding. (Replaces Stripe's OAuth callback.)
- `status` (GET) — RC project reachable? credentials present? webhook configured? Apple app linked? → drives the wizard's step checklist and the "Verify connection" button.
- `products` (GET/POST) — list/create RC products + entitlements + offerings via `sk_`; optionally create matching Apple IAP products via App Store Connect key.
- ~~`metrics` (POST, proxy or session)~~ — **deferred** (preliminary build links out to RC's dashboard instead of rendering metrics; see §8).
- `disconnect` (POST) — clear keys, flip disabled.
- `src/app/api/webhooks/revenuecat/route.ts` — receiver: verify `Authorization` header == `rc_inbound_webhook_secret`; dedup via `revenuecat_webhook_events`; `normalize()` RC event → canonical event; fan out (HMAC `X-Botflow-Signature`) to each enabled project's Convex `/revenuecat/webhook`. Always 200 after auth (owns its retry budget; RC retries 5×: 5/10/20/40/80 min).

`normalize()` maps RC's 18 event types → a small canonical set reused by Convex:
`entitlement.granted` (INITIAL_PURCHASE, RENEWAL, UNCANCELLATION, NON_RENEWING_PURCHASE, PRODUCT_CHANGE, TEMPORARY_ENTITLEMENT_GRANT, SUBSCRIPTION_EXTENDED), `entitlement.revoked` (EXPIRATION, CANCELLATION→at period end, REFUND_REVERSED inverse, TRANSFER), `billing.issue` (BILLING_ISSUE), `purchase.consumable` (NON_RENEWING_PURCHASE for consumables). Carry `environment`, `app_user_id`, `product_id`, `entitlement_ids`, `expiration_at_ms`, `store`, `price`, `currency`.

---

## 5. Convex scaffold (mirror §8 of the Stripe reference)

Drop into the user's `convex/` (read-only, regenerated) + one editable file:
- `convex/platformRevenueCat.ts` (read-only, `"use node"`) — thin actions that call Botflow proxy endpoints with `X-Botflow-Project-Secret` (e.g. `getEntitlements`, `getMetrics`, `syncCustomer`). Most entitlement state arrives via webhook, so this is lighter than `platformStripe.ts`.
- `convex/revenueCatWebhook.ts` (read-only) — `httpAction`; verify `X-Botflow-Signature` (HMAC-SHA256 with `BOTFLOW_REVENUECAT_WEBHOOK_SECRET`), then `ctx.runMutation(internal.billing.applyRevenueCatEvent, { event })`. Requires `convex/http.ts` route `POST /revenuecat/webhook`.
- `convex/billing.ts` (editable, seeded if missing) — `internalMutation applyRevenueCatEvent({ event })`; documents the canonical contract; user-link key is `event.data.app_user_id` (set to the app's auth user id when calling `Purchases.configure(appUserID:)`).

Convex env vars injected: `BOTFLOW_PROJECT_ID`, `BOTFLOW_REVENUECAT_PROXY_BASE`, `BOTFLOW_REVENUECAT_WEBHOOK_SECRET`, `REVENUECAT_ENVIRONMENT`.

Agent write-guards (mirror `stripeGuardedWrite`): block edits to `platformRevenueCat.ts`/`revenueCatWebhook.ts`; block hand-rolled StoreKit purchase code that bypasses RC (optional); allow `RevenueCat`/`RevenueCatUI` SPM deps (do NOT block these, unlike Stripe).

---

## 6. Swift app scaffold (the part with no Stripe analog)

Into the `swift`/`swiftConvex` template output:
- Add SPM deps `RevenueCat` + `RevenueCatUI` (mirror `https://github.com/RevenueCat/purchases-ios-spm`).
- `Purchases.configure(withAPIKey: "<appl_…>", appUserID: <authUserId>)` at launch; set delegate to push `customerInfo` updates.
- Entitlement helper: `customerInfo.entitlements.active["premium"]?.isActive`.
- Paywall: `RevenueCatUI.PaywallView` / `.presentPaywallIfNeeded(requiredEntitlementIdentifier:)` (remotely configured offering — no app update needed to change the paywall).
- Restore: `Purchases.shared.restorePurchases()`.
- **`Botflow.storekit`** config file wired into the Run scheme → lets the **streamed Xcode simulator** demo the full purchase UX with **zero Apple/RC setup** (the analog of Stripe's $10 demo product). Note: a pure local `.storekit` run won't sync entitlements to RC's servers (no real receipt); full RC entitlement sync requires a sandbox tester on TestFlight/device. Flag this clearly in the dev loop.

The `appUserID` must equal the Convex/app auth user id so webhook `app_user_id` joins to a Convex user.

---

## 7. Apple-side automation (App Store Connect API)

Because we already hold the user's App Store Connect API key for distribution, we can also:
- Create IAP products programmatically: `POST /v2/inAppPurchases` (consumables/non-consumables), `POST /v1/subscriptionGroups` + `POST /v1/subscriptions` (auto-renewables), then localizations + price points.
- Submit for review: `POST /v1/subscriptionAppStoreReviewSubmissions` (subs) — but **App Review is mandatory before products are purchasable in production**, and the *first* IAP is reviewed alongside an app version. We automate creation; we cannot automate approval.
- RC then needs these products: either RC imports them via the App Store Connect API key configured in the user's RC project, or we create RC `product` objects via v2 referencing the `store_identifier`.

Apple credentials needed (note: **two** different `.p8` key types):
1. **In-App Purchase Key** (App Store Connect → Integrations → In-App Purchase) → uploaded to RevenueCat for validation + StoreKit2 recording.
2. **App Store Connect API Key** (App Manager role) → used by Botflow for distribution + IAP product creation, and by RC for product import.

---

## 8. Workspace UI (preliminary: link-out, no data dashboard)

**Preliminary build decision:** the payments tab does **not** rebuild RevenueCat's dashboard. Since RC can't be iframed, the tab is a simple link-out page. This defers the `/metrics` proxy route (§4) and all RC data-fetching/theming work.

**No modal.** The connection flow lives entirely in the tab, which the `initialize` tool causes to appear and auto-open.

New, in `src/components/persistent-workspace/`:
- Extend `WorkspaceView` union (currently `code | preview | database`) with `"revenuecat"`; show the tab when `revenuecat_status !== 'none'` (mirror the Stripe tab appearing on enable).
- **Auto-open once:** when the tab first appears (status flips to `'connecting'`), the enabled-poller sets `currentView = 'revenuecat'` a single time — gently, so it doesn't yank the view back if the user navigates away (same one-shot discipline as the `?stripe_connect=success` handler).
- `revenuecat-tab.tsx` — **one component, two states driven by `revenuecat_status`:**
  - **`'connecting'` → setup wizard** (this is where the BYO flow lives, replacing Stripe's OAuth modal): step 1 "Create your RevenueCat account + project" (link-out) → step 2 paste `sk_` + `appl_` + project id (POST `/connect`) → step 3 confirm Apple `.p8` uploaded → step 4 copy the webhook URL + Authorization secret into RevenueCat → "Verify connection" button (GET `/status`). A step checklist shows what's done. Resumable — the user can leave and come back.
  - **`'connected'` → static link-out page, no data fetching:** short explainer; connection status (RC project id, sandbox/production); **primary button "Open RevenueCat Dashboard"** → deep-links to `https://app.revenuecat.com/projects/{revenuecat_project_id}/...` (fallback `https://app.revenuecat.com`), opened in a new tab via the iframe-aware `postMessage({ type: 'botflow:open-url', url })` pattern reused from `botflowCheckout.ts`; webhook reminder with copy buttons; **Disconnect** action.
  - Themed with `--sand-*` tokens. No `Connect*` components, no RC metrics calls.
- **Only one poller** (project-status poll to surface + auto-open the tab). No connect-request poll — there's no modal to coordinate.

> A real in-workspace metrics dashboard (RC v2 `metrics/overview` + `customers` + Convex entitlements) is **deferred to a later iteration**, not part of the preliminary build.

---

## 9. Agent tools, prompts, flags

- Add to the **Swift tool registry** (`getPersistentTools`, referenced in `src/app/api/agent/route.ts`): `initializeRevenueCatPayments`, `getRevenueCatProducts`, `createRevenueCatProduct` — conditionally spread on `REVENUECAT_ENABLED` (mirror the Stripe block).
- System prompt section (mirror `prompts.ts` "## Stripe payments") teaching: configure SDK with `appUserID`, use `RevenueCatUI` paywall, check entitlements, never hand-roll StoreKit, products go through the platform tools.
- `src/lib/feature-flags.ts`: add `REVENUECAT_ENABLED` / `NEXT_PUBLIC_REVENUECAT_ENABLED`.
- `src/lib/tier.ts`: add `canUseRevenueCat(userId)` (Pro/Max), mirror `canUseStripeConnect`.

---

## 10. Testing strategy (the Apple reality)

1. **Instant demo** — `.storekit` file in the streamed simulator. No Apple/RC account. Shows purchase UI + entitlement unlock locally.
2. **Sandbox** — user adds banking/tax + signs Paid Apps agreement, creates a sandbox tester, runs on TestFlight/device → RC records sandbox transactions, webhooks fire with `environment: SANDBOX`, dashboard shows sandbox data.
3. **Production** — products pass App Review, app is live → real revenue.

Set expectations in docs: simulator demo is instant; **real money requires the full Apple chain** (paid membership → Paid Apps agreement + banking/tax → products + App Review → TestFlight/App Store). We automate everything except Apple's approval gates.

---

## 11. Phasing

- **Phase 0 — Business**: open the RevenueCat partnership conversation in parallel (resolve the 5 unknowns in §12). Doesn't block Model B.
- **Phase 1 — Connect + scaffold (BYO)**: DB tables, `user_revenuecat_identity` (encrypted), the **payments tab with its setup wizard** (key paste in-tab, no modal), `initialize`/`connect`/`status` routes, tab auto-open, Swift SDK + `.storekit` scaffold, feature flag + tier gate. **Deliverable: simulator demo of a paywall + entitlement unlock.**
- **Phase 2 — Webhooks + Convex**: `/api/webhooks/revenuecat`, normalize+fan-out, Convex `revenueCatWebhook.ts` + `billing.ts`, entitlement tables. **Deliverable: sandbox purchase updates Convex.**
- **Phase 3 — Products + Apple automation**: RC products/entitlements/offerings via `sk_`; App Store Connect IAP creation; agent tools. **Deliverable: agent creates a subscription end-to-end.**
- **Phase 4 — Payments tab (link-out)**: `revenuecat-tab.tsx` as a static page — explainer + connection status + "Open RevenueCat Dashboard" button + webhook copy-fields + Disconnect. **Deliverable: tab appears on enable and deep-links to RC.** (Full in-workspace metrics dashboard deferred to a later iteration.)
- **Phase 5 (optional) — Model A migration**: if the RevenueCat partnership lands, swap the tab wizard's manual key-paste for OAuth auto-provisioning (the wizard collapses to a single "Connect" step); the rest of the stack — status enum, routes, scaffold, link-out view — is unchanged.

---

## 12. Open questions to resolve with RevenueCat (business track)

1. Does `POST /v2/projects` require an OAuth `atk_` (vs `sk_`)? (Implied, not documented.)
2. Can Apple `.p8` credentials be set via the v2 App API, or dashboard-only?
3. Can webhooks be registered via API, or dashboard-only?
4. Is MTR aggregated per-account or per-project? (Determines our fee exposure under Model A.)
5. Are platform / "projects on behalf of customers" terms allowed, and does it require Enterprise?

---

## 13. Decision (locked)

**Model B (BYO RevenueCat key) is confirmed for v1.** Model A (platform-hosted) is deferred to a parallel business track (Phase 5) and does not block. Phase 1 can start against the file map above.

### Phase 1 entry point (concrete first steps)
1. `drizzle/00XX_add_revenuecat_integration.sql` + `src/db/schema.ts` — new columns/tables (§3), with envelope encryption for `sk_`/`.p8`.
2. `src/lib/feature-flags.ts` — `REVENUECAT_ENABLED`; `src/lib/tier.ts` — `canUseRevenueCat`.
3. `src/lib/revenuecat.ts` + `revenuecat-connect.ts` + `revenuecat-proxy-auth.ts`.
4. `/api/projects/[id]/revenuecat/{initialize,connect,connect-request,status,disconnect}`.
5. `revenuecat-tab.tsx` (wizard + link-out states) + `WorkspaceView` `"revenuecat"` wiring + auto-open-once poller in `persistent-workspace`. No modal.
6. Swift scaffold: SDK + `RevenueCatUI` + `Botflow.storekit` → simulator paywall demo.
