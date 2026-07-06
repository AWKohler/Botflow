-- Conflict safety: per-file version history for instrumented writes.
-- Additive only; safe to run on a live database.
CREATE TABLE IF NOT EXISTS "project_file_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "path" text NOT NULL,
  "content" text NOT NULL,
  "hash" text NOT NULL,
  "size" integer NOT NULL,
  "actor_type" text NOT NULL,
  "actor_user_id" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "project_file_versions_project_path_created_idx"
  ON "project_file_versions" ("project_id", "path", "created_at");
