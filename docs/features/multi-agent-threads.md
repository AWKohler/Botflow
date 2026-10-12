# Multi-agent threads — plan

Status (2026-10-11): Phase 0 in PR #69 (`feat/retire-botflow-agent`). Phase 1 in PR #70 (`feat/agent-threads`, §11). Phase 2 built on `feat/shared-threads` (§12).

Each project gets a ChatGPT/Claude-style list of agent threads in the agent
panel. Each thread works like opening a new Claude Code or OpenCode terminal: it
has its own conversation, its own model, and its own agent process in the
project's shared sandbox. Several threads can run at the same time. Every
project member sees every thread live and can prompt any of them.

---

## 1. Decisions (locked)

| Topic | Decision |
|---|---|
| Agents | **Claude Code and OpenCode only**, both running in the sandbox. The server-side Botflow agent (`/api/agent`) is dead and is deleted in Phase 0. Nothing may fall back to it. |
| Model | **Per thread.** Any thread can run any model. The composer's model selector changes only the current thread. |
| Visibility | **Threads are shared by the whole project.** Every member with the project open sees every thread's text and tool calls streaming live, can prompt any thread, and can create threads. This **replaces** the sharing plan's "private-to-creator for prompting" rule ([project-sharing-plan.md](project-sharing-plan.md) §5.1). |
| Needs-input requests | Env vars, OAuth setup and Stripe connect follow the sharing permission table (project-sharing-plan.md §3). Any member can answer an `ask_question`; secret env values and integration connects stay owner-only. |
| Concurrency | **Not a paid feature.** The same rule applies to every tier. Thread *count* is unlimited; the limit is on how many agents may be *running* at once in one sandbox (§5). |
| Scope | Threads belong to a project. A new project starts with no threads. |
| Subagents | Claude Code `Task` subagents appear as nested sidebar entries in a later phase (Phase 3). |

Still open: **who may delete a thread.** Default until decided: any member can
archive; only the thread's creator or the project owner can delete.

---

## 2. What exists today

| Piece | Where | Reused as |
|---|---|---|
| Conversation segments: Reset mints `projects.current_segment_id`, and old segments' messages are kept | `chat_messages.segment_id`, `/api/chat` | One-time backfill: each existing segment becomes a thread |
| Detached in-sandbox agents + turn record + reattach | `claude-code/turn-registry.ts`, `/api/agent/claude-code/{reattach,turn-status,stop}` | Per-thread keys; also how multiple viewers follow one turn |
| Resumable sessions (Claude Code / OpenCode) | `claude-code/session-store.ts`, `opencode/session-store.ts` | Key per thread instead of per project |
| Subagent timeline parts | `data-claude-code-subagent` in `claude-code/translator.ts` | Phase 3 sidebar children |
| Sharing: `requireProjectAccess`, members, LLM-proxy billing attribution | `src/lib/project-access.ts`, `src/lib/sharing.ts`, `llm-proxy/` | Who may view, prompt, and pay |

### Single-agent assumptions to remove

| Assumption | Location |
|---|---|
| A new turn kills the project's previous agent | `buildPrepareTurnScript` + `BRIDGE_PID_FILE` in `claude-code/bridge-control.ts` |
| One turn record per project | `claude-code:turn:<projectId>` |
| One session id per project | `claude-code:session:<projectId>`, `opencode:session:<projectId>` |
| One live agent per project across collaborators | `sharedTurnBlockReason` in `src/lib/sharing.ts` |
| The browser that sent the prompt saves the assistant's reply | `AgentPanel` → `POST /api/chat` |
| Queued messages live in one browser's memory | `messageQueue` state in `AgentPanel` |
| The model is per project | `projects.model`; the selector PATCHes the project |
| Window events carry only `projectId` | `agent-busy-change`, `agent-turn-finished`, `agent-user-stopped` |

---

## 3. Data model

`chat_sessions` becomes the threads table (keeping the table name avoids a
rename migration):

```
chat_sessions
  id                uuid pk
  project_id        uuid fk → projects (cascade)
  title             text            -- from the first prompt; renameable
  created_by        text            -- user id
  model             text            -- per-thread model (replaces projects.model as the source)
  current_segment_id uuid           -- moved from projects; a backend switch inside a thread mints a new segment
  status            text            -- cached: idle | running | needs_input | error
  last_turn_started_at / last_turn_ended_at timestamptz
  archived_at       timestamptz null
  created_at / updated_at

chat_thread_views   (unread tracking, per user)
  thread_id, user_id, last_viewed_at   pk(thread_id, user_id)

chat_thread_queue   (server-side message queue)
  id, thread_id, user_id, message jsonb, status (queued|claimed|sent|cancelled), created_at

chat_messages     + user_id (author of user messages)
chat_questions    + thread_id
oauth_provider_requests / env_var_requests / stripe_connect_requests
                  + thread_id (still one pending per PROJECT — the modal is project-level;
                    the thread id only drives that thread's "needs input" status)
```

**Backfill.** The current one-session-per-project row becomes one thread per
distinct `segment_id`, titled from that segment's first user message. Its
model is `projects.model`, and the newest segment becomes the open thread.
`projects.model` is kept as "default model for new threads".

---

## 4. Runtime: everything keyed per thread

- Turn record: `claude-code:turn:<projectId>:<threadId>`. A project-level set
  `agent:running:<projectId>` → `{threadId: startedAt}` answers "what's running"
  in one read.
- Sessions: `claude-code:session:<threadId>`, `opencode:session:<threadId>`.
- Sandbox paths: `/tmp/botflow-cc/<threadId>/bridge.pid`, plus event files per
  turn as today. `buildPrepareTurnScript(threadId, …)` kills **only that
  thread's** previous agent.
- The stop, reattach and turn-status routes take `threadId`.
- Tool tokens and LLM-proxy tokens record `threadId`, so tool callbacks (ask_question,
  HITL) attribute to the right thread.
- **Per-project infra locks** (short Redis locks): package install, dev-server
  restart, git operations. File edits interleave freely; infra does not.
- **Cross-agent awareness:** when a turn starts while other threads are running,
  append to its system prompt: *"Other agents are working in this project right
  now: «title» (…). Re-read files before editing them and avoid unrelated
  refactors."*
- Claude Code and OpenCode can run side by side, since each thread has its own
  process.

### Server owns persistence

On `end_turn` the bridge calls `POST /api/internal/agent/turn-finished` over the
existing tool-token rail. The server reads the turn's event file, runs the
backend's translator, and upserts the messages. Message ids are derived from
the event log, so retries are idempotent. Browsers stop writing to `/api/chat`.
This gives one writer no matter how many people are watching, or whether anyone
is watching at all.

---

## 5. Concurrency limit (sandbox capacity)

The limit applies only to **starting or restarting an agent** (spawning a turn). Creating
threads, reading them and queueing messages are never blocked.

Admission check, run inside the existing prepare-turn script before spawning:

1. **Memory check (primary).** Read cgroup `memory.max` / `memory.current`
   (fall back to `/proc/meminfo` `MemAvailable`). Admit when available memory ≥
   `AGENT_MEM_RESERVE_MB` (initial value 700 MB) plus a safety margin of
   `SANDBOX_MEM_FLOOR_MB` (initial value 512 MB) for the dev server and builds.
2. **Hard ceiling (backstop).** At most `MAX_RUNNING_AGENTS_PER_PROJECT` (initial value 6)
   running at once, counted from `agent:running:<projectId>`, whatever the memory reading.

Measuring adapts by itself: a 4 GB Vercel sandbox and a differently sized
sandbox-host VM each admit what they can actually hold, with no per-provider
table. The ceiling protects against a bad reading, CPU contention and runaway cost.

If a turn is refused, the message stays in the thread's queue with status
*"waiting for capacity"*. When any running turn ends, the server drains queued
messages project-wide in FIFO order.

**Calibration (Phase 1 task):** measure real resident memory for Claude Code
and OpenCode agents during heavy turns on both sandbox providers, then set
`AGENT_MEM_RESERVE_MB` from the 95th percentile. Both numbers are environment
variables so they can be tuned without a deploy.

---

## 6. Live multi-viewer streaming and shared prompting

- **Viewing.** Every viewer of a thread follows the same sandbox event file
  through the reattach route, which already works for any number of readers.
  Browsers stream only the thread that's on screen; other threads update
  through the status poll.
- **Prompting.** If the thread is idle, the message spawns a turn (subject to §5).
  If it's busy, the message goes into `chat_thread_queue`, everyone sees it
  ("queued by Alex"), and the server starts it at `end_turn`. Any member can stop
  a thread or remove a queued message.
- **Credentials per sender.** Each turn's backend is decided from the
  **sender's** credentials plus the thread's model. Billing follows the sharing
  rules: platform credits are charged to the owner within per-member caps; Claude
  and ChatGPT/Codex subscriptions are always the sender's own account. If the
  sender can't run the thread's model, their composer shows why and how to fix
  it. If the backend differs from the previous turn (Claude Code ↔ OpenCode),
  a new segment starts inside the thread, as today.
- **Attribution.** User messages show their author. Thread rows show avatars of
  who's currently viewing them (presence on the status poll).

---

## 7. Status indicators

One poll: `GET /api/projects/:id/threads`, using the poll rate-limit bucket,
paused while the tab is hidden, and **never counted as sandbox activity**.

| Dot | Meaning | Source |
|---|---|---|
| pulsing | running | live turn record |
| amber | needs input | pending `chat_questions` / HITL row with this `thread_id` |
| red | error | turn record `dead`, or the turn ended with an error |
| accent dot | done, unread | `last_turn_ended_at > chat_thread_views.last_viewed_at` |
| — | idle | |

There is also a toast when a background thread needs input or fails.

---

## 8. UI

- The agent column stays 384px. A **threads button** in the header opens a list that
  slides over the column. It has *New agent*, sections Running / Recent / Archived,
  status dots, viewer avatars, rename and archive.
- The header shows the current thread's title and a small row of dots for other
  active threads.
- **Reset is removed**; *New agent* replaces it.
- The composer's model selector reads and writes `thread.model`.
- `AgentPanel` takes `threadId`. Switching threads remounts it. Background turns
  keep running in the sandbox, so nothing has to stay mounted.

---

## 9. Phases

### Phase 0 — retire the Botflow agent
- Delete `src/app/api/agent/route.ts` and its tool/prompt modules that nothing else
  imports.
- `deriveAgentBackend` returns only `claude-code | opencode` and gives
  `runnable: false` with a reason where it used to fall back.
- `AgentPanel`: remove the 412 → `/api/agent` retry, the Botflow request
  transform, client-side tool resolution, and resubmit-based auto-continue.
- Hardcode the Claude Code and OpenCode paths on; remove
  `NEXT_PUBLIC_OPENCODE_BACKEND_ENABLED` / `NEXT_PUBLIC_CLAUDE_CODE_ENABLED`
  and their legacy branches.
- `projects.agent_backend` stays in the database but is no longer read (its
  removal is a later migration).

### Phase 1 — threads
Data model + backfill, per-thread runtime keys, model per thread, server-side
persistence, admission control + calibration, infra locks, awareness note,
thread list UI, status poll.

### Phase 2 — shared live threads
Multi-viewer streaming, server-side queue, sender-based credentials and blocked-model
messaging, attribution, presence, permission-gated HITL.
`sharedTurnBlockReason` is removed.

### Phase 3 — subagents
Claude Code `Task` subagents as nested, read-only sidebar entries with their own status.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Two agents edit the same file | Awareness note, re-read instruction, file version history (`project_file_versions`) as the backstop |
| Out-of-memory crash takes down the dev server and every agent | Memory admission check + ceiling; calibrate before raising the ceiling |
| Concurrent turns race the credit reservation | Audit `llm-proxy/billing` reservations under concurrency in Phase 1 |
| Status poll keeps sandboxes awake | Poll bucket, paused while hidden, explicitly excluded from keepalive |
| Viewer streams cost function time | Stream only the on-screen thread; reattach chunks as today |

---

## 11. Phase 1 — what shipped, gaps, deploy runbook

**Shipped** (`feat/agent-threads`):
- Data model + backfill (§3). Verified against an in-memory Postgres (PGlite), run twice.
- Per-thread runtime (§4): turn records, session pointers, pidfiles and abort files are all
  keyed by thread; stop, reattach and turn-status take `threadId`. Claude Code OAuth turns
  pass their proxy token via `CLAUDE_CODE_OAUTH_TOKEN`, not the shared credentials file.
- Capacity admission (§5) inside the prepare script; refusals return 429 with a clear message.
  The script is exercised for real in `bridge-control.test.ts`.
- Server-side saves (§4): bridges call `/api/internal/agent/turn-finished`. The reply is saved
  under the per-turn id `turn-<turnId>`, which the live stream and reattach also use.
- Thread API, the status poll (poll bucket, paused while the tab is hidden, DB + Redis only),
  per-thread model, the awareness note, and question/HITL attribution.
- UI: header is [threads] [+ New chat] [Reset] … [gauges] [Settings]. The sheet overlays the
  agent column; it closes on Esc or any click outside it. Rows show status dots, rename,
  archive and delete. New chat reuses an untouched thread. Background threads that need input
  or fail raise a toast. The selected thread is remembered per project.

**Known gaps (not done in Phase 1):**
- **Infra locks** (installs, dev-server restarts, git) are not built yet. Agents run those
  through their own shell, so a lock needs a bridge-side wrapper; the awareness note is the
  only guard for now.
- **Needs-input requests are still one per project.** A second thread's env-var / OAuth /
  Stripe request dismisses the first thread's pending one. Goes with Phase 2's
  permission-gated version.
- **ChatGPT/Codex OAuth:** its tokens live in the shared OpenCode `auth.json`. Two Codex
  threads running at once for the same user can race on token refresh.
- **Calibration:** `AGENT_MEM_RESERVE_MB` is an estimate until agent memory use is measured
  on both sandbox providers.
- **Turns in flight at deploy time:** their old per-project turn record and session pointer
  aren't read, so they can't be reattached. Those threads continue with the
  prior-conversation preamble.

**Deploy runbook:**
1. Run `node scripts/migrate-agent-threads.mjs` against staging, then production, **before**
   deploying. It is idempotent; the app needs the new columns.
2. Optional env (defaults shown): `MAX_RUNNING_AGENTS_PER_PROJECT=6`,
   `AGENT_MEM_RESERVE_MB=700`, `SANDBOX_MEM_FLOOR_MB=512`.
3. Staging checks:
   - two threads running at once, one Claude Code and one OpenCode;
   - switch away mid-turn and come back (reattach);
   - close the tab mid-turn, and confirm the reply is saved;
   - Stop one thread while the other keeps going;
   - push the running count to the ceiling and confirm the 429 message;
   - a question in a background thread turns its dot amber and raises a toast.

---

## 12. Phase 2 — what shipped, gaps, deploy runbook

**Shipped** (`feat/shared-threads`):
- **Turn starters.** The agent routes' bodies moved into `startClaudeCodeTurn` /
  `startOpenCodeTurn` (`src/lib/agent/turn-start`). Each spawns the bridge and returns
  `toResponse()` for the live stream, so the server can start turns that nobody is streaming.
- **One live turn per thread, never killed.** The prepare script refuses (409 `thread_busy`)
  while the thread's bridge is alive. A short Redis spawn lock covers the moment before a new
  bridge writes its pidfile. `sharedTurnBlockReason` is gone.
- **Server-side queue** (`chat_thread_queue`). Messages sent to a busy thread wait server-side
  and are visible to every member. `drainThreadQueue` claims the oldest one with a
  compare-and-set and starts it **as its author**, so it bills to them and uses their
  credentials. Drain triggers: turn end, enqueue, and a viewer backstop. Bridges remove their
  pidfile before the end-of-turn notify so the drain sees the thread as free. Stop clears the
  queue first.
- **Following.** The threads poll reports each thread's live turn id. A viewer who didn't start
  a turn reloads the saved prompt and reattaches to the live event stream. When a turn ends,
  every viewer reloads from the database, so everyone converges on the same history.
  `turn-finished` also saves the agent's session pointer.
- **Attribution and presence.** Prompts from other members show their name. The header shows
  who else is viewing the thread; sheet rows show viewers and queued counts. Presence is one
  Redis hash per project; member identities are Redis-cached.
- **Needs-input permissions.** Secret client env values are owner-only server-side. A member
  who can't complete a request sees "Waiting for the project owner" instead of a form;
  editors can still tell the agent to skip an env var. An env-var request no longer dismisses
  another chat's pending request; the second agent is told to wait and retry. Late-submit
  notes go to the chat that asked, through its queue.

**Known gaps:**
- **Following delay:** a viewer starts following another member's turn within one poll
  (about 4s), not instantly.
- **One request per kind:** OAuth and Stripe requests are still one per project, by design;
  the second chat reuses the existing request.
- **Codex OAuth refresh race** (from Phase 1) is unchanged.
- **Queue drain retries:** a turn refused for capacity is retried by the next turn end or the
  viewer backstop (at most every 15s per viewer).

**Deploy runbook:**
1. Run `node scripts/migrate-thread-queue.mjs` (after Phase 1's migration), staging then prod.
2. Bridges are version-bumped (Claude Code 37, OpenCode 13); sandboxes rewrite them on their next turn.
3. Staging checks, with two accounts on one shared project:
   - B sees A's turn stream live;
   - B's message to A's busy thread queues, shows for both, and starts as B when A's turn ends;
   - Stop clears the queue;
   - presence chips and author labels appear;
   - an editor sees the owner-only card for OAuth, Stripe and secret env vars;
   - a late env-var submit reaches the chat that asked.
