-- MuhKoo backend integration: platform-owned edge-BaaS app credentials on the
-- projects table. All columns are nullable and only populated for projects with
-- backend_type = 'muhkoo'. The publishable key is browser-safe (injected into
-- the sandbox as VITE_MUHKOO_KEY); the secret key is a SERVER-ONLY hosting
-- deploy key and never reaches the sandbox. Idempotent (IF NOT EXISTS) so a
-- re-run is a no-op.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS muhkoo_app_id text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS muhkoo_slug text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS muhkoo_publishable_key text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS muhkoo_secret_key text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS muhkoo_hosting_url text;
