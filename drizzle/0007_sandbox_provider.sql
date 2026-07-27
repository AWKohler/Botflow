-- Which sandbox backend hosts this project's persistent sandbox.
--   'vercel'       — Vercel Sandbox (historical default; paid tiers)
--   'sandbox-host' — self-hosted Firecracker microVM service (free tier)
-- Existing rows stay on 'vercel' until migrated by
-- scripts/migrate-free-projects-to-sandbox-host.mjs.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS sandbox_provider text NOT NULL DEFAULT 'vercel';
