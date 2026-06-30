-- Stripe integration hardening.
--
-- 1. Enforce that a connected Stripe account belongs to at most ONE Botflow user
--    per mode (prevents cross-user webhook misrouting / data leakage). Replaces
--    the non-unique indexes from the baseline with partial UNIQUE indexes.
--    NOTE: if any acct_… is currently linked to two users this CREATE will fail;
--    dedupe user_stripe_identity first.
-- 2. Durable outbox for fanning normalized Stripe events to project Convex sites,
--    retried by /api/cron/retry-stripe-deliveries so paid events are never lost.

DROP INDEX IF EXISTS user_stripe_identity_test_account_id_idx;
DROP INDEX IF EXISTS user_stripe_identity_live_account_id_idx;

CREATE UNIQUE INDEX IF NOT EXISTS user_stripe_identity_test_account_id_unique
  ON user_stripe_identity (test_account_id)
  WHERE test_account_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS user_stripe_identity_live_account_id_unique
  ON user_stripe_identity (live_account_id)
  WHERE live_account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS stripe_webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  canonical_type text NOT NULL,
  mode text NOT NULL,
  payload text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamp NOT NULL DEFAULT now(),
  last_status integer,
  last_error text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- Harden next_attempt_at to NOT NULL even if an earlier run of this migration
-- created the table with a nullable column (CREATE TABLE IF NOT EXISTS is a
-- no-op for an existing table).
ALTER TABLE stripe_webhook_deliveries ALTER COLUMN next_attempt_at SET DEFAULT now();
UPDATE stripe_webhook_deliveries SET next_attempt_at = now() WHERE next_attempt_at IS NULL;
ALTER TABLE stripe_webhook_deliveries ALTER COLUMN next_attempt_at SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS stripe_webhook_deliveries_event_project_unique
  ON stripe_webhook_deliveries (event_id, project_id);

CREATE INDEX IF NOT EXISTS stripe_webhook_deliveries_retry_idx
  ON stripe_webhook_deliveries (status, next_attempt_at);

-- 3. Stripe object (subscription/customer) → project routing fallback, so
--    follow-up events lacking metadata.botflow_project_id (e.g. renewal
--    PaymentIntents) still route to the right project instead of being dropped.
CREATE TABLE IF NOT EXISTS stripe_object_project_map (
  mode text NOT NULL,
  object_id text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS stripe_object_project_map_pk
  ON stripe_object_project_map (mode, object_id);
