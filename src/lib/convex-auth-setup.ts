/**
 * Server-side Convex Auth provisioning.
 *
 * Generates RSA signing keys and sets them (plus SITE_URL and CONVEX_SITE_URL)
 * on a Convex deployment via its own HTTP admin API — the same mechanism the
 * Convex CLI uses for `convex env set`. Called by the `setupAuth` agent tool
 * so credentials never enter the sandbox.
 */

import { generateKeyPairSync, createPublicKey } from "crypto";
import { getDb } from "@/db";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { provisionConvexBackend } from "./convex-platform";

export interface ConvexAuthFile {
  path: string;
  content: string;
}

export interface SetupConvexAuthResult {
  ok: true;
  files: ConvexAuthFile[];
  packagesToInstall: string[];
  /** Rich reference context for the agent — patterns, snippets, env vars. */
  context: string;
}

export interface SetupConvexAuthError {
  ok: false;
  error: string;
}

function generateConvexAuthSecrets(): { privateKeyPem: string; jwksJson: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const pubKeyObj = createPublicKey(publicKey);
  const jwk = pubKeyObj.export({ format: "jwk" }) as Record<string, unknown>;
  const jwksJson = JSON.stringify({
    keys: [{ ...jwk, use: "sig", alg: "RS256", kid: "default" }],
  });

  return { privateKeyPem: privateKey, jwksJson };
}

/**
 * Frontend helper that makes OAuth sign-in work from the Botflow preview
 * iframe. OAuth (Google, GitHub, …) cannot complete inside the embedded
 * preview: the provider's page refuses to be framed, and even if it loaded the
 * resulting session would land in a different storage partition than the
 * preview. So inside the preview we hand the flow off to the workspace, which
 * re-opens this app in a new top-level tab with the provider preselected and
 * resumes sign-in there. In the deployed app (and in that new tab) it runs
 * normally. Written to /src/lib/botflowAuth.ts via buildAuthBoilerplate.
 *
 * NOTE: keep this string free of backticks and ${...} — it is emitted verbatim.
 */
export const AUTH_HELPER_TS = `// botflowAuth — makes OAuth sign-in work from the Botflow preview iframe.
//
// OAuth providers (Google, GitHub, …) can't complete inside the embedded
// preview, so here we hand sign-in off to the Botflow workspace, which reopens
// this app in a new top-level tab and resumes the flow. In your deployed app
// (and in that new tab) sign-in runs normally — these helpers are no-ops there.

// True when this app is running inside the Botflow preview iframe.
export function inBotflowPreview(): boolean {
  try {
    return typeof window !== "undefined" && window.self !== window.top;
  } catch {
    // Cross-origin access to window.top throws, which means we ARE framed.
    return true;
  }
}

// Call this from an OAuth sign-in button's onClick. Pass the signIn function
// from useAuthActions() and the provider id ("google", "github", …). In the
// preview it asks the workspace to reopen the app in a new tab and resume
// there; everywhere else it starts the real OAuth redirect.
export async function startOAuthSignIn(
  signIn: (provider: string, params?: Record<string, unknown>) => Promise<unknown>,
  provider: string,
): Promise<void> {
  if (inBotflowPreview()) {
    try {
      window.parent.postMessage({ type: "botflow:open-auth", provider: provider }, "*");
      return;
    } catch {
      // Fall through to a best-effort popup if the parent is unreachable.
    }
    const url = new URL(window.location.href);
    url.searchParams.set("botflow_signin", provider);
    window.open(url.toString(), "_blank", "noopener");
    return;
  }
  // redirectTo tells Convex Auth which origin to return to after OAuth. Passing
  // the current origin is what makes sign-in land back on THIS domain (dev
  // preview vs published site) instead of always the single SITE_URL.
  await signIn(provider, { redirectTo: window.location.origin });
}

// Call once when the app mounts (e.g. a top-level useEffect). When the preview
// handoff reopened this app in a new tab it appended ?botflow_signin=<provider>
// — this resumes that OAuth flow now (top-level, where it works) and strips the
// param so a refresh doesn't repeat it. No-op in the preview and when absent.
export function resumePendingOAuthSignIn(
  signIn: (provider: string, params?: Record<string, unknown>) => Promise<unknown>,
): void {
  if (typeof window === "undefined" || inBotflowPreview()) return;
  const params = new URLSearchParams(window.location.search);
  const provider = params.get("botflow_signin");
  if (!provider) return;
  params.delete("botflow_signin");
  const query = params.toString();
  const clean = window.location.pathname + (query ? "?" + query : "") + window.location.hash;
  window.history.replaceState(null, "", clean);
  // Return to this same origin (the tab the user is in) after OAuth completes.
  void signIn(provider, { redirectTo: window.location.origin });
}
`;

/**
 * Swift-only `convex/http.ts`. In addition to Convex Auth's own routes, it
 * serves the in-app-browser sign-in PAGE from this deployment's *.convex.site
 * origin. The native app (BotflowAuthProvider) opens GET /auth/signin inside an
 * ASWebAuthenticationSession; the page runs the SAME `auth:signIn` action the
 * web client uses and 303-redirects to the app's custom scheme with the tokens
 * in the URL fragment. Pure server-rendered HTML — no client JS, same-origin
 * POST (no CORS). Emitted verbatim — keep free of backticks and ${...}.
 */
export const SWIFT_AUTH_HTTP_TS = `import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";
import { auth } from "./auth";

const http = httpRouter();

// Convex Auth's own OAuth-callback / sign-out / well-known routes.
auth.addHttpRoutes(http);

// ── In-app-browser sign-in page (Swift / ConvexMobile client) ──
//
// Opened by the native app inside an ASWebAuthenticationSession. On submit it
// runs the "auth:signIn" action and redirects to:
//   botflowauth://auth-callback#token=<jwt>&refresh=<refreshToken>

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(redirect: string, flow: string, error: string | null): string {
  const signUp = flow === "signUp";
  const title = signUp ? "Create account" : "Sign in";
  const toggleLabel = signUp ? "Have an account? Sign in" : "Need an account? Sign up";
  const toggleFlow = signUp ? "signIn" : "signUp";
  const toggleHref = "/auth/signin?redirect=" + encodeURIComponent(redirect) + "&flow=" + toggleFlow;
  const errHtml = error ? '<p class="err">' + esc(error) + "</p>" : "";
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    "<title>" + esc(title) + "</title>",
    "<style>",
    ":root{color-scheme:dark}*{box-sizing:border-box}",
    "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;",
    "background:#000;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#fff}",
    ".card{width:100%;max-width:360px;padding:32px 24px}",
    "h1{font-size:26px;font-weight:700;margin:0 0 4px;text-align:center}",
    "p.sub{margin:0 0 24px;text-align:center;color:rgba(255,255,255,.45);font-size:14px}",
    "label{display:block;font-size:13px;color:rgba(255,255,255,.55);margin:14px 0 6px}",
    "input{width:100%;padding:14px 16px;border-radius:14px;border:1px solid rgba(255,255,255,.12);",
    "background:rgba(255,255,255,.06);color:#fff;font-size:16px;outline:none}",
    "input:focus{border-color:rgba(150,110,255,.7)}",
    "button{width:100%;margin-top:22px;padding:15px;border:0;border-radius:14px;background:#fff;",
    "color:#000;font-size:16px;font-weight:600}",
    "a{display:block;text-align:center;margin-top:18px;color:rgba(255,255,255,.55);font-size:14px;text-decoration:none}",
    ".err{color:#ff9b6b;font-size:13px;text-align:center;margin:14px 0 0}",
    "</style></head><body><div class=\\"card\\">",
    "<h1>" + esc(title) + "</h1>",
    '<p class="sub">' + (signUp ? "Sign up to continue." : "Welcome back.") + "</p>",
    '<form method="POST" action="/auth/signin">',
    '<input type="hidden" name="flow" value="' + flow + '">',
    '<input type="hidden" name="redirect" value="' + esc(redirect) + '">',
    "<label>Email</label>",
    '<input name="email" type="email" autocomplete="email" autocapitalize="none" required>',
    "<label>Password</label>",
    '<input name="password" type="password" autocomplete="' + (signUp ? "new-password" : "current-password") + '" minlength="8" required>',
    errHtml,
    '<button type="submit">' + esc(title) + "</button>",
    "</form>",
    '<a href="' + toggleHref + '">' + esc(toggleLabel) + "</a>",
    "</div></body></html>",
  ].join("");
}

function htmlResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

http.route({
  path: "/auth/signin",
  method: "GET",
  handler: httpAction(async (_ctx, request) => {
    const url = new URL(request.url);
    const redirect = url.searchParams.get("redirect") || "";
    const flow = url.searchParams.get("flow") === "signUp" ? "signUp" : "signIn";
    return htmlResponse(page(redirect, flow, null), 200);
  }),
});

http.route({
  path: "/auth/signin",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const form = await request.formData();
    const email = String(form.get("email") || "").trim();
    const password = String(form.get("password") || "");
    const flow = String(form.get("flow") || "signIn") === "signUp" ? "signUp" : "signIn";
    const redirect = String(form.get("redirect") || "");

    if (!redirect || !redirect.includes("://")) {
      return htmlResponse(page(redirect, flow, "Missing or invalid redirect target."), 400);
    }

    try {
      const result: any = await ctx.runAction(api.auth.signIn, {
        provider: "password",
        params: { email, password, flow },
      });
      const tokens = result && result.tokens;
      if (!tokens || !tokens.token || !tokens.refreshToken) {
        return htmlResponse(page(redirect, flow, "Sign-in failed. Please try again."), 200);
      }
      const dest =
        redirect +
        "#token=" + encodeURIComponent(tokens.token) +
        "&refresh=" + encodeURIComponent(tokens.refreshToken);
      return new Response(null, {
        status: 303,
        headers: { Location: dest, "Cache-Control": "no-store" },
      });
    } catch (e) {
      const msg = flow === "signUp"
        ? "Could not sign up. The email may already be in use, or your password may be too short (8+ characters)."
        : "Could not sign in. Check your email and password.";
      return htmlResponse(page(redirect, flow, msg), 200);
    }
  }),
});

export default http;
`;

function buildAuthBoilerplate(platform: "web" | "swift" = "web"): ConvexAuthFile[] {
  const files: ConvexAuthFile[] = [];
  if (platform === "web") {
    // Web-only: React helper for OAuth from the preview iframe. The Swift client
    // uses an in-app browser + BotflowAuthProvider instead (no React helper).
    files.push({ path: "src/lib/botflowAuth.ts", content: AUTH_HELPER_TS });
  }
  files.push(
    {
      path: "convex/auth.config.ts",
      content: `// Required by @convex-dev/auth — tells Convex to trust JWTs issued by
// this deployment's own HTTP actions endpoint.
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
`,
    },
    {
      path: "convex/auth.ts",
      content: `import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";

// This app is served from more than one origin: the Botflow dev preview
// (*.vercel.run), the published site (*.pages.dev), and any custom domain.
// Convex Auth otherwise only allows OAuth/magic-link redirects back to the
// single SITE_URL origin — which would bounce a production sign-in back to the
// preview domain. Botflow keeps ALLOWED_SITE_URLS (comma-separated origins) in
// sync across those domains; this callback lets sign-in return to whichever one
// the user actually started on, and falls back to SITE_URL otherwise (so it can
// never become an open redirect).
function allowedSiteOrigins(): string[] {
  const raw = process.env.ALLOWED_SITE_URLS ?? process.env.SITE_URL ?? "";
  const origins: string[] = [];
  for (const part of raw.split(",")) {
    try {
      const origin = new URL(part.trim()).origin;
      if (origin && !origins.includes(origin)) origins.push(origin);
    } catch {
      // ignore malformed entries
    }
  }
  return origins;
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password],
  callbacks: {
    async redirect({ redirectTo }) {
      // Relative paths are always safe.
      if (redirectTo.startsWith("/") || redirectTo.startsWith("?")) return redirectTo;
      let origin: string | null = null;
      try {
        origin = new URL(redirectTo).origin;
      } catch {
        origin = null;
      }
      if (origin && allowedSiteOrigins().includes(origin)) return redirectTo;
      // Not allow-listed → fall back to the canonical site URL.
      return process.env.SITE_URL ?? allowedSiteOrigins()[0] ?? redirectTo;
    },
  },
});
`,
    },
    {
      path: "convex/http.ts",
      content:
        platform === "swift"
          ? SWIFT_AUTH_HTTP_TS
          : `import { httpRouter } from "convex/server";
import { auth } from "./auth";

const http = httpRouter();
auth.addHttpRoutes(http);

export default http;
`,
    },
    {
      path: "convex/schema.ts",
      content: `import { defineSchema } from "convex/server";
import { authTables } from "@convex-dev/auth/server";

const schema = defineSchema({
  ...authTables,
  // Add your own tables below
});

export default schema;
`,
    },
    {
      path: "convex/users.ts",
      content: `import { query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

// Returns the currently authenticated user document, or null if signed out.
export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    return userId !== null ? ctx.db.get(userId) : null;
  },
});
`,
    },
  );
  return files;
}

/**
 * Build the rich context string that helps the AI agent understand the full
 * Convex Auth surface: file roles, frontend wiring, provider patterns, and
 * how to protect queries/mutations.
 */
function buildAgentContext(convexSiteUrl: string): string {
  return `
=== CONVEX AUTH REFERENCE ===

ENVIRONMENT VARIABLES SET ON YOUR CONVEX DEPLOYMENT:
  JWT_PRIVATE_KEY          — RSA-2048 private key for signing auth JWTs
                             (this is the name @convex-dev/auth actually reads)
  CONVEX_AUTH_PRIVATE_KEY  — Same value, mirror name set for forward-compat
  JWKS                     — Public key set for JWT verification
  SITE_URL                 — Your frontend app URL (used in email links)

ENVIRONMENT VARIABLES AUTO-PROVIDED BY CONVEX (do not try to set these):
  CONVEX_SITE_URL          — ${convexSiteUrl}
                             Convex sets this automatically. auth.config.ts reads
                             process.env.CONVEX_SITE_URL to register the deployment
                             as its own trusted JWT issuer.

FILES WRITTEN (WRITE THESE EXACTLY AS PROVIDED IN THE files ARRAY):
  convex/auth.config.ts  — Registers this deployment as a trusted JWT issuer.
                           Must exist or auth will silently fail.
  convex/auth.ts         — Configures providers. Export: auth, signIn, signOut, store.
  convex/http.ts         — Mounts auth's OAuth callback/sign-out HTTP routes.
  convex/schema.ts       — Spreads authTables so built-in auth tables exist in DB.
  convex/users.ts        — viewer query: returns the current user doc (or null).
  src/lib/botflowAuth.ts — Helpers so OAuth sign-in works from the preview iframe
                           (startOAuthSignIn / resumePendingOAuthSignIn). Only
                           needed once you add an OAuth provider — see below.

REQUIRED SEQUENCE AFTER WRITING FILES:
  1. pnpm add @convex-dev/auth @auth/core
  2. convexDeploy  ← MUST run this before the frontend can sign in
  3. After wiring the sign-in form, sign up with a test email then call
     getBrowserLog. If the catch handler fires, READ the logged error before
     deciding what to tell the user — do NOT assume "email taken." Most auth
     bugs surface as console errors here.

─────────────────────────────────────────────────────────────
BACKEND PATTERN — protecting queries and mutations:
─────────────────────────────────────────────────────────────

  import { query, mutation } from "./_generated/server";
  import { getAuthUserId } from "@convex-dev/auth/server";

  export const myProtectedQuery = query({
    handler: async (ctx) => {
      const userId = await getAuthUserId(ctx);
      if (userId === null) throw new Error("Not authenticated");
      return ctx.db.get(userId);
    },
  });

  // getAuthUserId returns null when not authenticated — it never throws.
  // Always check for null before using the id.
  //
  // CONVENTION — tolerant reads, strict writes: for any query a component may
  // subscribe to around sign-in/sign-out (or anything rendered outside
  // <Authenticated>), prefer returning [] / null when userId is null instead
  // of throwing — a query can briefly run before the auth token attaches, and
  // a throw surfaces as a generic ServerError. Keep mutations/actions strict
  // (throw when unauthenticated).

─────────────────────────────────────────────────────────────
FRONTEND PATTERN — main.tsx setup:
─────────────────────────────────────────────────────────────

  import { ConvexAuthProvider } from "@convex-dev/auth/react";
  import { ConvexReactClient } from "convex/react";

  const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

  // Replace <ConvexProvider client={convex}> with:
  <ConvexAuthProvider client={convex}>
    <App />
  </ConvexAuthProvider>

─────────────────────────────────────────────────────────────
FRONTEND PATTERN — conditional rendering:
─────────────────────────────────────────────────────────────

  import { Authenticated, Unauthenticated, useQuery } from "convex/react";
  import { api } from "../convex/_generated/api";

  // Authenticated / Unauthenticated are convex/react components, not @convex-dev/auth
  <Authenticated>
    <Dashboard />
  </Authenticated>
  <Unauthenticated>
    <SignInPage />
  </Unauthenticated>

  // Get the current user:
  const user = useQuery(api.users.viewer); // null = signed out

─────────────────────────────────────────────────────────────
FRONTEND PATTERN — sign-in/sign-up form (Password provider):
─────────────────────────────────────────────────────────────

  import { useAuthActions } from "@convex-dev/auth/react";

  function SignInForm() {
    const { signIn } = useAuthActions();
    const [flow, setFlow] = useState<"signIn" | "signUp">("signIn");
    const [error, setError] = useState<string | null>(null);

    return (
      <form onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        const formData = new FormData(e.currentTarget);
        formData.set("flow", flow);
        try {
          await signIn("password", formData);
          // On success: do NOT navigate or setState. The <Authenticated>
          // block in the parent will swap the view automatically.
        } catch (err) {
          // CRITICAL: log the error so you can diagnose with getBrowserLog.
          // Do NOT invent specific causes — @convex-dev/auth throws for many
          // reasons (validation, session conflict, token storage, etc.).
          // Use the hedged "may" phrasing from the official Convex example.
          console.error("Auth error:", err);
          setError(
            flow === "signIn"
              ? "Could not sign in. Check your email and password."
              : "Could not sign up. The email may already be in use, or your password may not meet requirements."
          );
        }
      }}>
        <input name="email" type="email" required />
        <input name="password" type="password" required minLength={8} />
        {/* CRITICAL: the "flow" field tells the server signIn vs signUp */}
        <input name="flow" value={flow} type="hidden" />
        {error && <div role="alert">{error}</div>}
        <button type="submit">{flow === "signIn" ? "Sign in" : "Sign up"}</button>
        <button type="button" onClick={() => { setFlow(f => f === "signIn" ? "signUp" : "signIn"); setError(null); }}>
          {flow === "signIn" ? "Need an account?" : "Have an account?"}
        </button>
      </form>
    );
  }

─────────────────────────────────────────────────────────────
FRONTEND PATTERN — sign out:
─────────────────────────────────────────────────────────────

  const { signOut } = useAuthActions();
  <button onClick={() => void signOut()}>Sign out</button>

─────────────────────────────────────────────────────────────
ADDING OAUTH PROVIDERS (Google):
─────────────────────────────────────────────────────────────

  ONLY DO THIS WHEN THE USER EXPLICITLY ASKS FOR GOOGLE / SOCIAL SIGN-IN.
  Default to the Password provider (optionally Anonymous). Google OAuth
  requires the user to own a Google Cloud project and complete a console
  setup — do NOT add it proactively or "to be helpful." If auth is needed
  and the user hasn't specified a method, use Password.

  THIS PLATFORM PROVIDES A DEDICATED TOOL: setupOAuthProvider
  DO NOT use bash or npx convex env set to set OAuth credentials.
  The setupOAuthProvider tool handles credential collection securely
  via a modal in the user's workspace.

  CORRECT SEQUENCE FOR GOOGLE SIGN-IN:

  Step 1 — Call setupOAuthProvider({ provider: "google" }).
           This opens a modal in the workspace where the user pastes their
           Google OAuth Client ID and Client Secret. The tool BLOCKS until
           the user completes or dismisses the modal (up to 5 minutes).
           The credentials are saved as AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET
           on the Convex deployment — you never see them.

           The modal shows the user the redirect URI they need to register
           in Google Cloud Console: ${convexSiteUrl}/api/auth/callback/google
           (this URL is stable and never changes for this project).

  Step 2 — After setupOAuthProvider returns ok: true, update convex/auth.ts:
           import Google from "@auth/core/providers/google";
           // add Google to the providers array alongside Password.
           // IMPORTANT: keep the existing callbacks.redirect block intact — it
           // lets OAuth return to the right domain in both preview and prod.
           // Only edit the providers array.

  Step 3 — Run convexDeploy to push the updated auth config.

  Step 4 — Add a Google sign-in button to the UI.

           CRITICAL: OAuth can't complete inside the Botflow preview iframe
           (the provider page refuses to be framed). The scaffold provides
           src/lib/botflowAuth.ts to handle this — ALWAYS use it for OAuth
           buttons; never call signIn("google") directly for an OAuth provider.

             import { useAuthActions } from "@convex-dev/auth/react";
             import { startOAuthSignIn } from "@/lib/botflowAuth";

             const { signIn } = useAuthActions();
             <button onClick={() => void startOAuthSignIn(signIn, "google")}>
               Sign in with Google
             </button>

           In the preview, startOAuthSignIn asks the workspace to reopen the app
           in a new tab and resume sign-in there; in the deployed app it just
           calls signIn normally. (Password/anonymous sign-in does NOT redirect,
           so keep calling signIn directly for those.)

           Then, so the new tab resumes the flow automatically, call
           resumePendingOAuthSignIn ONCE at app mount (e.g. in App.tsx):

             import { useEffect } from "react";
             import { useAuthActions } from "@convex-dev/auth/react";
             import { resumePendingOAuthSignIn } from "@/lib/botflowAuth";

             const { signIn } = useAuthActions();
             useEffect(() => { resumePendingOAuthSignIn(signIn); }, [signIn]);

  If the user clicks Cancel in the modal, setupOAuthProvider returns
  ok: false. In that case, do NOT retry automatically — just acknowledge
  the cancellation and continue with other work.

─────────────────────────────────────────────────────────────
ADDING ANONYMOUS AUTH:
─────────────────────────────────────────────────────────────

  Add to convex/auth.ts:
    import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
    // add Anonymous to providers array

  Frontend:
    <button onClick={() => void signIn("anonymous")}>Continue as guest</button>

  Upgrade anonymous → real user later:
    // Sign in with any real provider while already signed in as anonymous
    // @convex-dev/auth merges the sessions automatically

─────────────────────────────────────────────────────────────
IMPORTANT NOTES:
─────────────────────────────────────────────────────────────
  - convexDeploy MUST be run after every edit to files in /convex
  - The Password provider's "flow" hidden input ("signIn" | "signUp") is mandatory
  - getAuthUserId() returns null (never throws) — always null-check the result
  - CONVEX_SITE_URL ends in .convex.site; VITE_CONVEX_URL ends in .convex.cloud
  - OAuth providers need their own env vars set on the Convex deployment (not .env)
  - authTables in schema.ts stores users, sessions, accounts, verifications
`.trim();
}

/**
 * Swift-flavored agent context. The Swift client does NOT use React/@convex-dev/
 * auth/react — sign-in is an in-app browser flow handled entirely by the
 * template's BotflowAuthProvider. The agent's job is the BACKEND + gating the UI.
 */
function buildSwiftAgentContext(convexSiteUrl: string): string {
  return `
=== CONVEX AUTH (SWIFT) REFERENCE ===

HOW IT WORKS (you do NOT write any native auth UI):
  • setupAuth configured @convex-dev/auth on the deployment and set the signing
    keys (you never see them). It also wrote convex/http.ts, which now serves an
    in-app-browser SIGN-IN PAGE at:  ${convexSiteUrl}/auth/signin
  • The Swift template already contains the client side: BotflowAuthProvider
    (opens that page in an ASWebAuthenticationSession), Keychain storage,
    AuthStore, and SignInView. Botflow flipped ConvexConfig.authEnabled to true,
    so ContentView now gates the app behind sign-in automatically.
  • The user signs in with email + password on the hosted page. Tokens come back
    to the app; refresh is automatic via the auth:signIn action.

WHAT YOU MUST DO AFTER setupAuth RETURNS:
  1. Write each file in the returned \`files\` array (convex/auth.ts,
     auth.config.ts, http.ts, schema.ts, users.ts) with the write tool.
     NOTE: schema.ts now spreads authTables. If the project already had a
     schema, MERGE your existing tables into the new one (keep ...authTables).
  2. cd convex && pnpm add @convex-dev/auth @auth/core   (deps for the backend)
  3. Run convexDeploy. The sign-in page and auth functions are NOT live until you do.
  4. That is it for enabling sign-in — do NOT edit ConvexConfig.swift (platform-
     managed) and do NOT build a native login form; the hosted page IS the form.

PROTECTING DATA — tolerant reads, strict writes (IMPORTANT):
  The Swift app's live subscriptions can fire BEFORE the SDK has attached the
  auth token (app launch, sign-in handoff, token refresh). A query that throws
  "Not authenticated" during that window surfaces as a generic ServerError in
  the UI. So:
  • QUERIES (anything subscribed) must TOLERATE missing auth — return [] or
    null when getAuthUserId is null. The subscription re-fires with real data
    the moment auth attaches.
  • MUTATIONS/ACTIONS must REQUIRE auth — throw when getAuthUserId is null.

  import { getAuthUserId } from "@convex-dev/auth/server";

  export const list = query({
    args: {},
    handler: async (ctx) => {
      const userId = await getAuthUserId(ctx); // null when signed out — never throws
      if (userId === null) return [];          // tolerate the auth race — do NOT throw
      return await ctx.db.query("notes").withIndex("by_user", q => q.eq("userId", userId)).collect();
    },
  });

  export const add = mutation({
    args: { text: v.string() },
    handler: async (ctx, { text }) => {
      const userId = await getAuthUserId(ctx);
      if (userId === null) throw new Error("Not authenticated"); // writes stay strict
      await ctx.db.insert("notes", { userId, text });
    },
  });

READING THE CURRENT USER FROM SWIFT:
  • users.ts exposes the \`users:viewer\` query (current user doc or null).
    Subscribe to it like any other query via Convex.shared.
  • Gate views on AuthStore.state if you add more screens; SignInView is shown
    automatically when signed out.

OAUTH / SOCIAL SIGN-IN: out of scope for now (password only). Do not add Google
or other providers unless explicitly asked — there is no Swift OAuth path yet.

NOTES:
  • CONVEX_SITE_URL (auto-set by Convex) = ${convexSiteUrl}
  • Run convexDeploy after EVERY change to files under /convex.
  • The password "flow" field ("signIn" | "signUp") is handled by the hosted page.
`.trim();
}

/**
 * Set environment variables on a Convex deployment using its own HTTP admin API.
 * This is the same mechanism the Convex CLI uses for `convex env set`.
 */
async function setEnvVarsViaDeployKey(
  deploymentUrl: string,
  deployKey: string,
  vars: Record<string, string>,
): Promise<void> {
  const changes = Object.entries(vars).map(([name, value]) => ({ name, value }));
  const response = await fetch(`${deploymentUrl}/api/update_environment_variables`, {
    method: "POST",
    headers: {
      Authorization: `Convex ${deployKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ changes }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to set Convex env vars (${response.status}): ${errorText}`);
  }
}

export async function setupConvexAuth(
  projectId: string,
  opts: {
    siteUrl: string;
    userConvexOAuthToken?: string | null;
    /** "web" (default) emits the React helper; "swift" emits the in-app-browser
     *  sign-in page in convex/http.ts and a Swift-flavored agent context. */
    platform?: "web" | "swift";
  },
): Promise<SetupConvexAuthResult | SetupConvexAuthError> {
  const platform = opts.platform ?? "web";
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));

  if (!project) {
    return { ok: false, error: "Project not found." };
  }
  if (project.backendType === "none") {
    return { ok: false, error: "This project has no backend — Convex Auth is not available." };
  }

  // Resolve deploy URL and key based on backend type
  let deployUrl: string | null;
  let deployKey: string | null;

  if (project.backendType === "user") {
    deployUrl = project.userConvexUrl ?? null;
    deployKey = project.userConvexDeployKey ?? null;
    if (!deployUrl || !deployKey) {
      return {
        ok: false,
        error: "No Convex deployment is linked to this project. Connect your Convex account in Settings.",
      };
    }
  } else {
    // Platform backend — auto-provision if not yet created
    deployUrl = project.convexDeployUrl ?? null;
    deployKey = project.convexDeployKey ?? null;

    if (!project.convexDeploymentId || !deployKey) {
      const convexProjectName = `ide-${project.id.slice(0, 8)}`;
      const convex = await provisionConvexBackend(convexProjectName);
      await db.update(projects)
        .set({
          convexProjectId: convex.projectId,
          convexDeploymentId: convex.deploymentId,
          convexDeployUrl: convex.deployUrl,
          convexDeployKey: convex.deployKey,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, projectId));
      deployUrl = convex.deployUrl;
      deployKey = convex.deployKey;
    }

    if (!deployUrl) {
      deployUrl = `https://${project.convexDeploymentId}.convex.cloud`;
    }
  }

  if (!deployKey) {
    return { ok: false, error: "No Convex deploy key available. Try reconnecting your Convex backend in Settings." };
  }

  // CONVEX_SITE_URL is auto-provided by Convex (built-in env var, cannot be set).
  // Compute it here only for use in agent-facing docs (OAuth callback URLs).
  const convexSiteUrl = deployUrl.replace(".convex.cloud", ".convex.site");

  const { privateKeyPem, jwksJson } = generateConvexAuthSecrets();

  // @convex-dev/auth reads JWT_PRIVATE_KEY (matches the official `npx
  // @convex-dev/auth` setup script). We also set CONVEX_AUTH_PRIVATE_KEY for
  // forward-compatibility in case a future version renames it.
  // At setup the only known origin is the dev preview; publish/dev-restart
  // later expand ALLOWED_SITE_URLS via refreshAuthSiteUrl.
  const initialOrigin = toOrigin(opts.siteUrl) ?? opts.siteUrl;
  await setEnvVarsViaDeployKey(deployUrl, deployKey, {
    JWT_PRIVATE_KEY: privateKeyPem,
    CONVEX_AUTH_PRIVATE_KEY: privateKeyPem,
    JWKS: jwksJson,
    SITE_URL: initialOrigin,
    ALLOWED_SITE_URLS: initialOrigin,
  });

  // Mark the project as having auth configured so the workspace can show
  // the OAuth provider modal UI and SITE_URL auto-refresh can run.
  await db.update(projects)
    .set({ authConfigured: true, updatedAt: new Date() })
    .where(eq(projects.id, projectId));

  return {
    ok: true,
    files: buildAuthBoilerplate(platform),
    packagesToInstall: ["@convex-dev/auth", "@auth/core"],
    context:
      platform === "swift"
        ? buildSwiftAgentContext(convexSiteUrl)
        : buildAgentContext(convexSiteUrl),
  };
}

/** Normalize any URL or bare hostname to a scheme://host[:port] origin. */
function toOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).origin;
  } catch {
    return null;
  }
}

/**
 * Compute the canonical SITE_URL and the full set of allowed redirect origins
 * for a project's Convex Auth deployment. OAuth/magic-link redirects can return
 * to any of these origins (see the redirect callback in convex/auth.ts).
 *
 * Sources: the live dev-preview domain (passed in), the published *.pages.dev /
 * managed-domain URL, and any active custom domain. SITE_URL prefers the
 * published origin (so magic-link emails point at production) and falls back to
 * the dev origin before publish.
 */
function computeAuthUrls(
  project: {
    cloudflareDeploymentUrl: string | null;
    managedDomainHostname: string | null;
    customDomain: string | null;
    customDomainStatus: string | null;
  },
  devSiteUrl?: string | null,
): { siteUrl: string | null; allowed: string[] } {
  const prodOrigin =
    toOrigin(project.cloudflareDeploymentUrl) ??
    toOrigin(project.managedDomainHostname) ??
    (project.customDomainStatus === "active" ? toOrigin(project.customDomain) : null);
  const customOrigin =
    project.customDomainStatus === "active" ? toOrigin(project.customDomain) : null;
  const devOrigin = toOrigin(devSiteUrl);

  const allowed: string[] = [];
  for (const o of [devOrigin, prodOrigin, customOrigin]) {
    if (o && !allowed.includes(o)) allowed.push(o);
  }
  // Canonical: production if published, otherwise the dev preview.
  const siteUrl = prodOrigin ?? devOrigin ?? allowed[0] ?? null;
  return { siteUrl, allowed };
}

/**
 * Re-sync SITE_URL + ALLOWED_SITE_URLS on a deployment whenever the set of
 * frontend origins changes — every dev-server start (pass the live preview
 * URL) and every publish (omit it; the published URL is read from the DB).
 * No-ops silently when auth is not yet configured or no deploy key exists.
 */
export async function refreshAuthSiteUrl(
  projectId: string,
  devSiteUrl?: string,
): Promise<void> {
  try {
    const db = getDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project?.authConfigured) return; // nothing to refresh

    const deployUrl = project.userConvexUrl ?? project.convexDeployUrl ?? null;
    const deployKey = project.userConvexDeployKey ?? project.convexDeployKey ?? null;
    if (!deployUrl || !deployKey) return;

    const { siteUrl, allowed } = computeAuthUrls(project, devSiteUrl);
    if (!siteUrl || allowed.length === 0) return;

    await setEnvVarsViaDeployKey(deployUrl, deployKey, {
      SITE_URL: siteUrl,
      ALLOWED_SITE_URLS: allowed.join(","),
    });
  } catch (err) {
    // Non-fatal — a stale SITE_URL/ALLOWED_SITE_URLS degrades OAuth redirects
    // and magic links, but never blocks the dev server or a publish.
    console.warn("[refreshAuthSiteUrl] non-fatal error:", err);
  }
}

/**
 * Set OAuth provider credentials (CLIENT_ID / CLIENT_SECRET) on the Convex
 * deployment. Called server-side after the user fills in the workspace modal.
 */
export async function setOAuthProviderEnvVars(
  projectId: string,
  provider: "google",
  clientId: string,
  clientSecret: string,
): Promise<void> {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new Error("Project not found.");

  const deployUrl = project.userConvexUrl ?? project.convexDeployUrl ?? null;
  const deployKey = project.userConvexDeployKey ?? project.convexDeployKey ?? null;
  if (!deployUrl || !deployKey) {
    throw new Error("No Convex deployment is configured for this project.");
  }

  const vars: Record<string, string> =
    provider === "google"
      ? { AUTH_GOOGLE_ID: clientId, AUTH_GOOGLE_SECRET: clientSecret }
      : {};

  if (Object.keys(vars).length === 0) {
    throw new Error(`Unknown OAuth provider: ${provider}`);
  }

  await setEnvVarsViaDeployKey(deployUrl, deployKey, vars);
}
