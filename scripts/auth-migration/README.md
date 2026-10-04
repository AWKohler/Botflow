# Botflow identity and billing migration

This branch replaces Clerk runtime calls with Better Auth backed by Neon, an encrypted identity directory, native Botflow account/admin components, and direct Stripe Billing. Native authentication and direct Stripe billing went live on botflow.io on October 4, 2026. The sections below retain the rehearsal history; the production outcome is recorded at the end.

## Rehearsal evidence (2026-09-27)

The isolated Neon branch contains 107 imported users, 18 bcrypt password hashes, 90 linked social identities (82 Google, 8 GitHub), all public/unsafe/private metadata, 80 provider access tokens returned by Clerk, and 107 copied avatars. Clerk returned no usable token for the other 10 provider links. Those links remain usable for a new OAuth login; provider access tokens are distinct from login identity. Most exported Google access tokens have already expired. Private metadata, including integration refresh tokens and application API keys, is encrypted with AES-256-GCM and preserved without logging values.

Clerk-managed browser sessions are not imported. Users will need to sign in again. Existing bcrypt passwords are accepted unchanged; new passwords use scrypt. The migration must not be represented as preserving all active sessions or refreshing expired provider tokens.

106 users have a free subscription; one active Pro subscription is grandfathered at $1/month, with the next renewal at 2026-10-11T17:17:48.291Z. Stripe contains the customer and saved payment method but no corresponding Stripe subscription. The public prices remain Free, Pro $20/month or $204/year, and Max $60/month or $600/year. The legacy Pro price is private.

The source database has seven project-owner IDs absent from the current Clerk directory. Projects remain intact; deleted identities are not recreated automatically.

Validation: 198 repository tests, 16 authentication integration checks, and 16 Stripe test-mode billing checks passed. The production Next.js build and focused ESLint check passed. The auth rehearsal sends no real email. Billing fixtures use Stripe test mode and are cleaned up. No production subscriptions or user passwords were changed by these rehearsals. The existing GitHub OAuth app now also accepts the exact protected-preview callback; its Clerk callback remains in place. A real GitHub login resolved to the original owner ID with the user count unchanged at 107.

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

Run from the repository root with a mode-600 `.env.local`, or select a separate mode-600 configuration using `AUTH_MIGRATION_ENV_FILE`. Live provisioning writes catalog IDs only into the selected configuration file. Migration artifacts belong in ignored `.migration/`, never in Git or a PR. Set `AUTH_MIGRATION_ARTIFACT_DIR=.migration/production` for separate production envelopes, reports and billing checkpoints; its directory must remain inside `.migration/`.

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

Before production import, run `freeze-source.ts` with the production configuration for a dry review, then apply with `--apply --brief-sign-in-pause` only once the staged production deployment is ready. It requires an empty Clerk allowlist and no pending Clerk invitations, closes sign-up with the empty allowlist, temporarily locks existing users through Clerk’s supported lock API, and revokes and verifies all active legacy sessions. This instance rejects the API setting that would enforce the allowlist on sign-in. The encrypted checkpoint records each original account flag before applying a lock; the snapshot removes only those migration locks so they never become bans in the native service. Lock duration must leave at least 30 minutes for export, and import checks every current lock and the original flags. Disable the legacy lifecycle webhook before locking so temporary locks cannot trigger reaper work. The encrypted recovery checkpoint supports `freeze-source.ts --restore --apply`; it unlocks only accounts locked by the migration, and revoked sessions still require signing in again. Re-enable the legacy lifecycle webhook only if rolling back before native billing cutover. Wait at least 70 seconds after the freeze completes for previously issued JWTs to expire, then take a fresh password export and fresh snapshot. Production import verifies the pause, exact frozen user set, and a snapshot newer than session expiry and less than ten minutes old. Exports also recheck identity fields at the end to detect changes while billing/provider tokens are fetched. Do not promote the stale staging copy or treat the insert-only importer as a continuous synchronization system. Reconcile the complete user set again before switching traffic.

## Billing cutover and recovery

`cutover-billing.ts` is a dry run unless `--apply`, `AUTH_MIGRATION_TARGET=production`, `BILLING_STRIPE_MODE=live`, `--preserve-existing-renewals`, and the exact `--target-host` all agree. It refuses ambiguous owners, changed renewal dates, changed prices, existing unrelated subscriptions, canceled contracts, and renewals less than 48 hours away.

The sequence is: validate live Clerk contract and target row; create/recover a Stripe subscription with the existing customer, card, price, and future renewal anchor, proration disabled, and renewal initially disabled; save a durable checkpoint; cancel the Clerk renewal at period end; verify that cancellation; enable the Stripe renewal; update Neon; verify the checkpoint. This avoids charging immediately or leaving two automatic renewals enabled after an early failure.

A failure after Clerk cancellation may leave renewal disabled; a failure after Stripe activation may leave a stale database row. Read `.migration/billing-cutover-checkpoint.json`, inspect both systems, and resume the same migration idempotently before the renewal date. Never create a second subscription manually to work around a failed run. Keep the current Stripe subscription if rolling application code back; do not re-enable Clerk renewal without reconciling it first.

Configure signed events at `/api/webhooks/billing`: `customer.subscription.created`, `.updated`, `.deleted`, `invoice.paid`, `invoice.payment_failed`, and `checkout.session.completed`. The handler retrieves canonical Stripe state, checks mode and price mappings, serializes database updates, and records processed events. Preview webhook delivery must also satisfy Vercel deployment protection.

## Preview browser checks (2026-09-28)

The protected preview passed real GitHub login to the original owner, synthetic bcrypt password login, directory search, metadata editing, encrypted-key reveal with audit, impersonation and return, test-card checkout, signed Stripe webhook delivery, Pro entitlement activation, invoice display, and cancellation/resumption. The preview webhook uses a dedicated automation credential while deployment protection remains enabled. Its secret and endpoint identifier are recorded only in ignored `.migration/preview-webhook.json`.

Plan changes stay inside the Botflow account UI. Server-signed five-minute quotes bind the user, current subscription, target price, amount, and proration time. Upgrades use Stripe pending updates so access changes only after successful payment; downgrades and annual-to-monthly changes use schedules at renewal. The user can cancel a scheduled change. The Stripe portal remains an optional fallback for invoices, cards, and cancellation. Portal price changes are disabled; all plan changes use the native timing and quote checks.

## Follow-up validation (2026-09-30)

The native browser flows passed immediate Pro-to-Max upgrade with a prorated test invoice, Max-to-Pro downgrade scheduled at renewal, cancellation of that schedule, adding a second test card, changing the default card, and rejecting removal of the active default card. The account view now waits for the signed Stripe webhook before displaying an upgrade as active. A subsequent annual Max test confirmed that the deployed screen automatically changed to $600/year after payment. The disposable UI identity, Stripe test customer, and test subscription were removed afterward; the database contains exactly 113 source users.

Verification and recovery messages were delivered to Resend's reserved test recipient. The preview accepted the emailed verification code, completed password reset, and signed in with the replacement password. The reserved account was then removed. This verifies the deployed email path and provider delivery events, not delivery into a customer's real inbox.

The live Stripe catalog and portal are provisioned in an isolated mode-600 configuration at `.migration/live-billing.env`; customer subscriptions and renewals remain unchanged. Google OAuth callback configuration and real sign-in were completed on October 4 after the project owner enabled 2-Step Verification.

A fresh Clerk inventory has 113 users. The six added users use social sign-in. All 18 password accounts have unchanged, non-null `password_last_updated_at` timestamps relative to the original encrypted snapshot. `snapshot.ts --reuse-passwords-from=PATH` can preserve those hashes only when every current password account has a matching timestamp and existing hash in a snapshot from the same instance. A changed/new password fails closed and requires a new CSV. The original snapshot remains archived; do not confuse its 107-user counts with current production. The isolated database now contains all 113 source identities, 18 exact password hashes, 96 provider links, matching public/unsafe/private metadata, and 113 copied avatars. Of 85 access tokens returned in the fresh export, 84 match the rehearsal database exactly; one GitHub token was refreshed by the real owner login and is retained. `verify.ts --allow-rehearsal-token-rotation` reports this separately and is forbidden in production. Strict production verification still requires every token to match. GitHub accepts both preview and production replacement callbacks while retaining Clerk's callback.

## Follow-up validation (2026-10-04)

Google accepts both exact replacement callbacks, with the Clerk callback retained. A real Google login returned the original paid user ID without creating a duplicate, preserving the $1/month Pro contract and October 11 renewal. The fresh Clerk CSV and encrypted snapshot contain 117 users, 18 bcrypt password hashes and 100 provider links. Staging verifies every identity, email address and metadata field, 87 exact provider tokens, and two newer tokens from real preview logins retained separately. All 117 avatars are copied. Production billing reconciliation still shows one grandfathered paid contract and no native Stripe subscription.

Secondary-email integration checks pass verified addition, hashed codes, expiry/attempt limits, one-minute resend/hourly limits, password and OTP login, password recovery, primary selection, removal, alias signup/OAuth namespace collisions, cross-origin rejection, stale-session rejection and impersonation rejection. Only synthetic identities and a captured mailbox are used; fixtures are removed. The 198 repository tests, 16 authentication checks, 16 Stripe test-mode checks and Next.js build also passed with the alias implementation. Run `pnpm exec tsx scripts/auth-migration/email-integration-test.ts` alongside the existing integration scripts.

## Remaining production gates

- Add and verify provider callbacks ending `/api/auth/callback/google` and `/api/auth/callback/github`; retain Clerk callbacks during transition. Real Google/GitHub sign-in and deployed cross-account link rejection are verified. Synthetic linking checks already cover different-email linking, ownership conflicts, subsequent social sign-in and unlinking.
- Verify real verification/recovery email delivery and owner sign-in, admin metadata controls, impersonation return, account changes, and Stripe checkout in the protected preview.
- Confirm feature parity for any Clerk settings not exercised by the current Botflow UI. Self-service deletion uses an emailed confirmation token, cancels direct Stripe subscriptions, revokes sessions, and removes profile and integration secrets. Project records remain inaccessible under the deleted owner ID, matching the pre-existing retained-project behavior. Verified secondary emails support password/code sign-in, recovery, primary selection and removal. A database-wide email namespace prevents alias ownership races with sign-up and OAuth. All 117 source users currently have exactly one email; exported lists remain preserved.
- Provision live direct-billing catalog and signed webhook; run fresh export/import/reconciliation; validate all counts and the grandfathered contract.
- Coordinate production environment values, database migration, deployment and renewal cutover. Main auto-deploys, so do not merge ahead of those steps.
- Retain a recoverable Clerk snapshot and the encryption keys. Only retire Clerk billing/services after authentication, secrets, entitlements, and renewals have been verified in production.

## Production preparation (2026-10-04)

Production's 398 project records are backed up in Neon branch `br-fragrant-salad-adws0rba`, with no compute endpoint. The existing Vercel environment is backed up in ignored mode-600 storage. Production auth/encryption keys are separate from rehearsal; 19 runtime variables and an empty identity schema are prepared. The live signed webhook exists but remains disabled. No customer subscriptions, renewals or passwords have changed.

The production build `dpl_8ECkQdazYZtdA4WTq7DnRG2JXbnk` is staged on its generated protected URL; its auth health endpoint returns 200 with the existing project automation credential and rejects anonymous access through Vercel protection. `autoAssignCustomDomains=false` retained botflow.io on its Clerk deployment, but Vercel assigned generated project/branch aliases to the staged build. Those aliases were restored: botflow.io and the project base URL use `dpl_6HNBHMXBwbQzvZ57QyBhD85AvCWZ`; the protected branch preview uses `dpl_AcRqvDF2XiwQ3rptnx8fXQZGhsVV`. Always check aliases when staging a production build.

## Production cutover (2026-10-04)

The supported source pause used an empty sign-up allowlist, temporary user locks and verified revocation of eight Clerk sessions. The legacy lifecycle webhook was disabled first. After session-token expiry, a fresh password CSV and full encrypted snapshot were imported into the original production Neon database. Strict verification passed 117 users, 18 exact bcrypt hashes, 100 provider links, 89 exact available tokens and every public/unsafe/private metadata field. Original account flags were preserved: zero temporary locks became native bans. All 117 avatars are stored in Neon, all 398 project records remain intact, and the seven previously absent project owners remain absent.

The staged production build was promoted to botflow.io and www.botflow.io. Real GitHub owner login opened the native admin directory and 68 existing owner projects. Production impersonation opened the paid user's 13 projects and returned to the administrator. Real Google login opened the original Ar Ko account with Pro access. The grandfathered renewal is now owned by Stripe: same customer, saved card, $1/month price and October 11 at 17:17:48 UTC. Clerk cancellation was verified before enabling Stripe renewal. Classic billing mode and a backdated start retain the prior paid-period history without charging again. Stripe's initial invoice paid amount is zero. A genuine signed Stripe update event reached the production webhook, was recorded as processed, and has no pending deliveries.

All 117 original Stripe customers are linked by their existing user-ID metadata, including 116 free accounts. `migrate-customers.ts` is dry-run by default and requires the production/live configuration, imported manifest, exact target host and durable production promotion timestamp. It acquires the same per-user billing locks as checkout, refuses ownership conflicts and preserves current plans and payment methods. The saved cutover timestamp bounds legacy receipt lookup: pre-cutover card charges appear alongside new native invoices without duplicating later native payments. The current paid customer's eight earlier Stripe receipts remain accessible.

Recovery artifacts and checkpoints live in ignored mode-600 `.migration/production/`; encryption/auth secrets are saved separately from the Neon backup branch. After native account changes or billing activation, use a known working native deployment for code rollback. Do not blindly remap the domain to old Clerk code, overwrite the live database with the earlier backup, or re-enable Clerk renewal. Any return to the legacy identity service would require reconciling native changes first. Migration scripts are not continuous synchronization.
