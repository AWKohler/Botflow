# Convex usage guardrails (Phase 1)

Platform-managed Convex deployments all live in ONE shared Convex team, and
Convex bills usage **team-wide with no per-project caps on paid plans** — the
only native stop is a team-wide disable threshold that would take every
customer's backend down at once. These guardrails add per-project detection
and a per-project kill switch. Design chat: 2026-07-23.

## How it works

- **Poller** — `/api/cron/convex-usage` (vercel.json, every 30 min;
  `Authorization: Bearer $CRON_SECRET` header ONLY — no `?token=`, it would
  land in access logs). Counts new function executions per platform-managed
  deployment via the deployment admin log stream (`stream_function_logs`,
  cursor stored on `projects.convex_usage_cursor`), buckets per UTC day in
  `convex_usage_daily` **using each entry's own timestamp** (midnight
  straddles and downtime backlogs land on the right day), and rolls the
  30-day sum (today + 29 prior days) into `projects.convex_calls_last_30d`
  (which is also the reaper's liveness signal — previously scaffolded, never
  populated). Candidates are swept least-recently-checked first, so fleets
  larger than the per-tick cap (350) rotate fairly.
- **Policy** — `src/lib/convex-usage/policy.ts` (pure):
  `active → warned` at the warn threshold, `→ paused` at the pause threshold,
  `warned → active` only after a full quiet UTC day (hysteresis). `paused` is
  sticky: only `scripts/admin-unpause-convex.mjs` or the BYOC transfer flow
  (Phase 3) leaves it.
- **Pause** — `POST {deployUrl}/api/change_deployment_state {"newState":"paused"}`
  with `Authorization: Convex <deployKey>` (probe-verified 2026-07-23; states:
  disabled|paused|running|suspended). Stops ALL function execution including
  crons/scheduled jobs; data untouched; fully reversible.
- **Alerts** — operator email (Resend) to `CONVEX_USAGE_ALERT_EMAIL`:
  `warn`, `pause`, `would_pause` (alert-only mode, once per project per UTC
  day), `pause_failed` (pause API call failed — retried every tick until it
  sticks), `paused_but_active` (state drift: a deployment we recorded as
  paused served traffic, e.g. someone unpaused it in the Convex dashboard;
  auto-re-paused when CONVEX_AUTO_PAUSE=true). User-facing email + UI is
  Phase 2.

## Env vars

| Var | Default | Meaning |
| --- | --- | --- |
| `CONVEX_WARN_CALLS_PER_DAY` | 100000 | warn threshold (calls/UTC day) |
| `CONVEX_PAUSE_CALLS_PER_DAY` | 1000000 | pause threshold; clamped up to warn if set lower |
| `CONVEX_AUTO_PAUSE` | unset (off) | `'true'` = poller pauses; anything else = alert-only |
| `CONVEX_USAGE_ALERT_EMAIL` | unset | operator alert recipient; unset = alerts dropped with a log line |

## Deploy runbook

1. `node scripts/migrate-convex-usage.mjs` (staging, then prod) —
   `drizzle/0011_convex_usage.sql`: 4 new `projects` columns + `convex_usage_daily`.
2. Set `CONVEX_USAGE_ALERT_EMAIL` (and threshold overrides if desired).
   Leave `CONVEX_AUTO_PAUSE` **unset** for the first 1–2 weeks — detect-and-alert
   only, tune thresholds against real traffic, then flip to `'true'`.
3. Deploy; confirm the cron registered. Manual tick:
   `curl -H "Authorization: Bearer $CRON_SECRET" "https://<host>/api/cron/convex-usage?dryRun=1"`.
4. Separately (no code): set team-wide spending limits in the Convex dashboard
   (warning + disable thresholds) as the catastrophic backstop.

## Ops

- **Unpause**: `node scripts/admin-unpause-convex.mjs <projectId>` — resumes
  the deployment and resets `convex_status` to `active`. If the workload is
  still hot, the next tick will warn/pause again.
- **Saturation extrapolation**: the log-stream buffer caps at 1000 entries
  per poll (measured live: fired 1200, got 1000). A saturated poll is scaled
  by wall-time coverage (elapsed ÷ entry-span, capped at 20×) so multi-million
  call/day abusers still cross the pause bar despite the bounded buffer. Still
  an outlier detector, not billing-grade metering. If exact numbers ever
  matter, `api/app_metrics/udf_rate` exists on the same admin surface (probe:
  responds, needs param-shape work).
- **Quiet deployments long-poll** `stream_function_logs` until the 8s fetch
  timeout — the sweep polls in batches of 10 and caps candidates at 350/tick
  (350/10 × 8s = 280s worst case inside the 300s maxDuration). Fleets beyond
  350 rotate via least-recently-checked ordering; raise POLL_CONCURRENCY
  before raising the cap.
- Status meanings on `projects.convex_status`:
  `active|warned|paused` owned by the poller; `migrating|transferred` reserved
  for the Phase 3 BYOC transfer flow (poller skips them).
