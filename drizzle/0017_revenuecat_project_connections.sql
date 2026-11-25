-- RevenueCat connections move from one-per-user to one-per-project: a
-- RevenueCat project is one app (its SDK keys, Test Store, offerings and
-- entitlements), so each Botflow project connects to its own. Everything but
-- the secret key is discovered through the RevenueCat API and cached here.
-- user_revenuecat_identity is left in place (it never held a row) and is
-- dropped by a later migration.
CREATE TABLE IF NOT EXISTS "project_revenuecat_connections" (
  "project_id" uuid PRIMARY KEY NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "rc_secret_key" text NOT NULL,
  "rc_project_id" text NOT NULL,
  "rc_project_name" text,
  "rc_test_store_app_id" text,
  "rc_test_store_sdk_key" text,
  "rc_app_store_app_id" text,
  "rc_app_store_sdk_key" text,
  "inbound_webhook_secret" text NOT NULL,
  "inbound_webhook_secret_digest" text NOT NULL,
  "rc_webhook_integration_id" text,
  "webhook_error" text,
  "last_event_at" timestamp,
  "connected_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "project_revenuecat_connections_inbound_digest_unique" ON "project_revenuecat_connections" ("inbound_webhook_secret_digest");
-- One RevenueCat project per Botflow project. The unique index is created
-- BEFORE the plain one from an earlier draft of this migration is dropped: if
-- two rows already share a RevenueCat project the create fails, and the table
-- must not be left with no index at all.
CREATE UNIQUE INDEX IF NOT EXISTS "project_revenuecat_connections_rc_project_unique" ON "project_revenuecat_connections" ("rc_project_id");
DROP INDEX IF EXISTS "project_revenuecat_connections_rc_project_idx";
