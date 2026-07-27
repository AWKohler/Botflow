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

import { auth } from '@clerk/nextjs/server';

/** Operator accounts: prod instance, then dev instance. */
const DEFAULT_ADMIN_USER_IDS = [
  'user_3AXfS5TWRWoxbVQtZBs5NH3qbfw', // prod
  'user_320xpm1gJPwkWAuyi0WMD3gpNKd', // dev
];

function adminUserIds(): string[] {
  const raw = process.env.PANEL_ADMIN_USER_IDS;
  if (!raw) return DEFAULT_ADMIN_USER_IDS;
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // An env var set to whitespace/commas only would otherwise silently open the
  // panel to nobody OR fall back to defaults ambiguously — treat it as unset.
  return ids.length > 0 ? ids : DEFAULT_ADMIN_USER_IDS;
}

export function isPanelAdmin(userId: string): boolean {
  return adminUserIds().includes(userId);
}

/**
 * Guard for /api/panel routes. Returns the admin's userId, or null when the
 * caller is unauthenticated or not an allowlisted operator. Callers should 404
 * (not 403) on null so the panel's existence isn't advertised to non-admins.
 */
export async function requirePanelAdmin(): Promise<string | null> {
  const { userId } = await auth();
  if (!userId) return null;
  return isPanelAdmin(userId) ? userId : null;
}
