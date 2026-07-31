-- MuhKoo: access-token renewal metadata, schema cache, and the platform
-- developer session moved out of env into the database.
-- Run via: node scripts/migrate-muhkoo-session-and-renewal.mjs

-- Renewal metadata for the per-project scoped access token. Without the key id
-- a token cannot be revoked; without the expiry we cannot renew before it
-- lapses (the API hands both back at mint time).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS muhkoo_access_token_key_id text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS muhkoo_access_token_expires_at bigint;

-- Last-known-good table schema, so `list_muhkoo_tables` keeps answering while
-- the platform developer session is lapsed (schema is management-plane only —
-- app access tokens have no scope for it).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS muhkoo_schema_cache jsonb;

-- Platform-wide secrets that need rotating without a redeploy. Today this
-- holds the MuhKoo developer session token, which expires roughly daily and
-- would otherwise require a Vercel env edit + redeploy to refresh.
-- Values are envelope-encrypted (src/lib/secrets.ts), never plaintext.
CREATE TABLE IF NOT EXISTS platform_secrets (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL,
  updated_by text
);
