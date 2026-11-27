-- Sharing hardening (part 1).
-- Additive + data cleanup; idempotent; safe on a live database.
-- Run with scripts/migrate-sharing-hardening.mjs BEFORE the code that reads
-- these columns deploys. After the deploy, once no old instance can still
-- serve a request, run it again with --post-deploy (see the script).

-- 1. Sticky "this project has been shared" marker. Backfilled from every
--    member row ever written (any status), so a project that was shared,
--    even briefly, never again gets a personal credential in its sandbox.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "shared_at" timestamp;
UPDATE "projects" p
   SET "shared_at" = m.first_invited
  FROM (SELECT "project_id", min("invited_at") AS first_invited
          FROM "project_members" GROUP BY "project_id") m
 WHERE p."id" = m."project_id" AND p."shared_at" IS NULL;

-- 2. Whether the sandbox may hold a personal credential. NO default on
--    purpose: rows written by code that doesn't track it stay NULL
--    (unknown → purged before anyone else gets access). The app sets 'none'
--    on the projects it creates.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "sandbox_credentials" text;

-- 3. Snapshot/thumbnail URLs that PATCH /api/projects/[id] used to accept
--    from any editor. A real upload is exactly an UploadThing file URL
--    ending in /f/<its stored key>; anything else is dropped (the next
--    preview snapshot regenerates it).
UPDATE "projects" SET "html_snapshot_url" = NULL
 WHERE "html_snapshot_url" IS NOT NULL
   AND NOT ("html_snapshot_url" ~ '^https://(utfs\.io|[a-z0-9-]+\.ufs\.sh)/f/[^/?#]+$'
            AND substring("html_snapshot_url" from '/f/([^/?#]+)$') IS NOT DISTINCT FROM "html_snapshot_key");
-- Thumbnails are only ever shown as <img>, and older ones have no stored
-- key, so for them only the UploadThing URL form is required.
UPDATE "projects" SET "thumbnail_url" = NULL
 WHERE "thumbnail_url" IS NOT NULL
   AND "thumbnail_url" !~ '^https://(utfs\.io|[a-z0-9-]+\.ufs\.sh)/f/[^/?#]+$';
