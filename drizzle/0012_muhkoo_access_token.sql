-- MuhKoo scoped access token: a machine credential (mk_<env>_at_…) minted per
-- app with db:read/db:write scopes. Used for server-side data-plane reads (the
-- agent's read_muhkoo_table tool) so reads survive the ~1-day platform
-- developer-session TTL. SERVER-ONLY — never injected into the sandbox.
-- Idempotent (IF NOT EXISTS) so a re-run is a no-op.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS muhkoo_access_token text;
