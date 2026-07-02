-- RevenueCat scaffold-health persistence + dead-table cleanup.
-- 1. projects.revenuecat_scaffold_state: outcome of the last Convex scaffold
--    run (files/env/route + errors), surfaced in the payments tab checklist.
-- 2. Drop revenuecat_webhook_events: never used — inbound dedup lives on the
--    revenuecat_webhook_deliveries (event_id, project_id) unique index.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "revenuecat_scaffold_state" jsonb;

DROP TABLE IF EXISTS "revenuecat_webhook_events";
