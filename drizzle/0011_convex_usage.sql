-- Convex usage guardrails: status machine on projects + daily call buckets.
-- Run via: node scripts/migrate-convex-usage.mjs

ALTER TABLE projects ADD COLUMN IF NOT EXISTS convex_status text NOT NULL DEFAULT 'active';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS convex_paused_at timestamp;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS convex_pause_reason text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS convex_usage_cursor bigint;

CREATE TABLE IF NOT EXISTS convex_usage_daily (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  day text NOT NULL,
  calls bigint NOT NULL DEFAULT 0,
  updated_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT convex_usage_daily_project_id_day_pk PRIMARY KEY (project_id, day)
);

CREATE INDEX IF NOT EXISTS convex_usage_daily_day_idx ON convex_usage_daily (day);
