import { pgTable, uuid, timestamp, text, jsonb, integer, bigint, uniqueIndex, index, boolean } from 'drizzle-orm/pg-core';

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  userId: text('user_id').notNull(), // Clerk user id
  platform: text('platform').notNull().default('web'), // 'web' | 'swift' | 'sandboxed-web' | 'mobile' | 'multiplatform'
  // Which agent backend drives this project: 'botflow' (our agent) or
  // 'claude-code' (Anthropic's Claude Code subprocess). Sticky per project.
  agentBackend: text('agent_backend').notNull().default('botflow'),
  // The active conversation segment. When a user switches agent backends we
  // mint a new uuid here so the new agent reads a clean slate (older messages
  // stay in the DB under their old segment_id for UI display).
  currentSegmentId: uuid('current_segment_id'),
  // Preferred model for this project: 'gpt-5.3-codex' | 'gpt-5.4' | 'gpt-5.5' | 'claude-sonnet-4-6' | 'claude-opus-4-8' | 'claude-fable-5' | 'fireworks-minimax-m2p7' | 'fireworks-glm-5p1' | 'fireworks-kimi-k2p6' | 'gemini-3.1-pro-preview'
  model: text('model').notNull().default('fireworks-kimi-k2p6'),
  // Snapshot URLs for project thumbnails and HTML captures
  thumbnailUrl: text('thumbnail_url'),
  htmlSnapshotUrl: text('html_snapshot_url'),
  // UploadThing file keys for deletion (format: "fileKey" from uploadthing)
  thumbnailKey: text('thumbnail_key'),
  htmlSnapshotKey: text('html_snapshot_key'),
  // Convex backend integration (for web and multiplatform projects)
  convexProjectId: text('convex_project_id'),       // Convex platform project ID
  convexDeploymentId: text('convex_deployment_id'), // Deployment name (e.g., "happy-otter-123")
  convexDeployUrl: text('convex_deploy_url'),       // VITE_CONVEX_URL value
  convexDeployKey: text('convex_deploy_key'),       // Deploy key for pushing functions
  // GitHub repository integration
  githubRepoOwner: text('github_repo_owner'),         // GitHub username or org
  githubRepoName: text('github_repo_name'),           // Repository name
  githubDefaultBranch: text('github_default_branch').default('main'), // Default branch
  githubLastPushedSha: text('github_last_pushed_sha'), // Last commit SHA pushed to GitHub (webcontainer flow)
  // Sandbox GitHub flow: 'autonomous' | 'manual' | 'ask-each-time'. Null = the agent
  // hasn't yet asked the user how they want commits handled. Drives whether
  // git_* tool descriptions instruct the agent to commit/push on its own.
  gitAutonomy: text('git_autonomy'),
  // User-managed Convex backend (BYO Convex)
  userConvexUrl: text('user_convex_url'),
  userConvexDeployKey: text('user_convex_deploy_key'),
  backendType: text('backend_type').notNull().default('platform'), // 'platform' | 'user' | 'none'
  // Cloudflare Pages deployment
  cloudflareProjectName: text('cloudflare_project_name'),
  cloudflareDeploymentUrl: text('cloudflare_deployment_url'),
  // User custom domain (Pro/Max only) — legacy CNAME approach (webcontainer flow)
  customDomain: text('custom_domain'),
  customDomainStatus: text('custom_domain_status'), // 'pending' | 'active' | 'error'
  // Managed domain assignment (Pro/Max) — new approach where Botflow controls the CF zone
  managedDomainId: uuid('managed_domain_id'),
  managedDomainHostname: text('managed_domain_hostname'), // e.g. "www.myapp.com"
  // Convex Auth — set to true after setupAuth runs successfully
  authConfigured: boolean('auth_configured').notNull().default(false),
  // Public sharing — a project can only be public if it is deployed (Cloudflare
  // Pages). On a public deploy we tar the project source (no node_modules) and
  // store it in UploadThing; the read-only public viewer + "use as template"
  // fork both read from this bundle. Cleared (and the UT object deleted) when
  // the project is made private.
  isPublic: boolean('is_public').notNull().default(false),
  publicSlug: text('public_slug'), // human-readable unique URL slug, nullable
  publicDescription: text('public_description'), // optional short description shown on showcase
  publicSourceUrl: text('public_source_url'),     // UploadThing URL of the source bundle (.tar.gz)
  publicSourceKey: text('public_source_key'),     // UploadThing key, for deletion on unpublish/replace
  // Transient: when set, the project's sandbox seeds by extracting this bundle
  // (a forked public project's source) on first boot instead of cloning a
  // template. Cleared once the seed runs.
  seedBundleUrl: text('seed_bundle_url'),
  starCount: integer('star_count').notNull().default(0),
  forkedFromProjectId: uuid('forked_from_project_id'),
  publishedAt: timestamp('published_at'),
  lastOpened: timestamp('last_opened').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  // Soft delete — null means active. Set for Pro/Max users on delete; Free = immediate hard delete.
  deletedAt: timestamp('deleted_at'),
  // ─── Reaper / lifecycle fields ────────────────────────────────────────────
  // Which template seeds this project's sandbox if it ever needs to be recreated
  // empty after a true 404 from Vercel. 'swift' | 'viteConvex' | 'vite' | null.
  // Null means "don't auto-reseed" (preserves prior behavior for legacy rows).
  sandboxTemplate: text('sandbox_template'),
  // Last time anything ran a command against this project's Vercel sandbox.
  // Drives the reaper's "authoring idle" clock. Distinct from lastOpened, which
  // tracks UI session opens (cheaper to update).
  lastSandboxActivityAt: timestamp('last_sandbox_activity_at'),
  // Set when the project's owner is on the free tier (after a paid → free
  // downgrade, or at project creation if owner was free). Reaper's idle clock
  // = max(lastSandboxActivityAt, becameReapableAt). Cleared on upgrade.
  becameReapableAt: timestamp('became_reapable_at'),
  // Reap state machine. See src/lib/reaper/policy.ts.
  // 'active' | 'warned_90d' | 'warned_104d' | 'archived' | 'deleted'
  reapStage: text('reap_stage').notNull().default('active'),
  lastReapWarningSentAt: timestamp('last_reap_warning_sent_at'),
  // Liveness signal for managed-Convex projects: function-call count over the
  // last 30 days, refreshed by the reaper before deciding to act.
  convexCallsLast30d: bigint('convex_calls_last_30d', { mode: 'number' }),
  convexCallsCheckedAt: timestamp('convex_calls_checked_at'),
  // ─── Stripe Connect (Express) ─────────────────────────────────────────────
  // See drizzle/0017_add_stripe_integration.sql + src/lib/stripe.ts.
  // Each project is one Express connected account per mode. Test account is
  // created silently on initializeStripePayments; live account is created
  // lazily on first Live-toggle and runs through Stripe-hosted KYC.
  stripeTestAccountId: text('stripe_test_account_id'),
  stripeLiveAccountId: text('stripe_live_account_id'),
  stripePaymentMode: text('stripe_payment_mode').notNull().default('test'), // 'test' | 'live'
  stripeEnabled: boolean('stripe_enabled').notNull().default(false),
  // Per-project HMAC used when the platform forwards normalized webhook
  // events into the project's Convex HTTP endpoint. Generated at init.
  stripeWebhookSecret: text('stripe_webhook_secret'),
  // ─── RevenueCat (iOS in-app purchases) ────────────────────────────────────
  // See drizzle/0023_add_revenuecat_integration.sql + src/lib/revenuecat.ts.
  // BYO model: the user links their own RevenueCat account; we provision
  // products/entitlements via their secret key and read entitlement state via
  // webhooks. The payments tab hosts the entire connection flow (no modal):
  //   'none'       — not set up
  //   'connecting' — the agent enabled it; the tab is showing the setup wizard
  //   'connected'  — keys verified; the tab shows the link-out dashboard page
  revenuecatStatus: text('revenuecat_status').notNull().default('none'),
  revenuecatProjectId: text('revenuecat_project_id'),
  // Per-project HMAC for the Botflow→Convex webhook fan-out (mirrors
  // stripeWebhookSecret). Generated when the project is enabled.
  revenuecatWebhookSecret: text('revenuecat_webhook_secret'),
  revenuecatEnvironment: text('revenuecat_environment').notNull().default('sandbox'), // 'sandbox' | 'production'
}, (t) => ({
  stripeTestAccountIdIdx: index('projects_stripe_test_account_id_idx').on(t.stripeTestAccountId),
  stripeLiveAccountIdIdx: index('projects_stripe_live_account_id_idx').on(t.stripeLiveAccountId),
}));

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

// Project stars — join table for public project stars
export const projectStars = pgTable('project_stars', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(), // Clerk user id of the starrer
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  projectUserUnique: uniqueIndex('project_stars_project_user_unique').on(t.projectId, t.userId),
  projectIdIdx: index('project_stars_project_id_idx').on(t.projectId),
  userIdIdx: index('project_stars_user_id_idx').on(t.userId),
}));

export type ProjectStar = typeof projectStars.$inferSelect;
export type NewProjectStar = typeof projectStars.$inferInsert;

// Chat session per project (one active session per project)
export const chatSessions = pgTable('chat_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Store all messages as JSON to preserve all parts (tool-calls, data, etc.)
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull().references(() => chatSessions.id, { onDelete: 'cascade' }),
    // Original message id from the client/useChat to dedupe
    messageId: text('message_id').notNull(),
    role: text('role').notNull(),
    content: jsonb('content').notNull(),
    // Conversation segment this message belongs to. Nullable for pre-migration
    // rows but backfilled to projects.current_segment_id. New messages always
    // get stamped with the project's current_segment_id at insert.
    segmentId: uuid('segment_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    sessionMessageUnique: uniqueIndex('chat_messages_session_message_unique').on(t.sessionId, t.messageId),
    sessionSegmentIdx: index('chat_messages_session_segment_idx').on(t.sessionId, t.segmentId),
  })
);

export type ChatSession = typeof chatSessions.$inferSelect;
export type NewChatSession = typeof chatSessions.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;

// Per-user API key storage (BYOK)
export const userSettings = pgTable('user_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(), // Clerk user id
  openaiApiKey: text('openai_api_key'),
  anthropicApiKey: text('anthropic_api_key'),
  moonshotApiKey: text('moonshot_api_key'),
  fireworksApiKey: text('fireworks_api_key'),
  googleApiKey: text('google_api_key'),
  // Claude Code OAuth (takes priority over anthropicApiKey for Anthropic models)
  claudeOAuthAccessToken: text('claude_oauth_access_token'),
  claudeOAuthRefreshToken: text('claude_oauth_refresh_token'),
  claudeOAuthExpiresAt: bigint('claude_oauth_expires_at', { mode: 'number' }), // Unix ms
  // ChatGPT Codex OAuth
  codexOAuthAccessToken: text('codex_oauth_access_token'),
  codexOAuthRefreshToken: text('codex_oauth_refresh_token'),
  codexOAuthExpiresAt: bigint('codex_oauth_expires_at', { mode: 'number' }),
  codexOAuthAccountId: text('codex_oauth_account_id'),
  // GitHub OAuth
  githubAccessToken: text('github_access_token'),
  githubUsername: text('github_username'),
  githubAvatarUrl: text('github_avatar_url'),
  // Convex OAuth
  convexOAuthAccessToken: text('convex_oauth_access_token'),
  convexOAuthRefreshToken: text('convex_oauth_refresh_token'),
  convexOAuthExpiresAt: bigint('convex_oauth_expires_at', { mode: 'number' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  userUnique: uniqueIndex('user_settings_user_unique').on(t.userId),
}));

export type UserSettings = typeof userSettings.$inferSelect;
export type NewUserSettings = typeof userSettings.$inferInsert;

// Cloud backup tables for project files
export const projectFiles = pgTable('project_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  content: text('content').notNull(),
  hash: text('hash').notNull(),
  size: integer('size').notNull(),
  mimeType: text('mime_type'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  projectPathUnique: uniqueIndex('project_files_project_path_unique').on(t.projectId, t.path),
  projectIdIdx: index('project_files_project_id_idx').on(t.projectId),
  hashIdx: index('project_files_hash_idx').on(t.hash),
}));

export type ProjectFile = typeof projectFiles.$inferSelect;
export type NewProjectFile = typeof projectFiles.$inferInsert;

export const projectAssets = pgTable('project_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  uploadThingUrl: text('upload_thing_url').notNull(),
  uploadThingKey: text('upload_thing_key').notNull(),
  hash: text('hash').notNull(),
  size: integer('size').notNull(),
  mimeType: text('mime_type'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  projectPathUnique: uniqueIndex('project_assets_project_path_unique').on(t.projectId, t.path),
  projectIdIdx: index('project_assets_project_id_idx').on(t.projectId),
}));

export type ProjectAsset = typeof projectAssets.$inferSelect;
export type NewProjectAsset = typeof projectAssets.$inferInsert;

export const projectSyncManifests = pgTable('project_sync_manifests', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  fileManifest: jsonb('file_manifest').notNull(),
  totalFiles: integer('total_files').notNull().default(0),
  totalSize: bigint('total_size', { mode: 'number' }).notNull().default(0),
  lastSyncAt: timestamp('last_sync_at').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  projectUnique: uniqueIndex('project_sync_manifests_project_unique').on(t.projectId),
  projectIdIdx: index('project_sync_manifests_project_id_idx').on(t.projectId),
}));

export type ProjectSyncManifest = typeof projectSyncManifests.$inferSelect;
export type NewProjectSyncManifest = typeof projectSyncManifests.$inferInsert;

// Project environment variables (user-defined, stored in database)
export const projectEnvVars = pgTable('project_env_vars', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),           // Variable name (e.g., "API_KEY")
  value: text('value').notNull(),       // Variable value
  isSecret: boolean('is_secret').notNull().default(false), // Flag for sensitive values (masked in UI)
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  projectKeyUnique: uniqueIndex('project_env_vars_project_key_unique').on(t.projectId, t.key),
  projectIdIdx: index('project_env_vars_project_id_idx').on(t.projectId),
}));

export type ProjectEnvVar = typeof projectEnvVars.$inferSelect;
export type NewProjectEnvVar = typeof projectEnvVars.$inferInsert;

// Pending git commits: committed locally, not yet pushed to GitHub
export const pendingGitCommits = pgTable('pending_git_commits', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  message: text('message').notNull(),
  // Snapshot of changed files at commit time: { path: content (text) | null (deleted) }
  filesSnapshot: jsonb('files_snapshot').notNull().$type<Record<string, string | null>>(),
  // SHA of the tree before this commit (from lastPushedSha at commit time)
  baseSha: text('base_sha'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  projectIdIdx: index('pending_git_commits_project_id_idx').on(t.projectId),
}));

export type PendingGitCommit = typeof pendingGitCommits.$inferSelect;
export type NewPendingGitCommit = typeof pendingGitCommits.$inferInsert;

// Chat images: files attached to chat messages, stored in UploadThing
export const chatImages = pgTable('chat_images', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  uploadThingUrl: text('upload_thing_url').notNull(),
  uploadThingKey: text('upload_thing_key').notNull(),
  filename: text('filename'),
  size: integer('size'),
  mediaType: text('media_type'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  projectIdIdx: index('chat_images_project_id_idx').on(t.projectId),
}));

export type ChatImage = typeof chatImages.$inferSelect;
export type NewChatImage = typeof chatImages.$inferInsert;

// OAuth provider credential requests — created by the agent's setupOAuthProvider
// tool call; resolved when the user fills in the modal in the workspace UI.
export const oauthProviderRequests = pgTable('oauth_provider_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  /** Which OAuth provider to configure. Currently only 'google'. */
  provider: text('provider').notNull(),
  /** 'pending' → modal is open. 'completed' → credentials saved. 'dismissed' → user cancelled. */
  status: text('status').notNull().default('pending'),
  /** The .convex.site URL shown to the user in the modal as the redirect URI. */
  convexSiteUrl: text('convex_site_url'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  projectIdIdx: index('oauth_provider_requests_project_id_idx').on(t.projectId),
}));

export type OAuthProviderRequest = typeof oauthProviderRequests.$inferSelect;
export type NewOAuthProviderRequest = typeof oauthProviderRequests.$inferInsert;

// Env-var entry requests — created by the agent's requestEnvVar tool call;
// resolved when the user enters the value in the workspace modal. The agent
// picks the variable NAME and target; only the VALUE comes from the user, and
// it never flows back through the agent (it's written straight to the Vite
// .env / Convex deployment server-side).
export const envVarRequests = pgTable('env_var_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  /** 'client' → frontend Vite .env (project_env_vars). 'server' → Convex deployment env. */
  target: text('target').notNull(),
  /** Variable name chosen by the agent, shown read-only in the modal. */
  key: text('key').notNull(),
  /** Optional agent-authored explanation rendered in the modal. */
  message: text('message'),
  /** Whether the value should be stored/displayed as a secret (client target only). */
  isSecret: boolean('is_secret').notNull().default(false),
  /** 'pending' → modal is open. 'completed' → value saved. 'dismissed' → user cancelled. */
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  projectIdIdx: index('env_var_requests_project_id_idx').on(t.projectId),
}));

export type EnvVarRequest = typeof envVarRequests.$inferSelect;
export type NewEnvVarRequest = typeof envVarRequests.$inferInsert;

// In-chat questions surfaced by the agent (via the askQuestion tool) and
// resolved by the user clicking an option in the agent panel. Used as the
// async-handshake channel for the Claude Code bridge path; the Botflow path
// resolves the tool client-side via addToolOutput and doesn't depend on this
// table, but writes to it for cross-agent visibility.
export const chatQuestions = pgTable('chat_questions', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  /** Identifier of the conversation segment this question belongs to. */
  segmentId: uuid('segment_id'),
  /** Identifier supplied by the agent's tool call so the bridge can match the answer back. */
  toolCallId: text('tool_call_id').notNull(),
  /** Array of UserInputQuestion objects: { id, header, question, options[], multiSelect? }. */
  questions: jsonb('questions').notNull(),
  /** 'pending' → not yet answered. 'answered' → user picked. 'dismissed' → user skipped or agent stopped. */
  status: text('status').notNull().default('pending'),
  /** User's answer: { questionId: { selectedIds[], text? } } once status === 'answered'. */
  answer: jsonb('answer'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  projectIdIdx: index('chat_questions_project_id_idx').on(t.projectId),
  toolCallIdIdx: index('chat_questions_tool_call_id_idx').on(t.toolCallId),
}));

export type ChatQuestion = typeof chatQuestions.$inferSelect;
export type NewChatQuestion = typeof chatQuestions.$inferInsert;

// Usage tracking for subscription tier enforcement
// One row per (userId, period, model) — upserted on every agent call completion
export const usageRecords = pgTable('usage_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(),
  // Billing period in YYYY-MM format, e.g. "2026-03"
  period: text('period').notNull(),
  // Model id as used in MODEL_CONFIGS, e.g. "claude-sonnet-4-6"
  model: text('model').notNull(),
  tokensIn: bigint('tokens_in', { mode: 'number' }).notNull().default(0),
  tokensOut: bigint('tokens_out', { mode: 'number' }).notNull().default(0),
  // Prompt cache: tokens served from cache (cheaper) and tokens written to cache
  cachedTokensRead: bigint('cached_tokens_read', { mode: 'number' }).notNull().default(0),
  cachedTokensWrite: bigint('cached_tokens_write', { mode: 'number' }).notNull().default(0),
  // Credits consumed (MiniMax-equivalent tokens) — computed from raw tokens × model multiplier
  credits: bigint('credits', { mode: 'number' }).notNull().default(0),
  // Cumulative agent turns in this period (all models combined tracked separately)
  agentTurns: integer('agent_turns').notNull().default(0),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  userPeriodModelUnique: uniqueIndex('usage_records_user_period_model_unique').on(t.userId, t.period, t.model),
  userIdIdx: index('usage_records_user_id_idx').on(t.userId),
  periodIdx: index('usage_records_period_idx').on(t.period),
}));

export type UsageRecord = typeof usageRecords.$inferSelect;
export type NewUsageRecord = typeof usageRecords.$inferInsert;

// ─── Managed Domains ────────────────────────────────────────────────────────
// Domains the user has transferred to Botflow's Cloudflare account.
// Botflow controls the zone (NS records point at CF) and we expose DNS record
// management. Pro/Max only.
export const userDomains = pgTable('user_domains', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(),                    // Clerk user id
  apexDomain: text('apex_domain').notNull(),            // e.g. "myapp.com"
  cfZoneId: text('cf_zone_id'),                         // Cloudflare zone id
  status: text('status').notNull().default('pending_ns'), // 'pending_ns' | 'active' | 'error'
  nameservers: jsonb('nameservers').$type<string[]>(),  // CF nameservers user needs to set
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  userApexUnique: uniqueIndex('user_domains_user_apex_unique').on(t.userId, t.apexDomain),
  userIdIdx: index('user_domains_user_id_idx').on(t.userId),
}));

export type UserDomain = typeof userDomains.$inferSelect;
export type NewUserDomain = typeof userDomains.$inferInsert;

// Individual DNS records within a managed domain's zone. Cached locally for
// fast list views; CF remains the source of truth on writes.
export const domainDnsRecords = pgTable('domain_dns_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  domainId: uuid('domain_id').notNull().references(() => userDomains.id, { onDelete: 'cascade' }),
  cfRecordId: text('cf_record_id'),
  type: text('type').notNull(),       // 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS'
  name: text('name').notNull(),       // e.g. "www", "@", "mail"
  content: text('content').notNull(),
  ttl: integer('ttl').notNull().default(1), // 1 = auto
  priority: integer('priority'),
  proxied: boolean('proxied').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  domainIdIdx: index('domain_dns_records_domain_id_idx').on(t.domainId),
}));

export type DomainDnsRecord = typeof domainDnsRecords.$inferSelect;
export type NewDomainDnsRecord = typeof domainDnsRecords.$inferInsert;

// ─── Stripe Connect ──────────────────────────────────────────────────────────

// One row per Botflow user; drives prefill when creating their 2nd+ live
// Express account so Stripe recognizes the identity and skips re-verification.
// See drizzle/0017_add_stripe_integration.sql.
export const userStripeIdentity = pgTable('user_stripe_identity', {
  userId: text('user_id').primaryKey(),
  defaultEmail: text('default_email'),
  defaultCountry: text('default_country'),
  legalEntityType: text('legal_entity_type'), // 'individual' | 'company' | null
  lastLiveAccountId: text('last_live_account_id'),
  // OAuth-connected Stripe accounts (Standard Connect). One Botflow user
  // links their Stripe account once and reuses it across every project.
  testAccountId: text('test_account_id'),
  liveAccountId: text('live_account_id'),
  testPublishableKey: text('test_publishable_key'),
  livePublishableKey: text('live_publishable_key'),
  connectedAt: timestamp('connected_at'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  testAccountIdIdx: index('user_stripe_identity_test_account_id_idx').on(t.testAccountId),
  liveAccountIdIdx: index('user_stripe_identity_live_account_id_idx').on(t.liveAccountId),
}));

// Short-lived state tokens for the Stripe OAuth flow. CSRF prevention + binds
// the redirect callback back to the user/project/mode that started it.
export const stripeOauthStates = pgTable('stripe_oauth_states', {
  state: text('state').primaryKey(),
  userId: text('user_id').notNull(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  mode: text('mode').notNull(), // 'test' | 'live'
  createdAt: timestamp('created_at').defaultNow().notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  consumedAt: timestamp('consumed_at'),
}, (t) => ({
  expiresAtIdx: index('stripe_oauth_states_expires_at_idx').on(t.expiresAt),
}));

export type StripeOauthState = typeof stripeOauthStates.$inferSelect;
export type NewStripeOauthState = typeof stripeOauthStates.$inferInsert;

// Agent-triggered Stripe Connect modal requests. Mirrors oauthProviderRequests
// shape: agent creates pending row + polls; workspace UI polls + renders modal;
// OAuth callback flips status to 'completed' once Stripe redirects back.
export const stripeConnectRequests = pgTable('stripe_connect_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  mode: text('mode').notNull(), // 'test' | 'live'
  state: text('state').notNull(),
  authorizeUrl: text('authorize_url').notNull(),
  status: text('status').notNull().default('pending'), // 'pending' | 'completed' | 'dismissed'
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  projectIdIdx: index('stripe_connect_requests_project_id_idx').on(t.projectId),
  stateIdx: index('stripe_connect_requests_state_idx').on(t.state),
}));

export type StripeConnectRequest = typeof stripeConnectRequests.$inferSelect;
export type NewStripeConnectRequest = typeof stripeConnectRequests.$inferInsert;

export type UserStripeIdentity = typeof userStripeIdentity.$inferSelect;
export type NewUserStripeIdentity = typeof userStripeIdentity.$inferInsert;

// Dedupe table for inbound Stripe webhook events. SETNX on event.id makes the
// handler side-effect-once across Stripe's 3-day retry window.
export const stripeWebhookEvents = pgTable('stripe_webhook_events', {
  eventId: text('event_id').primaryKey(),
  receivedAt: timestamp('received_at').defaultNow().notNull(),
});

export type StripeWebhookEvent = typeof stripeWebhookEvents.$inferSelect;
export type NewStripeWebhookEvent = typeof stripeWebhookEvents.$inferInsert;

// Platform-managed Stripe Connect webhook endpoints, provisioned via the Stripe
// API (one per mode) so delivery never depends on a hand-configured dashboard
// webhook. Stripe only returns the signing secret at creation time, so we store
// it here for the inbound webhook receiver to verify against.
export const stripeWebhookEndpoints = pgTable('stripe_webhook_endpoints', {
  mode: text('mode').primaryKey(), // 'test' | 'live'
  endpointId: text('endpoint_id').notNull(),
  secret: text('secret').notNull(),
  url: text('url').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type StripeWebhookEndpoint = typeof stripeWebhookEndpoints.$inferSelect;
export type NewStripeWebhookEndpoint = typeof stripeWebhookEndpoints.$inferInsert;

// ─── RevenueCat (iOS in-app purchases) ─────────────────────────────────────────

// One row per Botflow user. BYO model: the user links their own RevenueCat
// account once and reuses it across their iOS apps (mirrors how one Stripe
// account is reused across projects). Bearer secrets (RevenueCat secret key,
// Apple .p8) are encrypted at rest via src/lib/secrets.ts.
// See drizzle/0023_add_revenuecat_integration.sql.
export const userRevenueCatIdentity = pgTable('user_revenuecat_identity', {
  userId: text('user_id').primaryKey(),
  // RevenueCat credentials.
  rcSecretKey: text('rc_secret_key'), // encrypted — server-side v2 API key (sk_...)
  rcPublicSdkKey: text('rc_public_sdk_key'), // public app-specific SDK key (appl_...)
  rcProjectId: text('rc_project_id'), // the RevenueCat project id (proj...)
  // The Authorization header value we expect inbound RevenueCat webhooks to
  // carry (the user pastes this into their RevenueCat dashboard).
  rcInboundWebhookSecret: text('rc_inbound_webhook_secret'),
  // Apple App Store Connect API key — reused for distribution + IAP product
  // creation, and uploaded by the user to RevenueCat for receipt validation.
  ascIssuerId: text('asc_issuer_id'),
  ascKeyId: text('asc_key_id'),
  ascPrivateKeyP8: text('asc_private_key_p8'), // encrypted
  connectedAt: timestamp('connected_at'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type UserRevenueCatIdentity = typeof userRevenueCatIdentity.$inferSelect;
export type NewUserRevenueCatIdentity = typeof userRevenueCatIdentity.$inferInsert;

// Dedupe table for inbound RevenueCat webhook events. RevenueCat retries up to
// 5 times; primary-key conflict on the event id makes the handler idempotent.
export const revenueCatWebhookEvents = pgTable('revenuecat_webhook_events', {
  eventId: text('event_id').primaryKey(),
  receivedAt: timestamp('received_at').defaultNow().notNull(),
});

export type RevenueCatWebhookEvent = typeof revenueCatWebhookEvents.$inferSelect;
export type NewRevenueCatWebhookEvent = typeof revenueCatWebhookEvents.$inferInsert;
