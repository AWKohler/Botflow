-- RevenueCat (iOS in-app purchases) integration.
-- BYO model: users link their own RevenueCat account; secrets are encrypted at
-- rest (src/lib/secrets.ts). The payments tab hosts the entire connection flow.

-- Per-project state on the existing projects table.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "revenuecat_status" text DEFAULT 'none' NOT NULL;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "revenuecat_project_id" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "revenuecat_webhook_secret" text;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "revenuecat_environment" text DEFAULT 'sandbox' NOT NULL;

-- One row per Botflow user (reused across their iOS apps).
CREATE TABLE IF NOT EXISTS "user_revenuecat_identity" (
	"user_id" text PRIMARY KEY NOT NULL,
	"rc_secret_key" text,
	"rc_public_sdk_key" text,
	"rc_project_id" text,
	"rc_inbound_webhook_secret" text,
	"asc_issuer_id" text,
	"asc_key_id" text,
	"asc_private_key_p8" text,
	"connected_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

-- Dedupe inbound RevenueCat webhooks (idempotent across their retry window).
CREATE TABLE IF NOT EXISTS "revenuecat_webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL
);
