# Project Sharing — Multi-User Collaboration

Status: **PROPOSED — planning only, no implementation.** Companion to (and gated on) [`anthropic-proxy-token-protection-plan.md`](./anthropic-proxy-token-protection-plan.md).

Goal: **Google-Docs-style sharing based on email** — an owner invites collaborators by email address; collaborators open the same workspace, prompt their own agents against the shared project, and see each other's activity — **with zero new infrastructure services** (no realtime vendor, no per-collaborator VMs) and no silent loss of anyone's work.

Decisions locked 2026-07-02:

| Decision | Choice |
|---|---|
| Access model | Custom `project_members` table — NOT Clerk Organizations |
| Availability | **Pro/Max owners only** — inviting requires a paid plan (server-side gate on the invite route) |
| Roles (v1) | `owner` + `editor` only; `viewer` deferred |
| Billing | **Hybrid** (locked 2026-07-02): platform-metered models bill the **owner's** credits, capped per-collaborator via a share-sheet % slider; Claude/Codex **OAuth tokens are never shared** — collaborators use their **own** connected accounts; **model availability follows the owner's tier**. Exception: owner-OAuth sharing behind `SHARING_ALLOW_OWNER_OAUTH` env flag + per-project owner switch, both default off (TOS caution) |
| Agent concurrency | Allowed — multiple concurrent agent turns in **one shared sandbox**; threads are **private-to-creator for prompting**, one running turn per thread |
| Git push (editors) | Per-project **share-sheet switch** ("editors can push"), default **off** |
| Spend caps | **At launch** (not deferred): per-collaborator cap as % of the owner's monthly tokens, set in the share sheet, enforced at the proxy |
| Realtime layer | None — presence + cursor info via Redis keys read on existing polls; no CRDT/co-typing |
| Conflict model | No merge. CAS (compare-and-swap) saves + advisory presence + per-file version history backstop |
| Hard prerequisite | Anthropic proxy Phases 0–2 (owner credential out of the sandbox) before any invite ships |

---

## 0. Why this exists

Today a project is strictly single-user: `projects.userId` is one Clerk id, and every protected API route inlines the same ownership check. There is no membership concept, no way to grant another account access, and several parts of the system implicitly assume one human per project (one chat session, one credential in the sandbox, keepalive driven by "the" tab).

The product is agent-first: users mostly prompt the agent and watch the preview; hand-editing in Monaco is secondary. That shapes everything below — we buy *awareness* and *recoverability* cheaply instead of paying (in dollars and complexity) for conflict-free simultaneous typing that the product doesn't need.

---

## 1. Current architecture — what sharing has to change

| Fact | Location | Consequence for sharing |
|---|---|---|
| ~34 of ~122 API routes inline `eq(projects.userId, userId)`; no shared helper | e.g. `src/app/api/projects/[id]/agent-backend/route.ts` (~L46) | Replace with one `requireProjectAccess()` helper — the foundational refactor |
| Projects list queries by `userId` only | `/api/projects` + `/projects` page | Needs union with memberships ("Shared with me") |
| One `chat_sessions` row per project; active segment tracked on `projects.currentSegmentId` | `src/db/schema.ts` | Generalize to N threads per project for concurrent agents |
| `chat_messages` has no author column | `src/db/schema.ts` | Add `userId` for attribution |
| Workspace sync is polling (preview-state ~2s, tree poll); agent output is SSE **to the requester only** | `/api/projects/[id]/sandbox/preview-state`, `/api/agent/*` | Presence rides the existing polls; completed messages already land in the DB for other viewers |
| Files authoritative in the per-project sandbox; last-write-wins; no locking, no version trail | `src/lib/vercel-sandbox.ts` | Conflict safety (§6) is net-new |
| `project_files` backup table already carries a `hash` column | `src/db/schema.ts` | Reuse hashing convention for CAS saves |
| Clerk is the only user store; `getEmailForClerkUser` exists (userId→email) but no reverse lookup | `src/lib/email.ts` (~L68) | Invites use `clerkClient.users.getUserList({ emailAddress })` |
| Resend + svix already dependencies | `package.json` | Invite emails + `user.created` claim webhook are free |
| Rate limits are per-user with poll/pollHeavy buckets; idle-sleep keyed off interaction + `lastSandboxActivityAt` | `src/lib/rate-limit.ts`, idle-sleep work | Presence traffic must be poll-classified and must NOT feed keepalive |
| Usage metered per `(userId, period, model)` | `usage_records` | Owner-pays needs actor attribution added |
| Owner's Anthropic OAuth refresh token currently written INTO the sandbox | `src/lib/agent/claude-code/setup.ts` | **The blocker.** See proxy plan §0 |

---

## 2. Target architecture

```
                     ┌────────────────────────── Botflow (Vercel) ──────────────────────────┐
 owner's browser ────┤  requireProjectAccess(projectId, userId, minRole)                    │
 editor's browser ───┤     ├─ project_members (Neon)                                        │
                     │     └─ role gates + owner-only actions                               │
                     │                                                                      │
                     │  presence:<projectId>:<userId>        (Redis, TTL 15s)               │
                     │  presence:<projectId>:agent:<threadId>                                │
                     │  file-write breadcrumbs, CAS hash checks, agent-turn locks           │
                     │                                                                      │
                     │  Anthropic proxy (separate plan): actingUserId + billingUserId=owner │
                     └───────────────┬──────────────────────────────────────────────────────┘
                                     │  one shared sandbox per project (unchanged)
                                     ▼
                         ┌───────────────────────┐
                         │  Vercel Sandbox VM    │   concurrent bridge processes, one per
                         │  /vercel/sandbox      │   running agent thread; NO credentials
                         └───────────────────────┘   for ANY user in the box (proxy token only)
```

No new services. New spend is limited to Neon rows, Resend emails, marginal Upstash ops, and the proxy's bandwidth/function-time (accounted in the proxy plan).

---

## 3. Access model

### 3.1 Schema

```ts
// project_members — one row per (project, person), including not-yet-signed-up invitees
projectMembers = pgTable('project_members', {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: text(),                      // Clerk id; NULL while invite is pending signup
  invitedEmail: text().notNull(),      // normalized (lowercased) email the invite targeted
  role: text().notNull(),              // 'editor' (owner stays on projects.userId — see below)
  tokenCapPct: integer().notNull().default(25), // % of owner's monthly tokens this member may consume (platform-metered path)
  status: text().notNull().default('pending'), // 'pending' | 'active' | 'revoked'
  invitedBy: text().notNull(),         // Clerk id of the inviter (owner)
  invitedAt / acceptedAt / revokedAt: timestamps,
}, unique(projectId, invitedEmail), index(userId), index(projectId));
```

- **The owner is NOT a member row.** `projects.userId` remains the single source of ownership truth — no migration/backfill, no "project with zero owners" states, and every existing query stays valid. `requireProjectAccess` checks owner first, then membership.
- One row per `(projectId, invitedEmail)` — re-inviting a revoked email flips the row back to pending rather than duplicating.
- `userId` is filled at claim time (see §4) and is what all authorization reads use; `invitedEmail` is only for the pending window + audit.

### 3.2 `requireProjectAccess()` — the foundational refactor

One helper replaces the 34 inline checks:

```ts
requireProjectAccess(projectId, userId, minRole: 'editor' | 'owner')
  → { project, role } | throws 404
```

- Returns 404 (not 403) on no-access, matching today's behavior of hiding project existence.
- Single DB roundtrip: fetch project + membership row in one query.
- Every `/api/projects/[id]/**` route migrates to it. This refactor is independently valuable (it's overdue anyway) and is **the first PR of the feature** — shipped while behavior is still owner-only, so it's a pure no-op refactor that can be verified as such.

### 3.3 Role matrix (v1)

| Capability | owner | editor |
|---|---|---|
| Open workspace, files, preview, terminal | ✅ | ✅ |
| Run agent (own threads) | ✅ | ✅ |
| Save files / env vars (non-secret values) | ✅ | ✅ |
| Git commit/push to the linked repo | ✅ | ⚙️ owner-controlled share-sheet switch, default off (pushes attributed to the acting editor in commit messages) |
| View secret env values, deploy keys | ✅ | ❌ (field-level filtering on the few routes that return them) |
| Invite/revoke members | ✅ | ❌ |
| Delete project, publish/unpublish, custom domains | ✅ | ❌ |
| Connect/disconnect integrations (GitHub, Convex, Stripe, RevenueCat) | ✅ | ❌ |
| Billing-adjacent (Stripe live toggle, RevenueCat env) | ✅ | ❌ |

- `viewer` is deliberately deferred: it forces field-level secret filtering across the whole route surface for a role with no current demand. Editors need it only on a handful of secret-bearing responses.
- **Terminal note:** an editor with a shell can read anything project-scoped in the box. That is accepted by design *after* the secrets audit (§8.2) guarantees nothing account-scoped lives there.

---

## 4. Email invites

```
owner: POST /api/projects/[id]/members  { email, role:'editor' }     (owner-only, rate-limited)
  ├─ normalize email (lowercase, trim)
  ├─ clerkClient.users.getUserList({ emailAddress: [email] })
  │     match ONLY against verified Clerk email addresses
  ├─ found    → insert row { userId, status:'active' }  + Resend "you've been added" email
  └─ not found→ insert row { userId:null, status:'pending' } + Resend invite email w/ signup link
                       │
        Clerk user.created webhook (svix — verify signature)
                       │  match verified emails against pending rows (case-insensitive)
                       └─ claim: set userId, status='active'
        Fallback: lazy claim on login — first authenticated request checks pending rows
                  for the session user's verified emails (covers missed webhooks)
```

- **Paid-plan gate:** the invite route requires the owner to be Pro/Max. On an owner downgrade to Free, memberships are **suspended** (collaborators lose access until re-upgrade; rows are kept, not revoked) — proposed, confirm.
- **Existing users are added instantly** (Google Docs behavior) — the project appears in a "Shared with me" section of `/projects`; a member can leave a project themselves (delete own row).
- **Revoke** is immediate: row → `revoked`; `requireProjectAccess` reads live, so the next request 404s. Any in-flight agent turn the revoked user started is allowed to finish (turn-scoped identity was already bound at spawn).
- Anti-abuse: per-owner invite rate limit; pending invites expire after 14 days (lazy expiry check, no cron needed).
- Signup link routes through the standard Clerk signup with a redirect back to the project.

---

## 5. Billing, identity, and agent concurrency

### 5.1 Billing — hybrid (resolves proxy plan §6/§11.2, locked 2026-07-02)

**Personal credentials are never shared across users.** Two billing paths, chosen per turn by the selected model's credential mode:

- **Platform-metered models** (Fireworks / platform API keys): bill the **owner's** credit pool. The share sheet sets a **per-collaborator cap as a % of the owner's monthly token allowance** (default 25%, editable per member row); enforced **at the proxy / metering layer** and present from the first sharing release — not deferred.
- **Claude Code / Codex OAuth models**: the collaborator's turns use **their own** connected account (their `user_settings` OAuth tokens, refreshed server-side, protected by the same proxy — nobody's token enters the box). The owner's OAuth token is used only for the owner's own turns. A collaborator without a connected account can't select these models.
- **Model availability follows the OWNER's tier**: the project's selectable model list is gated by the *owner's* plan — a Free collaborator on a Max owner's project can select Opus-class models. For OAuth models, whatever the collaborator's own subscription permits applies on top.
- **Owner-OAuth sharing escape hatch (TOS-driven, default OFF everywhere):** it is currently unclear whether Anthropic/OpenAI consumer-subscription TOS permit collaborators consuming the owner's plan. Collaborators may use the owner's OAuth only when BOTH hold: (a) platform env flag `SHARING_ALLOW_OWNER_OAUTH=1`, and (b) the per-project share-sheet switch (`projects.shareOwnerOauth`, owner-set, default off). When both hold, a collaborator's OAuth-model turn resolves to the owner's connected account (billing identity = owner); otherwise the default hybrid rule applies. The env flag is the platform-wide kill switch if compliance clarifies against it; the share-sheet switch is only rendered when the env flag is set, and enforcement is server-side at credential resolution (the UI switch is never trusted).
- **Attribution:** every turn records `actingUserId` (separate attribution table alongside `usage_records`, keeping the existing metering upsert path untouched). Owner sees a per-collaborator breakdown; the proxy binding carries `actingUserId` + the resolved billing identity — the sandbox can influence neither.

### 5.2 Concurrent agents in one shared sandbox

Requirement: collaborators spin up their **own** agents concurrently. Rejected alternatives: a global turn lock (violates the requirement), per-collaborator sandboxes (multiplies the largest cost line + needs a merge product).

Design:

1. **Multiple chat threads per project — private-to-creator for prompting.** Generalize `chat_sessions` → N per project: add `ownerUserId`, `title`, and move active-segment tracking from `projects.currentSegmentId` to the session row. **Only a thread's creator can prompt it** — collaborators never send into each other's threads, so the "prompting a busy shared thread" case cannot arise by construction (a double-send into your *own* busy thread is rejected with a message). Other members get **read-only visibility** of threads for awareness/audit of what changed the shared files *(interpretation to confirm — flip to fully-private threads if preferred)*. Messages carry `userId`. Concurrent turns always run in different threads, so `useChat`/stream state never interleaves.
2. **Cross-agent awareness.** When a turn spawns while another is live, inject into its system prompt: "Another agent is currently active in this workspace, working on: <thread title / first user message>. Avoid unrelated refactors and re-read files before editing." Cheap and effective; not a guarantee.
3. **Infra ops stay serialized.** Dev-server restart, package installs, and git operations (`index.lock`) take short per-project Redis locks (existing run-state machinery). File edits interleave; infrastructure does not.
4. **CC session state per thread.** Claude Code session-resume state becomes keyed per thread (per-thread session ids → separate `~/.claude` session files), so concurrent bridges don't fight over one session.
5. Idle-sleep/keepalive/resume routes move onto `requireProjectAccess` so any member's interaction resumes the sandbox; visibility-aware polling semantics unchanged.

Accepted risk: two agents (or an agent + a human) can still edit the same file in conflicting ways. That's what §6 makes visible and recoverable rather than impossible.

---

## 6. Conflict safety

No merge, no OT/CRDT. Three layers: **prevent silent loss** (CAS), **make collisions rare and visible** (presence + awareness), **make everything recoverable** (versions). Google Docs' real anti-clobber feature is revision history, not locks — same posture here.

### 6.1 CAS saves — the one guardrail that prevents data loss

The classic clobber: Alice opens a file, Bob saves, Alice later saves her stale buffer → Bob's work silently gone.

- File reads to the editor return `{ content, hash }` (sha256 of content).
- Every editor save sends `baseHash`. The server **re-reads and hashes the actual sandbox file** before writing — breadcrumbs are not authoritative, because agents, the terminal, and build tools write files outside the save path.
- Hash mismatch → `409 { currentHash }`; client shows "changed since you opened it" with **reload / view diff / overwrite anyway** (`force: true`).
- This also protects a single user with two tabs/devices — valuable before sharing ships, which is why it lands in Phase 3, not Phase 4.

### 6.2 Auto-reload clean buffers

Clients already poll. When an open file changes remotely and the local buffer is **not dirty**, silently refresh it (preserve cursor/scroll). After this, a real conflict requires two *dirty* buffers on the same file simultaneously — rare, and presence makes it visible.

### 6.3 Presence — "who is editing what file"

- Humans: heartbeat `{ openFile, line, dirty }` → `presence:<projectId>:<userId>`, TTL ~15s.
- Agents: the server-side tool executor stamps `presence:<projectId>:agent:<threadId>` = `{ file, task }` as write tools execute — zero client cooperation needed, works for every backend.
- UI: avatar chips in the file tree (solid when dirty = "actively editing", faded when just viewing); banner when you start typing in a file someone else has dirty; per-thread "files touched this turn" list. Cursor-*line* display comes free in the same payload at poll latency (~2–3s) — good enough, no realtime vendor.
- **Purely advisory — no hard locks.** Since we don't merge, a hard lock creates "why can't I type" friction while CAS already guarantees no silent loss.

Delivery + cost rules (non-negotiable, learned the hard way):

- Presence reads ride the **existing** workspace poll responses (extend preview-state or the merged poll), landing in the poll rate-limit bucket.
- The heartbeat POST must be explicitly classified into the **poll bucket** by the method-aware rate-limit classifier (a naive path/method rule would drop it into `write` 60/min → soft-ban repeat, see rate-limit incident 2026-07-01).
- Presence traffic **never** touches keepalive or `lastSandboxActivityAt` — otherwise collaborator tabs keep VMs awake and recreate the June idle-sandbox bill spike. Heartbeats follow the same visibility-aware suspend rules as existing polls.

### 6.4 Agent write breadcrumbs

Redis breadcrumb per file write: `filewrite:<projectId>:<path>` = `{ actorType, actorId, at }` (short TTL). Used for:

- **Tool-result warnings:** when an agent writes a file another actor touched recently, append to the tool result: "note: this file was modified 30s ago by Alice's agent." Agents respond well to in-band signals. (Claude Code's exact-match edit tool already fails on drifted content and re-reads — natural CAS; the warning covers whole-file `writeFile` paths.)
- Feeding the presence "files touched" UI.

### 6.5 Version history — the backstop

- New table `project_file_versions`: `(projectId, path, content, hash, size, actorType 'user'|'agent'|'system', actorUserId, threadId, createdAt)`.
- Written on every **editor save** and every **agent write tool** execution. Skip if hash equals the latest version (dedup). Text files under a size cap (~512 KB) only; cap ~20 versions per file with oldest-pruned. Neon storage cost is negligible at these bounds.
- UI: per-file history with restore; "restore to 10 minutes ago."
- **Turn checkpoints (v1.5):** snapshot a `{path→hash}` manifest at agent-turn start; "revert this turn" restores captured versions of files the turn changed. Honest limitation: writes that bypass instrumented paths (terminal commands, codegen) are not captured — revert covers instrumented writes only, and the UI says so.
- With cheap restore in place, every other mechanism can stay advisory — this is what keeps the whole design lightweight.

### 6.6 Collision matrix (summary)

| Collision | Protection |
|---|---|
| Human ↔ human (Monaco) | CAS saves (6.1) + auto-reload (6.2) + presence banners (6.3) |
| Human ↔ agent | CAS on human saves; agent edit tools re-read on drift; breadcrumb warnings (6.4) |
| Agent ↔ agent | Prompt awareness (§5.2) + breadcrumb warnings (6.4) + thread attribution |
| Anything ↔ infra ops | Per-project Redis locks on dev server / installs / git (§5.2) |
| All of the above, worst case | Version history restore (6.5) |

---

## 7. Workspace UX surface (v1 scope)

- "Share" sheet (owner, Pro/Max only): email input + member list + revoke — mirrors the Docs share dialog — plus per-member **token-cap slider** (% of owner's monthly allowance, default 25%) and a project-level **"editors can git push" switch** (default off). Cap → `project_members.tokenCapPct`; switch → `projects.editorsCanPush`. When `SHARING_ALLOW_OWNER_OAUTH=1` platform-wide, an additional **"collaborators may use my Claude/Codex subscription" switch** appears (default off → `projects.shareOwnerOauth`; §5.1 escape hatch).
- `/projects`: "Shared with me" section; leave-project action.
- Presence avatars in the workspace header + file tree; agent-thread list showing whose agent is doing what, live-ish.
- Conflict dialog on 409 saves (reload / diff / overwrite).
- Owner-visible usage breakdown per collaborator (settings → usage).

---

## 8. Security prerequisites (blocking)

### 8.1 Anthropic proxy Phases 0–2 — hard blocker

Today the owner's OAuth **refresh token** sits in `~/.claude/.credentials.json` inside the sandbox; BYOK keys ride the bridge env. A collaborator with terminal or agent access can exfiltrate it → **persistent account takeover**, not just spend. No invite ships before the proxy plan's Phase 2 (credential fully out of the box, fail-closed). Sharing enablement is that plan's Phase 3 — the two plans interlock; this document owns the membership/UX/conflict layers, that one owns credentials.

### 8.2 Sandbox secrets audit

Rule: **project-scoped secrets may remain in the box** (editors are collaborators on the project — tool token, project env vars, dev-server config are theirs to see). **Account-scoped secrets must not** (anything reusable across the owner's *other* projects/accounts):

| Secret | Scope | Action |
|---|---|---|
| Anthropic OAuth / BYOK | account | Proxy plan (blocker) |
| GitHub access token (git remote URLs / env) | account | Audit: keep git ops server-side (REST) or scope via a per-repo installation token — must NOT be readable in-box |
| Convex account OAuth / deploy key | account vs deployment | Deploy key is deployment-scoped → acceptable; account OAuth must never enter the box |
| `BOTFLOW_TOOL_TOKEN` | project + turn | OK (already scoped); re-verify under multi-user threat model |
| Project env vars incl. "secret" ones | project | In-box OK for editors; **UI/API field-filtering** keeps them out of editor-visible *responses* where marked secret |

Deliverable: a one-page inventory of everything that lands in sandbox env/filesystem at boot + per turn, tagged project- vs account-scoped, with fixes for every account-scoped item.

---

## 9. Rollout / phasing

Phases 1–2 are prerequisites from §8; conflict safety intentionally lands **with** members+invites (Phase 3), since CAS + presence + versions are valuable even single-user (two tabs) and de-risk the concurrency phase.

1. **Phase 0 — foundation refactor (no behavior change).** `requireProjectAccess()` helper; migrate all ~34 routes; verify pure no-op while still owner-only. Field-level secret filtering marked for the routes that return secrets.
2. **Phase 1 — proxy Phases 0–2** (separate plan; can proceed in parallel with Phase 0).
3. **Phase 2 — sandbox secrets audit** + fixes for account-scoped items (§8.2).
4. **Phase 3 — members + invites + conflict safety.** Pro/Max gate on invites; `project_members`, invite/claim/revoke flow, Shared-with-me UI, role gates live; share sheet with per-member % caps (enforced) + git-push switch; owner-tier model-list gating; per-actor OAuth credential resolution; CAS saves, auto-reload, file-level presence, `project_file_versions`. Feature-flagged; dogfood on internal projects first. *(Still one-agent-at-a-time at this point: turns across ALL threads take the per-project agent lock.)*
5. **Phase 4 — concurrent agents.** Multi-thread schema migration (private-to-creator prompting), per-thread CC session state, drop the global agent lock in favor of per-thread locks + infra-op locks, cross-agent prompt awareness, breadcrumb warnings, actor-attributed usage + owner breakdown. Proxy binding extended with acting identity + per-path billing (proxy Phase 3).
6. **Phase 5 — polish.** Cursor-line presence, turn checkpoints/revert-turn, cap-default tuning from real usage data, invite-expiry tuning.

---

## 10. Testing

- **Authz:** every migrated route × {owner, active editor, revoked editor, pending invitee, stranger} — expect exact today-behavior for owner, 404 for non-members; secret-bearing responses filtered for editors.
- **Invites:** existing-user instant add; pending → webhook claim; webhook-missed → lazy login claim; unverified-email must NOT match; revoke mid-session cuts next request; re-invite after revoke.
- **CAS:** stale save → 409; force overwrite; save racing an agent write (server re-hash catches it); two tabs same user.
- **Concurrency:** two threads, two turns, same project — streams don't cross; infra-op lock contention (both agents restart dev server); git `index.lock` never surfaces to users.
- **Cost regressions:** presence heartbeat lands in poll bucket (no soft-ban at 2 collaborators × normal usage); idle-sleep still fires with a presence-only idle tab open — **explicit test**, this is the June bill-spike regression.
- **Owner-OAuth flag:** with env flag unset, the share-sheet switch is hidden AND a collaborator turn can never resolve the owner's OAuth even if `shareOwnerOauth` is true in the DB; with flag set + switch on, collaborator OAuth turn uses the owner's account and bills the owner.
- **Billing:** platform-metered collaborator turn meters to owner with correct `actorUserId`; per-member % cap blocks the turn past the threshold (clean error, not mid-turn kill — decide exact semantics at build time); OAuth turn uses the collaborator's OWN token and never the owner's; collaborator without a connected account cannot select OAuth models; Free collaborator on a Max owner's project sees Max model list; revoked collaborator's in-flight turn completes then no new turns.

---

## 11. File-by-file change surface (approximate, for when we build)

| Area | Change |
|---|---|
| `src/db/schema.ts` + migration | **New:** `project_members` (incl. `tokenCapPct`), `project_file_versions`, usage-attribution table; `projects.editorsCanPush`, `projects.shareOwnerOauth`; `chat_sessions` + `ownerUserId`/`title`/active-segment; `chat_messages.userId` |
| `src/lib/agent/models.ts` + model-select UI | Model availability gated by the project **owner's** tier; OAuth models require the **acting** user's own connected account |
| `src/lib/project-access.ts` | **New:** `requireProjectAccess()` |
| `src/app/api/projects/[id]/**` (~34 routes) | Migrate to helper; role gates; secret field filtering |
| `src/app/api/projects/[id]/members/*` | **New:** invite / list / revoke / leave |
| `src/app/api/webhooks/clerk` | **New or extended:** `user.created` claim (svix-verified) |
| `src/lib/presence.ts` + poll endpoints | **New:** heartbeat write, presence read merged into existing poll responses; poll-bucket classification |
| File save route + Monaco editor | CAS (`baseHash` → 409 → conflict UI); auto-reload clean buffers; version write |
| Agent tool executor (writeFile/applyDiff paths) | Version write, breadcrumbs, tool-result warnings, agent presence stamps |
| Agent spawn paths (both backends) | Per-thread sessions, awareness injection, thread locks, acting/billing identity |
| `/projects` page + workspace UI | Shared-with-me, share dialog, presence avatars, conflict dialog, usage breakdown |
| Rate limit classifier | Presence heartbeat → poll bucket |
| Idle-sleep/keepalive | Membership-aware resume; presence excluded from activity |

---

## 12. Decisions

Resolved 2026-07-02 (owner):

1. **Availability** — Pro/Max owners only.
2. **Thread semantics** — threads are private-to-creator for prompting; prompting someone else's thread is impossible by design; double-send to your own busy thread is rejected.
3. **Editor git push** — per-project share-sheet switch, default off.
4. **Billing** — hybrid: platform-metered → owner's credits with per-collaborator share-sheet % caps at launch; Claude/Codex OAuth → collaborator's own connected account (tokens never shared); model list gated by owner's tier. Owner-OAuth sharing permitted only behind `SHARING_ALLOW_OWNER_OAUTH` env flag + per-project share-sheet switch, both default off (TOS-compliance uncertainty — flag = platform kill switch).

Resolved (engineering defaults, changeable):

5. **Usage attribution** — separate attribution table (existing `usage_records` upsert path untouched).
6. **Invite expiry** — 14 days, lazy expiry.
7. **Version caps** — 20 versions/file, 512 KB size cap.
8. **Cap default** — 25% per member.

Still open:

9. **GitHub token remediation** (§8.2) — server-side-only git vs scoped installation tokens; decided after the Phase 2 audit reports what's actually in the box.
10. **Thread visibility** — read-only visibility of others' threads assumed (awareness/audit); confirm vs fully private.
11. **Owner downgrade behavior** — suspend memberships until re-upgrade (proposed §4).
