-- Sharing: share-sheet toggle letting editors use the database dashboard +
-- backend env (off by default; re-opens the owner-only routes when set).
ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "editors_manage_backend" boolean NOT NULL DEFAULT false;
