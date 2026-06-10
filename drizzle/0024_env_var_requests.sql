-- Env-var entry requests, modelled after oauth_provider_requests.
-- The agent's requestEnvVar tool creates one of these; the workspace UI polls
-- and renders the EnvVarModal where the user types the VALUE (the agent only
-- chose the NAME). Saving writes the value to the Vite .env / Convex
-- deployment server-side and flips status='completed'; the X flips it to
-- 'dismissed' so the blocked tool poll reports "user declined".

CREATE TABLE IF NOT EXISTS "env_var_requests" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "user_id" TEXT NOT NULL,
  "target" TEXT NOT NULL,                     -- 'client' | 'server'
  "key" TEXT NOT NULL,                        -- variable name chosen by the agent
  "message" TEXT,                             -- optional agent note shown in the modal
  "is_secret" BOOLEAN NOT NULL DEFAULT FALSE,
  "status" TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'completed' | 'dismissed'
  "created_at" TIMESTAMP DEFAULT NOW() NOT NULL,
  "updated_at" TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS "env_var_requests_project_id_idx"
  ON "env_var_requests"("project_id");
