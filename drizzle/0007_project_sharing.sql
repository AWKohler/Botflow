-- Project sharing Phase 3: members table + share-sheet switches.
-- Additive only; safe to run on a live database.
-- See docs/features/project-sharing-plan.md §3.

CREATE TABLE IF NOT EXISTS "project_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "user_id" text,
  "invited_email" text NOT NULL,
  "role" text NOT NULL DEFAULT 'editor',
  "status" text NOT NULL DEFAULT 'pending',
  "token_cap_pct" integer NOT NULL DEFAULT 25,
  "invited_by" text NOT NULL,
  "invited_at" timestamp NOT NULL DEFAULT now(),
  "accepted_at" timestamp,
  "revoked_at" timestamp
);

CREATE UNIQUE INDEX IF NOT EXISTS "project_members_project_email_unique"
  ON "project_members" ("project_id", "invited_email");
CREATE INDEX IF NOT EXISTS "project_members_project_id_idx"
  ON "project_members" ("project_id");
CREATE INDEX IF NOT EXISTS "project_members_user_id_idx"
  ON "project_members" ("user_id");
CREATE INDEX IF NOT EXISTS "project_members_invited_email_idx"
  ON "project_members" ("invited_email");

ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "editors_can_push" boolean NOT NULL DEFAULT false;
ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "share_owner_oauth" boolean NOT NULL DEFAULT false;
