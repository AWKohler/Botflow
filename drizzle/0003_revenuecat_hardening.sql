-- RevenueCat integration hardening: durable outbox for fanning entitlement
-- events out to project Convex sites, retried by
-- /api/cron/retry-revenuecat-deliveries so a paid entitlement event is never
-- lost when a project's Convex backend is momentarily down. Mirrors
-- stripe_webhook_deliveries.

CREATE TABLE IF NOT EXISTS revenuecat_webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  canonical_type text NOT NULL,
  payload text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamp NOT NULL DEFAULT now(),
  last_status integer,
  last_error text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- Idempotency against RevenueCat re-delivering the same event id.
CREATE UNIQUE INDEX IF NOT EXISTS revenuecat_webhook_deliveries_event_project_unique
  ON revenuecat_webhook_deliveries (event_id, project_id);

CREATE INDEX IF NOT EXISTS revenuecat_webhook_deliveries_retry_idx
  ON revenuecat_webhook_deliveries (status, next_attempt_at);

-- Indexed SHA-256 digest of the inbound webhook secret, so the receiver resolves
-- the owning user with an O(1) lookup instead of scanning every user's secret.
-- (The digest backfill for existing rows is done in JS by the migrate runner so
-- we don't depend on the pgcrypto extension being enabled.)
ALTER TABLE user_revenuecat_identity
  ADD COLUMN IF NOT EXISTS rc_inbound_webhook_secret_digest text;

CREATE INDEX IF NOT EXISTS user_revenuecat_identity_inbound_digest_idx
  ON user_revenuecat_identity (rc_inbound_webhook_secret_digest);
