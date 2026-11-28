/**
 * Feature flags — controlled via environment variables.
 * NEXT_PUBLIC_ prefix makes them available in both server and client code.
 */

/** When false: Anthropic OAuth CTAs are hidden, existing OAuth tokens are ignored,
 *  and Claude models require a BYOK API key or Pro server key. */
export const ANTHROPIC_OAUTH_ENABLED =
  process.env.NEXT_PUBLIC_ANTHROPIC_OAUTH_ENABLED === 'true';

/** When true: the Stripe Connect integration is exposed — the
 *  `initializeStripePayments` AI tool is registered, the Stripe tab can
 *  appear in workspaces, and the proxy endpoints accept requests. When
 *  false: all of those are hidden / refuse. Default off until the slice
 *  is verified end-to-end on botflow.io. */
export const STRIPE_CONNECT_ENABLED =
  process.env.NEXT_PUBLIC_STRIPE_CONNECT_ENABLED === 'true';

/** When true: the RevenueCat (iOS in-app purchases) integration is exposed —
 *  the `initializeRevenueCatPayments` AI tool is registered, the payments tab
 *  can appear in Swift workspaces, and the RevenueCat endpoints accept
 *  requests. When false: all of those are hidden / refuse. Default off until
 *  the slice is verified end-to-end. */
export const REVENUECAT_ENABLED =
  process.env.REVENUECAT_ENABLED === 'true' ||
  process.env.NEXT_PUBLIC_REVENUECAT_ENABLED === 'true';

/** When true: project sharing is exposed — the Share button renders, the
 *  members/invite endpoints accept requests, and requireProjectAccess grants
 *  ACTIVE members editor access to shared projects. When false: strict
 *  single-owner behavior everywhere (member rows are ignored). Keep OFF in
 *  prod until the Anthropic proxy reaches Phase 2 — the owner's credential
 *  must be out of the sandbox before a collaborator can hold a shell in it
 *  (docs/features/anthropic-proxy-token-protection-plan.md §0). */
export const SHARING_ENABLED =
  process.env.NEXT_PUBLIC_SHARING_ENABLED === 'true';
