# OpenCode agent backend (Phase 1)

Flag: `NEXT_PUBLIC_OPENCODE_BACKEND_ENABLED`. When ON, OpenCode drop-in
replaces the Botflow agent as the presented agent: non-Anthropic models with a
personal credential (Codex/ChatGPT-plan OAuth or a BYOK provider key) run
inside an `opencode` subprocess in the project's Vercel Sandbox, mirroring the
Claude Code rail. Users without personal creds keep executing on `/api/agent`
via the 412-fallback contract (rendered neutrally — no "Botflow" agent
branding under the flag). Anthropic models are untouched (Claude OAuth →
Claude Code per ToS; Anthropic BYOK per preference). Platform server keys
never enter the sandbox; platform-metered OpenCode requires the provider
proxy (separate project).

Pinned versions (env-overridable; installed locally in the sandbox under
`~/.botflow/opencode/`, no sudo):
- `opencode-ai` `1.17.13` (`BOTFLOW_OPENCODE_VERSION`)
- `@modelcontextprotocol/sdk` `1.29.0` (`BOTFLOW_MCP_SDK_VERSION`) — used by
  the MCP tool script only. The bridge deliberately carries NO
  `@opencode-ai/sdk` dependency: it speaks plain fetch + SSE against four
  endpoints (`/session`, `/session/{id}/prompt_async`, `/session/{id}/abort`,
  `/event`) whose shapes were locked from the SDK's generated types at the
  pinned version.

Rate limit bucket: `opencode` (`RL_OPENCODE`, default 10/min).

## Integration-spike findings (2026-07-03, opencode 1.17.13)

Everything below was verified against the real binary/SDK/source at the
pinned version — not docs. Re-verify on any version bump.

### auth.json (`~/.local/share/opencode/auth.json`)
- Shape (confirmed from a real installation + SDK `Auth` type):
  `{ "<providerID>": { type: "api", key } | { type: "oauth", access, refresh, expires } }`
  with `expires` in epoch ms. There is **no accountId field** on the OAuth
  entry (SDK `OAuth` type: `access/refresh/expires/enterpriseUrl?`).
- An OAuth entry beats an API key for the same provider — write exactly ONE
  `openai` entry per turn (OAuth preferred).
- Never write an `anthropic` entry (ToS: Claude plans → Claude Code only).
- `XDG_DATA_HOME` relocates the data dir (used by tests/spikes; in the
  sandbox we use the real `$HOME`).

### Provider ids (verified against the binary's catalog)
- `openai`, `google`, `fireworks-ai`, `togetherai`.
  (The docs' `together-ai` is wrong for 1.17.13 — the catalog resolves
  `togetherai`; `google-generative-ai` doesn't resolve, `google` does.)
- The BUNDLED models.dev snapshot lags our model registry (e.g. it has
  kimi-k2p6/minimax-m2p7 but not k2p7-code/m3). **Always declare our exact
  model ids under `provider.<id>.models.<modelID>` in the generated config**;
  never rely on the catalog knowing them.

### Server / serve
- Readiness stdout line: `opencode server listening on <url>`.
- `--port=0` is NOT honored (falls back to default 4096) — the bridge picks
  an explicit random high port and retries on collision.
- `OPENCODE_CONFIG_CONTENT` env carries the full per-turn config inline
  (highest file-level precedence; nothing written into the user's project).

### Events (SDK `Event` union at 1.17.13)
- There is **no `message.part.delta` event** and **no `question.*` events**
  (t3code was written against a different version). The vocabulary we use:
  - `message.part.updated` `{ part, delta? }` — text/reasoning parts carry
    accumulated `text` (+ optional delta); tool parts carry
    `{ callID, tool, state }` with state.status pending→running→completed/error.
  - `message.updated` `{ info }` — assistant messages carry
    `tokens {input, output, reasoning, cache{read,write}}` + `cost` + `error?`.
  - `session.status` `{ status: {type: "busy"|"idle"|"retry"} }`, `session.idle`.
  - `session.compacted` `{ sessionID }` — drives the compaction divider.
  - `session.error` `{ error }` — union includes `MessageAbortedError`, which
    the bridge treats as a NORMAL end (user abort), not an error.
  - `permission.updated` → reply `POST /session/{id}/permissions/{permissionID}`
    with `{ response: "once"|"always"|"reject" }` (defensive backstop; config
    already allows everything).
- Builtin tool ids: `invalid, question, bash, read, glob, grep, edit, write,
  task, webfetch, todowrite, websearch, skill, apply_patch`. The builtin
  `question` tool is disabled per-prompt (`tools: { question: false }`) in
  favor of our MCP `ask_question` (which renders the QuestionPrompt UI).

### Prompting
- `session.promptAsync` exists (204 + events); body supports per-prompt
  `model {providerID, modelID}`, `system`, `tools {name: boolean}`, and
  `parts` (TextPartInput | FilePartInput...). `directory` rides as a query
  param; `session.create` body is `{parentID?, title?}`.
- `FilePartInput`: `{ type: "file", mime, filename?, url }` — image delivery
  uses file:// URLs pointing at /tmp files the bridge writes (data: URIs
  unverified; check during e2e before relying on them).

### MCP
- Local server config: `mcp.<name> = { type: "local", command: [...],
  environment: {...}, enabled, timeout? }`. `timeout` is for FETCHING the
  tool list (default 5000ms) — set generously; tool-CALL timeout behavior is
  unverified and must be checked in e2e with a long-blocking `ask_question`.
- Tool naming (from source, `packages/opencode/src/mcp/catalog.ts` @v1.17.13):
  `sanitize(server) + "_" + sanitize(tool)` → ours surface as
  `botflow_convex_deploy`, `botflow_ask_question`, … The translator strips
  the `botflow_` prefix before parts reach the UI/history.

## Still to verify live (dev-deployment e2e)
- Codex OAuth end-to-end through opencode (token written by us → chatgpt
  backend call succeeds; refresh-token rotation behavior over multiple turns).
- MCP tool-CALL timeout vs our 5-minute blocking tools (`ask_question`,
  `initialize_stripe_payments`).
- file:// image parts reach the model on gpt/gemini.
- Whether opencode rewrites auth.json mid-turn (rotated refresh token needs
  persisting back — route reads it back after end_turn if so).
