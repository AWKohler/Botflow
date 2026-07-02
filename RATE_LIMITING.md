# Rate limiting & abuse protection

This documents the request rate limiter added in the `rate-limited` branch and —
importantly — the **anti-Sybil / account-abuse** controls that live *outside*
our code (in Clerk), because account creation can't be throttled in our request
handlers.

## 1. Request rate limiting (in code)

Implemented in [`src/lib/rate-limit.ts`](src/lib/rate-limit.ts), wired in two layers:

- **Edge layer** ([`src/middleware.ts`](src/middleware.ts)): a coarse, tiered
  limiter over every `/api/*` route. The route→bucket table lives in
  [`src/lib/rate-limit-classify.ts`](src/lib/rate-limit-classify.ts) (pure,
  unit-tested, matched top-down, `global` fallback) and is **method-aware**:
  GET/HEAD/OPTIONS on split rules go to the read-side bucket, everything else
  to the mutate-side. Runs before `auth.protect()` so unauth floods are
  rejected cheaply. Identity is namespaced under `edge:` so it never shares a
  Redis key with the in-handler layer.
- **In-handler layer**: precise `enforce(identifierFor(userId, req), <bucket>)`
  guards on the most expensive routes (agent, claude-code, sandbox exec/seed/
  session, publish/deploy, swift build, OAuth exchange, public source download,
  the per-tenant internal tool callback).

Identity is `user:<id>` for authenticated requests, else `ip:<client-ip>`. Client
IP is resolved from **platform-set, non-forgeable headers first**
(`x-vercel-forwarded-for` → `x-real-ip` → `cf-connecting-ip`), falling back to
raw `x-forwarded-for` only when none are present.

### Polling buckets (2026-07-01 incident)

The original table classified by path only, so every `/api/projects/**` request
— including the workspace's background polling GETs — consumed the `write`
budget (60/min). One open, ready workspace polls preview-state (2s), env
requests (2.5s), Convex OAuth status (2.5s), Stripe connect requests (2.5s) and
the file-tree signature (3s) ≈ **120+ req/min**, so a single workspace tab
soft-banned its own user: `GET /api/projects` and the model-select `PATCH`
429'd for as long as any tab stayed open (eight tabs made it instant).

Fix, in three parts:

1. **Method-aware classification** — project GETs go to `read`, mutations to
   `write`; they can no longer starve each other.
2. **Dedicated polling buckets** — known polling GETs go to `poll`
   (`RL_POLL`, default 1200/min: lightweight Redis/DB state checks) or
   `pollHeavy` (`RL_POLL_HEAVY`, default 240/min: the file-tree signature and
   file-content reads, which execute inside the sandbox). Background polling
   can never consume interactive allowance.
3. **Client-side hygiene** —
   [`use-workspace-poll.ts`](src/components/sandboxed-web-workspace/use-workspace-poll.ts)
   pauses all polling while the tab is hidden, jitters intervals so windows
   don't synchronize, never overlaps ticks, and honors `Retry-After` on 429.
   Model select and the projects page retry once after `Retry-After` instead
   of showing a dead-end error.

When adding a new client polling loop, use `useWorkspacePoll` and add the
endpoint's GET to the `poll`/`pollHeavy` rules in `rate-limit-classify.ts` —
**never** let a poll land in `read`/`write`, and add a classifier test pinning
it.

### Operating it

- **Fail-open by design.** If `UPSTASH_REDIS_REST_URL` / `_TOKEN` are unset, or a
  Redis call errors or times out (3s), requests are **allowed** and
  `enforced:false` is returned. Rate limiting never takes the site down.
- **Kill switch:** set `RL_DISABLED=1` to disable enforcement without a redeploy.
- **Tuning:** every bucket's token budget is env-overridable (`RL_AGENT`,
  `RL_DEPLOY`, `RL_PUBLIC`, …; see `RATE_LIMIT_BUCKETS`). Windows are fixed in
  code (60s). Defaults are conservative; review under real traffic before
  tightening.
- **Tests:** `pnpm test` (node:test via tsx) covers IP spoof-resistance, identity
  keying, the fail-open contract, and the 429 shape.

### What it does and does NOT protect

It bounds **request volume per identity** — burst floods, scripted loops,
token/credential grinding on OAuth, expensive-endpoint hammering. It is **not** a
spend cap (that's the credit reservation in `/api/agent`) and **not** a
concurrency cap on running sandboxes (a separate, still-open control).

## 2. Anti-Sybil / account-abuse (Clerk configuration — NOT code)

**The gap:** the free tier's budget, project allowance, and managed-Convex
allowance are all keyed on the Clerk `userId`. A threat actor who can cheaply
mint many accounts multiplies all of those. We **cannot** throttle this in our
request handlers because **Clerk owns the signup flow** — by the time our
`user.created` webhook fires, the account already exists. The effective controls
are Clerk-side configuration.

### Checklist (Clerk Dashboard)

- [ ] **Bot protection / CAPTCHA on sign-up.** Enable Clerk's bot protection
      (Smart/Invisible CAPTCHA) on the sign-up flow. This is the single highest-
      leverage control against scripted account creation.
- [ ] **Require verified email** before the account is usable, and **block
      disposable-email domains** (Clerk email validation / blocklist). Disallow
      sub-addressing abuse (`user+1@`, `user+2@`) if your provider treats them as
      distinct.
- [ ] **Enable Clerk's built-in rate limiting** on auth endpoints
      (sign-up / sign-in / verification) to cap per-IP attempts.
- [ ] **Restrict social/SSO providers** to ones that carry their own identity
      cost; be wary of providers that allow throwaway accounts.
- [ ] **Session/device limits** per user where it fits the product.
- [ ] **Monitoring/alerting** on sign-up spikes per IP / subnet / ASN.

### Defense-in-depth already shipped (blunts the *value* of a Sybil account)

Even a successfully created account now gets a **bounded** free footprint, so
Sybil abuse is far less profitable than before:

- Per-user **weekly/monthly credit caps** with an atomic pre-flight reservation
  (`/api/agent`) — no concurrent-request overshoot.
- Per-turn **output-token ceiling** on platform-paid models.
- **Project** and **managed-Convex** caps (free: 3 projects, 0 managed Convex),
  enforced at creation and on the deploy path.
- Per-user / per-IP **request rate limiting** (this branch).

The remaining lever is raising the **cost of creating an account** — which is the
Clerk checklist above.

### Optional detective control (code)

The existing `user.created` Clerk webhook ([`src/app/api/webhooks/clerk`](src/app/api/webhooks/clerk))
could record the signup IP and flag per-IP/subnet velocity for review. This is
*after-the-fact* (the account already exists) so it complements, but does not
replace, the bot-protection control above.
