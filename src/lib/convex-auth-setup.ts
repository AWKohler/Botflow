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
import { projects, projectOAuthProviders } from "@/db/schema";
import { eq, and, lt } from "drizzle-orm";
import { encryptSecret, decryptSecret } from "@/lib/secrets";
import { buildOAuthEnvVars, signAppleClientSecret } from "@/lib/oauth-providers/server";
import {
  OAUTH_PROVIDERS,
  OAUTH_PROVIDER_IDS,
  oauthCallbackUrl,
} from "@/lib/oauth-providers/registry";

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
// Opened by the native app inside an ASWebAuthenticationSession. Password
// sign-in POSTs back here; OAuth providers go through the server-driven
// bridge (/auth/oauth/start → provider → /auth/oauth/finish). Both paths end
// the same way — a 303 to the app's custom scheme with tokens in the fragment:
//   botflowauth://auth-callback#token=<jwt>&refresh=<refreshToken>

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// OAuth providers the platform can configure on this deployment. A provider's
// button renders only when its credentials are actually set (env pushed by
// Botflow via setupOAuthProvider), so this list is safe to keep static.
const OAUTH_PROVIDERS: Array<{ id: string; label: string; envVar: string }> = [
  { id: "google", label: "Google", envVar: "AUTH_GOOGLE_ID" },
  { id: "github", label: "GitHub", envVar: "AUTH_GITHUB_ID" },
  { id: "microsoft-entra-id", label: "Microsoft", envVar: "AUTH_MICROSOFT_ENTRA_ID_ID" },
  { id: "apple", label: "Apple", envVar: "AUTH_APPLE_ID" },
];

function enabledOAuthProviders(): Array<{ id: string; label: string }> {
  return OAUTH_PROVIDERS.filter((p) => !!process.env[p.envVar]);
}

function oauthButtonsHtml(redirect: string, state: string): string {
  if (!redirect) return ""; // error page with no valid redirect — no live links
  const providers = enabledOAuthProviders();
  if (providers.length === 0) return "";
  const buttons = providers
    .map((p) => {
      const href =
        "/auth/oauth/start?provider=" + encodeURIComponent(p.id) +
        "&redirect=" + encodeURIComponent(redirect) +
        (state ? "&state=" + encodeURIComponent(state) : "");
      return '<a class="oauth" href="' + href + '">Continue with ' + esc(p.label) + "</a>";
    })
    .join("");
  return buttons + '<div class="or"><span>or</span></div>';
}

function page(redirect: string, flow: string, error: string | null, state: string): string {
  const signUp = flow === "signUp";
  const title = signUp ? "Create account" : "Sign in";
  const toggleLabel = signUp ? "Have an account? Sign in" : "Need an account? Sign up";
  const toggleFlow = signUp ? "signIn" : "signUp";
  const toggleHref = "/auth/signin?redirect=" + encodeURIComponent(redirect) + "&flow=" + toggleFlow +
    (state ? "&state=" + encodeURIComponent(state) : "");
  const errHtml = error ? '<p class="err">' + esc(error) + "</p>" : "";
  // Without a redirect target there is nowhere to deliver tokens, so a form
  // would only dead-end on submit — render the message alone instead (reached
  // via the "/" recovery route and malformed sign-in links).
  const formHtml = redirect
    ? [
        '<form method="POST" action="/auth/signin">',
        '<input type="hidden" name="flow" value="' + flow + '">',
        '<input type="hidden" name="redirect" value="' + esc(redirect) + '">',
        '<input type="hidden" name="state" value="' + esc(state) + '">',
        "<label>Email</label>",
        '<input name="email" type="email" autocomplete="email" autocapitalize="none" required>',
        "<label>Password</label>",
        '<input name="password" type="password" autocomplete="' + (signUp ? "new-password" : "current-password") + '" minlength="8" required>',
        errHtml,
        '<button type="submit">' + esc(title) + "</button>",
        "</form>",
        '<a href="' + toggleHref + '">' + esc(toggleLabel) + "</a>",
      ].join("")
    : errHtml;
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
    "a.oauth{display:block;text-align:center;margin-top:12px;padding:14px;border-radius:14px;",
    "border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#fff;",
    "font-size:16px;font-weight:600;text-decoration:none}",
    ".or{display:flex;align-items:center;gap:10px;margin:20px 0 4px;color:rgba(255,255,255,.35);font-size:12px}",
    ".or:before,.or:after{content:'';flex:1;height:1px;background:rgba(255,255,255,.12)}",
    "</style></head><body><div class=\\"card\\">",
    "<h1>" + esc(title) + "</h1>",
    '<p class="sub">' + (signUp ? "Sign up to continue." : "Welcome back.") + "</p>",
    oauthButtonsHtml(redirect, state),
    formHtml,
    "</div></body></html>",
  ].join("");
}

function htmlResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// SECURITY: the sign-in page hands the freshly-minted JWT + refresh token to the
// redirect target via the URL fragment. ONLY the native app's custom scheme is
// allowed — never an http(s) origin — so a phishing link like
// /auth/signin?redirect=https://attacker.example can't exfiltrate user tokens.
const ALLOWED_REDIRECT_PREFIX = "botflowauth://";
function isAllowedRedirect(r: string): boolean {
  return r.startsWith(ALLOWED_REDIRECT_PREFIX);
}

// 303 into the native app with the tokens in the URL fragment (fragments never
// reach a server, so tokens stay out of any request logs). The state nonce is
// echoed back so the app can verify this callback belongs to the sign-in it
// started. Callers MUST have validated redirect with isAllowedRedirect first.
function tokenHandoffResponse(
  redirect: string,
  tokens: { token: string; refreshToken: string },
  state: string,
  extraHeaders?: Record<string, string>,
): Response {
  const dest =
    redirect +
    "#token=" + encodeURIComponent(tokens.token) +
    "&refresh=" + encodeURIComponent(tokens.refreshToken) +
    (state ? "&state=" + encodeURIComponent(state) : "");
  return new Response(null, {
    status: 303,
    headers: { Location: dest, "Cache-Control": "no-store", ...(extraHeaders || {}) },
  });
}

http.route({
  path: "/auth/signin",
  method: "GET",
  handler: httpAction(async (_ctx, request) => {
    const url = new URL(request.url);
    const redirect = url.searchParams.get("redirect") || "";
    const flow = url.searchParams.get("flow") === "signUp" ? "signUp" : "signIn";
    // Per-attempt nonce the native app generates and verifies on the callback;
    // threaded opaquely through the form so a forged callback can be rejected.
    const state = url.searchParams.get("state") || "";
    if (!isAllowedRedirect(redirect)) {
      return htmlResponse(page("", flow, "Invalid sign-in link.", ""), 400);
    }
    return htmlResponse(page(redirect, flow, null, state), 200);
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
    const state = String(form.get("state") || "");

    if (!isAllowedRedirect(redirect)) {
      // Never hand tokens to anything but the native app's own scheme.
      return htmlResponse(page("", flow, "Invalid redirect target.", ""), 400);
    }

    try {
      const result: any = await ctx.runAction(api.auth.signIn, {
        provider: "password",
        params: { email, password, flow },
      });
      const tokens = result && result.tokens;
      if (!tokens || !tokens.token || !tokens.refreshToken) {
        return htmlResponse(page(redirect, flow, "Sign-in failed. Please try again.", state), 200);
      }
      return tokenHandoffResponse(redirect, tokens, state);
    } catch (e) {
      const msg = flow === "signUp"
        ? "Could not sign up. The email may already be in use, or your password may be too short (8+ characters)."
        : "Could not sign in. Check your email and password.";
      return htmlResponse(page(redirect, flow, msg, state), 200);
    }
  }),
});

// ── OAuth bridge (server-driven — no client JS anywhere in this flow) ──
//
// Convex Auth's OAuth flow normally ends with a browser client exchanging a
// one-time ?code= for tokens. This app has no web client, so these two routes
// play that role server-side:
//   start  → runs auth:signIn for the provider, stashes the returned verifier
//            in a cookie, and 303s to Convex Auth's own authorize route
//   finish → the post-callback redirectTo target; redeems code + verifier for
//            tokens and hands them to the app exactly like the password path.

// The verifier cookie needs the same cross-site attributes Convex Auth uses
// for its PKCE/state cookies, or Safari drops it on the provider round-trip
// (top-level cross-site navigation back to this origin).
const VERIFIER_COOKIE = "botflow_oauth_verifier";
const VERIFIER_COOKIE_ATTRS = "; Max-Age=900; Path=/; Secure; HttpOnly; SameSite=None; Partitioned";
const CLEAR_VERIFIER_COOKIE =
  VERIFIER_COOKIE + "=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=None; Partitioned";

function readCookie(request: Request, name: string): string {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch (e) {
        return "";
      }
    }
  }
  return "";
}

// Friendly landing for anything that falls off the flow. Convex Auth's
// callback redirects to the bare SITE_URL origin when its redirect cookie is
// missing (e.g. a silent provider re-auth bounce dropped cookies) — without
// this route that's a dead-end "No matching routes found" page inside the
// in-app browser. There's no redirect/state to resume with, so the honest
// recovery is: close the sheet and start sign-in again from the app.
http.route({
  path: "/",
  method: "GET",
  handler: httpAction(async (_ctx, _request) => {
    return htmlResponse(
      page("", "signIn", "Sign-in did not complete. Close this window and try again from the app.", ""),
      200,
    );
  }),
});

http.route({
  path: "/auth/oauth/start",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const provider = url.searchParams.get("provider") || "";
    const redirect = url.searchParams.get("redirect") || "";
    const state = url.searchParams.get("state") || "";
    if (!isAllowedRedirect(redirect)) {
      return htmlResponse(page("", "signIn", "Invalid sign-in link.", ""), 400);
    }
    if (!OAUTH_PROVIDERS.some((p) => p.id === provider)) {
      return htmlResponse(page(redirect, "signIn", "Unknown sign-in provider.", state), 400);
    }
    // redirectTo is RELATIVE on purpose: the redirect callback in convex/auth.ts
    // always accepts relative paths, and Convex Auth resolves them against
    // SITE_URL — which Botflow points at this deployment's own *.convex.site
    // origin for Swift projects. The app's custom-scheme redirect and the state
    // nonce ride along as query params (neither is a secret).
    const finish =
      "/auth/oauth/finish?redirect=" + encodeURIComponent(redirect) +
      (state ? "&state=" + encodeURIComponent(state) : "");
    try {
      const result: any = await ctx.runAction(api.auth.signIn, {
        provider,
        params: { redirectTo: finish },
      });
      if (!result || !result.redirect || !result.verifier) {
        return htmlResponse(page(redirect, "signIn", "Could not start sign-in. Please try again.", state), 200);
      }
      // The verifier is the secret half of the code exchange — without it the
      // finish route's redemption silently fails. It never appears in a URL.
      return new Response(null, {
        status: 303,
        headers: {
          Location: String(result.redirect),
          "Set-Cookie": VERIFIER_COOKIE + "=" + encodeURIComponent(String(result.verifier)) + VERIFIER_COOKIE_ATTRS,
          "Cache-Control": "no-store",
        },
      });
    } catch (e) {
      return htmlResponse(page(redirect, "signIn", "Could not start sign-in. Please try again.", state), 200);
    }
  }),
});

http.route({
  path: "/auth/oauth/finish",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const redirect = url.searchParams.get("redirect") || "";
    const state = url.searchParams.get("state") || "";
    const code = url.searchParams.get("code") || "";
    if (!isAllowedRedirect(redirect)) {
      return htmlResponse(page("", "signIn", "Invalid sign-in link.", ""), 400);
    }
    if (!code) {
      // Convex Auth redirects here WITHOUT ?code= when the provider flow fails
      // or the user cancels at the consent screen. Land back on the sign-in
      // page (with its provider buttons) rather than a dead end.
      return htmlResponse(page(redirect, "signIn", "Sign-in was cancelled or did not complete. Please try again.", state), 200);
    }
    try {
      const verifier = readCookie(request, VERIFIER_COOKIE);
      const args: any = { params: { code } };
      if (verifier) args.verifier = verifier;
      const result: any = await ctx.runAction(api.auth.signIn, args);
      const tokens = result && result.tokens;
      if (!tokens || !tokens.token || !tokens.refreshToken) {
        // Missing/wrong verifier or expired code — Convex Auth returns
        // tokens:null rather than throwing. The code is single-use and now
        // burned, so the only recovery is starting over.
        return htmlResponse(page(redirect, "signIn", "Sign-in expired or failed. Please try again.", state), 200);
      }
      return tokenHandoffResponse(redirect, tokens, state, { "Set-Cookie": CLEAR_VERIFIER_COOKIE });
    } catch (e) {
      return htmlResponse(page(redirect, "signIn", "Sign-in failed. Please try again.", state), 200);
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
 * Render the per-provider cheat-sheet injected into the agent context. Generated
 * from the registry so this guidance never drifts from what the platform
 * actually supports.
 */
function buildOAuthProviderGuidance(): string {
  return OAUTH_PROVIDER_IDS.map((id) => {
    const p = OAUTH_PROVIDERS[id];
    const imp = p.authImport.default
      ? `import ${p.authImport.symbol} from "${p.authImport.from}";`
      : `import { ${p.authImport.symbol} } from "${p.authImport.from}";`;
    const notes = p.caveats.length ? `\n      notes: ${p.caveats.join(" ")}` : "";
    return `  • ${p.displayName} — setupOAuthProvider({ provider: "${p.id}" })
      ${imp}
      providers: [Password, ${p.providerExpr}]
      sign-in button: startOAuthSignIn(signIn, "${p.id}")${notes}`;
  }).join("\n\n");
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
                           If it also mounts /revenuecat/webhook, KEEP that
                           route — it receives the platform's payment events.
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
ADDING OAUTH / SOCIAL SIGN-IN (Google, GitHub, Microsoft, Apple):
─────────────────────────────────────────────────────────────

  ONLY DO THIS WHEN THE USER EXPLICITLY ASKS FOR SOCIAL SIGN-IN.
  Default to the Password provider (optionally Anonymous). Every OAuth provider
  requires the user to own a developer account and register an app — do NOT add
  one proactively. If auth is needed and no method was specified, use Password.

  THIS PLATFORM PROVIDES A DEDICATED TOOL: setupOAuthProvider
  DO NOT use bash or npx convex env set to set OAuth credentials. The tool
  collects credentials securely via a modal in the user's workspace and sets the
  provider's env vars on the Convex deployment — you never see them.

  SUPPORTED PROVIDERS (pass one id to setupOAuthProvider):

${buildOAuthProviderGuidance()}

  CORRECT SEQUENCE (any provider — replace <id> with the chosen provider id):

  Step 1 — Call setupOAuthProvider({ provider: "<id>" }). It opens the modal
           (which shows the user the redirect URI to register,
           ${convexSiteUrl}/api/auth/callback/<id>) and BLOCKS until the user
           completes or dismisses it (up to 5 minutes). On ok: true the
           provider's env vars are set on the deployment — you never see them.
           Until ok: true is returned, do NOT edit convex/auth.ts, add or expose
           a provider sign-in button, or claim that provider setup is complete.

  Step 2 — After ok: true, edit convex/auth.ts: add the provider's import (see
           the list above) and add it to the providers array alongside Password.
           Keep the existing callbacks.redirect block intact — only edit the
           providers array. Pass NO arguments to the provider; Microsoft and
           Apple read their extra env vars (issuer / client secret) automatically.

  Step 3 — Run convexDeploy to push the updated auth config.

  Step 4 — Add a sign-in button. OAuth can't complete inside the Botflow preview
           iframe (the provider page refuses to be framed), so ALWAYS use the
           scaffolded helper — never call signIn("<id>") directly for OAuth:

             import { useAuthActions } from "@convex-dev/auth/react";
             import { startOAuthSignIn } from "@/lib/botflowAuth";

             const { signIn } = useAuthActions();
             <button onClick={() => void startOAuthSignIn(signIn, "<id>")}>
               Sign in
             </button>

           Then call resumePendingOAuthSignIn ONCE at app mount so the new-tab
           handoff resumes automatically (Password/anonymous do NOT redirect —
           keep calling signIn directly for those):

             import { useEffect } from "react";
             import { resumePendingOAuthSignIn } from "@/lib/botflowAuth";
             useEffect(() => { resumePendingOAuthSignIn(signIn); }, [signIn]);

  APPLE — extra: Apple returns the user's name/email ONLY on the first sign-in.
  If you need their name, capture it then (it is never sent again). Apple also
  cannot be tested on localhost — use the deployed preview.

  If the user clicks Cancel in the modal, setupOAuthProvider returns ok: false.
  Do NOT retry automatically — acknowledge the cancellation and continue.

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
  • The user signs in with email + password on the hosted page (plus any social
    providers enabled via setupOAuthProvider — see OAUTH below). Tokens come
    back to the app; refresh is automatic via the auth:signIn action.

WHAT YOU MUST DO AFTER setupAuth RETURNS:
  1. Write each file in the returned \`files\` array (convex/auth.ts,
     auth.config.ts, http.ts, schema.ts, users.ts) with the write tool.
     NOTE: schema.ts now spreads authTables. If the project already had a
     schema, MERGE your existing tables into the new one (keep ...authTables).
     NOTE: if the returned http.ts also mounts /revenuecat/webhook, KEEP that
     route exactly as provided — it receives the platform's payment events.
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

OAUTH / SOCIAL SIGN-IN (Google, GitHub, Microsoft, Apple):
  • Available via the setupOAuthProvider tool — but ONLY when the user
    explicitly asks for social sign-in. Never add a provider proactively;
    password is the default.
  • The flow is entirely server-driven: after the tool succeeds you add the
    provider to convex/auth.ts (the tool returns the exact snippet) and run
    convexDeploy. The hosted sign-in page then shows a "Continue with …"
    button automatically. There is NO Swift code to write, NO native SDK to
    add, and NO redirect handling to build — the existing in-app-browser flow
    (BotflowAuthProvider) receives OAuth tokens exactly like password tokens.
  • Use the snippet's provider expression EXACTLY — for Google/GitHub/
    Microsoft it includes authorization params (prompt: "select_account").
    Those are REQUIRED on iOS: a returning user's silent provider bounce
    drops the OAuth cookies in the in-app browser and repeat sign-ins fail
    without the forced account picker.
  • If this project's convex/http.ts predates OAuth support (it has no
    /auth/oauth/start route), call setupAuth again to get the refreshed
    http.ts before deploying.
  • APP STORE RULE (nudge, don't force): guideline 4.8 requires iOS apps that
    offer third-party login (Google/GitHub/Microsoft) to ALSO offer Sign in
    with Apple. When the user enables one of those, tell them this and
    recommend adding Apple too — but it is their decision; proceed without it
    if they decline. Enforcement happens at App Review, not here.

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
    // Bound the request so a single hung deployment can't stall the Apple
    // rotation cron, which sweeps projects serially.
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    // Deliberately do NOT surface the upstream response body. This request's
    // payload carries secret env values (AUTH_*_SECRET, JWT_PRIVATE_KEY, Apple
    // client-secret JWTs); a Convex error that echoed the submitted `changes`
    // would otherwise leak those into our thrown message — which propagates to
    // client error text and server logs. Status code only.
    await response.text().catch(() => '');
    throw new Error(`Failed to set Convex env vars (status ${response.status}).`);
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
    // Platform backend. This function configures Convex Auth on an EXISTING
    // platform deployment — it never provisions one. Managed-Convex provisioning
    // lives only in the project-creation flow and the explicit deploy route,
    // where the per-tier managed-Convex cap is enforced. If the project has no
    // platform deployment yet, fail loudly rather than silently spinning one up
    // here (which would bypass that cap).
    deployUrl = project.convexDeployUrl ?? null;
    deployKey = project.convexDeployKey ?? null;

    if (!project.convexDeploymentId || !deployKey) {
      return {
        ok: false,
        error: "This project has no Convex deployment. Provision a backend first before setting up Convex Auth.",
      };
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

  const files = buildAuthBoilerplate(platform);

  // The boilerplate REPLACES convex/http.ts. If the RevenueCat receiver is
  // already scaffolded into this project, its /revenuecat/webhook route must
  // survive the replacement — otherwise the platform's signed deliveries 404
  // and paid entitlement events are dropped after the retry budget. Wire the
  // route into the fresh template before handing it to the agent. Keyed on the
  // receiver file actually existing (not revenuecatStatus) so we never emit an
  // import of a module that isn't there.
  try {
    const { sandboxReadFile } = await import("@/lib/vercel-sandbox");
    const receiver = await sandboxReadFile(projectId, "/convex/revenueCatWebhook.ts").catch(() => null);
    if (receiver?.content) {
      const httpFile = files.find((f) => f.path === "convex/http.ts");
      if (httpFile) {
        const { wireRevenueCatRoute } = await import("@/lib/revenuecat-scaffold");
        const wired = wireRevenueCatRoute(httpFile.content);
        if (wired) httpFile.content = wired;
      }
    }
  } catch (err) {
    console.error("[convex-auth-setup] RevenueCat route preservation failed:", err);
  }

  return {
    ok: true,
    files,
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
 * Apply an OAuth provider's credentials: map the collected fields to the Convex
 * Auth env vars (signing/deriving as needed — see src/lib/oauth-providers), push
 * them onto the deployment, and record the provider as enabled for this project.
 * For providers that need rotation (Apple) the signing inputs are persisted
 * encrypted at rest.
 *
 * Called server-side after the user fills in the workspace modal — credentials
 * never enter the sandbox, the client, or the agent.
 */
export async function applyOAuthProvider(
  projectId: string,
  provider: string,
  fields: Record<string, string>,
): Promise<void> {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new Error("Project not found.");

  const deployUrl = project.userConvexUrl ?? project.convexDeployUrl ?? null;
  const deployKey = project.userConvexDeployKey ?? project.convexDeployKey ?? null;
  if (!deployUrl || !deployKey) {
    throw new Error("No Convex deployment is configured for this project.");
  }

  // Map fields → env vars (validates required fields, derives MS issuer, signs
  // the Apple client secret). Throws a clear Error on bad/missing input.
  const result = buildOAuthEnvVars(provider, fields);

  // Persist the provider row FIRST (for Apple: the encrypted .p8 + expiry the
  // rotation cron needs) BEFORE pushing env to Convex — but mark it
  // "configuring", NOT "enabled", until the env push actually succeeds. This
  // gives us both invariants: (a) a live AUTH_APPLE_SECRET always has its
  // rotation inputs saved, and (b) the row is never reported "enabled" (and the
  // rotation sweep, which only scans enabled rows, never targets it) while the
  // secret hasn't actually reached Convex. A failed push leaves it "configuring";
  // the user retries (idempotent), and on success step 3 flips it to "enabled".
  const convexSiteUrl = deployUrl.replace(".convex.cloud", ".convex.site");
  const now = new Date();
  const baseCols = {
    redirectUri: oauthCallbackUrl(convexSiteUrl, provider),
    updatedAt: now,
  };
  const appleCols = result.persist
    ? {
        appleTeamId: result.persist.appleTeamId,
        appleKeyId: result.persist.appleKeyId,
        appleServicesId: result.persist.appleServicesId,
        applePrivateKeyP8: encryptSecret(result.persist.applePrivateKeyP8),
        secretExpiresAt: result.persist.secretExpiresAt,
      }
    : {};

  // 1) Persist inputs + mark configuring.
  await db
    .insert(projectOAuthProviders)
    .values({ projectId, provider, configuredAt: now, status: "configuring", ...baseCols, ...appleCols })
    .onConflictDoUpdate({
      target: [projectOAuthProviders.projectId, projectOAuthProviders.provider],
      set: { status: "configuring", ...baseCols, ...appleCols },
    });

  // 2) Push env to Convex (throws on failure — row stays "configuring").
  await setEnvVarsViaDeployKey(deployUrl, deployKey, result.env);

  // 3) Secret is live — mark enabled.
  await db
    .update(projectOAuthProviders)
    .set({ status: "enabled", updatedAt: new Date() })
    .where(
      and(
        eq(projectOAuthProviders.projectId, projectId),
        eq(projectOAuthProviders.provider, provider),
      ),
    );
}

/**
 * Re-sign "Sign in with Apple" client secrets nearing Apple's 6-month expiry.
 * Apple's client secret is an ES256 JWT we sign from the user's .p8;
 * applyOAuthProvider persists that .p8 (encrypted) + the expiry, and this sweep
 * — driven by a daily cron — re-signs any secret expiring within `withinDays`
 * and pushes the fresh value to that project's Convex deployment, so Apple
 * sign-in never silently breaks. Per-project failures are isolated and logged.
 */
export async function rotateExpiringAppleSecrets(
  withinDays = 30,
): Promise<{ checked: number; rotated: number; failed: number }> {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) + withinDays * 24 * 60 * 60;

  const rows = await db
    .select()
    .from(projectOAuthProviders)
    .where(
      and(
        eq(projectOAuthProviders.provider, "apple"),
        eq(projectOAuthProviders.status, "enabled"),
        lt(projectOAuthProviders.secretExpiresAt, cutoff),
      ),
    );

  let rotated = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const p8 = decryptSecret(row.applePrivateKeyP8);
      if (!p8 || !row.appleTeamId || !row.appleKeyId || !row.appleServicesId) {
        throw new Error("Missing or undecryptable Apple signing inputs.");
      }

      const [project] = await db.select().from(projects).where(eq(projects.id, row.projectId));
      const deployUrl = project?.userConvexUrl ?? project?.convexDeployUrl ?? null;
      const deployKey = project?.userConvexDeployKey ?? project?.convexDeployKey ?? null;
      if (!deployUrl || !deployKey) {
        throw new Error("No Convex deployment is configured for this project.");
      }

      const { secret, expiresAt } = signAppleClientSecret({
        teamId: row.appleTeamId,
        keyId: row.appleKeyId,
        servicesId: row.appleServicesId,
        p8,
      });
      await setEnvVarsViaDeployKey(deployUrl, deployKey, { AUTH_APPLE_SECRET: secret });
      await db
        .update(projectOAuthProviders)
        .set({ secretExpiresAt: expiresAt, updatedAt: new Date() })
        .where(eq(projectOAuthProviders.id, row.id));
      rotated++;
    } catch (err) {
      failed++;
      console.error(`[rotateExpiringAppleSecrets] project ${row.projectId} failed:`, err);
    }
  }

  return { checked: rows.length, rotated, failed };
}
