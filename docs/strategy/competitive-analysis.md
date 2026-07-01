# Botflow — Competitive Analysis & Strategy

**Date:** June 2026
**Author:** Strategy synthesis (code-grounded + multi-source competitor research)
**Status:** Internal. Not part of the published docs site (plain `.md`, not in `docs.json`).
**Scope:** Botflow vs Lovable, Base44, Shipper, Cursor (web/cloud), Rork, Vibecode, Bloom.

> **How to read this.** Every claim about Botflow is grounded in the actual codebase (file paths cited). Every claim about a competitor is from June-2026 multi-source research (figures are cross-checked; soft figures flagged). The recommendations are weighted toward **market fit and UX**, not engineering cost — where a feature is *not* recommended, the reason is "it hurts our positioning or bloats the product," never "it's hard to build."

---

## 0. Executive summary

Botflow competes on **two fronts** simultaneously, and that is the central strategic fact:

- **Web front** — against Lovable, Base44, Shipper (and, adjacent, Cursor). Here Botflow is a competent, well-architected member of the Lovable class but **not the category leader** and not differentiated on the surface. This is a *table-stakes* front: you must be good, but you will not win the market here.
- **Native-mobile front** — against Rork (specifically **Rork Max**), Vibecode, and Bloom. This is where Botflow has a **genuine, defensible, and currently rare capability**: a real native-SwiftUI build/preview/publish pipeline. This is the front Botflow can actually *win* — but it is no longer uncontested.

**Botflow's two real moats** (both confirmed in code, both rare in the market):

1. **Bring-your-own Claude subscription via a real in-sandbox Claude Code subprocess.** Botflow runs the actual `claude` agent inside the user's Vercel Sandbox driven by the user's *personal* Claude Pro/Max OAuth token (`src/app/api/agent/claude-code/route.ts`, `src/lib/agent/claude-code/bridge-script.ts`). This is ToS-compliant and costs Botflow **zero** model spend. No competitor does this — Rork and Vibecode also use Claude Code, but *they* pay Anthropic.
2. **A managed native-iOS pipeline** — streamed real iOS Simulator preview from a Mac build farm, free-Apple-ID device sideload via a Companion app, and server-side App Store/TestFlight publishing with distribution signing the user never touches (`src/lib/asc-publish.ts`, `src/components/persistent-workspace/publish-to-app-store.tsx`, the `expo-simulator-stream` farm).

**The biggest threat:** **Rork Max** (launched Feb 2026) is an almost architecturally identical native-SwiftUI competitor — cloud Mac fleet, browser-streamed simulator, "2-click" App Store publish, Claude Opus 4.6 + Claude Code — and it is **already public, generating revenue, and well-funded** ($15M seed, a16z) while Botflow's Swift platform is still **private beta**. The native moat Botflow is building is the exact moat Rork already shipped.

**The biggest tailwind:** **Apple's March 2026 Guideline 2.5.2 crackdown** is actively blocking the *on-device* vibe-coding builder apps (Vibecode and Replit named; "Anything" pulled from the store). Botflow's web-IDE-plus-streamed-simulator architecture is **structurally insulated**. This is a positioning gift — "the vibe-coder Apple can't ban."

**Top actions (detailed in §8):**

1. Get **Swift out of private beta** and own/contest the public native-iOS moment — every week Rork is public and Botflow is gated, Rork compounds mindshare.
2. Build an **"App Store readiness AI"** (auto icon, screenshots, description, metadata, pre-flight rejection checks) — Rork shipped this; it is now table stakes on the native front.
3. **Weaponize the Apple 2.5.2 story** in positioning — it is the single best argument for Botflow's architecture over Vibecode/Bloom/Replit.
4. **Scale the Mac farm** (`vm-manager` is sized `{1,1}` on one Mac Air) — the native moat is operationally capped today.
5. Add a **visual / select-to-edit layer** — the one web-builder UX expectation Botflow lacks, and the most effective credit-burn reducer.
6. Make the **Convex "batteries-included backend"** story explicit on the native front — it is Botflow's clean win over Rork (BYO-Firebase) and a parity answer to Base44.
7. **Resolve the Android question** deliberately — either revive cross-platform on Vercel sandboxes or explicitly commit to "best real iOS." Drifting is the worst option.

---

## 1. The market map

The "vibe-coding" / prompt-to-app market in mid-2026 splits into three lanes. Most competitors live in exactly one. **Botflow is the only product credibly straddling the web and native-iOS lanes at once** — which is both its differentiation and its strategic burden.

| Lane | What it produces | Who plays here | Buyer |
|---|---|---|---|
| **Web builders** | Hosted React web apps (+ managed backend) | Lovable, Base44, Shipper, Bolt, v0, Replit | Non-technical founders, ops/marketing, designers |
| **Native-mobile builders** | Real iOS/Android apps (RN/Expo or native Swift) | **Rork**, Vibecode, Bloom, a0.dev | Indie hackers, mobile-first founders, "App Store entrepreneurs" |
| **Pro-dev agent tools** | PRs into your repo; you own infra | Cursor, Claude Code, Copilot | Professional engineers |
| **— Botflow —** | **Both** hosted web apps **and** real native iOS apps | **Botflow** | Non-technical → wants a real app in the store |

**Key structural reads:**

- **The web lane is saturated and capital-flooded.** Lovable alone is at ~$400–500M ARR, ~8M users, a $6.6B valuation (Dec 2025 Series B), ~100k projects/day. Base44 sold to Wix for ~$80M and is reportedly ~$100–150M ARR. Botflow will not out-scale these on the web front; it must be *good enough* there to be a credible single-tool answer, and win elsewhere.
- **The native lane is the real opportunity** — smaller, younger, less capitalized, and structurally harder (real builds, signing, Apple review). Rork is the clear front-runner ($15M seed, "top-2 Developer Tools," #1 referrer to RevenueCat), but the field is still forming.
- **Nobody bridges the lanes.** Industry consensus (per the research): *"For non-developers who outgrow Lovable, the path is to hire a developer who uses Cursor. There isn't a middle-ground tool that bridges the two categories."* Botflow's two-front presence is a genuine attempt at that bridge — **one tool that takes a non-technical user from idea to a shipped web app *and* a shipped App Store app.** That is a real, ownable story, if Botflow can tell it without looking unfocused.
- **Cursor is a complement, not a competitor.** Its web/cloud surface (Background/Cloud Agents, `cursor.com/agents`) outputs GitHub PRs for professional engineers; the "Cursor iOS app" is a PWA. It is where graduates go, not a head-to-head threat. Watch it only as a long-term signal of Anysphere lowering the skill floor.

---

## 2. Botflow today — authoritative capability baseline

This section is the code-grounded factual baseline. Everything in the comparisons (§3–§9) refers back to it.

### 2.1 Live platforms (and what's deprecated)

The canonical enum is in `src/lib/project-platform.ts`. Only **two surfaces are live**:

| Platform (stored) | Label | Status | Stack | Runtime |
|---|---|---|---|---|
| `sandboxed-web` | "Web" | **GA, default, always-on** | Vite + React + TS (+ Convex optional) | Vercel Sandbox |
| `swift` | "Swift" | **Private beta, gated** | Swift 6 / SwiftUI / iOS 18, XcodeGen (+ ConvexMobile) | Vercel Sandbox (edit) + remote Mac (build/sim/publish) |
| `web`, `mobile`, `multiplatform` | "Web" | **Deprecated, uncreatable** | (WebContainer / Expo) | — |

- `getEnabledProjectPlatforms()` returns `["sandboxed-web"]` plus `"swift"` when `NEXT_PUBLIC_ALLOW_PERSISTENT_EXP` is on; Swift additionally requires per-user `publicMetadata.isBeta` (`swiftRuntimeForbidden`, enforced at every runtime endpoint, not just creation).
- **The React-Native `mobile` and `multiplatform` ("Universal") platforms are dead.** They died in the WebContainer→Vercel-Sandbox migration. **Botflow uses no Expo / React Native at all today** — a project is either **web** (Vite/React) or **mobile = Swift** (SwiftUI + Convex). The Expo templates (`react-native-convex-template`, `universal-native-convex-template`) and any RN strings left in the codebase are inert remnants, not live code paths. **Botflow has no live Android or cross-platform-native story today.** Native = Apple-only via SwiftUI. (A cross-platform revival is *planned but shelved* under the name **"Universal"** — RN-for-web + iOS + Android, a future **Web / Swift / Universal** lineup; see §8A#8. Not a current capability.)

**Backend type** is an orthogonal axis (`BackendType = "platform" | "user" | "none"`): Botflow-managed Convex, bring-your-own-Convex (OAuth), or frontend-only. Default is `none` — a project never silently provisions a backend.

### 2.2 The AI agent layer

Two backends, selected automatically per turn by `deriveAgentBackend()` (run on both client and server so it can't be spoofed):

- **Botflow agent (`/api/agent`)** — ai-sdk `streamText` with server-side tool execution against the sandbox. Default for all non-Anthropic models and for Anthropic-via-BYOK/platform-key. Tools are platform-specific (`sandboxed-web-tools.ts`, `persistent-tools.ts`): file ops, dev-server/preview control, browser-log capture, and (with backend) `setupAuth`, `setupOAuthProvider`, `convexDeploy`, `getConvexLogs`, `list/read/writeConvexData`, plus Stripe tools when enabled.
- **Claude Code agent (`/api/agent/claude-code`)** — runs a real `claude` subprocess **inside the user's sandbox** via `@anthropic-ai/claude-agent-sdk`, driven by the user's **own Claude Pro/Max OAuth subscription**. Sensitive tools (Convex deploy, Stripe, git) call back to Next.js over HTTPS with a short-lived bearer token so platform secrets never enter the sandbox. ToS-compliant; **zero platform model cost**. (See §0 moat #1.)

**Models** (single source: `src/lib/agent/models.ts`): GPT-5.3 / 5.4 / 5.5, Claude Sonnet 4.6, **Claude Opus 4.8**, Claude Fable 5, Gemini 3.1 Pro, MiniMax-M3, GLM-5.2, **Kimi K2.6 (the default)**. Up to 1M-token context. Credentials resolve OAuth → personal BYOK → server platform key. **BYOK/OAuth traffic consumes zero Botflow credits.**

**Pricing/credits** (`src/lib/tier.ts`, `src/lib/credits.ts`): Clerk billing, tiers **free / pro / max**. Credits are normalized to "MiniMax-equivalent tokens" ($0.30/MTok base) with per-model multipliers (×1 MiniMax → ×20 Fable). Free ≈ 3 projects / Kimi-K2.6-class models only; Pro/Max unlock the frontier models on the server key. This is **more model choice and more pricing transparency than any competitor** (most ship a single hidden model and an opaque "credit ≈ a message" unit).

### 2.3 The web pipeline

- **Runtime:** one persistent **Vercel Sandbox** (real Linux microVM) per project, `node22`, 30-min timeout with auto-extend while active, snapshot persistence (90-day), and a reaper subsystem for idle projects (`src/lib/vercel-sandbox.ts`).
- **Backend:** **Convex** (not Supabase), auto-provisioned (managed or BYO-Convex via OAuth), with automated **Convex Auth** setup (`setupAuth`), Google OAuth provider wiring, and direct data tools. Real-time, typed, single source of truth.
- **Deploy:** one-click to **Cloudflare Pages** (`*.pages.dev`), with **managed custom domains** (NS delegation + full DNS management) and legacy CNAME, plus a **public showcase / Explore** with fork-as-template (`/explore`, `/p/[slug]`).
- **GitHub:** real git *inside the sandbox* (link/commit/push/pull/PR/conflict-resolve) with a per-project autonomy mode (autonomous / manual / ask-each-time). **Users own real, exportable code** — no lock-in.
- **Visual editor (exists, web):** a real select-to-edit layer — a `BF_EDITOR_*` postMessage picker injected into the dev server's Vite config (`src/lib/preview-editor/wrapper.ts`), a context panel (`VisualEditorPanel.tsx`), and a write-back route (`/api/projects/[id]/visual-edit`) that splices the change into the exact JSX node via a `data-bf-loc` stamp. **Scope is narrow:** persists **className/Tailwind only** (background, text color, font size, align, or raw classes), **no text editing**, **no structure**, **bails on dynamic `className={…}`**, and **web-only in practice** (DOM/JSX-based; the streamed SwiftUI simulator has none). See §8A#5 — the action is to *deepen* it, not build it.
- **Monetization for generated apps:** **Stripe Connect** (Checkout-only, gated `STRIPE_CONNECT_ENABLED`, Pro/Max).

### 2.4 The native pipeline (the differentiator)

Built on the **`expo-simulator-stream`** Mac build farm (legacy name — *no Expo involved*, the repo just hasn't been renamed; it's the live Swift/iOS build-and-stream farm). One Mac (`100.119.219.31`, Tailscale), Controller + Host Agent + a `vm-manager` tart VM pool currently sized **`{1,1}`**.

Three iOS rails off one farm:

1. **Simulator preview** — `runBuild()` (unsigned, `-sdk iphonesimulator`) → **real iOS Simulator streamed to the browser** over token-secured WebSocket (iPhone-16-Pro / iPad-Pro), with interactive touch, device rotation, and even webcam→simulator-camera injection.
2. **Device sideload (Companion)** — `runDeviceBuild()` produces an unsigned IPA; the **Botflow Companion** Mac app re-signs with the user's *free* Apple ID and installs to a USB iPhone (AltStore-style, 7-day expiry). Explicitly modeled on Rork's Companion.
3. **App Store / TestFlight** — `runAppStoreBuild()` does distribution-signed archive → export → **WWDC25 BuildUpload REST** upload. The farm even goes *beyond* the planning docs: it does **device-free distribution signing via CSR** (because `-allowProvisioningUpdates` fails on a headless server) — minting the cert, creating an `IOS_APP_STORE` profile with no devices, importing to a signing keychain, and manual-signing. Botflow does the ASC REST half (validate `.p8`, find/register bundle id, next build number, processing-state polling — `src/lib/asc-publish.ts`); the Mac does only what's physically local.

**The publish UX** (`publish-to-app-store.tsx`, ~1,844 lines) is a polished 3-step wizard: App Info → Apple Developer key (ASC `.p8` stored in Clerk privateMetadata) → Submit, with a 6-stage live progress (Queued → Building → Exporting → Uploading → Processing(Apple) → Done) ending in "In TestFlight ✅."

**Native monetization:** **RevenueCat** (BYO-account, gated `REVENUECAT_ENABLED`, Pro/Max) for iOS in-app purchases.

> **Honest status flags:** Swift is private beta; App Store publishing is implemented end-to-end in code but the live signing "Spike 0" + integrated production run are the last unverified link; the build farm is **one Mac** (`{1,1}`); Stripe Connect and RevenueCat default **off** until verified; there is **brand ambiguity** (Botflow.io / "OpenVibeCode" / `open-vibe-code`).

### 2.5 What the user must still bring for native (be precise)

Botflow's native pipeline abstracts **Xcode, EAS, certificates, provisioning, and signing** — but, like every competitor, it **cannot abstract Apple itself**:

- The user still needs an **Apple Developer Program membership ($99/yr)** and supplies an **App Store Connect API key (`.p8`)**.
- The **app record must be created once by hand** in App Store Connect — Apple has *no* create-app API for `.p8` keys. The wizard deep-links and auto-detects completion, but the manual step is unavoidable (it's why Rork instead demands the user's Apple ID *password*).

So the honest wedge is **"no Xcode, no EAS CLI, no cert wrangling, server-side signing you never see"** — *not* "no Apple account." Marketing must not over-claim here, or the first power user will call it out.

---

## 3. Competitor deep dives

Each competitor below ends with an explicit **head-to-head**: where Botflow wins, where it loses.

### 3.1 Lovable — the web-lane giant

**Snapshot:** Founded 2023 (Stockholm), grew out of GPT-Engineer. ~$400–500M ARR, ~8M users, **$6.6B valuation** (Dec 2025 Series B, $330M). ~120–150 FTEs. Enterprise now ~half of revenue.

**What it is:** The category-defining prompt-to-web-app builder. React + (now) **TanStack Start SSR** + Tailwind + shadcn/ui, **Supabase-powered "Lovable Cloud"** backend (managed DB/auth/storage/edge functions), two-way GitHub sync, real ownable code. Chat Mode (plan/debug without editing) + agentic build mode + **Visual Edits** (click-to-edit). Multiplayer workspaces. One-click publish to `*.lovable.app` + custom domains.

**Market fit:** Strongest greenfield-MVP and designer/non-coder tool in the world right now. The magic is front-loaded (seconds to a polished, deployed app).

**Native story:** **None.** Web/PWA only; docs explicitly say native isn't supported. "Native" requires the user to export and wrap with Capacitor/Expo themselves (App Store 4.2 rejection risk). A whole third-party ecosystem (Newly, CatDoes, RapidNative) exists *purely to bolt React Native onto Lovable apps* — a loud signal of unmet native demand in exactly Botflow's target base.

**Weaknesses:** Credit burn / "slot-machine" feel and debugging "doom loops" are the load-bearing complaints. Falls apart beyond prototypes. **Security:** CVE-2025-48757 — mass missing Supabase RLS exposed 170+ apps; a real, public "secure-by-default" failure. Strategic dependency risk: married to Supabase and Claude, and Anthropic itself launched "Claude Design" (Apr 2026) moving on the category.

**Head-to-head vs Botflow:**
- *Botflow wins:* native iOS (Lovable has zero), BYO-Claude-subscription cost model, multi-model choice + transparent credits, real native monetization (RevenueCat).
- *Botflow loses:* brand, scale, capital, web polish, designer love, Visual Edits, multiplayer, default-design quality, sheer momentum. On the **pure web front, Botflow cannot beat Lovable** — it can only be a credible single-tool alternative whose reason-to-exist is the native front.

### 3.2 Base44 — Wix-owned, batteries-included

**Snapshot:** Solo founder (Maor Shlomo), bootstrapped to ~$3.5M ARR in 6 months, **acquired by Wix for ~$80M cash** (July 2025, + earn-outs). Now 2M+ users, Wix-reported ~$100–150M ARR.

**What it is:** The "all-in-one, no-integrations-needed" web builder. React SPA frontend + a **fully built-in backend**: NoSQL DB, native auth (email + Google/Microsoft/Facebook/Apple + SSO), row/field-level security, file storage, Deno serverless functions, realtime, email, image/text gen, analytics — *all first-party*. Fastest prompt-to-app (~6 min). "Discuss mode" plans cheaply (0.3 credits). Default model Claude Sonnet 4.5.

**Market fit:** The simplest end-to-end experience for non-technical users who never want to think about a stack. Single login, single bill, batteries included.

**Native story:** **Web-only.** Native export is an open, unfulfilled feature request; the same third-party wrapper ecosystem applies.

**Weaknesses:** **Vendor lock-in is the #1 complaint** — the managed backend never leaves Base44; "migration would be a rebuild, not a port." Trustpilot ~2.5. Post-Wix trust erosion: support went from hours to weeks, quiet price hikes, custom integrations dropped for new builds (~Mar 2026), a Feb-2026 outage, and a critical SSO auth-bypass (Wiz, July 2025). No SLA, no public roadmap.

**Head-to-head vs Botflow:**
- *Botflow wins:* native iOS; **no lock-in** (real exportable code + GitHub + Convex-or-BYOC) vs Base44's closed backend; model choice; not subject to Wix's SMB-roadmap drift.
- *Botflow loses:* the **batteries-included simplicity**. Base44's "describe it, it runs, zero setup" is genuinely lower-friction than wiring Convex + auth + deploy. Botflow's Convex is powerful but the *experience* isn't as turnkey. This is a UX gap to close on the web front (see §8B).

### 3.3 Shipper (shipper.now) — small, web-only

**Snapshot:** Bootstrapped, ~3 people, launched ~Feb 2026, likely a **Hostinger** product, ~$1k MRR (founder's own figure; aggregator "$330k" is unreliable). Very early.

**What it is:** A Lovable-class web builder (React + TS, hosted on `*.shipper.now`) with two twists: **"The Advisor"** (a strategic AI layer suggesting what to build/grow next) and **bot builders** (Discord/Slack/WhatsApp). Multi-model on the MAX tier (Opus/Gemini/DeepSeek). Clean code export.

**Native story:** **None real.** It can *emit* React Native source, but you compile/sign/submit yourself — zero managed pipeline. Hosted web output can't reach the App Store as-is.

**Head-to-head vs Botflow:** High overlap on web, near-zero on native. Botflow wins decisively on real native + managed submission. Shipper is not a serious threat; watch only as a signal that Hostinger may pour distribution into the category.

### 3.4 Cursor (web/cloud) — pro-dev complement

**Snapshot:** Anysphere. The cloud/web surface is **Cloud Agents** (async agents in Ubuntu VMs), the `cursor.com/agents` web app, Slack/Linear/Jira automations, and Composer models (Composer 2 built on Kimi K2.5). Customers: Nvidia, Uber, Adobe.

**What it is:** A control plane for cloud coding agents that **output GitHub PRs**. Requires a repo, diff/PR literacy, and you own deployment/DB/infra. Explicitly pro-developer; the "iOS app" is a PWA.

**Head-to-head vs Botflow:** **Low overlap — complement, not competitor.** A non-developer cannot go idea→shipped app here. Cursor is the "graduate to a developer" destination at the *end* of the funnel Botflow sits *inside*. No native publishing pipeline. Relevant only as a long-horizon watch item.

### 3.5 Rork — the direct collision ⚠️

**This is the most important competitor in this document.** Rork attacks the *exact* wedge Botflow is building.

**Snapshot:** Founded by Daniel Dhawan & Levan Kvirkvelia (SF). **$15M seed (Apr 2026, Left Lane; a16z Speedrun earlier).** Notably, **Expo's co-founder and lead RN engineer are investors.** Acquired Paperline (a Swift-AI macOS app) — the tech behind Rork Max. Claims: $1.5M ARR in 3 days post-Max-launch, top-2 App Store "Developer Tools," **#1 referrer to RevenueCat**.

**Two products:**

| | **Rork Pro** | **Rork Max** |
|---|---|---|
| Output | **React Native + Expo** | **Native Swift / SwiftUI** |
| Targets | iOS, Android, Web | Apple-only (iPhone/iPad/Watch/TV/Vision) |
| Launched | Feb 2025 | **Feb 2026** |
| Publish | Expo token + **EAS Build** + Apple 2FA + manual ASC metadata (clunky) | **"2-click" cloud publish** — enter Apple Developer creds (not stored), cloud Mac fleet signs + submits |
| Preview | Expo Go (QR) | **Browser-streamed real iOS Simulator at 60fps** + QR-to-device |
| Model | (GPT-5-class, per one source) | **Claude Opus 4.6 + Claude Code**, compile-fix agent loop |

**Rork Max ≈ Botflow's Swift platform, feature-for-feature:** cloud Mac fleet, browser-streamed real simulator, Companion/QR device install, App Store publish via the user's own Apple credentials, Claude Code engine, RevenueCat monetization. They even shipped an **"App Store Publishing AI"** (~Nov 2026) that auto-generates icon, screenshots, description, and an SEO'd store page and is pitched as "prevents review rejections."

**Where Rork is weak (Botflow's openings, all confirmed against Botflow's code):**
- **No built-in backend.** Rork Pro/Max make you **BYO Firebase/Supabase**. Botflow auto-provisions **Convex** + Convex Auth (including the clever Swift in-app-browser Convex Auth flow). **This is Botflow's single cleanest win over Rork.**
- **No visual editor**; chat-only tweaks burn credits on UI iteration.
- **No checkpoints/rollback**; context loss after ~3–4 iterations.
- **Reliability:** "broken previews," publish-button fails first try, Trustpilot ~2.9–3.2. Publish often falls back to manual GitHub export.
- **Rork Max is Apple-only** (no Android from Max).
- **Apple approval at scale is unproven** — an Apple Developer Forum thread ("What is Apple going to do about Rork Max") raises Guideline 4.3 (spam/duplicate) risk; no independent end-to-end "approved & live" Max app is documented.

**Where Rork is ahead of Botflow (the uncomfortable part):**
- **It's public, monetizing, and funded**; Botflow's Swift is private beta. Time-to-market mindshare is compounding *now*.
- **App Store Publishing AI** (auto-metadata) — Botflow has no equivalent yet.
- **Two products cover both RN-cross-platform and native-Swift**; Botflow has only native-Swift live.
- **Marketing/distribution machine** (8M X views on the Max launch, RevenueCat #1 referrer).
- One Opus version behind is irrelevant; Botflow has **Opus 4.8** available, a slight edge, but execution/mindshare dominate.

**Head-to-head verdict:** This is a genuine fight, and Rork is currently winning on go-to-market while Botflow is at parity-or-better on architecture and **ahead on backend**. The battle plan is §9.

### 3.6 Vibecode — well-funded on-phone RN builder

**Snapshot:** Riley Brown & Ansh Nanda (SF). **$9M seed (Aug 2025).** ~$10M ARR (3× after adopting Claude Opus 4.5), 40k+ apps, 50–200 staff. A featured Anthropic customer.

**What it is:** "The mobile app that builds mobile apps" — build **React Native + Expo** apps *from your phone* by prompting. Engine is **Claude Code + Claude Opus 4.5** (same family Botflow uses; Botflow is a version ahead at Opus 4.8). Built-in image/sound gen, auto AI-API integrations, web→mobile conversion. In-app "Publish on App Store" GUI → Expo Launch/EAS cloud build (~20 min).

**Native/publish friction:** Still requires the user's **own $99/yr Apple Developer account**, an Expo token, signed Apple agreements, and a multi-step dance. Builds via EAS; cert handling delegated to Expo (opaque).

**The critical risk (see §4):** Vibecode is an **on-device builder app**, and Apple's **Guideline 2.5.2** crackdown named it explicitly (Mar 2026). It had to push live previews to an external browser; listing churn ("Website Builder" / "Expo Go AI Builder" variants) suggests compliance scrambling.

**Head-to-head vs Botflow:**
- *Botflow wins:* **architecture not exposed to Apple's 2.5.2** (web IDE, not an iOS app); native **SwiftUI fidelity** vs RN; auto-provisioned Convex backend; managed signing (no EAS token dance); Opus 4.8.
- *Botflow loses:* the **on-phone build magic** (build from your iPhone), media generation breadth, funding, ARR, and a slick in-app submission GUI. Vibecode's "build an app while on the toilet" UX is genuinely compelling to its base — but it's the very thing Apple is attacking.

### 3.7 Bloom — Expo + Convex, App-Clip distribution

**Snapshot:** David Oort Alonso & Sirian Maathuis. YC X25, **$3.4M pre-seed (Moonfire, YC, Pioneer)** — backed by **Convex and Expo insiders**. "Tens of thousands" of builders. Pivoted from "Fireview."

**What it is:** Build native mobile apps from your phone, no code. **Exports a standard Expo + Convex project** — i.e., **the same backend stack as Botflow**, cross-platform RN frontend, OAuth auth, fully exportable + GitHub-syncable. Headline feature: **instant share via link/QR/App Clip — no install, no App Store, no dev account.** Most generous free tier (700 credits/mo).

**Native/publish friction:** Bloom's "no App Store / no dev account" claim is **only true for the throwaway App Clip/share-link experience.** A real App Store listing is **fully DIY**: export the code and run `eas build` yourself with your own Apple account and Transporter — arguably *more* friction than Vibecode, because Bloom doesn't even GUI it.

**Head-to-head vs Botflow:**
- *Botflow wins:* **end-to-end managed App Store publishing** (Bloom hands off to a CLI); native **SwiftUI** fidelity vs RN; lower 2.5.2 exposure.
- *Botflow loses:* the **instant App-Clip share UX** (genuinely magical "seconds to shareable"), the most generous free tier, and cross-platform reach. **Note the backend is *not* a differentiator vs Bloom — both are Convex.** Against Bloom, Botflow's edge is the *managed publish* and *native fidelity*, not the stack.

---

## 4. The Apple 2.5.2 tailwind (cross-cutting — read this twice)

The most important market development of 2026, and a structural advantage for Botflow.

**What happened:** In March 2026, Apple began **blocking updates to vibe-coding *builder* apps** under **Guideline 2.5.2** — apps must be "self-contained in their bundles, and may not download, install, or execute code which introduces or changes features or functionality." **Vibecode and Replit** ($9B) were named; the app **"Anything" was pulled from the store entirely** (even after moving previews to a browser). Apple clarified (Mar 18) it's about self-contained bundles, "not vibe coding per se." The accepted workaround: **previews must open in an external browser, not run inside your app.**

**Why this favors Botflow — structurally, not luck:**

- Botflow's builder is a **web app**, not an iOS app. There is no on-device app for Apple to reject.
- Botflow's preview is a **streamed real iOS Simulator from a Mac farm** (and an iframe/Vite preview for web). It does not run unreviewed code inside an App Store app.
- Botflow ships **real, distribution-signed, reviewed apps** through the normal pipeline.

**The on-device builders (Vibecode, Bloom, the whole "build apps from your phone" category) are the ones in Apple's crosshairs. Botflow's architecture sidesteps the entire risk.**

**Action:** This must become a **first-class positioning pillar** — *"Botflow builds real, signed, App-Store-compliant apps. We're not an app that builds apps inside an app — which is exactly why Apple isn't pulling us."* It is the single best argument against Vibecode/Bloom/Replit and it costs nothing to make because it's already true. (Caveat to state honestly: a *user's generated app* can still face 2.5.2 if it does dynamic-code things — Botflow's pre-flight checks should screen for that; see §8B.)

---

## 5. Cross-cutting comparison matrices

### 5.1 Capability matrix

| | Botflow | Lovable | Base44 | Shipper | Rork (Pro/Max) | Vibecode | Bloom |
|---|---|---|---|---|---|---|---|
| **Web apps** | ✅ Vite/React | ✅ TanStack SSR | ✅ React SPA | ✅ React | ⚠️ web target | ⚠️ web→mobile | — |
| **Native iOS** | ✅ **SwiftUI** | ❌ | ❌ | ❌ (RN source only) | ✅ RN / **Swift** | ✅ RN | ✅ RN/App Clip |
| **Android** | ❌ (RN deprecated) | ❌ | ❌ | ❌ | ✅ Pro only | 🔜 | ✅ |
| **Managed App Store publish** | ✅ (own Apple acct) | ❌ | ❌ | ❌ | ✅ Max / ⚠️ Pro | ⚠️ GUI, own acct | ❌ DIY `eas build` |
| **Built-in backend** | ✅ Convex | ✅ Supabase/Cloud | ✅✅ all-in-one | ⚠️ unnamed | ❌ BYO | ⚠️ thin | ✅ Convex |
| **Real exportable code** | ✅ + GitHub | ✅ + GitHub | ⚠️ FE only, locked BE | ✅ | ✅ (paid) | ⚠️ | ✅ + GitHub |
| **Model choice / BYOK** | ✅✅ 9 models + BYOK/OAuth | ⚠️ hidden multi | ⚠️ auto | ⚠️ MAX | ❌ fixed | ⚠️ multi | ❌ undisclosed |
| **BYO-Claude-subscription** | ✅ **unique** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Visual / click-to-edit** | ⚠️ web, Tailwind-class only | ✅ | ✅ | ✅ | ❌ | ⚠️ | ⚠️ |
| **Checkpoints / rollback** | ⚠️ snapshots/git | ⚠️ | ⚠️ | ⚠️ | ❌ | ⚠️ | ⚠️ |
| **Native IAP monetization** | ✅ RevenueCat | ❌ | ❌ | ❌ | ✅ RevenueCat | ⚠️ | ⚠️ |
| **Apple 2.5.2 exposure** | ✅ **low (web IDE)** | n/a | n/a | n/a | low (web) | ❌ **high (on-device)** | ⚠️ moderate |
| **Stage / capital** | beta, pre-scale | $6.6B | Wix-owned | tiny | $15M seed, public | $9M, ~$10M ARR | $3.4M pre-seed |

(✅ strong · ⚠️ partial/qualified · ❌ absent · 🔜 promised)

### 5.2 Native App Store friction matrix (the battleground)

| | Apple acct needed | Xcode/CLI needed | Signing handled for user | Publish UX | 2.5.2 risk |
|---|---|---|---|---|---|
| **Botflow** | Yes ($99) + `.p8` | **No** | **Yes (server-side CSR)** | 3-step wizard | **Low** |
| **Rork Max** | Yes ($99) | No | Yes (cloud fleet) | 2-click | Low |
| **Rork Pro** | Yes ($99) | Expo token + EAS + 2FA | EAS | Multi-step | Low |
| **Vibecode** | Yes ($99) + Expo token | No (cloud EAS) | EAS (opaque) | In-app GUI | **High** |
| **Bloom** | Yes ($99) | **Yes (`eas build` CLI)** | No (DIY) | None (CLI handoff) | Moderate |
| Lovable/Base44/Shipper | — | — | — | **No native at all** | n/a |

**The throughline:** every native competitor stops at the same wall — the user's own Apple account and Apple's review. Botflow and Rork Max are tied for **least mechanical friction** (no Xcode/EAS, server-side signing). Botflow's differentiator vs Rork is *not* less Apple friction — it's the **backend** and the **2.5.2-safe architecture**.

---

## 6. Where Botflow is weaker / what's missing

Ranked by strategic impact.

1. **Swift is private beta while Rork Max is public and monetizing.** This is the biggest gap, and it's self-imposed. Every week of gating cedes the native-iOS narrative to Rork.
2. **No "App Store readiness AI."** Rork auto-generates icon, screenshots, description, store page, and pre-checks for rejections. Botflow's wizard still relies on the user to bring assets and survive review. On the native front this is now table stakes.
3. **The native moat is operationally capped at one Mac** (`vm-manager {1,1}`). The moat cannot scale to a public launch as-is. (Also a single point of failure.)
4. **No Android / cross-platform native (deliberately shelved, not drifted).** Rork Pro, Vibecode, and Bloom all ship RN cross-platform; Botflow's RN platforms are deprecated and Botflow is Apple-only. This is a *made decision*: a cross-platform revival is planned under the name **"Universal"** (RN-for-web + iOS + Android, giving a future lineup of **Web / Swift / Universal**) but is **shelved for now**. It stays on this list because the *capability gap* is real today — competitors have cross-platform reach and Botflow doesn't — but the posture (own iOS first; see §8A#8) is correct.
5. **Shallow visual editor (exists, but className-only).** Botflow *has* a select-to-edit layer for web (see §2.3), but it persists **Tailwind className edits only** — no text editing, no structural edits, bails on dynamic classNames, and nothing on native. Lovable/Base44/Shipper's visual edits are broader (text, more controls). The gap is **comprehensiveness + native coverage**, not existence — and it matters because a *complete* cheap-nudge layer is the most effective antidote to the "credit burn on tiny UI tweaks" complaint that plagues the whole category.
6. **The "batteries-included" simplicity gap vs Base44.** Convex is powerful but the setup experience (backend, auth, deploy) isn't as turnkey as Base44's "describe it, it runs." Non-technical users feel this.
7. **No checkpoints/rollback as a first-class feature.** Botflow *has* the primitives (sandbox snapshots + in-sandbox git) but doesn't surface a one-click "undo to last working state." Rork's lack of this is a top complaint — Botflow can leapfrog cheaply.
8. **Brand incoherence** (Botflow.io / OpenVibeCode / `open-vibe-code`). In a category won partly on virality and word-of-mouth (Base44, Rork, Lovable all rode X/LinkedIn), an ambiguous name is a real growth tax.
9. **Discoverability / marketing / capital gap.** Every serious competitor has a funding and distribution machine. Botflow's two genuine moats are invisible if nobody hears the story.
10. **No "secure-by-default" story** — even though Convex's typed schema + server functions are *structurally* safer than the Supabase-RLS footguns that burned Lovable (CVE-2025-48757). This is a latent strength Botflow doesn't advertise.

---

## 7. Strategic analysis — stack & market-fit choices

### 7.1 Choices working FOR Botflow

- **Native SwiftUI over React Native.** Best fidelity, deepest Apple integration (widgets, Live Activities, HealthKit, ARKit, etc.), and — critically — a **web-IDE build model that's insulated from Apple's 2.5.2 crackdown.** Rork validated this bet by *acquiring* a Swift-AI team (Paperline) to build Rork Max. Botflow made the same bet natively. This is a *good, contrarian* bet.
- **Convex over Supabase.** Real-time by default, typed end-to-end, auto-provisioned, and **portable to Swift** (the in-app-browser Convex Auth flow is genuinely clever). It sidesteps the RLS-footgun class that publicly burned Lovable. Bloom independently chose Convex too — a market validation. The one cost: smaller mindshare than Supabase.
- **BYO-Claude-subscription via real Claude Code.** A unique cost structure (zero platform model spend for Claude-subscriber users) and a quality ceiling (the actual Claude Code agent, not a reimplementation). No competitor offers this.
- **Real code + GitHub + no lock-in.** A direct answer to Base44's most-cited weakness.
- **Multi-model + BYOK + transparent credits.** Power-user and cost-conscious appeal; defuses the "credit slot-machine" resentment that dogs Lovable/Base44/Rork.
- **One tool spanning web + native.** The "bridge" nobody else builds — if told coherently.

### 7.2 Choices working AGAINST Botflow

- **Apple-only native = smaller TAM than cross-platform.** SwiftUI fidelity is real, but "iOS-only" loses the Android-inclusive segment Rork Pro / Vibecode / Bloom serve. The bet only pays off if Botflow *owns* "best real iOS app" — half-committing loses both.
- **The two-front war dilutes focus.** Competing with Lovable *and* Rork at once risks being second-best at both. The mitigation is sequencing: be *good enough* on web, *win* on native. (This is why the recommendations lead with native.)
- **Beta-gating the differentiator.** Caution on an unhardened Xcode/signing pipeline is reasonable, but it surrendered the public-launch moment to Rork. The cost of gating now exceeds the cost of a few rough edges.
- **Operational fragility of the moat.** A one-Mac farm is a beautiful demo and a scaling cliff. The moat is only as real as its throughput.
- **Power/complexity vs the "TikTok-easy" expectation.** Botflow's depth (sandbox, terminal, model picker, Convex, GitHub autonomy modes) is a power-user delight and a non-technical-user tax. Base44/Bloom/Vibecode win the absolute beginner with radical simplicity. Botflow must hide its depth behind a simple default path.
- **Brand ambiguity** taxes the word-of-mouth growth this category runs on.

---

## 8. Actionable recommendations

Weighted to **market fit and UX**. "Add" items include a stack-tailored design sketch; "don't" items are justified by positioning/bloat, never by cost.

### 8A. Top actions Botflow MUST take (ranked)

**1. Take Swift to public beta / GA — contest the native moment now.**
Why: Rork Max is compounding mindshare while Botflow is invisible. The pipeline is built end-to-end; the blocker is hardening + the one-Mac farm, not capability. Ship to a public waitlist with visible queueing rather than a closed `isBeta` gate.
Design: keep `swiftRuntimeForbidden` as the trust boundary but flip the default to an open waitlist; add a transparent "build queue position" UI (the farm already returns `queuePosition`). Pair with #4 so the farm survives the load.

**2. Build an "App Store readiness AI" (auto-metadata + pre-flight checks).**
Why: Rork shipped this; on the native front it's now table stakes, and it directly attacks the #1 reason AI-built apps get rejected. It also plays to a Botflow strength (the multi-model agent layer).
Design: a new agent toolset that (a) generates a 1024px icon + device screenshots from the streamed simulator (the farm already captures per-device screenshots), (b) drafts name/subtitle/description/keywords via the existing model layer, (c) runs a **pre-flight rejection checklist** (missing privacy policy, `ITSAppUsesNonExemptEncryption`, permission usage strings, iPad screenshot sizing, **and a 2.5.2 dynamic-code scan of the generated app**), and (d) pushes metadata via the ASC REST client already in `src/lib/asc-publish.ts`. Surface it as a Step 4 in `publish-to-app-store.tsx`.

**3. Make Apple 2.5.2 a positioning pillar.**
Why: free, true, and the best argument against the entire on-device-builder cohort (Vibecode/Bloom/Replit). See §4.
Design: a landing section + docs page — "Real apps, real review, no 2.5.2 risk." Include the pre-flight 2.5.2 scan from #2 as proof. Honest framing only (the *builder* is safe; the scan keeps the *user's app* safe too).

**4. Scale the Mac build farm beyond `{1,1}`.**
Why: the moat is throughput-bound; a public launch on one Mac Air will fall over. This is the operational precondition for #1.
Design: the `vm-manager` tart pool is built for this ("scaling up requires only env changes"). Move to a multi-Mac fleet (or Mac-cloud capacity), raise `{warm,max}`, and migrate from the shared standing signing keychain to the **per-user `.p12`-in-ephemeral-keychain** model already anticipated in `future/app-store-submission.md` (also required to respect Apple's distribution-cert caps once many users publish).

**5. Deepen the existing visual editor (web) and extend it to native (Swift).**
Why: Botflow already ships a select-to-edit layer (§2.3), but it's className-only, so it feels broken on real components. The job of this layer is to absorb the **cheap, high-frequency, deterministic** edits (recolor, resize text, fix a label) so users don't burn agent turns on them — the single best credit-burn reducer. Make it *complete enough* that ~80% of trivial tweaks never hit the agent; then extend the same cheap-nudge layer to native, where it's a category first (Rork explicitly lacks click-to-edit).
Design — **Tier 1 (web, highest value-per-effort):** (a) **inline text editing** — add `op: "text"` to the `visual-edit` route and a double-click flow that splices new text into the JSX children at the same `data-bf-loc` (the loc machinery already exists); (b) **stop bailing on dynamic classNames** — edit a string-literal segment inside `cn(...)`/template literals, else append an override class, instead of the current 409.
**Tier 2 (web):** broaden the panel's Tailwind controls (spacing, sizing, flex/grid, border, shadow, opacity) — persisted as **Tailwind tokens only**, never raw inline styles, so diffs stay clean and idiomatic.
**Tier 3 (native, differentiated):** the `visual-edit` route already permits `swift`; the real work is mapping a tap on the streamed simulator → the SwiftUI view → nudging common modifiers (`.foregroundStyle/.font/.padding/.background`) or handing the view + instruction to the agent.
**Guardrail:** keep the picker deterministic and styling/text-only; route everything structural (move/add/delete/restructure) to the agent as a scoped edit. **Do not** build a freeform drag-and-drop / absolute-position canvas — it fights the React/Tailwind component model, breaks the "real code" promise, and is an edge-case tar pit (a market-fit reason, not an effort one).

**6. Surface the Convex "batteries-included backend" story on the native front.**
Why: Botflow's cleanest, codeable win over Rork (BYO-Firebase) and a parity answer to Base44.
Design: nothing new to build — make it *visible*. In the Swift workspace, lead with "Database, auth, and sync included — no Firebase setup," show the Convex dashboard inline (already exists), and template a working data+auth demo so the first prompt yields a backed app, not a toy.

**7. Ship first-class checkpoints / rollback.**
Why: Rork's most-cited gap; cheap for Botflow given existing primitives; reduces the "AI broke my working app" fear across the category.
Design: surface sandbox snapshots + in-sandbox git as a one-click "restore to last working build" in both workspaces, auto-tagging a checkpoint before each agent turn that touches many files.

**8. Hold the "iOS-first" line — the Android question is already (rightly) decided.**
Why: "Apple-only" is a fine strategy *because it's chosen*, not drifted into. The actual call: **own native iOS now, revive cross-platform later under the planned "Universal" platform** — RN-for-web + iOS + Android, yielding a future lineup of **Web / Swift / Universal** — which is **shelved for now**. That sequencing is correct: iOS-first is where the moat and the 2.5.2 advantage live, and shelving (rather than half-shipping) Universal avoids the worst outcome — a half-built Android path.
Recommendation: **stay the course.** Market the iOS focus as a feature; keep "Universal" explicitly shelved, not partially live, until iOS is decisively won. When it returns, build it onto Vercel sandboxes like `sandboxed-web` — treat the old Expo/`multiplatform` templates as a reference, not a foundation to ship as-is. Do **not** ship a half-built Android path in the meantime.

**9. Fix brand coherence.**
Why: word-of-mouth is the category's primary growth engine; "Botflow / OpenVibeCode / open-vibe-code" fractures it. Pick one public name and align repo, marketing, and product.

### 8B. Features to ADD (stack-tailored design)

- **App Store readiness AI** — see 8A#2.
- **Deepen the visual editor** (inline text editing, dynamic-className handling, broader Tailwind controls; extend to the Swift simulator) — see 8A#5. *It already exists for web (className-only); this is depth, not a new build.*
- **Checkpoints/rollback** — see 8A#7.
- **Secure-by-default scan** — Convex schema/auth-rule linting surfaced as a "your app is secure" badge. Turns a latent structural advantage (typed Convex vs Supabase RLS footguns) into a *visible* one. Directly exploits Lovable's CVE-2025-48757 wound. Reuse the agent + `convex-admin.ts` introspection.
- **Template / starter gallery** — Botflow already has the public-bundle + fork-as-template infra (`/explore`, `public-bundle.ts`). Curate first-party native + web starters so the cold-start prompt isn't a blank page. Reduces the "vague prompt → generic app" failure the whole category suffers.
- **App Store readiness checklist automation** (privacy policy generation, export-compliance plist, 1024 icon) — folds into 8A#2 but worth calling out as the concrete rejection-reducers.

### 8C. Features to NOT add — and why (market fit / UX, not cost)

- **Do NOT build an "AI Employees / autonomous-agents" platform** (Base44 Superagents, Shipper's "Advisor"). It dilutes the "build me an app" focus into "automation platform," confuses positioning, and adds surface area that doesn't serve the core user. It hurts market fit more than it adds.
- **Do NOT build an on-device "build apps from your iPhone" app** (Vibecode/Bloom). It would put Botflow *directly* in Apple's 2.5.2 crosshairs and forfeit the architectural advantage that is currently Botflow's best native story. This is self-sabotage, regardless of how magical the demo looks.
- **Do NOT chase pro-dev IDE depth** (Cursor's lane). You cannot out-Cursor Cursor, and every step toward "for engineers" alienates the non-technical core that is Botflow's actual market. Keep the terminal/code view as an escape hatch, not a headline.
- **Do NOT ship thin PWA/Capacitor "native" wrappers** (Lovable's punt). They risk App Store 4.2 rejection and would *contaminate the "real native" brand* that is Botflow's entire native value proposition. Botflow ships real SwiftUI — never blur that.
- **Do NOT marry a single closed backend** the way Base44 does. The lock-in would trade away the "real code, no lock-in" advantage that is Botflow's wedge against Base44. Keep Convex-or-BYOC-or-none open.
- **Do NOT add real-time multiplayer collaboration yet** (Lovable's 2.0 feature). The solo-founder / indie-hacker core gets little from it; it's a bloat magnet that serves enterprise (a segment Botflow isn't fighting for yet). Revisit only if/when moving upmarket.
- **Do NOT bolt on a half-committed Android path** — see 8A#8. Mediocre cross-platform is worse for the brand than excellent iOS-only.

---

## 9. The Rork Max head-to-head (the existential one)

Because Rork Max is the one competitor attacking Botflow's actual moat, it deserves its own battle plan.

**Architecture: essentially tied.** Both: cloud Mac fleet, browser-streamed real simulator, Companion/QR device install, native SwiftUI, Claude Code engine, App Store publish via the user's Apple credentials, RevenueCat IAP. Botflow's edges: **Opus 4.8** (vs 4.6), and the **BYO-Claude-subscription** cost model. Rork's edges: **public, funded, monetizing, marketed.**

**Where Botflow can win, concretely:**

1. **Backend.** Auto-provisioned **Convex + auth** vs Rork's BYO-Firebase/Supabase. This is the most defensible, demoable difference — "your Botflow app has a real database and login on the first prompt; your Rork app needs you to go set up Firebase." Lead with it.
2. **Reliability & rollback.** Rork's reputation is "broken previews, publish fails first try, context loss, no rollback." Botflow shipping *visible* checkpoints + a hardened publish flow turns Rork's weakness into Botflow's tagline.
3. **The 2.5.2 / "real reviewed apps" framing** — applies to both (both are web-IDEs), but Botflow can claim it first and loudest.
4. **No-lock-in real code** — parity with Rork (paid export), but pair it with Convex portability for a fuller story.

**Where Botflow must reach parity fast (or lose):**

1. **Get public.** Beta-gating against a public, funded incumbent is the losing move. (8A#1, #4.)
2. **App Store Publishing AI.** Match Rork's auto-metadata or concede the "it just ships" demo. (8A#2.)
3. **Distribution/marketing.** Rork won the launch with 8M X views and the RevenueCat-#1-referrer flywheel. Botflow's two genuine moats (BYO-Claude-sub, Convex-backed native) are *better stories than Rork has* — they just need to be told.

**Where Botflow should NOT try to match Rork:** don't rush an Android/RN "Pro" twin just because Rork has one. Rork's Pro RN-publish path is *clunky* (Expo token + EAS + 2FA) and dilutes their native-Swift story. Botflow owning "best real iOS, backend included" is a sharper position than "we also do mediocre RN."

**6-month plan, sequenced:** (1) scale the farm → (2) public Swift beta with queue → (3) App Store readiness AI + checkpoints → (4) Convex-backend + 2.5.2 positioning blitz → (5) visual edit. Web-front improvements (visual edit, secure-by-default, templates) ride along but are secondary.

---

## 10. The one-sentence strategy

**Be the only tool that takes a non-technical person from a prompt to a *real, reviewed, backend-included* app in the App Store — win the native-iOS front decisively (Convex-backed, 2.5.2-safe, reliability-first) before Rork makes it theirs, stay credibly good on web, and tell the two stories nobody else can tell: your own Claude subscription building real Swift, and a vibe-coder Apple can't ban.**

---

### Appendix: source provenance

- **Botflow claims:** grounded in the repository at `/Users/aronne/Documents/webcontainer-project/webcontainer-ide` and the `expo-simulator-stream` build farm. Key files cited inline: `src/lib/project-platform.ts`, `src/lib/agent/models.ts`, `src/app/api/agent/claude-code/route.ts`, `src/lib/agent/claude-code/bridge-script.ts`, `src/lib/vercel-sandbox.ts`, `src/lib/asc-publish.ts`, `src/lib/sim-platform.ts`, `src/components/persistent-workspace/publish-to-app-store.tsx`, `src/lib/tier.ts`, `src/lib/credits.ts`, and `future/{app-store-submission,spike0-signing-runbook,swift-convex-auth}.md`.
- **Competitor claims:** June-2026 multi-source web research (official sites/docs/pricing/changelogs, TechCrunch/CNBC/PR Newswire, Sacra/Tracxn/Latka, Trustpilot/Reddit/X, Apple Developer Forums, 9to5Mac/Michael Tsai for the 2.5.2 crackdown, Anthropic's Vibecode customer story). Soft figures (ARR ranges, undisclosed models, exact pricing tiers) are flagged at point of use in the underlying briefs; treat ARR/valuation and "model under the hood" claims as directional, not audited.
