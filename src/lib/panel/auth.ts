/**
 * Admin panel authorization.
 *
 * Access is a fixed allowlist of Clerk user ids — deliberately the simplest
 * thing that works. No Clerk Organizations feature to enable, no Backend API
 * round-trip, no cache to invalidate. The prod and dev instances each have
 * exactly one operator id, and both are baked in so the panel needs zero env
 * configuration to work in either place.
 *
 * PANEL_ADMIN_USER_IDS (comma-separated) REPLACES the defaults when set —
 * use it to grant temporary access or lock the panel down further without a
 * deploy.
 */

import { auth } from '@/lib/auth/server';

import { ownerIds } from '@/lib/auth/policy';

export function isPanelAdmin(userId: string): boolean {
  return ownerIds().includes(userId);
}

/**
 * Guard for /api/panel routes. Returns the admin's userId, or null when the
 * caller is unauthenticated or not an allowlisted operator. Callers should 404
 * (not 403) on null so the panel's existence isn't advertised to non-admins.
 */
export async function requirePanelAdmin(): Promise<string | null> {
  const { userId, actor } = await auth();
  if (!userId || actor) return null;
  return isPanelAdmin(userId) ? userId : null;
}
