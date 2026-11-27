-- Sharing hardening (part 1).
-- Additive + data cleanup; safe to run on a live database. Run BEFORE the
-- code that reads these columns deploys: node scripts/migrate-sharing-hardening.mjs

-- 1. Sticky "this project has been shared" marker. Backfilled from every
--    member row ever written (any status), so a project that was shared,
--    even briefly, never again gets a personal credential in its sandbox.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "shared_at" timestamp;
UPDATE "projects" p
   SET "shared_at" = m.first_invited
  FROM (SELECT "project_id", min("invited_at") AS first_invited
          FROM "project_members" GROUP BY "project_id") m
 WHERE p."id" = m."project_id" AND p."shared_at" IS NULL;

-- 2. Whether the sandbox may hold a personal credential. Existing rows stay
--    NULL (unknown → cleaned before anyone else gets access); new rows 'none'.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "sandbox_credentials" text;
ALTER TABLE "projects" ALTER COLUMN "sandbox_credentials" SET DEFAULT 'none';

-- 3. Snapshot/thumbnail URLs that PATCH /api/projects/[id] used to accept
--    from any editor. Real uploads always store their UploadThing key, and
--    the key is part of the URL; anything else is dropped (the next preview
--    snapshot regenerates it).
UPDATE "projects" SET "html_snapshot_url" = NULL
 WHERE "html_snapshot_url" IS NOT NULL
   AND ("html_snapshot_key" IS NULL OR strpos("html_snapshot_url", "html_snapshot_key") = 0);
UPDATE "projects" SET "thumbnail_url" = NULL
 WHERE "thumbnail_url" IS NOT NULL
   AND ("thumbnail_key" IS NULL OR strpos("thumbnail_url", "thumbnail_key") = 0);
