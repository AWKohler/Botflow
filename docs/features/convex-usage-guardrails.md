# Convex usage guardrails (Phase 1)

Platform-managed Convex deployments all live in ONE shared Convex team, and
Convex bills usage **team-wide with no per-project caps on paid plans** — the
only native stop is a team-wide disable threshold that would take every
customer's backend down at once. These guardrails add per-project detection
and a per-project kill switch. Design chat: 2026-07-23.

## How it works

- **Poller** — `/api/cron/convex-usage` (vercel.json, every 30 min, CRON_SECRET
  auth). Counts new function executions per platform-managed deployment via
  the deployment admin log stream (`stream_function_logs`, cursor stored on
  `projects.convex_usage_cursor`), buckets per UTC day in `convex_usage_daily`,
  and rolls the 30-day sum into `projects.convex_calls_last_30d` (which is also
  the reaper's liveness signal — previously scaffolded, never populated).
- **Policy** — `src/lib/convex-usage/policy.ts` (pure):
  `active → warned` at the warn threshold, `→ paused` at the pause threshold,
  `warned → active` only after a full quiet UTC day (hysteresis). `paused` is
  sticky: only `scripts/admin-unpause-convex.mjs` or the BYOC transfer flow
  (Phase 3) leaves it.
- **Pause** — `POST {deployUrl}/api/change_deployment_state {"newState":"paused"}`
  with `Authorization: Convex <deployKey>` (probe-verified 2026-07-23; states:
  disabled|paused|running|suspended). Stops ALL function execution including
  crons/scheduled jobs; data untouched; fully reversible.
- **Alerts** — operator email (Resend) on warn / pause / would-pause, to
  `CONVEX_USAGE_ALERT_EMAIL`. User-facing email + UI is Phase 2.

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
   `GET /api/cron/convex-usage?token=$CRON_SECRET&dryRun=1`.
4. Separately (no code): set team-wide spending limits in the Convex dashboard
   (warning + disable thresholds) as the catastrophic backstop.

## Ops

- **Unpause**: `node scripts/admin-unpause-convex.mjs <projectId>` — resumes
  the deployment and resets `convex_status` to `active`. If the workload is
  still hot, the next tick will warn/pause again.
- **Known undercount**: the log-stream buffer is bounded; a deployment doing
  millions of calls between ticks undercounts. Acceptable — this is an outlier
  detector, not billing-grade metering (a saturated buffer every tick is itself
  the spike signal). If exact numbers ever matter, `api/app_metrics/udf_rate`
  exists on the same admin surface (probe: responds, needs param-shape work).
- **Quiet deployments long-poll** `stream_function_logs` until the 8s fetch
  timeout — the sweep polls in batches of 10; at ~300 candidates worst case
  ≈ 4 min, inside the route's 300s maxDuration. Revisit before the fleet
  outgrows that.
- Status meanings on `projects.convex_status`:
  `active|warned|paused` owned by the poller; `migrating|transferred` reserved
  for the Phase 3 BYOC transfer flow (poller skips them).
