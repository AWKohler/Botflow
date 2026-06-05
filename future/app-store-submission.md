# App Store Submission (Swift) — Implementation Plan

Ship a Swift project from the browser to **TestFlight first, then the App Store**,
using the user's own **App Store Connect API key (`.p8`)** — no Apple ID password,
no expiring 2FA session. Mirrors Rork's "Publish" flow but with the more reliable,
more secure credential model.

This is the index/spec; everything here builds on patterns already in the repo
(see "Precedents" per section).

---

## 0. Why `.p8` over Apple ID + password

| | Apple ID + password (Rork) | ASC API key `.p8` (this plan) |
|---|---|---|
| Setup | 2 fields | upload `.p8` + Key ID + Issuer ID (once) |
| Every publish after | re-auth + **2FA code every ~30 days** | **nothing — click Submit** |
| Breaks unexpectedly | yes (session expiry, robot-login blocks) | no (keys don't expire unless revoked) |
| "Never touches our servers" | hard to claim | true if we keep signing on the controller |
| Apple-supported | legacy/spaceship | official |

The only cost is ~60s more first-time setup, mitigated by a guided wizard step.

---

## Architecture at a glance

```
Browser (Next.js)                Next.js API (this repo)          Mac controller (external)
─────────────────                ───────────────────────          ─────────────────────────
Publish wizard  ──submit──▶  /api/projects/[id]/app-store/  ──▶   POST /api/submissions
                             submit                                  xcodegen generate
   ▲                           • auth + ownership + beta            fastlane gym (archive+sign)
   │  WS progress              • ensure ASC key on file              export signed .ipa
   └──────────────────────────• tarSandboxProject()        ◀── WS  fastlane pilot/deliver → ASC
                               • POST tarball + ASC key              (ASC API key = JWT auth)
```

**Key insight:** the expensive piece — a remote Mac running `xcodebuild` — already
exists (`SIM_CONTROLLER_URL`, today only `-sdk iphonesimulator`). This plan adds a
device archive + sign + upload path on the *same* controller. No new build farm.

---

## Phase 0 — Apple credential plumbing

Per-user (a developer account is per user/team). Store alongside existing BYOK keys.

### Data model — `src/lib/user-credentials.ts`
Add to `UserCredentials` (lives in Clerk privateMetadata, Redis-cached — already the
sensitive store):
```ts
// App Store Connect API key (per Apple Developer team)
appleAscIssuerId: string | null;   // team-level UUID
appleAscKeyId:    string | null;   // 10-char key id
appleAscKeyP8:    string | null;   // PEM private key (~250 bytes — fits privateMetadata)
appleTeamId:      string | null;   // 10-char team id (for export signing)
appleTeamName:    string | null;   // display only, fetched on validation
```
No DB migration needed (privateMetadata is schemaless). No Neon fallback entry
(new field, like `togetherApiKey`).

### Routes — `src/app/api/user/apple-credentials/route.ts` (new)
- `POST` — accept `{ issuerId, keyId, p8 }`; **validate** by minting an ES256 JWT
  and calling `GET https://api.appstoreconnect.apple.com/v1/apps` (or `/v1/users`);
  on success resolve + store `appleTeamId`/`appleTeamName`; `setUserCredentials(...)`.
- `GET` — return **masked** status only: `{ connected: true, keyId: "··· AB12", teamName }`.
  Never return the `.p8` to the client after save (write-only).
- `DELETE` — `clearUserCredentials(userId, [appleAsc*...])`.

### Settings UI
Add an "Apple Developer" card to the existing credentials/settings screen:
upload `.p8` + two text fields → on save shows **"Connected ✓ to {teamName}"**.

**Security:** `.p8` is a powerful key. Recommend users create an **App Manager**
(not Admin) key — least privilege. Never log it. Pass to the controller only over the
authenticated channel; controller holds it in memory/ephemeral temp for the job, then
deletes. Add `appleAscKeyP8` to any log/redaction allowlist.

**Precedent:** `src/lib/user-credentials.ts` (get/set/clear), GitHub/Convex OAuth cards.

---

## Phase 1 — Controller: archive → sign → export `.ipa` (biggest lift, external repo)

Lives on the Mac controller (not this repo). The hard, valuable part.

New controller endpoint **`POST /api/submissions`** (auth via existing `x-platform-token`):
- Body/headers: project tarball (octet-stream, like `/build`) + `bundleId`, `version`,
  `buildNumber`, `scheme`, and the ASC key triple (`issuerId`, `keyId`, `p8`).
- Steps:
  1. Unpack tarball, `xcodegen generate --spec project.yml`.
  2. `fastlane gym` / `xcodebuild archive -sdk iphoneos` **with automatic signing +
     `-allowProvisioningUpdates`** and `-authenticationKeyPath/-authenticationKeyID/
     -authenticationKeyIssuerID`. ASC-key automatic signing creates the distribution
     cert + provisioning profile on the fly — **no `match`/manual profile management.**
  3. `-exportArchive` → signed `.ipa`.
- Stream stdout/stderr + parsed diagnostics back over WS (reuse the simulator stream
  pattern + `SimBuildDiagnostic` shape from `build-issues-panel.tsx`).

**Gotchas to handle here:**
- **Build number**: query latest from ASC, auto-increment (`agvtool`/Info.plist).
- **Entitlements/capabilities**: if `project.yml` enables Push / IAP / Sign in with
  Apple, the App ID must enable them — `-allowProvisioningUpdates` + the entitlements
  file handles it, provided the ASC key has rights.
- **Export compliance**: set `ITSAppUsesNonExemptEncryption=false` (or true+docs) in
  Info.plist to skip the per-submit prompt.
- **App icon**: asset catalog must contain 1024px + all sizes, or archive fails.
- **Concurrency**: archiving takes minutes and is serial per Mac. Reuse/extend the
  controller's session/queue; keep build jobs distinct from preview sessions.

**Verify Phase 1 manually** with one real test app before wiring any UI.

---

## Phase 2 — TestFlight end-to-end (the first shippable feature)

Lower-stakes than App Store (no screenshots, no review gauntlet) → prove the chain.

### Controller
- Extend `POST /api/submissions` (or add `/upload`): `fastlane pilot upload` (or
  `xcrun altool`/ASC API) using the ASC key. First time: create the app record via
  `fastlane produce` / ASC `POST /v1/apps`.

### Schema — `src/db/schema.ts`
New table `appStoreSubmissions` (one row per attempt — model on the Stripe/Convex
integration fields already in `projects`):
```ts
export const appStoreSubmissions = pgTable('app_store_submissions', {
  id, projectId (fk), userId,
  target: text(),        // 'testflight' | 'appstore'
  bundleId, version, buildNumber,
  status: text(),        // queued|archiving|signing|uploading|processing|ready|failed
  ascAppId, ascBuildId,  // returned by ASC
  errorMessage, logUrl,
  createdAt, updatedAt,
});
```
Add project-level app metadata as a `jsonb('app_store_metadata')` on `projects`
(name ≤30 chars, subtitle, category, iconKey, privacyUrl, supportUrl, ageRating).

### Routes — mirror `swift-preview/` exactly
- `POST /api/projects/[id]/app-store/submit` — auth → load project → ownership →
  `platform === 'swift'` → `swiftRuntimeForbidden()` → ensure ASC creds present →
  `tarSandboxProject(projectId)` → call controller → insert `appStoreSubmissions`
  row → return `{ submissionId, wsUrl }`.
- `GET /api/projects/[id]/app-store/submissions` — list + status.
- `POST /api/projects/[id]/app-store/metadata` — save app info.
- `DELETE .../[submissionId]` — cancel.

**Precedent:** `src/app/api/projects/[id]/swift-preview/start/route.ts` (auth/ownership/
beta gate/tar/controller-call/cleanup is copy-adaptable almost verbatim).

### Wizard UI — `src/components/persistent-workspace/publish-to-app-store.tsx` (new)
3-step modal behind a **Publish** button in the workspace top bar (Rork-style):
- **Step 1 — App Info**: icon, platform (iOS), name, version, bundle id (prefilled
  `io.botflow.<slug>-<hash>`, editable).
- **Step 2 — Apple Developer**: if key on file → auto-skip, show "Connected ✓ to
  {team}". Else guided `.p8` upload + Key ID + Issuer ID, deep-link to
  `https://appstoreconnect.apple.com/access/integrations/api`, validate inline.
- **Step 3 — Submit**: pick TestFlight; live progress (archive → sign → upload →
  processing) over WS; on success link to App Store Connect.

**Precedent:** `swift-simulator-preview.tsx` + `build-issues-panel.tsx` (WS stream,
diagnostics rendering, session pool).

---

## Phase 3 — App Store submission (review)

Same pipeline + metadata + Apple's human review.
- Controller: `fastlane deliver` to push metadata, screenshots, and submit the version.
- Metadata wizard expands: description, keywords, screenshots (App Store *requires*
  them — TestFlight doesn't, which is why Phase 2 ships first), privacy nutrition
  labels, support/marketing URLs, age rating.
- **AI assists** (optional, Rork parity): "Generate with AI" app icon (image model →
  1024px + downscaled set into the asset catalog); draft description/keywords/privacy
  answers from the project (reuse the agent + a project snapshot).
- Set expectation in UI: submission ≠ approval; review is async/human, rejections
  happen. Surface ASC status by polling `appStoreSubmissions`.

---

## Phase 4 — Hardening

- Map common Apple errors (missing icon, export compliance, bad bundle id, capability
  not enabled) to actionable UI messages.
- Build-number automation; multiple apps per user; per-team key reuse across projects.
- Controller queue limits + per-user concurrency; cost/runtime guards on archives.
- Audit log of submissions; rate limiting.

---

## Files touched (this repo)

| File | Change |
|---|---|
| `src/lib/user-credentials.ts` | + `appleAsc*` / `appleTeam*` fields, get/set/clear |
| `src/app/api/user/apple-credentials/route.ts` | **new** — validate/save/disconnect `.p8` |
| `src/lib/asc-jwt.ts` | **new** — mint ES256 JWT from `.p8` for ASC API validation |
| `src/lib/sim-platform.ts` | + `submitToAppStore()` / `submissionWsUrl()` controller client |
| `src/app/api/projects/[id]/app-store/submit/route.ts` | **new** — orchestrate (mirror swift-preview/start) |
| `src/app/api/projects/[id]/app-store/submissions/route.ts` | **new** — list/status |
| `src/app/api/projects/[id]/app-store/metadata/route.ts` | **new** — save app info |
| `src/db/schema.ts` | + `appStoreSubmissions` table, + `projects.appStoreMetadata` jsonb |
| `drizzle/00xx_app_store_submissions.sql` | **new** — migration |
| `src/components/persistent-workspace/publish-to-app-store.tsx` | **new** — 3-step wizard |
| Settings credentials screen | + "Apple Developer" card |

**External (Mac controller, separate repo):** `POST /api/submissions` (archive+sign+
export+upload via Fastlane + ASC-key automatic signing), build queue, WS progress.

---

## Open decisions

1. **Controller endpoint shape** — one `POST /api/submissions` that archives→signs→
   uploads and streams, vs. split `/archive` + `/upload`. (Lean: one endpoint, WS progress.)
2. **`.p8` storage** — Clerk privateMetadata (chosen; fits size, already the sensitive
   store) vs. a dedicated encrypted DB column. Revisit only if we ever need server-side
   access without a user context.
3. **Bundle ID prefix** — confirm `io.botflow.*` namespace + uniqueness hash.
4. **AI icon/metadata** — Phase 3 nice-to-have or fast-follow?

## Recommended sequencing
**Phase 0 → 1 (verify manually) → 2 (ship TestFlight) → 3 → 4.**
TestFlight is the proof-of-chain and the highest-frequency user win; App Store review
rides on the same rails once it's solid.
