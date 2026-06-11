CREATE TABLE "chat_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"upload_thing_url" text NOT NULL,
	"upload_thing_key" text NOT NULL,
	"filename" text,
	"size" integer,
	"media_type" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"role" text NOT NULL,
	"content" jsonb NOT NULL,
	"segment_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"segment_id" uuid,
	"tool_call_id" text NOT NULL,
	"questions" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"answer" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_dns_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_id" uuid NOT NULL,
	"cf_record_id" text,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"content" text NOT NULL,
	"ttl" integer DEFAULT 1 NOT NULL,
	"priority" integer,
	"proxied" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "env_var_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"target" text NOT NULL,
	"key" text NOT NULL,
	"message" text,
	"is_secret" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_provider_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"convex_site_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_git_commits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"message" text NOT NULL,
	"files_snapshot" jsonb NOT NULL,
	"base_sha" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"path" text NOT NULL,
	"upload_thing_url" text NOT NULL,
	"upload_thing_key" text NOT NULL,
	"hash" text NOT NULL,
	"size" integer NOT NULL,
	"mime_type" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_env_vars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"is_secret" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"hash" text NOT NULL,
	"size" integer NOT NULL,
	"mime_type" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_stars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_sync_manifests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"file_manifest" jsonb NOT NULL,
	"total_files" integer DEFAULT 0 NOT NULL,
	"total_size" bigint DEFAULT 0 NOT NULL,
	"last_sync_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"user_id" text NOT NULL,
	"platform" text DEFAULT 'web' NOT NULL,
	"agent_backend" text DEFAULT 'botflow' NOT NULL,
	"current_segment_id" uuid,
	"model" text DEFAULT 'fireworks-kimi-k2p6' NOT NULL,
	"thumbnail_url" text,
	"html_snapshot_url" text,
	"thumbnail_key" text,
	"html_snapshot_key" text,
	"swift_screenshot_iphone_url" text,
	"swift_screenshot_iphone_key" text,
	"swift_screenshot_ipad_url" text,
	"swift_screenshot_ipad_key" text,
	"convex_project_id" text,
	"convex_deployment_id" text,
	"convex_deploy_url" text,
	"convex_deploy_key" text,
	"github_repo_owner" text,
	"github_repo_name" text,
	"github_default_branch" text DEFAULT 'main',
	"github_last_pushed_sha" text,
	"git_autonomy" text,
	"user_convex_url" text,
	"user_convex_deploy_key" text,
	"backend_type" text DEFAULT 'none' NOT NULL,
	"cloudflare_project_name" text,
	"cloudflare_deployment_url" text,
	"custom_domain" text,
	"custom_domain_status" text,
	"managed_domain_id" uuid,
	"managed_domain_hostname" text,
	"auth_configured" boolean DEFAULT false NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"public_slug" text,
	"public_description" text,
	"public_source_url" text,
	"public_source_key" text,
	"seed_bundle_url" text,
	"star_count" integer DEFAULT 0 NOT NULL,
	"forked_from_project_id" uuid,
	"published_at" timestamp,
	"last_opened" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	"sandbox_template" text,
	"last_sandbox_activity_at" timestamp,
	"became_reapable_at" timestamp,
	"reap_stage" text DEFAULT 'active' NOT NULL,
	"last_reap_warning_sent_at" timestamp,
	"convex_calls_last_30d" bigint,
	"convex_calls_checked_at" timestamp,
	"stripe_test_account_id" text,
	"stripe_live_account_id" text,
	"stripe_payment_mode" text DEFAULT 'test' NOT NULL,
	"stripe_enabled" boolean DEFAULT false NOT NULL,
	"stripe_webhook_secret" text,
	"revenuecat_status" text DEFAULT 'none' NOT NULL,
	"revenuecat_project_id" text,
	"revenuecat_webhook_secret" text,
	"revenuecat_environment" text DEFAULT 'sandbox' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revenuecat_webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_connect_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"mode" text NOT NULL,
	"state" text NOT NULL,
	"authorize_url" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "stripe_webhook_endpoints" (
	"mode" text PRIMARY KEY NOT NULL,
	"endpoint_id" text NOT NULL,
	"secret" text NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"period" text NOT NULL,
	"model" text NOT NULL,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"cached_tokens_read" bigint DEFAULT 0 NOT NULL,
	"cached_tokens_write" bigint DEFAULT 0 NOT NULL,
	"credits" bigint DEFAULT 0 NOT NULL,
	"agent_turns" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"apex_domain" text NOT NULL,
	"cf_zone_id" text,
	"status" text DEFAULT 'pending_ns' NOT NULL,
	"nameservers" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_revenuecat_identity" (
	"user_id" text PRIMARY KEY NOT NULL,
	"rc_secret_key" text,
	"rc_public_sdk_key" text,
	"rc_project_id" text,
	"rc_inbound_webhook_secret" text,
	"asc_issuer_id" text,
	"asc_key_id" text,
	"asc_private_key_p8" text,
	"connected_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"openai_api_key" text,
	"anthropic_api_key" text,
	"moonshot_api_key" text,
	"fireworks_api_key" text,
	"google_api_key" text,
	"claude_oauth_access_token" text,
	"claude_oauth_refresh_token" text,
	"claude_oauth_expires_at" bigint,
	"codex_oauth_access_token" text,
	"codex_oauth_refresh_token" text,
	"codex_oauth_expires_at" bigint,
	"codex_oauth_account_id" text,
	"github_access_token" text,
	"github_username" text,
	"github_avatar_url" text,
	"convex_oauth_access_token" text,
	"convex_oauth_refresh_token" text,
	"convex_oauth_expires_at" bigint,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_stripe_identity" (
	"user_id" text PRIMARY KEY NOT NULL,
	"default_email" text,
	"default_country" text,
	"legal_entity_type" text,
	"last_live_account_id" text,
	"test_account_id" text,
	"live_account_id" text,
	"test_publishable_key" text,
	"live_publishable_key" text,
	"connected_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_images" ADD CONSTRAINT "chat_images_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_questions" ADD CONSTRAINT "chat_questions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_dns_records" ADD CONSTRAINT "domain_dns_records_domain_id_user_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."user_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "env_var_requests" ADD CONSTRAINT "env_var_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_provider_requests" ADD CONSTRAINT "oauth_provider_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_git_commits" ADD CONSTRAINT "pending_git_commits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_assets" ADD CONSTRAINT "project_assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_env_vars" ADD CONSTRAINT "project_env_vars_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_stars" ADD CONSTRAINT "project_stars_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_sync_manifests" ADD CONSTRAINT "project_sync_manifests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_connect_requests" ADD CONSTRAINT "stripe_connect_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_oauth_states" ADD CONSTRAINT "stripe_oauth_states_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_images_project_id_idx" ON "chat_images" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_session_message_unique" ON "chat_messages" USING btree ("session_id","message_id");--> statement-breakpoint
CREATE INDEX "chat_messages_session_segment_idx" ON "chat_messages" USING btree ("session_id","segment_id");--> statement-breakpoint
CREATE INDEX "chat_questions_project_id_idx" ON "chat_questions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "chat_questions_tool_call_id_idx" ON "chat_questions" USING btree ("tool_call_id");--> statement-breakpoint
CREATE INDEX "domain_dns_records_domain_id_idx" ON "domain_dns_records" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "env_var_requests_project_id_idx" ON "env_var_requests" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "oauth_provider_requests_project_id_idx" ON "oauth_provider_requests" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "pending_git_commits_project_id_idx" ON "pending_git_commits" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_assets_project_path_unique" ON "project_assets" USING btree ("project_id","path");--> statement-breakpoint
CREATE INDEX "project_assets_project_id_idx" ON "project_assets" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_env_vars_project_key_unique" ON "project_env_vars" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "project_env_vars_project_id_idx" ON "project_env_vars" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_files_project_path_unique" ON "project_files" USING btree ("project_id","path");--> statement-breakpoint
CREATE INDEX "project_files_project_id_idx" ON "project_files" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_files_hash_idx" ON "project_files" USING btree ("hash");--> statement-breakpoint
CREATE UNIQUE INDEX "project_stars_project_user_unique" ON "project_stars" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "project_stars_project_id_idx" ON "project_stars" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_stars_user_id_idx" ON "project_stars" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_sync_manifests_project_unique" ON "project_sync_manifests" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_sync_manifests_project_id_idx" ON "project_sync_manifests" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "projects_stripe_test_account_id_idx" ON "projects" USING btree ("stripe_test_account_id");--> statement-breakpoint
CREATE INDEX "projects_stripe_live_account_id_idx" ON "projects" USING btree ("stripe_live_account_id");--> statement-breakpoint
CREATE INDEX "projects_became_reapable_at_idx" ON "projects" USING btree ("became_reapable_at");--> statement-breakpoint
CREATE INDEX "projects_is_public_idx" ON "projects" USING btree ("is_public");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_public_slug_unique" ON "projects" USING btree ("public_slug");--> statement-breakpoint
CREATE INDEX "projects_reap_stage_idx" ON "projects" USING btree ("reap_stage");--> statement-breakpoint
CREATE INDEX "projects_star_count_idx" ON "projects" USING btree ("star_count");--> statement-breakpoint
CREATE INDEX "stripe_connect_requests_project_id_idx" ON "stripe_connect_requests" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "stripe_connect_requests_state_idx" ON "stripe_connect_requests" USING btree ("state");--> statement-breakpoint
CREATE INDEX "stripe_oauth_states_expires_at_idx" ON "stripe_oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_records_user_period_model_unique" ON "usage_records" USING btree ("user_id","period","model");--> statement-breakpoint
CREATE INDEX "usage_records_user_id_idx" ON "usage_records" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "usage_records_period_idx" ON "usage_records" USING btree ("period");--> statement-breakpoint
CREATE UNIQUE INDEX "user_domains_user_apex_unique" ON "user_domains" USING btree ("user_id","apex_domain");--> statement-breakpoint
CREATE INDEX "user_domains_user_id_idx" ON "user_domains" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_settings_user_unique" ON "user_settings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_stripe_identity_test_account_id_idx" ON "user_stripe_identity" USING btree ("test_account_id");--> statement-breakpoint
CREATE INDEX "user_stripe_identity_live_account_id_idx" ON "user_stripe_identity" USING btree ("live_account_id");