/**
 * Usage helpers — increment/read usage counters in Redis (daily) and Neon (monthly).
 */

import { redis } from './redis';
import { getDb } from '@/db';
import { usageRecords, projects } from '@/db/schema';
import { eq, and, sql, isNull } from 'drizzle-orm';

// ─── Period helpers ───────────────────────────────────────────────────────────

export function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function todayKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

// ─── Project counts ───────────────────────────────────────────────────────────

/** Count active (non-deleted) projects for a user */
export async function countUserProjects(userId: string): Promise<number> {
  const db = getDb();
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(projects)
    .where(
      and(
        eq(projects.userId, userId),
        isNull(projects.deletedAt)
      )
    );
  return result[0]?.count ?? 0;
}

/**
 * Count active platform-managed Convex projects for a user.
 *
 * Only counts PLATFORM-provisioned backends (backendType = 'platform' with a
 * convexProjectId). BYOC instances the user connected via their own Convex
 * OAuth account (backendType = 'user') run on the user's Convex account, cost
 * the platform nothing, and are intentionally excluded from the managed-Convex
 * cap.
 */
export async function countUserConvexProjects(userId: string): Promise<number> {
  const db = getDb();
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(projects)
    .where(
      and(
        eq(projects.userId, userId),
        isNull(projects.deletedAt),
        eq(projects.backendType, 'platform'),
        sql`${projects.convexProjectId} IS NOT NULL`
      )
    );
  return result[0]?.count ?? 0;
}

/** Count active CF Pages deployments for a user */
export async function countUserCfPagesDeployments(userId: string): Promise<number> {
  const db = getDb();
  const result = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(projects)
    .where(
      and(
        eq(projects.userId, userId),
        isNull(projects.deletedAt),
        sql`${projects.cloudflareProjectName} IS NOT NULL`
      )
    );
  return result[0]?.count ?? 0;
}

// ─── Daily counters (Redis) ───────────────────────────────────────────────────

function agentTurnsKey(userId: string): string {
  return `turns:${userId}:${todayKey()}`;
}

function screenshotKey(userId: string): string {
  return `ss:${userId}:${todayKey()}`;
}

const DAY_TTL = 86_400 + 3_600; // 25 hours — covers timezone drift

/** Get today's agent turn count for a user */
export async function getDailyAgentTurns(userId: string): Promise<number> {
  const val = await redis.get<number>(agentTurnsKey(userId));
  return val ?? 0;
}

/** Increment and return new daily agent turn count */
export async function incrementDailyAgentTurns(userId: string): Promise<number> {
  const key = agentTurnsKey(userId);
  const newVal = await redis.incr(key);
  if (newVal === 1) {
    // First increment today — set TTL
    await redis.expire(key, DAY_TTL);
  }
  return newVal;
}

/** Get today's screenshot count for a user */
export async function getDailyScreenshots(userId: string): Promise<number> {
  const val = await redis.get<number>(screenshotKey(userId));
  return val ?? 0;
}

/** Increment and return new daily screenshot count */
export async function incrementDailyScreenshots(userId: string): Promise<number> {
  const key = screenshotKey(userId);
  const newVal = await redis.incr(key);
  if (newVal === 1) {
    await redis.expire(key, DAY_TTL);
  }
  return newVal;
}

// ─── Monthly token usage (Neon) ───────────────────────────────────────────────

interface TokenUsage {
  tokensIn: number;
  tokensOut: number;
  total: number;
}

/** Get total tokens used this month for a given model */
export async function getMonthlyTokenUsage(userId: string, model: string): Promise<TokenUsage> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.userId, userId),
        eq(usageRecords.period, currentPeriod()),
        eq(usageRecords.model, model)
      )
    )
    .limit(1);

  if (!row) return { tokensIn: 0, tokensOut: 0, total: 0 };
  return {
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    total: row.tokensIn + row.tokensOut,
  };
}

/** Upsert token usage after a completed agent call */
export async function recordTokenUsage(
  userId: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
  credits: number = 0,
  cachedTokensRead: number = 0,
  cachedTokensWrite: number = 0,
): Promise<void> {
  const db = getDb();
  await db
    .insert(usageRecords)
    .values({
      userId,
      period: currentPeriod(),
      model,
      tokensIn,
      tokensOut,
      cachedTokensRead,
      cachedTokensWrite,
      credits,
      agentTurns: 1,
    })
    .onConflictDoUpdate({
      target: [usageRecords.userId, usageRecords.period, usageRecords.model],
      set: {
        tokensIn: sql`usage_records.tokens_in + excluded.tokens_in`,
        tokensOut: sql`usage_records.tokens_out + excluded.tokens_out`,
        cachedTokensRead: sql`usage_records.cached_tokens_read + excluded.cached_tokens_read`,
        cachedTokensWrite: sql`usage_records.cached_tokens_write + excluded.cached_tokens_write`,
        credits: sql`usage_records.credits + excluded.credits`,
        agentTurns: sql`usage_records.agent_turns + 1`,
        updatedAt: new Date(),
      },
    });
}
