# Convex Auth for Swift projects (the auth continuation)

Follows `swift-convex-backend.md`, which deliberately left auth out of v1. This
adds it. The earlier "square peg" conclusion assumed a **native** auth UI needing
a first-party Swift `AuthProvider` (only Auth0/Clerk exist). We sidestep that:
the Swift app opens the **existing Convex Auth password flow in an in-app
browser** (`ASWebAuthenticationSession`) and bridges the resulting tokens back.
That makes `@convex-dev/auth` portable verbatim — the backend setup is reused
almost entirely.

## Why it works (verified against SDK + convex-auth source)

- **`convex-swift` contract** (`Sources/ConvexMobile/ConvexMobile.swift`):
  `ConvexClientWithAuth<T>` takes an `AuthProvider<T>` with exactly four methods:
  `login(onIdToken:) async throws -> T`, `loginFromCache(onIdToken:) async throws
  -> T`, `logout()`, `extractIdToken(from:) -> String`. The Rust client refreshes
  by calling **`loginFromCache`** (via an internal `AuthTokenProviderBridge`
  whose `getValidToken` invokes it on `forceRefresh`). So *refresh = our
  `loginFromCache`*.
- **The whole auth protocol is one Convex action.** `@convex-dev/auth`'s React
  client (`src/react/client.tsx`) does sign-in AND refresh through
  `action("auth:signIn", …)`:
  - password sign-in → `{ provider: "password", params: { email, password, flow } }`
  - refresh → `{ refreshToken }`
  - both return `{ tokens: { token, refreshToken } }` (refresh tokens rotate).
  The Swift base `ConvexClient.action<T: Decodable>(_:with:)` makes that exact
  call — no native auth UI, no new backend protocol.
- **Server setup is frontend-agnostic.** `setupConvexAuth` (RSA/JWKS env vars,
  `convex/auth.ts|auth.config.ts|http.ts|schema.ts|users.ts`, `authConfigured`)
  applies to Swift unchanged. The only web-only artifact is the React helper
  `src/lib/botflowAuth.ts`, replaced for Swift by (a) the Swift `AuthProvider`
  and (b) a Convex-hosted sign-in page.

## Architecture (self-contained — chosen)

The in-app-browser sign-in page is served from the **app's own Convex
deployment** via an `httpAction` (on `*.convex.site`), so a published App Store
build depends only on its own backend, never on botflow.io.

```
Swift app ──ASWebAuthenticationSession──▶ GET  https://<dep>.convex.site/auth/signin?redirect=botflowauth://auth-callback
                                          (httpAction renders an email/password form)
            user submits ───────────────▶ POST https://<dep>.convex.site/auth/signin   (same-origin, no CORS)
                                          httpAction runs ctx.runAction(api.auth.signIn,{provider:"password",params})
                                          → { tokens:{ token, refreshToken } }
            302 / location.href ◀──────── botflowauth://auth-callback#token=<jwt>&refresh=<rt>
Swift parses the fragment, stores refreshToken in Keychain, returns AuthData.
ConvexClientWithAuth refreshes by calling auth:signIn {refreshToken} via loginFromCache.
```

- **Callback scheme:** fixed `botflowauth` (no per-project Info.plist scheme
  needed — `ASWebAuthenticationSession` intercepts the scheme internally; it does
  NOT require `CFBundleURLSchemes` registration). Tokens travel in the URL
  **fragment** (`#`) so they never hit server logs or the `Referer` header.
- **Password-first.** Mirrors the web default (`Default to the Password
  provider`). OAuth (Google) is a later additive track — the httpAction page is
  written so it can host the provider redirect + verifier later.

## Build plan

### A. Template (`swift-convex-template`, `main`) — Swift client
Ships the auth scaffolding **inert by default** (auth is opt-in via `setupAuth`,
exactly like web ships `botflowAuth.ts` only when auth is configured). Gated by a
generated flag so a no-auth project builds + runs unchanged.

- `Sources/Core/ConvexConfig.swift` (generated/injected): add `authEnabled`
  (placeholder `false`) and a derived `siteURL` (`.convex.cloud`→`.convex.site`).
- `Sources/Core/Keychain.swift` — minimal Keychain wrapper (refresh token).
- `Sources/Core/BotflowAuthProvider.swift` — `AuthProvider` impl:
  `login` (ASWebAuthenticationSession), `loginFromCache` (refresh via
  `auth:signIn {refreshToken}`), `logout`, `extractIdToken`; `AuthCredentials`
  value type `{ token, refreshToken }`; an `ASWebAuthenticationPresentationContextProviding`.
- `Sources/Core/ConvexClient+Shared.swift` — when `ConvexConfig.authEnabled`,
  build `ConvexClientWithAuth(deploymentUrl:authProvider:)` and expose it as
  `Convex.auth`; `Convex.shared` stays the base type (subclass) for queries.
- `Sources/ViewModels/AuthStore.swift` — `@Observable` mirror of `authState`,
  `signIn()`/`signOut()`/`restore()` (calls `loginFromCache` on launch).
- `Sources/Views/SignInView.swift` — a single "Sign in" button that triggers the
  in-app browser (no native form — the web page IS the form).
- `ContentView.swift` — when `authEnabled`, gate the demo behind auth state
  (loading / SignInView / authenticated). No-auth path unchanged.
- README auth section rewritten (the old "out of scope" note is now wrong).

### B. Platform (`open-vibe-code`, branch `feat/swift-convex-followups`)
- `src/lib/convex-auth-setup.ts`: `setupConvexAuth(projectId, { siteUrl,
  platform })`. For `platform: "swift"`:
  - emit `convex/http.ts` with the auth routes **plus** the `/auth/signin`
    GET (render form) + POST (`runAction(api.auth.signIn)` → redirect) handlers;
  - emit `convex/auth.ts|auth.config.ts|schema.ts|users.ts` (same as web);
  - do NOT emit `src/lib/botflowAuth.ts`;
  - return a Swift-flavored agent `context` (no React snippets; explains the
    in-app-browser flow, that `setupAuth` flips `authEnabled`, and to gate the UI
    on `AuthStore`).
- `src/lib/sandbox-env.ts` (`materializeSwiftConvexConfig`): write
  `authEnabled = true` into `ConvexConfig.swift` when `project.authConfigured`.
- Agent tool: add `setupAuth` to the Swift backend toolset (gate on `hasBackend`,
  alongside `convexDeploy`/`getConvexLogs`). Wire from `agent/route.ts`.
- Swift agent prompt (`prompts.ts`): add an auth subsection to
  `SWIFT_CONVEX_SECTION` — when the user wants sign-in, call `setupAuth`, then
  `convexDeploy`, then gate the root view on `AuthStore`; never hand-edit
  `ConvexConfig.swift`; the sign-in UI is the hosted page, not a native form.
- `refreshAuthSiteUrl`: Swift has no published web origin, but the dev preview
  origin still matters only for OAuth/magic-link redirects — password needs only
  `SITE_URL`. Keep the existing call; it no-ops cleanly for Swift (no
  `cloudflareDeploymentUrl`).

## Test matrix (write before trusting any "done")

Backend / page — ✅ **VERIFIED 2026-06-09** via a scripted local e2e that
provisioned a throwaway Convex deployment, deployed the real emitted auth files
(incl. `SWIFT_AUTH_HTTP_TS`), exercised the endpoints, and deleted the project
(6/6 checks passed):
- [x] auth env vars (`JWT_PRIVATE_KEY/JWKS/SITE_URL/ALLOWED_SITE_URLS`) set on the
      deployment; Swift file set deploys; `botflowAuth.ts` NOT emitted for swift.
- [x] `GET /auth/signin?redirect=…` returns the HTML password form (200).
- [x] `POST /auth/signin` `flow=signUp` → **303** to
      `botflowauth://auth-callback#token=<valid 3-part JWT>&refresh=…`.
- [x] `POST` `flow=signIn` wrong password → error page (200), NO token/redirect.
- [x] `action auth:signIn {refreshToken}` (via `/api/action`) returns a fresh
      `{ token, refreshToken }` — the exact call `loginFromCache` makes.

Config injection:
- [x] `swiftConvexConfigContent`/`materializeSwiftConvexConfig` emit `authEnabled`
      (from `project.authConfigured`) + `siteURL`. Project `tsc` clean.

Swift build (this Mac, Xcode 26.5, real `xcodebuild` for the iOS Simulator):
- [x] Template builds with auth files present and `authEnabled = false` (inert) —
      **BUILD SUCCEEDED**, no `AuthenticationServices`/`Security` link errors.
- [x] With `authEnabled = true`, the `ConvexClientWithAuth` path compiles —
      **BUILD SUCCEEDED**.

Platform build gate:
- [x] Vercel production `next build` green on `feat/swift-convex-followups`.

End-to-end (botflow.io live, simulator) — **NOT yet run.** Every component is
independently verified (page works, Swift builds, refresh works), but the
integrated simulator flow is blocked on the preview by Vercel deployment
protection (SSO 401) + Clerk not allow-listing the preview origin. Best run on
prod after review/merge:
- [ ] Create Swift+backend project → agent `setupAuth` → `convexDeploy` →
      Rebuild → app shows SignInView.
- [ ] Tap Sign in → in-app browser → sign up → returns authenticated;
      `users:viewer` non-null; a protected query works.
- [ ] Kill + relaunch → `loginFromCache` restores the session silently.
- [ ] Sign out → back to SignInView.

## Loose ends discovered while testing
- **Convex project deletion is broken** (unrelated to auth): `deleteProject` in
  `convex-platform.ts` uses `DELETE /v1/projects/{id}` → **405**. Correct is
  `POST /v1/projects/{id}/delete` (confirmed). Deleted Botflow projects currently
  leak their Convex backends. Flagged as a separate task.
- **Template branch-pin** (`TEMPLATE_BRANCHES` in `vercel-sandbox.ts`): RESOLVED —
  `swift-convex-template@feat/auth` merged to `main` (PR #1), so the pin was removed
  and `swiftConvex` now clones `main` (which carries the auth scaffolding + the
  App Store publish template fixes).

## Out of scope v1 (unchanged)
Google/OAuth providers (additive: the page hosts the redirect later), magic-link
email, anonymous upgrade. Native sign-in form (the hosted page is the form).
