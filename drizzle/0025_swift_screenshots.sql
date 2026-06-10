-- Swift simulator screenshots — the "last seen" frame per device family,
-- captured browser-side from the stream canvas and stored in UploadThing
-- (one file kept per device; the key columns allow eviction on replace).
-- Shown blurred in the stopped preview state, like the web HTML snapshot.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "swift_screenshot_iphone_url" TEXT;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "swift_screenshot_iphone_key" TEXT;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "swift_screenshot_ipad_url" TEXT;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "swift_screenshot_ipad_key" TEXT;
