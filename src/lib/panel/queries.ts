/**
 * Admin panel aggregate queries. Read-only — every function here is a SELECT.
 *
 * All money numbers derive from usage_records credits (see
 * src/lib/panel/pricing.ts for the USD conversion). Revenue is estimated from
 * tier sticker prices until real Stripe billing access exists.
 */

import { getDb } from '@/db';
import { sql } from 'drizzle-orm';
import { creditsToUsd } from './pricing';

/** A workspace open (lastOpened) or sandbox command (lastSandboxActivityAt)
 *  within this window counts as a live session. */
const LIVE_WINDOW_MIN = 10;

// ─── Shapes ──────────────────────────────────────────────────────────────────

export interface UsageOverview {
  totalUsersEver: number; // distinct user_ids in usage_records (used the agent at least once)
  thisMonth: {
    credits: number;
    costUsd: number;
    activeUsers: number;
    turns: number;
    tokensIn: number;
    tokensOut: number;
    cachedRead: number;
    cacheHitRatePct: number;
  };
  lastMonth: { credits: number; costUsd: number; activeUsers: number; turns: number };
  monthlyTrend: Array<{
    period: string;
    credits: number;
    costUsd: number;
    activeUsers: number;
    turns: number;
  }>;
  byModelThisMonth: Array<{
    model: string;
    credits: number;
    costUsd: number;
    users: number;
    turns: number;
    tokensIn: number;
    tokensOut: number;
    cachedRead: number;
    cacheHitRatePct: number;
  }>;
}

export interface PerUserUsage {
  userId: string;
  monthCredits: number;
  monthTurns: number;
  lifetimeCredits: number;
  lifetimeTurns: number;
  models: string[];
}

export interface PerUserProjects {
  userId: string;
  projectCount: number; // active (non-deleted)
  convexPlatformCount: number;
  convexPausedCount: number;
  cfDeployments: number;
  vercelSandboxes: number;
  sandboxHostSandboxes: number;
  stripeLiveProjects: number;
  revenuecatProjects: number;
  managedDomains: number;
  lastActiveAt: string | null; // max(lastOpened, lastSandboxActivityAt) ISO
  liveNow: boolean;
}

export interface ProjectAggregates {
  total: number;
  active: number;
  deleted: number;
  byPlatform: Array<{ platform: string; count: number }>;
  bySandboxProvider: Array<{ provider: string; count: number }>;
  byReapStage: Array<{ stage: string; count: number }>;
  createdByMonth: Array<{ month: string; created: number }>;
  publicProjects: number;
  githubLinked: number;
  stripeEnabled: number;
  stripeLiveMode: number;
  revenuecatConnected: number;
  customDomains: number;
  liveSessionCount: number;
}

export interface ConvexAggregates {
  platformInstances: number;
  byStatus: Array<{ status: string; count: number }>;
  byocInstances: number;
  totalCallsLast30d: number;
  /** Platform instances whose owning project is soft-deleted — provisioned
   *  backends potentially still costing money with no live project. */
  orphanedInstances: number;
  topByCalls: Array<{
    projectId: string;
    projectName: string;
    userId: string;
    calls: number;
    status: string;
  }>;
}

export interface WebhookHealth {
  stripe: Array<{ status: string; mode: string; count: number }>;
  revenuecat: Array<{ status: string; count: number }>;
  recentFailures: Array<{
    source: 'stripe' | 'revenuecat';
    projectId: string;
    canonicalType: string;
    attempts: number;
    lastStatus: number | null;
    lastError: string | null;
    updatedAt: string;
  }>;
}

export interface OpsSignals {
  /** Most recent convexCallsCheckedAt — proxy for the convex-usage cron's last run. */
  convexUsageCronLastRun: string | null;
  /** Most recent updated_at on a delivered/failed webhook delivery — proxy for retry-cron liveness. */
  stripeDeliveryLastActivity: string | null;
  revenuecatDeliveryLastActivity: string | null;
  pendingOauthRequests: number;
  pendingEnvVarRequests: number;
  pendingChatQuestions: number;
}

// ─── Usage aggregates ────────────────────────────────────────────────────────

function pct(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

export async function getUsageOverview(): Promise<UsageOverview> {
  const db = getDb();
  const [overallRows, thisMonthRows, lastMonthRows, trendRows, modelRows] =
    await Promise.all([
      db.execute(sql`
        SELECT COUNT(DISTINCT user_id)::int AS users FROM usage_records
      `),
      db.execute(sql`
        SELECT
          COUNT(DISTINCT user_id)::int                 AS active_users,
          COALESCE(SUM(credits), 0)::float8            AS credits,
          COALESCE(SUM(agent_turns), 0)::int           AS turns,
          COALESCE(SUM(tokens_in), 0)::float8          AS tokens_in,
          COALESCE(SUM(tokens_out), 0)::float8         AS tokens_out,
          COALESCE(SUM(cached_tokens_read), 0)::float8 AS cached_read
        FROM usage_records
        WHERE period = TO_CHAR(CURRENT_DATE, 'YYYY-MM')
      `),
      db.execute(sql`
        SELECT
          COUNT(DISTINCT user_id)::int       AS active_users,
          COALESCE(SUM(credits), 0)::float8  AS credits,
          COALESCE(SUM(agent_turns), 0)::int AS turns
        FROM usage_records
        WHERE period = TO_CHAR((CURRENT_DATE - INTERVAL '1 month'), 'YYYY-MM')
      `),
      db.execute(sql`
        SELECT
          period,
          COUNT(DISTINCT user_id)::int       AS active_users,
          COALESCE(SUM(credits), 0)::float8  AS credits,
          COALESCE(SUM(agent_turns), 0)::int AS turns
        FROM usage_records
        GROUP BY period
        ORDER BY period
      `),
      db.execute(sql`
        SELECT
          model,
          COUNT(DISTINCT user_id)::int                 AS users,
          COALESCE(SUM(credits), 0)::float8            AS credits,
          COALESCE(SUM(agent_turns), 0)::int           AS turns,
          COALESCE(SUM(tokens_in), 0)::float8          AS tokens_in,
          COALESCE(SUM(tokens_out), 0)::float8         AS tokens_out,
          COALESCE(SUM(cached_tokens_read), 0)::float8 AS cached_read
        FROM usage_records
        WHERE period = TO_CHAR(CURRENT_DATE, 'YYYY-MM')
        GROUP BY model
        ORDER BY credits DESC
      `),
    ]);

  const tm = (thisMonthRows.rows?.[0] ?? {}) as Record<string, unknown>;
  const lm = (lastMonthRows.rows?.[0] ?? {}) as Record<string, unknown>;
  const tmCredits = Number(tm.credits ?? 0);
  const tmTokensIn = Number(tm.tokens_in ?? 0);
  const tmCachedRead = Number(tm.cached_read ?? 0);

  return {
    totalUsersEver: Number(
      (overallRows.rows?.[0] as Record<string, unknown>)?.users ?? 0,
    ),
    thisMonth: {
      credits: tmCredits,
      costUsd: creditsToUsd(tmCredits),
      activeUsers: Number(tm.active_users ?? 0),
      turns: Number(tm.turns ?? 0),
      tokensIn: tmTokensIn,
      tokensOut: Number(tm.tokens_out ?? 0),
      cachedRead: tmCachedRead,
      cacheHitRatePct: pct(tmCachedRead, tmTokensIn + tmCachedRead),
    },
    lastMonth: {
      credits: Number(lm.credits ?? 0),
      costUsd: creditsToUsd(Number(lm.credits ?? 0)),
      activeUsers: Number(lm.active_users ?? 0),
      turns: Number(lm.turns ?? 0),
    },
    monthlyTrend: (trendRows.rows ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      const credits = Number(row.credits ?? 0);
      return {
        period: String(row.period),
        credits,
        costUsd: creditsToUsd(credits),
        activeUsers: Number(row.active_users ?? 0),
        turns: Number(row.turns ?? 0),
      };
    }),
    byModelThisMonth: (modelRows.rows ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      const credits = Number(row.credits ?? 0);
      const tokensIn = Number(row.tokens_in ?? 0);
      const cachedRead = Number(row.cached_read ?? 0);
      return {
        model: String(row.model),
        credits,
        costUsd: creditsToUsd(credits),
        users: Number(row.users ?? 0),
        turns: Number(row.turns ?? 0),
        tokensIn,
        tokensOut: Number(row.tokens_out ?? 0),
        cachedRead,
        cacheHitRatePct: pct(cachedRead, tokensIn + cachedRead),
      };
    }),
  };
}

// ─── Per-user usage ──────────────────────────────────────────────────────────

export async function getPerUserUsage(): Promise<Map<string, PerUserUsage>> {
  const db = getDb();
  const rows = await db.execute(sql`
    SELECT
      user_id,
      COALESCE(SUM(credits) FILTER (WHERE period = TO_CHAR(CURRENT_DATE, 'YYYY-MM')), 0)::float8     AS month_credits,
      COALESCE(SUM(agent_turns) FILTER (WHERE period = TO_CHAR(CURRENT_DATE, 'YYYY-MM')), 0)::int    AS month_turns,
      COALESCE(SUM(credits), 0)::float8                                                              AS lifetime_credits,
      COALESCE(SUM(agent_turns), 0)::int                                                             AS lifetime_turns,
      ARRAY_AGG(DISTINCT model)                                                                      AS models
    FROM usage_records
    GROUP BY user_id
  `);

  const map = new Map<string, PerUserUsage>();
  for (const r of rows.rows ?? []) {
    const row = r as Record<string, unknown>;
    const userId = String(row.user_id);
    map.set(userId, {
      userId,
      monthCredits: Number(row.month_credits ?? 0),
      monthTurns: Number(row.month_turns ?? 0),
      lifetimeCredits: Number(row.lifetime_credits ?? 0),
      lifetimeTurns: Number(row.lifetime_turns ?? 0),
      models: Array.isArray(row.models) ? (row.models as string[]).filter(Boolean) : [],
    });
  }
  return map;
}

// ─── Per-user project/resource footprint ─────────────────────────────────────

export async function getPerUserProjects(): Promise<Map<string, PerUserProjects>> {
  const db = getDb();
  const rows = await db.execute(sql`
    SELECT
      user_id,
      COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS project_count,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND backend_type = 'platform' AND convex_project_id IS NOT NULL)::int AS convex_platform,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND convex_status = 'paused')::int AS convex_paused,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND cloudflare_project_name IS NOT NULL)::int AS cf_deployments,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND sandbox_provider = 'vercel')::int AS vercel_sandboxes,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND sandbox_provider = 'sandbox-host')::int AS sandbox_host_sandboxes,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND stripe_enabled AND stripe_payment_mode = 'live')::int AS stripe_live,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND revenuecat_status = 'connected')::int AS revenuecat,
      COUNT(DISTINCT managed_domain_id) FILTER (WHERE deleted_at IS NULL AND managed_domain_id IS NOT NULL)::int AS managed_domains,
      MAX(GREATEST(COALESCE(last_opened, 'epoch'::timestamp), COALESCE(last_sandbox_activity_at, 'epoch'::timestamp))) AS last_active,
      BOOL_OR(
        deleted_at IS NULL AND GREATEST(
          COALESCE(last_opened, 'epoch'::timestamp),
          COALESCE(last_sandbox_activity_at, 'epoch'::timestamp)
        ) > NOW() - ${sql.raw(`INTERVAL '${LIVE_WINDOW_MIN} minutes'`)}
      ) AS live_now
    FROM projects
    GROUP BY user_id
  `);

  const map = new Map<string, PerUserProjects>();
  for (const r of rows.rows ?? []) {
    const row = r as Record<string, unknown>;
    const userId = String(row.user_id);
    const lastActive = row.last_active ? new Date(String(row.last_active)) : null;
    map.set(userId, {
      userId,
      projectCount: Number(row.project_count ?? 0),
      convexPlatformCount: Number(row.convex_platform ?? 0),
      convexPausedCount: Number(row.convex_paused ?? 0),
      cfDeployments: Number(row.cf_deployments ?? 0),
      vercelSandboxes: Number(row.vercel_sandboxes ?? 0),
      sandboxHostSandboxes: Number(row.sandbox_host_sandboxes ?? 0),
      stripeLiveProjects: Number(row.stripe_live ?? 0),
      revenuecatProjects: Number(row.revenuecat ?? 0),
      managedDomains: Number(row.managed_domains ?? 0),
      lastActiveAt:
        lastActive && lastActive.getTime() > 0 ? lastActive.toISOString() : null,
      liveNow: row.live_now === true,
    });
  }
  return map;
}

// ─── Platform-wide project aggregates ────────────────────────────────────────

export async function getProjectAggregates(): Promise<ProjectAggregates> {
  const db = getDb();
  const [totals, byPlatform, byProvider, byReap, byMonth, live] = await Promise.all([
    db.execute(sql`
      SELECT
        COUNT(*)::int                                                    AS total,
        COUNT(*) FILTER (WHERE deleted_at IS NULL)::int                  AS active,
        COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)::int              AS deleted,
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND is_public)::int    AS public,
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND github_repo_name IS NOT NULL)::int AS github,
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND stripe_enabled)::int AS stripe,
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND stripe_enabled AND stripe_payment_mode = 'live')::int AS stripe_live,
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND revenuecat_status = 'connected')::int AS revenuecat,
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND (custom_domain IS NOT NULL OR managed_domain_hostname IS NOT NULL))::int AS domains
      FROM projects
    `),
    db.execute(sql`
      SELECT platform, COUNT(*)::int AS count FROM projects
      WHERE deleted_at IS NULL GROUP BY platform ORDER BY count DESC
    `),
    db.execute(sql`
      SELECT sandbox_provider AS provider, COUNT(*)::int AS count FROM projects
      WHERE deleted_at IS NULL GROUP BY sandbox_provider ORDER BY count DESC
    `),
    db.execute(sql`
      SELECT reap_stage AS stage, COUNT(*)::int AS count FROM projects
      WHERE deleted_at IS NULL GROUP BY reap_stage ORDER BY count DESC
    `),
    db.execute(sql`
      SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month, COUNT(*)::int AS created
      FROM projects GROUP BY month ORDER BY month
    `),
    db.execute(sql`
      SELECT COUNT(*)::int AS live FROM projects
      WHERE deleted_at IS NULL AND GREATEST(
        COALESCE(last_opened, 'epoch'::timestamp),
        COALESCE(last_sandbox_activity_at, 'epoch'::timestamp)
      ) > NOW() - ${sql.raw(`INTERVAL '${LIVE_WINDOW_MIN} minutes'`)}
    `),
  ]);

  const t = (totals.rows?.[0] ?? {}) as Record<string, unknown>;
  const mapRows = (res: { rows?: unknown[] }, key: string) =>
    (res.rows ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      return { [key]: String(row[key]), count: Number(row.count ?? 0) };
    });

  return {
    total: Number(t.total ?? 0),
    active: Number(t.active ?? 0),
    deleted: Number(t.deleted ?? 0),
    byPlatform: mapRows(byPlatform, 'platform') as ProjectAggregates['byPlatform'],
    bySandboxProvider: mapRows(byProvider, 'provider') as ProjectAggregates['bySandboxProvider'],
    byReapStage: mapRows(byReap, 'stage') as ProjectAggregates['byReapStage'],
    createdByMonth: (byMonth.rows ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      return { month: String(row.month), created: Number(row.created ?? 0) };
    }),
    publicProjects: Number(t.public ?? 0),
    githubLinked: Number(t.github ?? 0),
    stripeEnabled: Number(t.stripe ?? 0),
    stripeLiveMode: Number(t.stripe_live ?? 0),
    revenuecatConnected: Number(t.revenuecat ?? 0),
    customDomains: Number(t.domains ?? 0),
    liveSessionCount: Number(
      ((live.rows?.[0] ?? {}) as Record<string, unknown>).live ?? 0,
    ),
  };
}

// ─── Convex aggregates ───────────────────────────────────────────────────────

export async function getConvexAggregates(): Promise<ConvexAggregates> {
  const db = getDb();
  const [counts, byStatus, top, orphaned] = await Promise.all([
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND backend_type = 'platform' AND convex_project_id IS NOT NULL)::int AS platform,
        COUNT(*) FILTER (WHERE deleted_at IS NULL AND backend_type = 'user')::int AS byoc,
        COALESCE(SUM(convex_calls_last_30d) FILTER (WHERE deleted_at IS NULL AND backend_type = 'platform'), 0)::float8 AS calls
      FROM projects
    `),
    db.execute(sql`
      SELECT convex_status AS status, COUNT(*)::int AS count FROM projects
      WHERE deleted_at IS NULL AND backend_type = 'platform' AND convex_project_id IS NOT NULL
      GROUP BY convex_status ORDER BY count DESC
    `),
    db.execute(sql`
      SELECT id, name, user_id, convex_calls_last_30d AS calls, convex_status AS status
      FROM projects
      WHERE deleted_at IS NULL AND backend_type = 'platform' AND convex_calls_last_30d IS NOT NULL
      ORDER BY convex_calls_last_30d DESC
      LIMIT 10
    `),
    db.execute(sql`
      SELECT COUNT(*)::int AS orphaned FROM projects
      WHERE deleted_at IS NOT NULL AND backend_type = 'platform' AND convex_project_id IS NOT NULL
    `),
  ]);

  const c = (counts.rows?.[0] ?? {}) as Record<string, unknown>;
  return {
    platformInstances: Number(c.platform ?? 0),
    byocInstances: Number(c.byoc ?? 0),
    totalCallsLast30d: Number(c.calls ?? 0),
    orphanedInstances: Number(
      ((orphaned.rows?.[0] ?? {}) as Record<string, unknown>).orphaned ?? 0,
    ),
    byStatus: (byStatus.rows ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      return { status: String(row.status), count: Number(row.count ?? 0) };
    }),
    topByCalls: (top.rows ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      return {
        projectId: String(row.id),
        projectName: String(row.name),
        userId: String(row.user_id),
        calls: Number(row.calls ?? 0),
        status: String(row.status),
      };
    }),
  };
}

// ─── Webhook delivery health ─────────────────────────────────────────────────

export async function getWebhookHealth(): Promise<WebhookHealth> {
  const db = getDb();
  const [stripe, rc, failures] = await Promise.all([
    db.execute(sql`
      SELECT status, mode, COUNT(*)::int AS count FROM stripe_webhook_deliveries
      GROUP BY status, mode ORDER BY count DESC
    `),
    db.execute(sql`
      SELECT status, COUNT(*)::int AS count FROM revenuecat_webhook_deliveries
      GROUP BY status ORDER BY count DESC
    `),
    db.execute(sql`
      (SELECT 'stripe' AS source, project_id, canonical_type, attempts, last_status, last_error, updated_at
        FROM stripe_webhook_deliveries WHERE status IN ('failed', 'exhausted')
        ORDER BY updated_at DESC LIMIT 10)
      UNION ALL
      (SELECT 'revenuecat' AS source, project_id, canonical_type, attempts, last_status, last_error, updated_at
        FROM revenuecat_webhook_deliveries WHERE status IN ('failed', 'exhausted')
        ORDER BY updated_at DESC LIMIT 10)
      ORDER BY updated_at DESC LIMIT 15
    `),
  ]);

  return {
    stripe: (stripe.rows ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      return {
        status: String(row.status),
        mode: String(row.mode),
        count: Number(row.count ?? 0),
      };
    }),
    revenuecat: (rc.rows ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      return { status: String(row.status), count: Number(row.count ?? 0) };
    }),
    recentFailures: (failures.rows ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      return {
        source: row.source === 'stripe' ? ('stripe' as const) : ('revenuecat' as const),
        projectId: String(row.project_id),
        canonicalType: String(row.canonical_type),
        attempts: Number(row.attempts ?? 0),
        lastStatus: row.last_status == null ? null : Number(row.last_status),
        lastError: row.last_error == null ? null : String(row.last_error),
        updatedAt: String(row.updated_at),
      };
    }),
  };
}

// ─── Ops liveness signals ────────────────────────────────────────────────────

export async function getOpsSignals(): Promise<OpsSignals> {
  const db = getDb();
  const [convexCron, stripeAct, rcAct, pending] = await Promise.all([
    db.execute(sql`
      SELECT MAX(convex_calls_checked_at) AS last FROM projects WHERE backend_type = 'platform'
    `),
    db.execute(sql`
      SELECT MAX(updated_at) AS last FROM stripe_webhook_deliveries
    `),
    db.execute(sql`
      SELECT MAX(updated_at) AS last FROM revenuecat_webhook_deliveries
    `),
    db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM oauth_provider_requests WHERE status = 'pending') AS oauth,
        (SELECT COUNT(*)::int FROM env_var_requests WHERE status = 'pending')        AS env,
        (SELECT COUNT(*)::int FROM chat_questions WHERE status = 'pending')          AS questions
    `),
  ]);

  const toIso = (res: { rows?: unknown[] }) => {
    const v = ((res.rows?.[0] ?? {}) as Record<string, unknown>).last;
    return v ? new Date(String(v)).toISOString() : null;
  };
  const p = (pending.rows?.[0] ?? {}) as Record<string, unknown>;

  return {
    convexUsageCronLastRun: toIso(convexCron),
    stripeDeliveryLastActivity: toIso(stripeAct),
    revenuecatDeliveryLastActivity: toIso(rcAct),
    pendingOauthRequests: Number(p.oauth ?? 0),
    pendingEnvVarRequests: Number(p.env ?? 0),
    pendingChatQuestions: Number(p.questions ?? 0),
  };
}
