/**
 * Builds the short `appendSystemPrompt` we hand to Claude Code on every turn.
 *
 * Claude Code already has its own embedded system prompt that explains the
 * tools and operating environment. We just need to add project-specific
 * context that the official prompt can't know: project root, package manager,
 * Convex import rules, no-backend hard rules, etc.
 *
 * Keep it tight — anything Claude Code already covers (file paths,
 * tool-call semantics, etc.) we omit.
 */

export interface BuildAppendPromptInput {
  platform: "sandboxed-web" | "swift";
  hasBackend: boolean;
  /** Whether VITE_CONVEX_URL has been written to .env so the model knows. */
  hasConvexEnv?: boolean;
}

export function buildClaudeCodeAppendPrompt(input: BuildAppendPromptInput): string {
  const { platform, hasBackend, hasConvexEnv } = input;

  if (platform === "swift") {
    return [
      "# Botflow project context",
      "",
      "You are working inside a Vercel Sandbox that holds the source for a **native iOS Swift app**.",
      "Project root is `/vercel/sandbox`. The user opens this project in Botflow's web IDE; you edit files here, the user runs/builds the app on their own Mac.",
      "",
      "## Stack",
      "- Swift 6, iOS 18+, SwiftUI-first",
      "- XcodeGen-driven: `project.yml` is the source of truth, `MyApp.xcodeproj` is regenerated and NEVER edited by hand",
      "- Bundle prefix: `com.botflow`",
      "",
      "## Editing rules",
      "- Never edit `MyApp.xcodeproj/` — XcodeGen overwrites it from `project.yml`",
      "- For new target types (widgets, extensions), edit `project.yml` and tell the user to run `make generate` on their Mac",
      "- Don't try to run `xcodebuild` / `xcodegen` here — this is Linux; they require macOS",
      "",
      "## Source layout",
      "- `Sources/App/MyApp.swift` — `@main` entry point",
      "- `Sources/Models/`, `Sources/Views/`, `Sources/Core/` — code",
      "- `Resources/Assets.xcassets/` — images, app icon",
      ...(hasBackend
        ? [
            "",
            "## Convex backend",
            "This project has a **Convex backend** — the same TypeScript backend web projects use, consumed from Swift via the **ConvexMobile** SDK. Backend code lives in `/vercel/sandbox/convex/` (`schema.ts` + function files).",
            "- **Convex is the data layer; there is NO SwiftData.** Never add `@Model`, `ModelContainer`, or `import SwiftData` — the sync engine is the single source of truth.",
            "- Swift side: `Convex.shared.subscribe(to: ConvexAPI.Items.list, yielding: [Item].self)` for live queries; `try await Convex.shared.mutation(ConvexAPI.Items.add, with: [...])` for writes. Models are plain `Decodable`/`Identifiable` structs kept in sync with `convex/schema.ts` BY HAND (no schema codegen). Convex numbers need `@ConvexInt` / `@ConvexFloat` wrappers.",
            "- **Reference Convex functions ONLY through `ConvexAPI` constants** (`Sources/Core/ConvexAPI.swift`) — never a raw `\"file:function\"` string. The file is PLATFORM-MANAGED: it regenerates from the deployed backend on every `convex_deploy`, so a stale name becomes a compile error instead of a runtime ServerError. Never hand-edit it.",
            "- **Order matters**: (1) edit `/convex`, (2) `convex_deploy` — regenerates `ConvexAPI.swift`, (3) only then write Swift referencing the new constants. When repurposing the template demo, delete `Item.swift`/`ItemsStore.swift`/`convex/items.ts` outright and `Grep` `Sources/` for leftover raw `\"file:function\"` strings.",
            "- `Sources/Core/ConvexConfig.swift` is **PLATFORM-MANAGED — never edit** (Botflow injects the deployment URL and auth flag at build time).",
            "- After ANY change under `/convex/`, run the **`convex_deploy`** MCP tool — changes are not live until deployed. Debug server-side failures with **`get_convex_logs`** (Convex hides thrown error details from the client).",
            "",
            "### Auth (email + password, plus optional social sign-in)",
            "When the user wants sign-in / accounts / per-user data, call the **`setup_auth`** MCP tool ONCE. The Swift client side already ships in the template (in-app-browser sign-in: BotflowAuthProvider, Keychain, AuthStore, SignInView) — you do NOT write a native login form or any Swift auth code.",
            "- After it returns: write every file in its `files` (merge existing schema tables into the returned `schema.ts`, keeping `...authTables`), run `cd convex && pnpm add @convex-dev/auth @auth/core`, then `convex_deploy`.",
            "- The tool flips the app into authenticated mode automatically (`ConvexConfig.authEnabled` — platform-managed). Protect data with `getAuthUserId(ctx)` (returns null when signed out) using **tolerant reads, strict writes**: queries (anything subscribed) return `[]`/`null` when unauthenticated — NEVER throw, since live subscriptions can fire before the auth token attaches and a throw surfaces as a generic ServerError. Mutations/actions stay strict. Current user: the `users:viewer` query.",
            "- **Social sign-in (Google/GitHub/Microsoft/Apple):** available via the **`setup_oauth_provider`** MCP tool, but ONLY when the user explicitly asks — never proactively; password is the default. After it succeeds: add the provider to `convex/auth.ts` (the tool returns the snippet) and run `convex_deploy` — the hosted sign-in page shows the provider button automatically; there is NO Swift code to write and NO native SDK to add. If the project's `convex/http.ts` has no `/auth/oauth/start` route (predates OAuth support), run `setup_auth` again first to refresh it.",
            "- **App Store rule (nudge, don't force):** when the user enables Google/GitHub/Microsoft, tell them App Store guideline 4.8 also requires Sign in with Apple in apps offering third-party login and recommend adding it — but it is their decision; proceed without it if they decline.",
          ]
        : []),
      "",
      "## iOS Simulator (MCP tools — your run button)",
      "The user's workspace can stream a live iOS simulator running this project. It does NOT run while you work — Swift has no hot reload, and every start costs a full remote compile plus a simulator slot.",
      "- **`start_simulator`** — build + run in the user's workspace. Call ONCE, after your changes are complete and you believe the project compiles. The call BLOCKS until the build finishes (can take minutes) and returns the outcome: `build-succeeded` (with any warnings), `build-failed` (with compiler errors), `workspace-closed` (user's tab isn't open — tell them to open it), or `timeout` (build still running — check `get_simulator_status.lastBuild`). Never call it mid-work or on a known-broken build.",
      "- **`stop_simulator`** — stop the stream (user asked, or you're about to make the running build stale with a long edit batch).",
      "- **`get_simulator_status`** — cheap state check ('stopped' | 'starting' | 'building' | 'installing' | 'live' | 'failed') + `lastBuild` outcome/diagnostics.",
      "If `start_simulator` returns `build-failed`, FIX the reported errors and call it again — do not finish your turn on a broken build.",
      "",
      "Always restate the user's request, plan minimally, edit, verify with `Grep`/`Read`. Don't add comments unless the *why* is non-obvious. When you finish runnable work, call `start_simulator` so the user sees the result.",
    ].join("\n");
  }

  // sandboxed-web
  const sections: string[] = [
    "# Botflow project context",
    "",
    "You are working inside a Vercel Sandbox that holds the source for a **Vite + React web app**.",
    "Project root is `/vercel/sandbox`. The user's browser shows a live preview from the dev server running in this sandbox — your file edits are reflected via HMR within ~1s.",
    "",
    "## Stack",
    "- Vite + React + TypeScript",
    "- Package manager: **pnpm**. Use `pnpm install`, `pnpm add <pkg>`, etc.",
    "- Tailwind CSS for styling; shadcn/ui where applicable",
    "",
    "## Workspace control (MCP tools — your eyes and hands)",
    "These six MCP tools manage and observe the live preview. Prefer them over running `pnpm dev` / `tail` via Bash so the workspace UI stays in sync:",
    "- **`isDevServerRunning`** — cheap state check (~50ms)",
    "- **`startDevServer`** — start (or restart) the Vite dev server; returns the public preview URL once reachable (~30-45s on first install)",
    "- **`stopDevServer`** — kill the dev server",
    "- **`getDevServerLog`** — tail vite stdout/stderr (compile errors, HMR events)",
    "- **`getBrowserLog`** — read the USER'S browser console: runtime JS/React errors, console.log calls, HMR events from inside the preview iframe. **This is your only window into client-side problems.** Server logs won't show a React component crashing.",
    "- **`refreshPreview`** — force the preview iframe to hard-reload (~2s); only needed for changes HMR can't pick up (vite.config, env)",
    "",
    "**After any non-trivial change, call `getDevServerLog` AND `getBrowserLog` before finishing.** Untriaged errors are worse than admitting uncertainty.",
    "",
    "## AI image generation (`generate_image` MCP tool)",
    "Generate real images (hero shots, backgrounds, illustrations, placeholder photos, textures) instead of shipping gray boxes or hotlinking stock URLs. Pass `prompt`, `output_path` (project-relative, e.g. `public/images/hero.png` — use `.png`/`.jpg`), and optional `aspect_ratio` (`1:1` default; also `4:3`, `3:2`, `16:9`, `2.35:1`, `4:5`, `2:3`, `9:16`). The call blocks until the image is saved into the project (~10-30s), then reference it like any static asset (`/images/hero.png` for files under `public/`).",
    "**Each image costs the user credits** — generate what the design needs, but don't regenerate an image that already looks right and never call it speculatively.",
    "**Pro/Max feature** — for Free users the tool returns a tier-blocked error; relay it and do NOT retry, falling back to CSS/gradients or existing assets.",
  ];

  if (hasBackend) {
    sections.push(
      "",
      "## Convex backend",
      "This project uses **Convex** as its backend. Backend code lives in `/vercel/sandbox/convex/`.",
      "",
      "### Convex import rules (CRITICAL)",
      "The template has a `@convex` path alias mapped to `convex/_generated/*`. Use it everywhere — never relative paths.",
      "",
      "- ✅ `import { useQuery, useMutation, useAction } from \"convex/react\";` (always from the npm package)",
      "- ✅ `import { api } from \"@convex/api\";`",
      "- ✅ `import { Id, Doc } from \"@convex/dataModel\";`",
      "- ❌ `import { useQuery } from \"@convex/react\";` (this file doesn't exist)",
      "- ❌ `import { api } from \"../convex/_generated/api\";` (use the alias)",
      "",
      "### Deploying",
      "After editing files under `/vercel/sandbox/convex/`, call the **`convex_deploy`** MCP tool to push changes live. Do NOT run `npx convex deploy` via Bash — the deploy key is held server-side and is not available in this sandbox.",
      "The MCP tool returns the deploy output; if it succeeds, generated types in `/vercel/sandbox/convex/_generated/` are refreshed automatically.",
      "",
      "### Function rules",
      "- All exported functions must be wrapped: `query({ args, handler })`, `mutation(...)`, `action(...)`",
      "- All public functions require validators from `convex/values`",
      "- Tables must be defined in `schema.ts` before insert; indexes too",
      "- Queries are read-only; mutations can read+write transactionally; actions are for third-party API calls",
      "",
      "### Inspecting & editing data (no SQL — use these tools)",
      "Convex has no query language you can type ad-hoc. To look at or fix real data, use these MCP tools (they resolve the deploy key server-side — never try to reach the DB from the sandbox):",
      "- **`list_convex_tables`** — what tables exist.",
      "- **`read_convex_table`** — page through a table's documents (newest first). Use it to verify a mutation worked, debug what's stored, or grab `_id` values before an edit.",
      "- **`get_convex_logs`** — recent function executions + their errors/console output (see error catalog below).",
      "- **`write_convex_data`** — insert / patch / replace / delete documents directly, for one-off fixes, seeding, or corrections, without writing or deploying a function.",
      "",
      "**`write_convex_data` is confirmation-gated.** Call it FIRST without `confirmed` — it returns `status='needs-confirmation'` and a preview, and does NOT touch the DB. Show the user exactly what will change, confirm with the question tool, then call again with the SAME args plus `confirmed: true`. Never set `confirmed: true` on the first call. Prefer writing a proper mutation for anything recurring; reserve `write_convex_data` for one-off data work.",
    );
    if (hasConvexEnv) {
      sections.push("", "`VITE_CONVEX_URL` is already set in `/vercel/sandbox/.env`.");
    }

    sections.push(
      "",
      "## Stripe payments",
      "When the user asks for checkout, subscriptions, billing, a paywall, or any money-handling flow:",
      "1. Call the `initialize_stripe_payments` MCP tool first. On `status='already-connected'` or `'connected'`, three files appear in `/convex/`: `platformStripe.ts`, `stripeWebhook.ts`, `billing.ts`. Run `convex_deploy` to push them.",
      "2. Pick a product and reference it by its stable `lookupKey` — NEVER store or hardcode a `price_…` id (mode-specific; breaks on test/live switch). Use `get_stripe_products` to list what exists (each price has a `lookupKey`); if you need a new one, call `create_stripe_product` (unitAmount in cents — 1500 = $15.00; set `interval` for subscriptions) and store the returned `lookupKey`. A pre-made \"Demo Product\" exists out of the box, so you can call `createCheckoutSession` with no `lookupKey` while prototyping. Botflow handles modes: the lookupKey resolves to the active mode's price and is mirrored across modes on switch.",
      "3. Checkout UI: a React button that calls `useAction(api.platformStripe.createCheckoutSession)` with `{ lookupKey, successUrl, cancelUrl }` (lookupKey optional — omit for the Demo Product). It returns `{ ok, url?, sessionId?, error? }` and NEVER throws: on `result.ok` call `redirectToCheckout(result.url)` imported from `@/lib/botflowCheckout` (scaffolding drops this file), else surface `result.error`. ALWAYS use `redirectToCheckout`, never `window.location.assign` — Stripe Checkout can't load inside the Botflow preview iframe, so the helper hands the URL to the workspace to open in a new tab there (in the deployed app it just redirects normally).",
      "   IMPORTANT for subscriptions/paywalls/tiers: also pass `metadata: { appUserId: <the signed-in user's _id> }` to `createCheckoutSession`. That is the ONLY reliable way to map the subscription back to the user — it returns as `event.data.metadata.appUserId`. Stripe subscription events carry NO email, so never match on `customerEmail`.",
      "   DON'T rely on the webhook alone — verify on return. Set `successUrl` to carry the session id (Stripe substitutes it): `window.location.origin + \"/settings?session_id={CHECKOUT_SESSION_ID}\"`. On that page read `session_id` and call `useAction(api.platformStripe.reconcileSubscription)({ sessionId })` — it reads the truth from Stripe and runs your `billing.ts` tier logic right away, so the user is recognized as paid even if the webhook is slow or never fires. Also call `reconcileSubscription({ subscriptionId })` on load when a subscription id is stored, so cancels/renewals self-heal. The reactive viewer/profile query re-renders the UI.",
      "4. \"Open Stripe Dashboard\" link: `useAction(api.platformStripe.createDashboardLoginLink)` → `{ ok, url?, error? }`; when `ok`, pass `url` to `redirectToCheckout` (same iframe-safe handoff) or open in a new tab.",
      "5. Reaction logic (flip to a paid tier, revert on cancel) goes in `convex/billing.ts`. Inside `applyStripeEvent` switch on the NORMALIZED `event.type` (not raw Stripe names). Shapes: `subscription.activated` data `{ subscriptionId, customerId, status, priceId, metadata }`; `subscription.updated` `{ subscriptionId, status, priceId?, metadata }`; `subscription.canceled` `{ subscriptionId, cancelAtPeriodEnd?, status?, metadata }`; `payment.succeeded` `{ sessionId?, paymentIntentId?, amountTotal?, currency?, customerEmail?, metadata }`. Find the user via `event.data.metadata.appUserId` (step 3); on `subscription.activated`/`updated` set tier paid when `status` is `active`/`trialing`, on `subscription.canceled` revert to free. Run `convex_deploy`, then VERIFY with `get_convex_logs` that the tier was actually written — don't assume the webhook fired.",
      "",
      "**Enforced by tool guards (Bash/Write will refuse):**",
      "- No installs of `stripe`, `@stripe/stripe-js`, `@stripe/react-stripe-js`, `@stripe/connect-js`, or `@stripe/react-connect-js`. Card entry only ever happens on Stripe Checkout's hosted page.",
      "- No `<CardElement>`, `<PaymentElement>`, `<Elements>`, or any other component that collects card numbers/CVCs/bank details. If you reach for one, you want `createCheckoutSession` + redirect instead.",
      "- `convex/platformStripe.ts` and `convex/stripeWebhook.ts` are auto-generated and read-only; your edits would be overwritten. Edit `convex/billing.ts` for state-reaction logic.",
      "",
      "**Convex error catalog — recognize and fix without flailing:**",
      "- `Server Error` / `Called by client` with no detail → an action/mutation threw; Convex hides the message from the client. Call `get_convex_logs` (onlyErrors: true) to read the REAL server-side error. Fix: return `{ ok: false, error }` and read it on the client instead of throwing (the scaffolded `platformStripe.ts` already does this).",
      "- `Can't use fetch() in queries and mutations` → move the network call into an `action` (`\"use node\";` at top) and call it with `useAction`, not `useMutation`.",
      "- `No active price found for \"…\"` or `No such price` → you stored a raw `price_…` id (mode-specific) instead of a `lookupKey`, or referenced a product that was never created. Reference products by `lookupKey` from `get_stripe_products` / `create_stripe_product`, or omit lookupKey for the Demo Product.",
      "- Payment succeeds but the user stays on the free tier (upgrade button lets them pay again) → `billing.ts` isn't mapping the event to the user. Causes: matching on `customer_email` (subscription events have none), or not passing `metadata.appUserId` at checkout. Fix: pass `metadata: { appUserId }` in `createCheckoutSession`, read `event.data.metadata.appUserId` in `billing.ts`, patch the tier on `subscription.activated`, and confirm with `get_convex_logs`.",
      "- Convex calls hang / `xhr poll error` → the function isn't deployed. Run `convex_deploy` after editing `/convex/`.",
    );
  } else {
    sections.push(
      "",
      "## No backend — frontend-only project",
      "",
      "**HARD RULES:**",
      "- NEVER create a `/convex` directory",
      "- NEVER install `convex` or any `@convex-dev/*` package",
      "- NEVER import from `convex/react`, `@convex/api`, or any Convex module",
      "- NEVER set `VITE_CONVEX_URL` in `.env`",
      "",
      "For persistence use `localStorage`, `sessionStorage`, or IndexedDB. If the user wants a real backend, tell them this project was created with the 'No Backend' option and they'd need a new project to add one.",
    );
  }

  sections.push(
    "",
    "## Asking the user a question (`ask_question` MCP tool)",
    "Use `ask_question` when you genuinely need a decision from the user — the question renders inline in the chat as buttons. Each question takes `id`, `question`, `options` (each with `id`, `label`, optional `description`). Returns `{ answered: true, selectedIds, selectedLabels, customText }` or `{ answered: false }` on dismiss/timeout. Only ask when continuing without the answer would be guessing.",
    "",
    "## GitHub integration (only when a repo is linked)",
    "If the project has a GitHub repo linked, you will see `git_status`, `git_diff`, `git_commit`, `git_push`, `git_pull`, `git_resolve_conflict`, and `set_git_autonomy` in your tool list. When the project has no linked repo, these tools are not available — do not refer to them.",
    "",
    "**Autonomy modes** govern whether you commit on your own:",
    "- `autonomous` — call `git_commit` AND THEN `git_push` after meaningful changes; never claim something is 'pushed' or 'saved to GitHub' until `git_push` returns successfully",
    "- `manual` — never call git tools; the user saves from the GitHub panel",
    "- `ask-each-time` — use `ask_question` before each commit",
    "",
    "If a system note in the conversation says GitHub was just linked, your first move is `ask_question` for the autonomy mode, then `set_git_autonomy` with the user's pick. Until autonomy is set, do not call `git_commit` on your own.",
    "",
    "**Conflicts**: when `git_pull` returns conflicts, walk each path with `git_resolve_conflict` (side='ours' / side='theirs' / content=<merge>) and finalize with `git_commit`.",
    "",
    "## Style",
    "- Tailwind tokens / semantic colors, mobile-first responsive",
    "- For brand-new scaffolds, lean toward beautiful, ambitious initial designs (wow factor)",
    "- Never write comments that just restate what the code does",
  );

  return sections.join("\n");
}
