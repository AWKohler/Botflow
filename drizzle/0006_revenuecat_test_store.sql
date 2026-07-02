-- RevenueCat Test Store support: cache the discovered test_store app id and
-- its public sandbox SDK key on the user's RevenueCat identity, so dev builds
-- can bake the test key without calling the RevenueCat API at build time.
ALTER TABLE "user_revenuecat_identity" ADD COLUMN IF NOT EXISTS "rc_test_store_app_id" text;
ALTER TABLE "user_revenuecat_identity" ADD COLUMN IF NOT EXISTS "rc_test_store_sdk_key" text;
