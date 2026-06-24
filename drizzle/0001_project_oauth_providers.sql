-- project_oauth_providers: configured OAuth sign-in providers per generated app
-- (Google, GitHub, Microsoft Entra ID, Apple).
--
-- Client secrets live ONLY on the project's Convex deployment env (set via deploy
-- key, never stored here). This table tracks which providers are enabled so the
-- UI can list/manage them. Apple is the exception: its client secret is an ES256
-- JWT that expires every <=6 months, so the signing inputs are persisted here
-- (apple_private_key_p8 is AES-256-GCM encrypted via src/lib/secrets.ts) to
-- auto-rotate the secret. See src/lib/oauth-providers/.
CREATE TABLE IF NOT EXISTS project_oauth_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'enabled',
  redirect_uri text,
  apple_team_id text,
  apple_key_id text,
  apple_services_id text,
  apple_private_key_p8 text,
  secret_expires_at bigint,
  configured_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_oauth_providers_project_id_idx
  ON project_oauth_providers (project_id);

CREATE UNIQUE INDEX IF NOT EXISTS project_oauth_providers_project_provider_unique
  ON project_oauth_providers (project_id, provider);
