# Publish to App Store / TestFlight — Scope

Wire the **"Publish"** button in the Swift workspace to a real flow that ships a
project to **TestFlight (then App Store)** using the user's **App Store Connect API
key (`.p8`)**.

> This doc is grounded in the actual code. The build farm is `expo-stream` (the repo
> whose name is legacy — no Expo involved), running on the Mac at
> `macbook-air-botflow` (`100.119.219.31`, Tailscale). `SIM_CONTROLLER_URL` →
> `@sim/controller`; the host agent runs xcodebuild/simctl.

---

## Real ASC flow findings (2026-06)

Walked the actual App Store Connect API-key creation flow with a live paid account.
These are the steps the in-app copy must reflect — each is something a real user hits:

1. **The "Request Access" gate (first-time only).** With an *active paid* membership,
   the very first visit to **Users and Access → Integrations → App Store Connect API**
   does **not** show a "+" to create a key. It shows *"Permission is required to access
   the App Store Connect API"* with a **"Request Access"** button. The **Account Holder**
   must click it and accept a terms checkbox; only then does the page flip to show
   **Team Keys** + a **"Generate API Key"** button. This is the #1 reason a paid user
   thinks our instructions are wrong — they look for a "+" that isn't there yet.
2. **Team Keys vs Individual Keys.** After access is granted there are two tabs. Create
   the key under **Team Keys** (the default tab) via "Generate API Key" / "+". Individual
   Keys are scoped to one user and are *not* what we want.
3. **Issuer ID location.** The Issuer ID appears **once at the top of the Keys page**
   (with a Copy button), **above** the table. It is per-team, shared by every key — it is
   **not** shown per-key. Users hunt for it next to each row and don't find it.
4. **Key ID + role.** Each key row shows its **Key ID**. The Generate dialog asks for a
   **Name** (max 30 chars) and an **Access role**; the role list is Admin / App Manager /
   Developer / Finance / Sales and Reports / Customer Support / Marketing. We recommend
   **App Manager** (sufficient for upload + TestFlight, less than Admin).
5. **Download-once + browser "Keep" gotcha.** Downloading the `.p8` shows a confirm:
   *"API keys can be downloaded only once."* After download the Download link disappears.
   Separately, Chromium browsers (Chrome/Brave/Edge) may flag the uncommon `.p8` file type
   as potentially dangerous and hold the download pending a **"Keep"** click. If the
   download seems stuck or the browser warns, click **Keep** — the `.p8` is safe.
6. **Team ID location + gotcha.** The optional Team ID lives at
   **developer.apple.com/account → Membership details → "Team ID"** (a 10-char code like
   `ABCDE12345`). It is **different** from the code embedded in the Apple Developer Program
   License Agreement PDF's filename — users frequently grab that one by mistake. We
   auto-detect the Team ID from the key when the field is left blank.

---

## The key reframe: this is a NEW distribution target, not an extension

There are already **two** Swift runtimes wired end-to-end:

1. **Simulator preview** — `swift-preview/*` routes → controller `/api/sessions` →
   host-agent `runBuild()` (`-sdk iphonesimulator`, unsigned, install+launch).
2. **Physical-device sideload (companion)** — `swift-device/*` routes → controller
   `/api/device-builds` → host-agent **`runDeviceBuild()`**: compiles `-sdk iphoneos`
   with `CODE_SIGNING_ALLOWED=NO`, packages an **UNSIGNED** `Payload/*.app` IPA. The
   user's **Botflow Companion** Mac app re-signs it with their *free* Apple ID and
   sideloads to a connected device (AltStore-style, 7-day expiry).

**App Store / TestFlight is a third target.** It is NOT the companion path — it needs a
**distribution-signed** `.ipa` produced *on the server* and **uploaded to App Store
Connect**, no companion involved. The good news: the entire scaffolding for target #2
(tar → controller route → orchestrator record → host-agent xcodebuild → artifact →
status polling → ownership/token store → UI) is a near-perfect template to clone.

---

## What already exists (clone these)

| Layer | Companion/device path (existing) | What to add for App Store |
|---|---|---|
| Host-agent build | `runDeviceBuild()` in `packages/host-agent/src/build.ts` (unsigned `build`) | `runAppStoreBuild()`: `xcodebuild archive` + `-exportArchive` (signed) + upload |
| Controller route | `packages/controller/src/routes/device-builds.ts` (`POST /`, `GET /:id`, `GET /:id/ipa`) | `routes/app-store-builds.ts` (or a `target` flag on device-builds) |
| Orchestrator | `DeviceBuildRecord`, `createDeviceBuild/getDeviceBuild/getDeviceBuildArtifact` | `AppStoreBuildRecord` + upload/processing states |
| Shared protocol | `DeviceBuildState`/`DeviceBuildSummary` zod in `packages/shared/src/protocol.ts` | `AppStoreBuildState` (+ `uploading`,`processing`,`submitted`), summary |
| Botflow route | `src/app/api/projects/[id]/swift-device/build/**` | `src/app/api/projects/[id]/swift-publish/**` |
| Botflow client | device fns in `src/lib/sim-platform.ts` | `submitAppStore()` / status / etc. |
| Botflow store | `src/lib/swift-device-build-store.ts` (Redis ownership+token) | `swift-publish-store.ts` (same shape) |
| Botflow UI | `src/components/persistent-workspace/iphone-device-runner.tsx` | `publish-to-app-store.tsx` wizard |
| Publish button | `persistent-workspace/index.tsx:404-412` → "Coming soon" toast | open the wizard |

---

## Server reality (probed `100.119.219.31`)

- ✅ macOS 26.2, **Xcode 26.5**, `xcodegen` at `~/.local/xcodegen/...`
- ✅ `xcrun altool` present (`Xcode.app/.../altool`) → upload via
  `xcrun altool --upload-app -f App.ipa -t ios --apiKey <KID> --apiIssuer <ISS>`.
  **No fastlane needed** — stay with raw `xcodebuild`/`xcrun`, matching existing style.
  (`fastlane` is NOT installed; system Ruby is old — don't fight it.)
- ✅ `idb`, `git`; `node` lives at `~/.local/node/bin` (not on default SSH PATH — the
  controller is already launched with the right PATH, fine).
- ⚠️ **`security find-identity -v -p codesigning` → 0 valid identities.** No distribution
  cert/keychain yet. **This is the #1 risk** (see below).

---

## The hard part: signing on a headless-ish Mac

Distribution signing on the server, driven by the ASC key:

```
xcodebuild archive \
  -project X.xcodeproj -scheme X -sdk iphoneos -archivePath X.xcarchive \
  -allowProvisioningUpdates \
  -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_<KID>.p8 \
  -authenticationKeyID <KID> -authenticationKeyIssuerID <ISS>
xcodebuild -exportArchive -archivePath X.xcarchive \
  -exportOptionsPlist export.plist  # method: app-store-connect, signingStyle: automatic
  -allowProvisioningUpdates -authenticationKey* ...
xcrun altool --upload-app -f X.ipa -t ios --apiKey <KID> --apiIssuer <ISS>
```

`-allowProvisioningUpdates` + the ASC key auto-creates the **distribution certificate +
provisioning profile** — no `match`, no manual profiles. BUT the new cert's private key
lands in a **keychain that must be unlocked**, and the build runs over a non-GUI session.

**De-risk this FIRST, before any plumbing** (one manual spike on the box with a real
$99 account + `.p8`):
1. Confirm `xcodebuild ... -allowProvisioningUpdates` can create a distribution cert
   under the `botflow` login keychain (may need `security unlock-keychain`, or a
   dedicated keychain created/unlocked by the controller at boot).
2. Confirm `altool --upload-app` succeeds to TestFlight with apiKey/apiIssuer.
3. Decide keychain strategy: persistent unlocked login keychain (simplest, the Mac is a
   dedicated desktop) vs. an ephemeral per-build keychain the host-agent creates/unlocks/
   deletes (cleaner, more code). **Lean: dedicated unlocked keychain on the box.**

Everything else is plumbing we already have a template for. If signing works manually,
the feature is low-risk.

---

## Credential model (`.p8`, per the prior decision)

- Store per-user in **Clerk privateMetadata** (the existing sensitive store —
  `src/lib/user-credentials.ts`). Add `appleAscIssuerId`, `appleAscKeyId`,
  `appleAscKeyP8`, `appleTeamId`, `appleTeamName`. No DB migration (schemaless).
- New `src/app/api/user/apple-credentials/route.ts`: POST validates by minting an
  ES256 JWT (new `src/lib/asc-jwt.ts`) and calling `GET /v1/apps`; resolves team; saves.
  GET returns masked status; DELETE clears.
- Settings UI: "Apple Developer" card → upload `.p8` + Key ID + Issuer ID →
  **"Connected ✓ to {team}"**. Recommend an **App Manager** key (least privilege).
- **Transit:** Botflow publish route sends the key triple to the controller (headers/
  body, over the existing `x-platform-token` channel) → host-agent writes the `.p8` to
  `~/.appstoreconnect/private_keys/AuthKey_<KID>.p8` for the job, **deletes after**.
  Never logged; add `appleAscKeyP8` to redaction.

---

## App Store Connect API calls (web-verified 2026-06-10)

Two facts checked against Apple docs/WWDC25 — both changed the plan:

1. **App-record creation is NOT possible with a `.p8` key.** The official ASC API has
   no create-app endpoint; fastlane's `App.create` works only with Apple ID login —
   which is exactly why Rork demands the user's Apple ID password. Our flow instead
   has a **one-time guided manual step**: wizard deep-links to App Store Connect →
   "New App" with every value to paste (name, bundle id — registered by us via
   `POST /v1/bundleIds` or `-allowProvisioningUpdates` — SKU, locale), then
   **auto-detects** completion by polling `GET /v1/apps?filter[bundleId]=…`. Once per
   app, never again.
2. **Upload via the new BuildUpload REST API (WWDC25), not altool.** `altool
   --upload-app` is deprecated (and `--upload-package` has Xcode 26 quirks — fastlane
   #29698/#29743). The ASC API now supports direct build upload: POST `buildUploads`
   → POST `buildUploadFiles` → chunked PUT to provided URLs → PATCH `uploaded: true`.
   Host-agent is Node, so this is plain TypeScript with the `.p8` JWT — no CLI tool,
   structured errors. Keep `altool --upload-package` as a documented fallback.
   Webhooks exist for processing-state push; v1 polls instead.

Mint ES256 JWT from the `.p8` (`node:crypto`, no deps), then per publish:
- **Botflow:** ensure bundle ID registered; look up app record (guide creation if
  missing); compute next build number from latest builds; poll processing status.
- **Host-agent:** archive → export → BuildUpload REST upload.

---

## Sequencing

- **Spike 0 — signing/keychain on the box** (manual, half-day, needs the $99 + a `.p8`).
  Validate archive→export→altool end-to-end by hand. *Gates everything.*
- **Phase 1 — host-agent `runAppStoreBuild()`** + orchestrator `AppStoreBuildRecord` +
  controller `app-store-builds` route + shared protocol types. Test via curl with a
  tarball + key. (Mirrors device-builds almost line-for-line.)
- **Phase 2 — Botflow plumbing:** `apple-credentials` route + `asc-jwt.ts` + settings
  card; `swift-publish/*` routes + `swift-publish-store.ts` + `sim-platform` client.
- **Phase 3 — wizard UI** behind the Publish button (`persistent-workspace/index.tsx`):
  Step 1 App Info (prefilled) → Step 2 Apple key (auto-skip if on file) → Step 3 Submit
  with live progress over the existing WS/poll mechanism. **Ship TestFlight.**
- **Phase 4 — App Store metadata + review submit; AI icon/description; hardening**
  (error mapping, build-number automation, queue limits, export-compliance plist).

## Decisions (resolved)

1. **Separate route — YES.** New `app-store-builds` route + `runAppStoreBuild()`; the
   companion path is untouched. Refactor the shared prologue (tar extract, xcodegen
   regen, locate `.xcodeproj`, diagnostics, line-streaming) into a `prepareWorkdir()`
   helper in `build.ts` so the two build fns stay thin without duplication.

2. **Keychain — dedicated always-unlocked keychain NOW; design for per-user `.p12`
   later.** v1 (single account / spike): one `botflow-signing.keychain`, unlocked at
   host-agent boot, never auto-locks, cert created once via `-allowProvisioningUpdates`
   and reused. The non-obvious required step so codesign never shows a GUI prompt:
   `security set-key-partition-list -S apple-tool:,apple: -s -k <pw> <keychain>`.
   **Multi-tenant wrinkle (production):** every user brings their own Apple account, so
   a shared standing keychain would accumulate many users' distribution private keys,
   and auto-creating a cert per user risks Apple's ~2–3 distribution-cert cap. Plan to
   move to: create each user's distribution cert once → export encrypted `.p12` to the
   backend (match-style) → import into a per-user/ephemeral keychain per build, then
   delete. Build the credential/data model now so this migration needs no rework.

3. **ASC calls — hybrid (Option 3).** The Mac does only what's physically local:
   `archive`, sign, `xcrun altool --upload-app`. Botflow (has Clerk + DB) does all the
   REST: validate `.p8`, ensure the app record exists, compute next build number, poll
   TestFlight processing status. Ordering: Botflow ensures app record + computes build
   number → passes build number as a build hint → host-agent stamps `CFBundleVersion`,
   archives, signs, uploads → Botflow polls status. Keeps the controller a stateless
   build box (as it is today); the `.p8` reaches the Mac regardless for sign+upload.

4. **No chooser. Publish = App Store / TestFlight only.** The Publish button opens the
   publish wizard directly. The companion "Test on my iPhone" stays a SEPARATE
   affordance (`iphone-device-runner.tsx`), not under Publish.

## Superseded
Earlier draft assumed Fastlane + an unknown external controller. Both wrong: the
controller is `expo-stream` (ours), and we stay fastlane-free to match existing code.
