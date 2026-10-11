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

/** When true: Kimi K2.7 traffic is routed to Together AI instead of Fireworks.
 *  The model id stays `fireworks-kimi-k2p7` (so existing project preferences and
 *  the model selector are unaffected) — only the backend provider changes. The
 *  server key becomes `TOGETHER_API_KEY` and the connections tab exposes a
 *  Together AI BYOK input. Server-only flag (no NEXT_PUBLIC_ prefix); the client
 *  learns its value via the /api/user-settings response. */
export const USE_TOGETHER_KIMI =
  process.env.USE_TOGETHER_KIMI === 'true';

/** When true: project sharing is exposed — the Share button renders, the
 *  members/invite endpoints accept requests, and requireProjectAccess grants
 *  ACTIVE members editor access to shared projects. When false: strict
 *  single-owner behavior everywhere (member rows are ignored). Keep OFF in
 *  prod until the Anthropic proxy reaches Phase 2 — the owner's credential
 *  must be out of the sandbox before a collaborator can hold a shell in it
 *  (docs/features/anthropic-proxy-token-protection-plan.md §0). */
export const SHARING_ENABLED =
  process.env.NEXT_PUBLIC_SHARING_ENABLED === 'true';
