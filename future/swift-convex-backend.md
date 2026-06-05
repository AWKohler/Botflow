# Convex backends for Swift projects

Swift projects today are frontend-only (no backend), while `sandboxed-web`
projects get a full Convex backend. This plan adds Convex to Swift. The headline:
the `/convex` layer and admin tooling are already language-neutral, so ~70% of
this is reuse. The genuinely new code is one config-injection function plus the
Swift template's client wiring — and the one thing we deliberately drop is
SwiftData, which Convex's sync engine wholly replaces.

## Status (2026-06-03)

**Implemented + verified:**
- ✅ **`swift-convex-template`** built at `~/Documents/swift-convex-template`
  (clean git repo, initial commit). SwiftData removed; ConvexMobile `0.8.1`
  wired via XcodeGen; co-located `convex/` TS backend.
- ✅ **Milestone 1 (build spike) PASSED on real hardware** (Xcode 16.4, Apple
  Silicon). `make build` → **BUILD SUCCEEDED** for the iOS Simulator, including
  a clean **offline-resolution** rebuild → **Strategy B confirmed, no vendoring
  (C) needed.** Two fixes were required and are baked into the template:
  1. `EXCLUDED_ARCHS[sdk=iphonesimulator*] = x86_64` — the Rust xcframework
     (`libconvexmobile-rs`) has no x86_64 simulator slice (arm64-only). This was
     the exact "missing simulator slice" risk; controller + sim are arm64 so the
     exclusion is correct.
  2. `nonisolated(unsafe) static let shared` on the ConvexClient singleton —
     Swift 6 strict concurrency rejects the non-Sendable global otherwise.
  3. `Package.resolved` committed at repo root + restored into the workspace by
     `make generate` (the `.xcodeproj` is gitignored); `make build` passes
     `-onlyUsePackageVersionsFromResolvedFile -disableAutomaticPackageResolution`.
- ✅ **Plumbing** in webcontainer-ide (typechecks clean):
  - `swiftConvex` template in `TEMPLATE_REPOS` + `pickSandboxTemplate`
    (`vercel-sandbox.ts`); creation (`projects/route.ts`) + seed
    (`sandbox/seed/route.ts`) select it for `swift` + backend.
  - `materializeSwiftConvexConfig` (`sandbox-env.ts`) writes
    `Sources/Core/ConvexConfig.swift`; hooked into swift-preview `start`/`rebuild`
    just before tar.
  - `tarSandboxProject(projectId, { excludeConvex })` drops `/convex` from the
    simulator upload; swift-preview routes pass `excludeConvex: true`.
  - Backend-aware Swift agent prompt: `buildSwiftSystemPrompt({ hasBackend })`
    (`prompts.ts`) — adds the Convex section, forbids SwiftData.
  - `convexDeploy` + `getConvexLogs` tools added to `getPersistentTools` when
    `hasBackend`; wired from `agent/route.ts`.
  - Deploy route (`convex/deploy`) needed **no change** — already platform-agnostic.

**Also implemented (UI + integration, 2026-06-05):**
- ✅ **Template pushed** → `github.com/AWKohler/swift-convex-template` (public).
  The `TEMPLATE_REPOS` URL now resolves.
- ✅ **Backend choice for Swift at creation**: the homepage backend selector
  (none / platform / BYOC) now shows for `swift`, and `/start` + the page
  coercion guard treat swift as `supportsNoBackend` (plain `swift` vs.
  `swiftConvex`). `/start` already provisions platform/BYOC for swift.
- ✅ **Swift workspace UI** (`persistent-workspace/index.tsx`): fetches the
  project row; a **Database tab** reusing the platform-agnostic `ConvexDashboard`
  (embedded Convex dashboard); a header **Deploy** button (`convex/deploy`); and
  a one-time **provision-on-mount** safety net (`deployBackend({ silent })`) that
  fires only when a swift+backend project is unprovisioned.
- ✅ **Auto-reseed bug fixed elegantly**: `deployConvexFromSandbox` now derives
  the template from the project row via `pickSandboxTemplate` and regenerates the
  platform-correct config (Swift → `ConvexConfig.swift`, web → `.env`) instead of
  hardcoding `viteConvex`.

**Remaining / follow-ups:**
- **Initial schema deploy UX**: `/start` provisions the deployment URL but does
  not push the `/convex` functions. The app builds + connects to an empty
  deployment; data appears after the first Deploy (button or agent
  `convexDeploy`). The template UI degrades gracefully ("No items yet"). Consider
  an eager first-deploy if we want the demo populated on first preview.
- **Cross-component rebuild**: after a backend Deploy, the user clicks the
  preview's Rebuild to pick up the URL (we toast a hint). Could wire an automatic
  rebuild trigger from the Deploy button into `SwiftSimulatorPreview`.
- **BYOC connect entry point** inside the Swift workspace (today BYOC is chosen
  at creation via the existing homepage OAuth flow).
- **Auth**: out of scope (see below).

## The key insight: the backend is already portable

Convex integration splits into two halves; only the client half is web-specific.

| Layer | Web today | Reuse for Swift? |
|---|---|---|
| Provisioning (create project, deploy key, team token) | `src/lib/convex-platform.ts`, `src/app/api/convex/provision/route.ts` | ✅ verbatim |
| Function deploy (zip `/convex`, push to Fly worker) | `src/app/api/projects/[id]/convex/deploy/route.ts` | ✅ verbatim — language-agnostic |
| Admin / data / logs / env (HTTP admin API) | `src/lib/convex-admin.ts`, `src/lib/convex-env.ts` | ✅ verbatim |
| URL injection (`VITE_CONVEX_URL` → `.env`) | `src/lib/sandbox-env.ts` (`materializeFrontendEnv`) | ❌ needs a Swift equivalent |
| Client binding (React `useQuery`) | `vite_convex_template` | ❌ replaced by the Convex Swift SDK |
| Auth (`@convex-dev/auth`, RSA/JWKS, iframe OAuth) | `src/lib/convex-auth-setup.ts`, `botflowAuth.ts` | ❌ out of scope v1 (see below) |

The `/convex` TypeScript directory (schema + queries/mutations/actions) is
**identical** between a web and a Swift project and deploys through the same
pipeline. Only two things change: how the deployment URL gets baked into a native
app, and that React hooks become the Convex Swift SDK.

SDK: `get-convex/convex-swift`, `import ConvexMobile`. Wraps the Convex Rust
client. `ConvexClient.subscribe(...)` returns a Combine `Publisher` (live query
results); `mutation(...)`/`action(...)` are async. Decodes into `Decodable`
value-type structs. Docs: https://docs.convex.dev/client/swift

## Why we drop SwiftData

SwiftData and Convex are each *both* a source of truth *and* a reactivity engine,
and they're mutually incompatible by design:
- **SwiftData** persists `@Model` reference-type classes in a local SQLite store
  via `ModelContainer`/`ModelContext`; reactivity (`@Query`) is driven by local
  writes.
- **Convex Swift SDK** delivers query results as `Decodable` value-type structs
  pushed from the server via the sync engine; reactivity is Combine publishers.

Keeping both means owning a two-way sync layer (conflict resolution, identity
mapping, write ordering) plus the impedance mismatch that `@Model` isn't cleanly
`Decodable` and Convex payloads aren't `ModelContext`-managed — fighting both
frameworks for no benefit, because Convex's sync engine already provides the
reactive, persistent layer SwiftData was there to give.

Replacement (mirrors web's `useQuery`): Convex is the single source of truth;
local types are plain `Decodable`/`Identifiable` structs; SwiftUI binds through
`@Observable` view-models holding a `ConvexClient`. Template ships **zero**
`import SwiftData` / `@Model` / `ModelContainer`. (On-device offline cache, if
ever needed, is a separate additive concern — not SwiftData, not v1.)

## Decisions locked in

- **BYOC: in.** Reuses the web Convex OAuth flow (`src/app/api/oauth/convex/`),
  the `userConvexUrl`/`userConvexDeployKey` columns, and the URL resolver in
  `sandbox-env.ts`. Swift gets the same none / platform / BYOC toggle with no new
  backend logic.
- **Auth: out of scope v1.** The web flow is built on `@convex-dev/auth`. The
  Swift SDK's `ConvexClientWithAuth` needs an `AuthProvider`, and the only
  first-party Swift providers are **Auth0** and **Clerk** — there is no Swift
  `AuthProvider` for `@convex-dev/auth`. Porting the web impl would mean writing a
  provider from scratch + a native `ASWebAuthenticationSession` flow (Clerk here
  is for the *platform*, not user sub-apps). Square peg → skip `setupConvexAuth`
  for Swift entirely; sub-apps ship un-authenticated in v1. Future auth = a
  deliberate Clerk-native/Auth0 track, not a port.
- **Tarball: exclude `/convex` from the simulator upload.** The `xcodebuild`
  build never compiles the TS backend; shipping it is dead weight on every
  `start`/`rebuild`. The deploy pipeline zips `/convex` on its own separate path,
  so excluding it from the simulator tar doesn't touch deploys.
- **SDK dependency strategy: pre-warm, vendor as fallback.** The hot rebuild loop
  must never touch the network (see milestone 1).

## Milestone 1 — SDK build spike (HARD GATE, do first)

`convex-swift` is not pure Swift: its core is the Convex Rust client shipped as a
prebuilt `.xcframework`. Adding it makes `xcodebuild` (a) resolve the package
from GitHub, (b) download the binary, (c) link the **iOS-Simulator** slice
(`arm64-apple-ios-simulator`) — three things the current zero-dependency
swift-template build never did. Any can fail *only on the controller*. If the SDK
can't resolve-and-link through the real controller pipeline, nothing else
matters.

**Invariant we are designing toward:** the dependency is resolved ahead of time
and frozen, so a simulator build is pure local compile + link with **no live
fetch**. Live SPM resolution at build time is explicitly *not* acceptable for the
hot loop.

Strategy — **(B) pre-warm first, (C) vendor as fallback:**
- **(B)** Resolve `convex-swift` once on the controller Mac (the long-lived
  launchd host agent, e.g. `botflow-mba-26`) so it lives in SPM cache +
  DerivedData. Commit `Package.resolved` in the template to pin the version.
  Every later build is a cache hit. Get SDK updates by bumping `Package.resolved`
  + re-warming.
- **(C)** If the spike fails — controller can't/shouldn't have build-time network,
  or the published xcframework lacks the simulator slice — vendor the
  `.xcframework` directly and reference it as a local `binaryTarget`. Same
  template, different `project.yml` package stanza.

Spike steps:
1. Take today's swift-template, add **only** the `convex-swift` package + one
   trivial `ConvexClient(deploymentUrl:)` call. Commit `Package.resolved`.
2. Build on the controller to populate caches; run through the real
   `swift-preview/start` → controller → simulator path.
3. **Kill-network test:** disable outbound network, rebuild. Must still succeed.
   - passes → B holds, proceed.
   - fails → drop to C (vendor the simulator-slice xcframework locally).

## Milestone 2 — project model & creation

- `src/lib/vercel-sandbox.ts`: add `swiftConvex` to `TEMPLATE_REPOS`; extend
  `SandboxTemplate`.
- `src/db/schema.ts`: extend the `sandboxTemplate` union with `'swiftConvex'`.
  **No new columns** — existing platform columns (`convexProjectId`,
  `convexDeploymentId`, `convexDeployUrl`, `convexDeployKey`) and BYOC columns
  (`userConvexUrl`, `userConvexDeployKey`) are already language-agnostic;
  `backendType` simply stops being ignored for Swift.
- `src/app/api/projects/route.ts`: map `swift` + `backendType !== 'none'` →
  `swiftConvex`; run the same provisioning path `sandboxed-web` uses. Add the
  none / platform / BYOC backend choice to the Swift creation UI.

## Milestone 3 — URL injection (the one genuinely new piece)

Add a Swift analog of `materializeFrontendEnv`, e.g.
`materializeSwiftConvexConfig(projectId)`:
- Resolves the effective URL exactly like web (BYOC → `userConvexUrl`, else
  platform → `convexDeployUrl`), reusing the resolver in `sandbox-env.ts`.
- Writes `Sources/Core/ConvexConfig.swift` into the sandbox — a generated file:
  `enum ConvexConfig { static let url = "https://….convex.cloud" }`. Gitignored.
  The Swift analog of `import.meta.env.VITE_CONVEX_URL`.
- **Hook points:** call it just before `tarSandboxProject()` in
  `src/app/api/projects/[id]/swift-preview/start/route.ts` and
  `.../rebuild/route.ts`, so the URL is always baked into the bytes shipped to the
  simulator.
- Add `convex/` (+ `_generated/`, any `node_modules/`) to the exclusion list in
  the Swift-preview tar path.
- Mark the Swift config as platform-managed in `src/lib/platform-env.ts` so the UI
  shows it as reserved.

## Milestone 4 — deploy + agent + UI

- Reuse `src/app/api/projects/[id]/convex/deploy/route.ts` unchanged.
- Surface a "Deploy backend" action in the Swift workspace (and/or auto-deploy on
  backend file change); wire the `convexDeploy` agent tool
  (`src/lib/agent/sandboxed-web-tools.ts`) into the Swift agent toolset.
- Data/logs/env panels work as-is once the project carries deploy credentials
  (`convex-admin.ts` / `convex-env.ts` are frontend-agnostic).

## The new template: `swift-convex-template`

New GitHub repo (e.g. `AWKohler/swift-convex-template`) = today's swift-template
plus the Convex client and a co-located TS backend:

```
/                              (CWD = /vercel/sandbox)
├── Sources/
│   ├── App/MyApp.swift            @main; builds ConvexClient from generated config
│   ├── Core/
│   │   ├── ConvexConfig.swift     ← GENERATED, platform-injected URL  [gitignored]
│   │   └── ConvexClient+Shared.swift   shared client singleton / env object
│   ├── Models/                    Decodable/Identifiable structs (mirror schema.ts)
│   ├── ViewModels/                @Observable stores subscribing to Convex queries
│   └── Views/                     SwiftUI (the useQuery analog)
├── Resources/Assets.xcassets/
├── convex/                        IDENTICAL to web: schema.ts, queries, mutations
│   └── _generated/                written back by the deploy worker
├── project.yml                    XcodeGen — adds convex-swift SPM pkg + target dep
├── Package.resolved               pinned SDK version (milestone 1)
├── Makefile
└── deploy.sh
```

- `project.yml`: add a `packages:` entry for `convex-swift` + target dependency on
  `ConvexMobile`. (Or, under strategy C, a local `binaryTarget`.)
- `ConvexConfig.swift`: the injection target — never hand-edited.
- Swift agent prompt (`src/lib/agent/prompts.ts`): add a Convex section — `/convex`
  is backend source of truth; `Models` must be hand-mirrored from `convex/schema.ts`
  (no Swift codegen, unlike web's `_generated`); never edit `ConvexConfig.swift`;
  deploy via tool not by editing generated files.

## Sequencing

1. **SDK build spike** (gate). 2. Project model & creation. 3. URL injection +
tar hooks → first live query on the simulator. 4. Deploy + agent + panels.
Auth stays out of v1.
