/**
 * Project-namespaced RevenueCat App User ID.
 *
 * RevenueCat webhook events carry no Botflow project id — only the app's
 * `app_user_id`. To route an event to the single owning project (instead of
 * broadcasting to every project that shares the user's one RevenueCat account),
 * the generated app sets its RevenueCat App User ID with a project prefix:
 *
 *     bfp_<projectId>__<yourAppUserId>
 *
 * The webhook parses the projectId back out and delivers only to that project.
 * `<projectId>` is the Botflow project UUID (which contains no "__"), so the
 * first "__" cleanly separates it from the app's own user id.
 */

const PREFIX = 'bfp_';
const SEP = '__';

/** Build a namespaced App User ID for the generated app to pass to RevenueCat. */
export function buildNamespacedAppUserId(projectId: string, appUserId: string): string {
  return `${PREFIX}${projectId}${SEP}${appUserId}`;
}

/**
 * The exact `bfp_<projectId>__` prefix a project's app must prepend to its own
 * user id. Single source of truth for the agent tool result, the prompt, and
 * the generated RevenueCatConfig.swift — they must never drift.
 */
export function namespacedAppUserIdPrefix(projectId: string): string {
  return `${PREFIX}${projectId}${SEP}`;
}

/** Extract the Botflow projectId from a namespaced App User ID, or null. */
export function parseProjectIdFromAppUserId(appUserId: string | null | undefined): string | null {
  if (!appUserId || !appUserId.startsWith(PREFIX)) return null;
  const rest = appUserId.slice(PREFIX.length);
  const sepIdx = rest.indexOf(SEP);
  if (sepIdx <= 0) return null;
  const projectId = rest.slice(0, sepIdx);
  // Botflow project ids are UUIDs — basic shape check to avoid mis-routing.
  if (!/^[0-9a-fA-F-]{36}$/.test(projectId)) return null;
  return projectId;
}

/**
 * Strip the bfp_<projectId>__ prefix, returning the app's OWN user id — the value
 * the generated app passed to RevenueCat and the one its billing logic keys on.
 * Returns the input unchanged when it isn't namespaced. Critical: the webhook must
 * deliver the STRIPPED id so billing.ts can match its users.
 */
export function stripNamespacedAppUserId(appUserId: string | null | undefined): string | null {
  if (!appUserId) return appUserId ?? null;
  if (!appUserId.startsWith(PREFIX)) return appUserId;
  const rest = appUserId.slice(PREFIX.length);
  const sepIdx = rest.indexOf(SEP);
  if (sepIdx < 0) return appUserId;
  return rest.slice(sepIdx + SEP.length);
}
