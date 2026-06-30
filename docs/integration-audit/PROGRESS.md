# Integration Hardening Audit

Long-horizon review + fix of the agent-triggerable integration flows. Each feature is
reviewed by Codex (GPT-5.5, high reasoning), fixed, then re-reviewed until clean.

Branch: `fix/integration-hardening`
Raw Codex outputs: `.integration-audit/` (untracked)

## Methodology
1. Map the flow end-to-end (done in recon).
2. Codex review round N → parse findings.
3. Triage each finding against the real code (don't blindly trust the reviewer).
4. Fix confirmed issues.
5. Re-run Codex → repeat until no material findings remain.
6. `tsc --noEmit` gate before moving on.

## Features
| # | Feature | Status | Rounds | Notes |
|---|---------|--------|--------|-------|
| 1 | Web Stripe Connect | round 7 (final verify) | 7 | + double-fulfill fix, async-checkout, cancel-date (webhook+reconcile). 1% one-time fee (user-approved). tsc clean |
| 2 | Web OAuth providers (Tier 1) | ✅ DONE | 3 | R3 clean ("no new findings"). 5 fixes + Claude-Code path synced. F5 (pending-uniqueness) → Feature 6 |
| 3 | Web Convex provision + auth | ✅ DONE | 5 | r5 "production-sound, nothing substantive remains". key-leak (2 paths), signed-state CSRF, idempotency, Swift redirect allowlist, deploy-key=inherent(no-store+origin-scoped), precedence |
| 4 | Swift RevenueCat payments | ✅ DONE | 5 | r5 "production-sound, at the hardened Stripe bar". durable outbox+cron, V2 replay sig, O(1) digest auth, namespaced routing, V2-verifying scaffold+env+route-wire, enforced write-guard |
| 5 | Swift Convex auth | ✅ DONE (platform) | 2 | r2 "sound". redirect allowlist + signed OAuth state + per-attempt nonce threading. Swift-template nonce gen/verify spun off as task |
| 6 | Shared HITL/secrets infra | ✅ DONE | 11 | r11 "the full 6-feature integration-hardening audit are DONE". claim/lease state machine: create→claim('completing')→side-effect→completed/revert; pending-guarded dismiss/timeout; one-active unique index (pending\|completing); client-var public; secret discipline verified |

## Deployment runbook (apply before deploy — same pattern as 0001)
- `node scripts/migrate-stripe-hardening.mjs`      (drizzle/0002 — deliveries outbox, account uniqueness, object map)
- `node scripts/migrate-revenuecat-hardening.mjs`  (drizzle/0003 — deliveries outbox, inbound-secret digest)
- `node scripts/migrate-hitl-one-pending.mjs`      (drizzle/0004 — one-pending-per-project partial unique indexes)
- New Vercel crons: `retry-stripe-deliveries`, `retry-revenuecat-deliveries` (both */5).
- `CRON_SECRET` must be set (the new crons + rotate-apple-secrets are Bearer-only).
- Swift-template follow-up: BotflowAuthProvider must generate+verify the sign-in `state` nonce (spun off as a task).

## Findings log

### Feature 1 — Web Stripe Connect — Round 1 (Codex GPT-5.5 + own analysis)
Codex raw: `.integration-audit/review-stripe-r1.md`

| # | Sev | Finding | Status |
|---|-----|---------|--------|
| 1 | HIGH | OAuth callback trusted state as a bearer token; state consumed only at end (replay/concurrent race); no Clerk session check | FIXED — `auth()` + `userId===state.userId`, atomic consume-first via `UPDATE…RETURNING`, project re-ownership check, state dropped from `/oauth/start` response |
| 2 | HIGH | `test/live_account_id` only indexed, not unique → two users could link same acct → webhook misroutes (`.limit(1)`) | FIXED — partial UNIQUE indexes (`drizzle/0002`) + callback rejects cross-user account reuse |
| 3 | HIGH | Webhook broadcast every event to ALL of a user's same-mode projects → cross-project payment/customer leak | FIXED — route payment/subscription events to the single `metadata.botflow_project_id` project (verified owner+mode+enabled); only `account.updated` broadcasts; checkout-session now stamps `payment_intent_data.metadata` so PI events route too |
| 4 | HIGH | Event marked processed before delivery; 200 on failure → paid events permanently lost; (naive 5xx would risk disabling the SHARED endpoint) | FIXED — durable `stripe_webhook_deliveries` outbox, inline-once + always-200, async retry cron `/api/cron/retry-stripe-deliveries` (Bearer-only) with backoff to MAX_DELIVERY_ATTEMPTS |
| 5 | MED | Botflow→Convex HMAC signs body only → replayable; receiver had no freshness | FIXED — timestamped V2 signature (`HMAC("<ts>.<body>")` + `X-Botflow-Timestamp`), receiver rejects >5min skew; legacy header kept for already-deployed receivers; billing.ts idempotency guidance added |
| 6 | MED | Concurrent endpoint provisioning creates 2 Stripe endpoints; loser's secret unstored → its deliveries fail verification forever | FIXED — insert `…onConflictDoNothing().returning()`; delete the orphan Stripe endpoint when the race is lost (and when no secret returned) |

Own additional fix: callback/initialize previously left a ~3s window where `stripeEnabled=true` but `stripeWebhookSecret=null` (events dropped). Callback now sets the secret atomically; `flipProjectEnabled` re-reads current secret instead of a stale snapshot.

Verified OK by Codex: project-scoped routes enforce Clerk auth+ownership; state is 32-byte random w/ expiry; inbound uses raw body + constructEvent; account-session client secret only via owner route; agent tools never return secrets; proxy-auth constant-time.
