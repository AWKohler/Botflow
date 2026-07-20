/**
 * Shared `setupOAuthProvider` agent tool — used by both the sandboxed-web
 * agent and the Swift (persistent sandbox) agent.
 *
 * The request/poll machinery is identical on both rails: create (or reuse) a
 * pending row in oauth_provider_requests, let the workspace modal collect the
 * credentials, and block-poll until completed/dismissed/timeout. Only the
 * agent-facing guidance differs:
 *   • web   — after success the agent wires a React sign-in button via the
 *             preview-iframe-safe helpers in @/lib/botflowAuth.
 *   • swift — there is NO client work: the hosted in-app-browser sign-in page
 *             (convex/http.ts) renders the provider button automatically once
 *             the env vars are live and auth.ts is deployed.
 */
import { tool } from "ai";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { getDb } from "@/db";
import { projects, oauthProviderRequests } from "@/db/schema";
import {
  OAUTH_PROVIDER_IDS,
  getOAuthProvider,
  oauthProviderNameList,
  oauthProviderIdList,
  type OAuthProviderDef,
} from "@/lib/oauth-providers/registry";
import { markAgentWaiting } from "@/lib/agent/modal-wait";
import { fixAuthCookiesPackageJsonLine } from "@/lib/convex-auth-cookie-fix";

export type OAuthToolPlatform = "web" | "swift";

function buildAuthTsSnippet(def: OAuthProviderDef, platform: OAuthToolPlatform): string {
  const imp = def.authImport.default
    ? `import ${def.authImport.symbol} from "${def.authImport.from}";`
    : `import { ${def.authImport.symbol} } from "${def.authImport.from}";`;
  // Swift uses the in-app-browser flow; some providers need a Swift-specific
  // expression (e.g. prompt=select_account so silent re-auth bounces — which
  // drop the OAuth cookies in WebKit — never happen). See registry.ts.
  const expr =
    platform === "swift" ? (def.swiftProviderExpr ?? def.providerExpr) : def.providerExpr;
  return `   import { convexAuth } from "@convex-dev/auth/server";
   import { Password } from "@convex-dev/auth/providers/Password";
   ${imp}

   export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
     // ADD ${def.authImport.symbol} to the existing providers array — keep Password and any
     // previously registered providers exactly as they are.
     providers: [Password, ${expr}],
     // keep the existing callbacks.redirect block intact
   });`;
}

/**
 * Post-success guidance for the agent. Exported because the in-sandbox rails
 * (Claude Code / OpenCode) execute this tool via /api/internal/claude-code-tool
 * rather than the ai-sdk tool above — both must return the same instructions.
 */
export function buildOAuthProviderSuccessContext(
  platform: OAuthToolPlatform,
  provider: string,
  def: OAuthProviderDef,
  /** Rail-specific tool names — the CC/OpenCode MCP rails use snake_case. */
  toolNames?: { deploy?: string; setupAuth?: string; setupOAuth?: string; logs?: string },
): string {
  const deployTool = toolNames?.deploy ?? "convexDeploy";
  const setupAuthTool = toolNames?.setupAuth ?? "setupAuth";
  const setupOAuthTool = toolNames?.setupOAuth ?? "setupOAuthProvider";
  const header = `=== ${def.displayName.toUpperCase()} OAUTH CREDENTIALS SAVED ===

${def.envVars.join(", ")} now set on your Convex deployment.

REQUIRED NEXT STEPS:

1. Update convex/auth.ts — register the provider with the EXACT expression below
   (do not simplify it: where it includes a custom profile() mapping — Apple —
   that mapping is REQUIRED; the provider's default returns image: null, which
   the authTables users schema rejects and every first sign-in fails. Secrets
   such as the Microsoft issuer or Apple client secret are read from env
   automatically; never inline credentials):

${buildAuthTsSnippet(def, platform)}

2. Run ${deployTool} to push the updated auth config.
`;

  if (platform === "web") {
    const logsTool = toolNames?.logs ?? "getConvexLogs";
    const appleNote =
      provider === "apple"
        ? "\n\nAPPLE NOTE: the user's name/email are returned ONLY on the first sign-in — capture them then. Apple can't be tested on localhost; use the deployed preview."
        : "";
    return (
      header +
      `
3. Add a sign-in button using the preview-safe helper (NOT signIn("${provider}") directly):

   import { useAuthActions } from "@convex-dev/auth/react";
   import { startOAuthSignIn } from "@/lib/botflowAuth";

   const { signIn } = useAuthActions();
   <button onClick={() => void startOAuthSignIn(signIn, "${provider}")}>Sign in</button>

   Also call resumePendingOAuthSignIn(signIn) once at app mount so the new-tab
   handoff resumes the flow. On return, Convex Auth creates or merges the user
   account automatically and <Authenticated> updates reactively.

4. Check package.json for the "[fix-auth-cookies]" postinstall entry that
   setup_auth prescribes (strips \`partitioned: true\` from @convex-dev/auth's
   OAuth cookies — without it, sign-in fails on mobile Safari with
   invalid_grant while desktop works). If this project predates the fix and
   the entry is missing, add it now exactly as given below, then run
   \`pnpm install\` once:

     ${fixAuthCookiesPackageJsonLine()}

5. VERIFY before declaring the provider done: you cannot complete OAuth from
   the preview iframe yourself, so after the deploy ask the user to do ONE
   test sign-in with ${def.displayName}, then immediately check ${logsTool}
   for auth errors (failures surface as auth:store / auth:signIn errors, e.g.
   schema-validation or token-exchange failures). Only report success after a
   clean test sign-in — "deployed" is not "working".` +
      appleNote
    );
  }

  // Swift: the hosted sign-in page is the whole client — no app-side work.
  const appleNudge =
    provider !== "apple"
      ? "\n\nAPP STORE NOTE (tell the user, do not force): App Store guideline 4.8 requires iOS apps that " +
        "offer third-party login (Google/GitHub/Microsoft) to ALSO offer Sign in with Apple. Recommend adding " +
        `it via ${setupOAuthTool} with provider "apple" before they submit to the App Store — but it is ` +
        "their call; proceed without it if they decline (enforcement happens at App Review, not here)."
      : "\n\nAPPLE NOTE: the user's name/email are returned ONLY on the first sign-in — capture them then.";
  return (
    header +
    `
3. That is it — do NOT write any Swift code for this. The hosted sign-in page
   (convex/http.ts) shows a "Continue with ${def.displayName}" button automatically
   once the deploy is live; the existing in-app-browser flow handles the rest.
   IMPORTANT: use the provider expression from step 1 EXACTLY as given. Where it
   includes authorization params (e.g. prompt: "select_account"), they are
   REQUIRED: without a forced interaction, a returning user's silent provider
   bounce drops the OAuth cookies in the in-app browser and repeat sign-ins fail.
   IMPORTANT: if this project's convex/http.ts predates OAuth support (no
   /auth/oauth/start route in it), call ${setupAuthTool} again to get the
   refreshed http.ts before deploying.` +
    appleNudge
  );
}

function buildDescription(platform: OAuthToolPlatform): string {
  const afterSuccess =
    platform === "web"
      ? "AFTER SUCCESS: add the provider to the convex/auth.ts providers array, run convexDeploy, and add a sign-in " +
        "button using startOAuthSignIn from @/lib/botflowAuth (NOT signIn(...) directly) so it works from the preview " +
        "iframe, plus resumePendingOAuthSignIn(signIn) once at app mount. The tool returns the exact per-provider snippet."
      : "AFTER SUCCESS: add the provider to the convex/auth.ts providers array and run convexDeploy — that is ALL. " +
        "The hosted in-app-browser sign-in page renders the provider button automatically; there is NO Swift code to " +
        "write and NO native SDK to add. The tool returns the exact per-provider snippet.\n\n" +
        "APP STORE RULE: when the user enables Google/GitHub/Microsoft, remind them that App Store guideline 4.8 " +
        "also requires Sign in with Apple in apps offering third-party login, and recommend adding it — but do NOT " +
        "force it or block on it if they decline.";
  return (
    `Add a social sign-in provider (${oauthProviderNameList()}) to Convex Auth on this project. ` +
    "Calling this tool opens a modal in the user's workspace where they register an app and paste their credentials.\n\n" +
    "ONLY call this when the user EXPLICITLY asks for social sign-in. Each provider requires them to own a " +
    "developer account and complete a console setup, so never add it proactively — default to the Password provider when auth is needed.\n\n" +
    "PREREQUISITES:\n" +
    "  • setupAuth must have been called first.\n\n" +
    "IDEMPOTENT: once the provider's credentials are saved this returns success IMMEDIATELY (no modal) with the exact " +
    "registration snippet — safe to call any time you need the wiring instructions. Pass reconfigure:true ONLY when the " +
    "user explicitly wants to REPLACE saved credentials (reopens the modal).\n\n" +
    "FLOW:\n" +
    "  1. This tool creates a pending request and the workspace shows a modal immediately.\n" +
    "  2. The user registers the app in the provider's console and pastes the credentials (Apple uploads a .p8).\n" +
    "  3. This tool waits only briefly — console setup takes the user minutes, so a 'still-pending' result is NORMAL: " +
    "the modal STAYS OPEN. Continue other work or end your turn; a system note arrives when they save, then call this " +
    "tool again for the snippet. NEVER re-call in a tight loop, and NEVER report still-pending as the user dismissing or declining.\n" +
    "  4. On success: credentials are saved server-side. You then update convex/auth.ts (using the returned snippet " +
    "EXACTLY — Apple requires its custom profile() mapping) and run convexDeploy.\n" +
    "  5. If the user explicitly DISMISSES the modal: returns an error saying so. Stop trying — do not call this again unless the user asks.\n" +
    "  6. Until this tool returns success, do NOT edit convex/auth.ts or add/expose the provider's sign-in UI.\n" +
    "  7. VERIFY before declaring done: after deploying, ask the user for one test sign-in and check getConvexLogs for auth errors.\n\n" +
    afterSuccess
  );
}

export function createSetupOAuthProviderTool(
  projectId: string,
  platform: OAuthToolPlatform,
) {
  return tool({
    description: buildDescription(platform),
    inputSchema: z.object({
      provider: z
        .enum(OAUTH_PROVIDER_IDS as [string, ...string[]])
        .describe(`Provider to add (required, no default): ${oauthProviderIdList()}.`),
      reconfigure: z
        .boolean()
        .optional()
        .describe(
          "Reopen the credentials modal even though this provider is already configured — ONLY when the user explicitly asks to replace the saved credentials.",
        ),
    }),
    async execute({ provider, reconfigure }) {
      // Direct DB access — avoids the Clerk auth problem that would arise
      // from server→server fetch calls which carry no session cookies.
      const db = getDb();

      // ── Verify project has auth configured ────────────────────────────
      const [proj] = await db
        .select({
          userId: projects.userId,
          authConfigured: projects.authConfigured,
          userConvexUrl: projects.userConvexUrl,
          convexDeployUrl: projects.convexDeployUrl,
        })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);

      if (!proj) {
        return { ok: false, error: "Project not found." };
      }
      if (!proj.authConfigured) {
        return {
          ok: false,
          error:
            "Auth must be set up before adding OAuth providers. Call setupAuth first.",
        };
      }

      // ── IDEMPOTENT FAST PATH — credentials already saved. Return the
      //    registration context immediately instead of reopening the modal
      //    (a post-save re-call used to yank a fresh modal open in the
      //    user's workspace). reconfigure:true opts out intentionally. ──
      if (reconfigure !== true) {
        const { projectOAuthProviders } = await import("@/db/schema");
        const [enabledRow] = await db
          .select({ id: projectOAuthProviders.id })
          .from(projectOAuthProviders)
          .where(
            and(
              eq(projectOAuthProviders.projectId, projectId),
              eq(projectOAuthProviders.provider, provider),
              eq(projectOAuthProviders.status, "enabled"),
            ),
          )
          .limit(1);
        if (enabledRow) {
          const def = getOAuthProvider(provider)!;
          return {
            ok: true,
            provider,
            alreadyConfigured: true,
            context:
              `${def.displayName} OAuth credentials are ALREADY saved on this project — no modal was opened. ` +
              "If the provider isn't wired into the app yet, complete the steps below. " +
              "To REPLACE the saved credentials, call again with reconfigure: true (only if the user explicitly asked).\n\n" +
              buildOAuthProviderSuccessContext(platform, provider, def),
          };
        }
      }

      const deployUrl = proj.userConvexUrl ?? proj.convexDeployUrl ?? null;
      const convexSiteUrl = deployUrl
        ? deployUrl.replace(".convex.cloud", ".convex.site")
        : null;

      // ── Reuse a pending request for the SAME provider (the user may be
      //    mid-typing in that very modal); replace pending ones for others ──
      const [existingReq] = await db
        .select({ id: oauthProviderRequests.id })
        .from(oauthProviderRequests)
        .where(
          and(
            eq(oauthProviderRequests.projectId, projectId),
            eq(oauthProviderRequests.status, "pending"),
            eq(oauthProviderRequests.provider, provider),
          ),
        )
        .limit(1);

      let requestId: string;
      if (existingReq) {
        requestId = existingReq.id;
        await db
          .update(oauthProviderRequests)
          .set({ updatedAt: new Date() })
          .where(eq(oauthProviderRequests.id, existingReq.id));
      } else {
        await db
          .update(oauthProviderRequests)
          .set({ status: "dismissed", updatedAt: new Date() })
          .where(
            and(
              eq(oauthProviderRequests.projectId, projectId),
              eq(oauthProviderRequests.status, "pending"),
            ),
          );

        // ── Create pending request — workspace modal appears on next poll ──
        const [record] = await db
          .insert(oauthProviderRequests)
          .values({
            projectId,
            userId: proj.userId,
            provider,
            status: "pending",
            convexSiteUrl,
          })
          .returning();
        requestId = record.id;
      }

      // ── Short grace poll only (45s). Console setup takes the user
      //    MINUTES — blocking a live turn that long is how turns die
      //    mid-modal. Past the grace we return an honest still-pending
      //    result; the workspace fires a system note on submit and the
      //    idempotent fast path above makes the follow-up call instant. ──
      const deadline = Date.now() + 45 * 1000;
      while (Date.now() < deadline) {
        void markAgentWaiting("oauth-provider", requestId);
        await new Promise<void>((r) => setTimeout(r, 3000));

        const [statusRow] = await db
          .select({ status: oauthProviderRequests.status })
          .from(oauthProviderRequests)
          .where(
            and(
              eq(oauthProviderRequests.id, requestId),
              eq(oauthProviderRequests.projectId, projectId),
            ),
          )
          .limit(1);

        if (!statusRow) break; // Record disappeared — bail

        if (statusRow.status === "completed") {
          const def = getOAuthProvider(provider)!;
          return {
            ok: true,
            provider,
            context: buildOAuthProviderSuccessContext(platform, provider, def),
          };
        }

        if (statusRow.status === "dismissed") {
          const name = getOAuthProvider(provider)?.displayName ?? provider;
          return {
            ok: false,
            error:
              `User declined to set up ${name} sign-in. The modal was dismissed and no credentials were saved. ` +
              "Do not retry automatically. Continue with the rest of the implementation and tell the user " +
              "they can add it later from the workspace.",
          };
        }
        // status === 'pending' — keep polling
      }

      // Grace passed — the row stays PENDING and the modal stays open. A
      // still-pending result means "the user hasn't finished yet", never
      // "the user declined"; a late submit triggers a system-note back to
      // the agent. Drop the wait marker NOW so that late submit notifies
      // correctly. NOT an error: a human mid-modal is an expected state.
      const { clearAgentWaiting } = await import("@/lib/agent/modal-wait");
      void clearAgentWaiting("oauth-provider", requestId);
      return {
        ok: true,
        status: "still-pending",
        context:
          `The user hasn't finished entering the ${getOAuthProvider(provider)?.displayName ?? provider} OAuth credentials yet — ` +
          "the modal is STILL OPEN in their workspace; nothing was dismissed or declined, and this is normal " +
          "(provider console setup takes minutes). Stop waiting: continue unrelated work or end your turn. " +
          "You'll receive a system note when they save; then call setupOAuthProvider again — once credentials are " +
          "saved it returns the registration snippet instantly. Until then do NOT edit convex/auth.ts, add or expose " +
          "this provider's sign-in UI, or claim the provider is configured, and NEVER describe this as the user " +
          "dismissing or declining.",
      };
    },
  });
}
