-- Sharing: owner-credits switch (billing + tier follow the owner when on).
ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "share_owner_credits" boolean NOT NULL DEFAULT false;
