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

export type OAuthToolPlatform = "web" | "swift";

function buildAuthTsSnippet(def: OAuthProviderDef): string {
  const imp = def.authImport.default
    ? `import ${def.authImport.symbol} from "${def.authImport.from}";`
    : `import { ${def.authImport.symbol} } from "${def.authImport.from}";`;
  return `   import { convexAuth } from "@convex-dev/auth/server";
   import { Password } from "@convex-dev/auth/providers/Password";
   ${imp}

   export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
     providers: [Password, ${def.providerExpr}],
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
  toolNames?: { deploy?: string; setupAuth?: string; setupOAuth?: string },
): string {
  const deployTool = toolNames?.deploy ?? "convexDeploy";
  const setupAuthTool = toolNames?.setupAuth ?? "setupAuth";
  const setupOAuthTool = toolNames?.setupOAuth ?? "setupOAuthProvider";
  const header = `=== ${def.displayName.toUpperCase()} OAUTH CREDENTIALS SAVED ===

${def.envVars.join(", ")} now set on your Convex deployment.

REQUIRED NEXT STEPS:

1. Update convex/auth.ts — add the provider (pass NO arguments; extra config such
   as the Microsoft issuer or Apple client secret is read from env automatically):

${buildAuthTsSnippet(def)}

2. Run ${deployTool} to push the updated auth config.
`;

  if (platform === "web") {
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
   account automatically and <Authenticated> updates reactively.` +
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
    "FLOW:\n" +
    "  1. This tool creates a pending request and the workspace shows a modal immediately.\n" +
    "  2. The user registers the app in the provider's console and pastes the credentials (Apple uploads a .p8).\n" +
    "  3. This tool blocks (polls) until the user completes or dismisses the modal (a few minutes).\n" +
    "  4. On success: credentials are saved server-side. You then update convex/auth.ts and run convexDeploy.\n" +
    "  5. If the user explicitly DISMISSES the modal: returns an error saying so. Stop trying — do not call this again unless the user asks.\n" +
    "  6. If it times out, the user simply hasn't finished YET — the modal STAYS OPEN. NEVER report a timeout as the user dismissing " +
    "or declining; you'll get a system note when they submit, and you can call this tool again later to resume waiting.\n\n" +
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
    }),
    async execute({ provider }) {
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

      // ── Poll until completed/dismissed (270s, bounded by the agent
      //    route's serverless maxDuration) ──
      const deadline = Date.now() + 270 * 1000;
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

      // Timed out — the row stays PENDING and the modal stays open. A
      // timeout means "the user hasn't finished yet", never "the user
      // declined"; a late submit triggers a system-note back to the agent.
      // Drop the wait marker NOW so that late submit notifies correctly.
      const { clearAgentWaiting } = await import("@/lib/agent/modal-wait");
      void clearAgentWaiting("oauth-provider", requestId);
      return {
        ok: false,
        error:
          `The user has NOT finished entering ${getOAuthProvider(provider)?.displayName ?? provider} OAuth credentials yet — ` +
          "the modal is still open in their workspace; nothing was dismissed or declined. " +
          "Do NOT say the user dismissed or declined it. Continue with other work; you'll get a system note when they submit, " +
          "or call setupOAuthProvider again later to resume waiting.",
      };
    },
  });
}
