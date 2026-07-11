/**
 * Unified credential store — Clerk privateMetadata, Redis-cached.
 *
 * Sensitive credentials (API keys, OAuth tokens) live in Clerk privateMetadata.
 * Non-sensitive display data (githubUsername, githubAvatarUrl) remains in Neon.
 *
 * Read path:  Redis (5 min TTL) → Clerk privateMetadata → Neon fallback (legacy)
 * Write path: Clerk privateMetadata + Redis invalidation
 *
 * The Neon fallback means existing users keep working before running the migration script.
 */

import { clerkClient } from '@clerk/nextjs/server';
import { redis } from './redis';
import { getDb } from '@/db';
import { userSettings } from '@/db/schema';
import { eq } from 'drizzle-orm';

export interface UserCredentials {
  // BYOK API keys
  openaiApiKey: string | null;
  anthropicApiKey: string | null;
  moonshotApiKey: string | null;
  fireworksApiKey: string | null;
  togetherApiKey: string | null;
  googleApiKey: string | null;
  xaiApiKey: string | null;
  // Claude OAuth
  claudeOAuthAccessToken: string | null;
  claudeOAuthRefreshToken: string | null;
  claudeOAuthExpiresAt: number | null;
  // Codex OAuth
  codexOAuthAccessToken: string | null;
  codexOAuthRefreshToken: string | null;
  codexOAuthExpiresAt: number | null;
  codexOAuthAccountId: string | null;
  // GitHub OAuth
  githubAccessToken: string | null;
  // Display (non-sensitive, kept in Neon but mirrored here for convenience)
  githubUsername: string | null;
  githubAvatarUrl: string | null;
  // Apple App Store Connect API key (per Apple Developer team). Used for the
  // Swift "Publish to App Store / TestFlight" flow. The .p8 private key is
  // write-only from the client's perspective: never returned by any API route.
  appleAscIssuerId: string | null;  // team-level issuer UUID
  appleAscKeyId: string | null;     // 10-char key id
  appleAscKeyP8: string | null;     // PEM private key contents
  appleTeamId: string | null;       // 10-char Developer Team ID (signing)
  appleTeamName: string | null;     // display only
  // Convex OAuth
  convexOAuthAccessToken: string | null;
  convexOAuthRefreshToken: string | null;
  convexOAuthExpiresAt: number | null;
  convexTeamId: string | null;
  // User preference for new project creation:
  //   'platform' — Botflow-managed Convex (default)
  //   'user'     — Bring Your Own Convex (BYOC)
  //   'none'     — No backend (frontend-only project)
  convexBackendPreference: 'platform' | 'user' | 'none' | null;
  // User preference for the agent backend on Anthropic models when a choice
  // exists (BYOK users). 'botflow' (default) or 'claude-code'. OAuth users
  // are locked to 'claude-code' regardless of this value.
  preferredAnthropicBackend: 'botflow' | 'claude-code' | null;
}

const CACHE_TTL = 300; // 5 minutes

function cacheKey(userId: string) {
  return `creds:${userId}`;
}

/** Read credentials — Redis → Clerk privateMetadata → Neon fallback */
export async function getUserCredentials(userId: string): Promise<UserCredentials> {
  // 1. Try cache
  const cached = await redis.get<UserCredentials>(cacheKey(userId));
  if (cached) return cached;

  // 2. Read from Clerk privateMetadata
  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  const meta = (user.privateMetadata ?? {}) as Partial<UserCredentials>;

  // 3. Fall back to Neon for users not yet migrated (any field Clerk doesn't have)
  const needsNeonFallback =
    meta.openaiApiKey === undefined &&
    meta.anthropicApiKey === undefined &&
    meta.claudeOAuthAccessToken === undefined &&
    meta.codexOAuthAccessToken === undefined &&
    meta.githubAccessToken === undefined;

  let neon: Partial<UserCredentials> = {};
  if (needsNeonFallback) {
    try {
      const db = getDb();
      const [row] = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);
      if (row) {
        neon = {
          openaiApiKey: row.openaiApiKey ?? null,
          anthropicApiKey: row.anthropicApiKey ?? null,
          moonshotApiKey: row.moonshotApiKey ?? null,
          fireworksApiKey: row.fireworksApiKey ?? null,
          googleApiKey: row.googleApiKey ?? null,
          claudeOAuthAccessToken: row.claudeOAuthAccessToken ?? null,
          claudeOAuthRefreshToken: row.claudeOAuthRefreshToken ?? null,
          claudeOAuthExpiresAt: row.claudeOAuthExpiresAt ?? null,
          codexOAuthAccessToken: row.codexOAuthAccessToken ?? null,
          codexOAuthRefreshToken: row.codexOAuthRefreshToken ?? null,
          codexOAuthExpiresAt: row.codexOAuthExpiresAt ?? null,
          codexOAuthAccountId: row.codexOAuthAccountId ?? null,
          githubAccessToken: row.githubAccessToken ?? null,
          githubUsername: row.githubUsername ?? null,
          githubAvatarUrl: row.githubAvatarUrl ?? null,
          convexOAuthAccessToken: row.convexOAuthAccessToken ?? null,
          convexOAuthRefreshToken: row.convexOAuthRefreshToken ?? null,
          convexOAuthExpiresAt: row.convexOAuthExpiresAt ?? null,
        };
      }
    } catch {
      // Non-fatal — proceed with Clerk data only
    }
  }

  const creds: UserCredentials = {
    openaiApiKey: (meta.openaiApiKey ?? neon.openaiApiKey) ?? null,
    anthropicApiKey: (meta.anthropicApiKey ?? neon.anthropicApiKey) ?? null,
    moonshotApiKey: (meta.moonshotApiKey ?? neon.moonshotApiKey) ?? null,
    fireworksApiKey: (meta.fireworksApiKey ?? neon.fireworksApiKey) ?? null,
    // Together AI key is a newer field stored only in Clerk privateMetadata
    // (no Neon legacy column), so there's nothing to fall back to.
    togetherApiKey: meta.togetherApiKey ?? null,
    googleApiKey: (meta.googleApiKey ?? neon.googleApiKey) ?? null,
    // xAI key is newer — Clerk privateMetadata only, no Neon legacy column.
    xaiApiKey: meta.xaiApiKey ?? null,
    claudeOAuthAccessToken: (meta.claudeOAuthAccessToken ?? neon.claudeOAuthAccessToken) ?? null,
    claudeOAuthRefreshToken: (meta.claudeOAuthRefreshToken ?? neon.claudeOAuthRefreshToken) ?? null,
    claudeOAuthExpiresAt: (meta.claudeOAuthExpiresAt ?? neon.claudeOAuthExpiresAt) ?? null,
    codexOAuthAccessToken: (meta.codexOAuthAccessToken ?? neon.codexOAuthAccessToken) ?? null,
    codexOAuthRefreshToken: (meta.codexOAuthRefreshToken ?? neon.codexOAuthRefreshToken) ?? null,
    codexOAuthExpiresAt: (meta.codexOAuthExpiresAt ?? neon.codexOAuthExpiresAt) ?? null,
    codexOAuthAccountId: (meta.codexOAuthAccountId ?? neon.codexOAuthAccountId) ?? null,
    githubAccessToken: (meta.githubAccessToken ?? neon.githubAccessToken) ?? null,
    githubUsername: (meta.githubUsername ?? neon.githubUsername) ?? null,
    githubAvatarUrl: (meta.githubAvatarUrl ?? neon.githubAvatarUrl) ?? null,
    // Apple ASC fields are newer and stored only in Clerk privateMetadata
    // (no Neon legacy columns), so there's nothing to fall back to.
    appleAscIssuerId: meta.appleAscIssuerId ?? null,
    appleAscKeyId: meta.appleAscKeyId ?? null,
    appleAscKeyP8: meta.appleAscKeyP8 ?? null,
    appleTeamId: meta.appleTeamId ?? null,
    appleTeamName: meta.appleTeamName ?? null,
    convexOAuthAccessToken: (meta.convexOAuthAccessToken ?? neon.convexOAuthAccessToken) ?? null,
    convexOAuthRefreshToken: (meta.convexOAuthRefreshToken ?? neon.convexOAuthRefreshToken) ?? null,
    convexOAuthExpiresAt: (meta.convexOAuthExpiresAt ?? neon.convexOAuthExpiresAt) ?? null,
    convexTeamId: (meta.convexTeamId as string | null) ?? null,
    convexBackendPreference: (meta.convexBackendPreference as 'platform' | 'user' | 'none' | null) ?? null,
    preferredAnthropicBackend: (meta.preferredAnthropicBackend as 'botflow' | 'claude-code' | null) ?? null,
  };

  await redis.setex(cacheKey(userId), CACHE_TTL, creds);
  return creds;
}

/** Write (partial) credentials to Clerk privateMetadata and invalidate cache */
export async function setUserCredentials(
  userId: string,
  updates: Partial<UserCredentials>
): Promise<void> {
  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  const current = (user.privateMetadata ?? {}) as Partial<UserCredentials>;

  await client.users.updateUserMetadata(userId, {
    privateMetadata: { ...current, ...updates },
  });

  // Invalidate Redis cache so next read picks up fresh data
  await redis.del(cacheKey(userId));
}

/** Clear specific credential fields (e.g. on OAuth disconnect) */
export async function clearUserCredentials(
  userId: string,
  fields: (keyof UserCredentials)[]
): Promise<void> {
  const client = await clerkClient();
  const user = await client.users.getUser(userId);
  const current = { ...(user.privateMetadata ?? {}) } as Record<string, unknown>;

  for (const field of fields) {
    current[field] = null;
  }

  await client.users.updateUserMetadata(userId, { privateMetadata: current });
  await redis.del(cacheKey(userId));
}

/** Invalidate the credentials cache only (no write) */
export async function invalidateCredentialsCache(userId: string): Promise<void> {
  await redis.del(cacheKey(userId));
}
