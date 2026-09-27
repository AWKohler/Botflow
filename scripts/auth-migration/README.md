# Botflow identity and billing migration

This branch replaces Clerk runtime calls with Better Auth backed by Neon, an encrypted identity directory, native Botflow account/admin components, and direct Stripe Billing. It is a staged migration, not a production cutover.

## Rehearsal evidence (2026-09-27)

The isolated Neon branch contains 107 imported users, 18 bcrypt password hashes, 90 linked social identities (82 Google, 8 GitHub), all public/unsafe/private metadata, 80 provider access tokens returned by Clerk, and 107 copied avatars. Clerk returned no usable token for the other 10 provider links. Those links remain usable for a new OAuth login; provider access tokens are distinct from login identity. Most exported Google access tokens have already expired. Private metadata, including integration refresh tokens and application API keys, is encrypted with AES-256-GCM and preserved without logging values.

Clerk-managed browser sessions are not imported. Users will need to sign in again. Existing bcrypt passwords are accepted unchanged; new passwords use scrypt. The migration must not be represented as preserving all active sessions or refreshing expired provider tokens.

106 users have a free subscription; one active Pro subscription is grandfathered at $1/month, with the next renewal at 2026-10-11T17:17:48.291Z. Stripe contains the customer and saved payment method but no corresponding Stripe subscription. The public prices remain Free, Pro $20/month or $204/year, and Max $60/month or $600/year. The legacy Pro price is private.

The source database has seven project-owner IDs absent from the current Clerk directory. Projects remain intact; deleted identities are not recreated automatically.

Validation: 198 repository tests, 16 authentication integration checks, and 11 Stripe test-mode billing checks passed. The production Next.js build and focused ESLint check passed. The auth rehearsal sends no real email. Billing fixtures use Stripe test mode and are cleaned up. No production subscriptions or user passwords were changed by these rehearsals. The existing GitHub OAuth app now also accepts the exact protected-preview callback; its Clerk callback remains in place. A real GitHub login resolved to the original owner ID with the user count unchanged at 107.

## Configuration

- `DATABASE_URL`: selected Neon database. Never use a production database for rehearsal.
- `BETTER_AUTH_SECRET`: high-entropy authentication secret; preserve securely across deployments.
- `IDENTITY_ENCRYPTION_KEY`: 32 random bytes encoded as base64. Back up separately from the database. Losing this key loses access to encrypted metadata.
- `BETTER_AUTH_URL`: canonical production URL (or localhost in development). Vercel previews use `VERCEL_BRANCH_URL` for stable callback URLs.
- `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`, `AUTH_GITHUB_CLIENT_ID`, `AUTH_GITHUB_CLIENT_SECRET`: sign-in credentials, separate from project integration OAuth credentials.
- `PANEL_ADMIN_USER_IDS`: explicit owner allowlist. When omitted, the two existing owner IDs are retained. An explicitly empty value disables all operators. Never grant admin privileges based solely on an email address or user-editable metadata.
- `RESEND_API_KEY`, optional `EMAIL_FROM`: verification and recovery email delivery.
- `BILLING_STRIPE_MODE`: `test` or `live`. Live billing is refused in Vercel previews.
- `BILLING_STRIPE_SECRET_KEY`, `NEXT_PUBLIC_BILLING_STRIPE_PUBLISHABLE_KEY`, `BILLING_STRIPE_WEBHOOK_SECRET`: separate direct-billing keys.
- `BILLING_PRICE_PRO_MONTH`, `BILLING_PRICE_PRO_YEAR`, `BILLING_PRICE_MAX_MONTH`, `BILLING_PRICE_MAX_YEAR`, `BILLING_PRICE_PRO_LEGACY`, `BILLING_PORTAL_CONFIGURATION_ID`: provisioned catalog IDs.
- Existing production Redis settings remain necessary for application usage limits. Rehearsal deliberately omits production Redis; authentication itself has a persistent database rate limiter.

Vercel overrides must target only `preview` and `gitBranch=codex/clerk-replacement`. Previews contain copied private account data and must retain Vercel deployment protection. Do not expose the branch as a public custom domain.

## Export, import, and verification

Run from the repository root with a mode-600 `.env.local`. Migration artifacts belong in ignored `.migration/`, never in Git or a PR.

1. Set `CLERK_MIGRATION_SECRET_KEY`, `CLERK_MIGRATION_INSTANCE_ID`, and `AUTH_MIGRATION_TARGET=staging`.
2. Export users from Clerk's instance settings to obtain the password hashes. Save as `.migration/clerk-passwords.csv` with mode 600.
3. `pnpm exec tsx scripts/auth-migration/snapshot.ts` exports users, metadata, billing, provider tokens, and a manifest into an encrypted snapshot.
4. `pnpm exec tsx scripts/auth-migration/attach-passwords.ts` attaches the password export and checks the exact user set.
5. `pnpm exec tsx scripts/auth-migration/import.ts` performs the dry run. Apply with `--apply --target-host=THE_EXACT_NEON_HOST` after selecting the isolated database. It creates the identity schema and imports transactionally. Existing identities are skipped on replay, so it cannot overwrite a changed local password.
6. `pnpm exec tsx scripts/auth-migration/migrate-avatars.ts` copies provider-hosted avatars into Neon.
7. `pnpm exec tsx scripts/auth-migration/verify.ts` compares identities, password hashes, all metadata, provider links, and available tokens.
8. `pnpm exec tsx scripts/auth-migration/reconcile-billing.ts` matches the paid Clerk contract to the Stripe customer using metadata, not email alone.
9. `pnpm exec tsx scripts/auth-migration/provision-billing.ts` creates the test catalog. Live provisioning requires the script's explicit live-review guard.
10. Run `pnpm test`, `pnpm exec tsx scripts/auth-migration/integration-test.ts`, `pnpm exec tsx scripts/auth-migration/billing-integration-test.ts`, and `pnpm build`.

Before production import, freeze Clerk identity/billing changes briefly and take a fresh password export and fresh snapshot. Do not promote the stale staging copy or treat the insert-only importer as a continuous synchronization system. Reconcile the complete user set again before switching traffic.

## Billing cutover and recovery

`cutover-billing.ts` is a dry run unless `--apply`, `AUTH_MIGRATION_TARGET=production`, `BILLING_STRIPE_MODE=live`, `--preserve-existing-renewals`, and the exact `--target-host` all agree. It refuses ambiguous owners, changed renewal dates, changed prices, existing unrelated subscriptions, canceled contracts, and renewals less than 48 hours away.

The sequence is: validate live Clerk contract and target row; create/recover a Stripe subscription with the existing customer, card, price, and future renewal anchor, proration disabled, and renewal initially disabled; save a durable checkpoint; cancel the Clerk renewal at period end; verify that cancellation; enable the Stripe renewal; update Neon; verify the checkpoint. This avoids charging immediately or leaving two automatic renewals enabled after an early failure.

A failure after Clerk cancellation may leave renewal disabled; a failure after Stripe activation may leave a stale database row. Read `.migration/billing-cutover-checkpoint.json`, inspect both systems, and resume the same migration idempotently before the renewal date. Never create a second subscription manually to work around a failed run. Keep the current Stripe subscription if rolling application code back; do not re-enable Clerk renewal without reconciling it first.

Configure signed events at `/api/webhooks/billing`: `customer.subscription.created`, `.updated`, `.deleted`, `invoice.paid`, `invoice.payment_failed`, and `checkout.session.completed`. The handler retrieves canonical Stripe state, checks mode and price mappings, serializes database updates, and records processed events. Preview webhook delivery must also satisfy Vercel deployment protection.

## Remaining production gates

- Add and verify provider callbacks ending `/api/auth/callback/google` and `/api/auth/callback/github`; retain Clerk callbacks during transition. Complete real Google/GitHub login and account-linking checks in preview.
- Verify real verification/recovery email delivery and owner sign-in, admin metadata controls, impersonation return, account changes, and Stripe checkout in the protected preview.
- Confirm feature parity for any Clerk settings not exercised by the current Botflow UI. Self-service deletion uses an emailed confirmation token, cancels direct Stripe subscriptions, revokes sessions, and removes profile and integration secrets. Project records remain inaccessible under the deleted owner ID, matching the pre-existing retained-project behavior. Managing additional email aliases is not implemented; all 107 source users currently have exactly one email, and the exported email lists are retained.
- Provision live direct-billing catalog and signed webhook; run fresh export/import/reconciliation; validate all counts and the grandfathered contract.
- Coordinate production environment values, database migration, deployment and renewal cutover. Main auto-deploys, so do not merge ahead of those steps.
- Retain a recoverable Clerk snapshot and the encryption keys. Only retire Clerk billing/services after authentication, secrets, entitlements, and renewals have been verified in production.
