# Universal LLM proxy

All in-sandbox agent provider traffic transits
`/api/internal/llm-proxy/[provider]/[...path]`. Sandboxes hold turn-scoped
`bfap_` tokens — never real credentials (platform, BYOK, **or** OAuth) —
because project collaboration means co-tenants can read anything in a
sandbox. The proxy injects the real credential server-side and is the ONLY
component that turns usage into money.

Gated by `NEXT_PUBLIC_OPENCODE_BACKEND_ENABLED` (strictly opt-in — it now
governs billing behavior). Flag off = full legacy kill switch: Botflow via
/api/agent, Claude Code with real credentials, byte-identical.

## Routing decision table (flag ON, sandbox platform)

| Traffic | Backend | credMode | Sandbox holds |
|---|---|---|---|
| Anthropic + Claude OAuth | Claude Code | oauth | bfap_ token (credentials.json, far-future expiry so the CLI never self-refreshes) |
| Anthropic + BYOK key | Claude Code | byok | bfap_ token (`ANTHROPIC_API_KEY`) |
| Anthropic + no personal creds (paid tier) | OpenCode | platform | bfap_ token (auth.json `anthropic` entry) |
| OpenAI + ChatGPT/Codex OAuth | OpenCode | — | **real Codex tokens** (the one documented exception, below) |
| Any other model + BYOK key | OpenCode | byok | bfap_ token (auth.json) |
| Any other model, no personal creds | OpenCode | platform | bfap_ token (auth.json) |
| Anything, tier below the model's platform requirement | — | — | not runnable (`tier_too_low`; picker hides) |

`ANTHROPIC_BASE_URL` / opencode `provider.options.baseURL` point at the
proxy; opencode also pins `small_model` to the turn's model so title-gen
calls stay priced/allowlisted.

### The Codex exception
opencode 1.17.13's ChatGPT-plan plugin hardcodes its endpoint (the
`codexApiEndpoint` option is not wireable from config) and SELF-REFRESHES
against auth.openai.com — a proxy token in its auth slot would be sent to
OpenAI's token endpoint. So Codex OAuth tokens stay in-sandbox for now:
the user's own account, exposure limited to their own future co-tenants.
**Pre-sharing-GA blocker.** When upstream makes the endpoint wireable, add a
`codex` entry to `LLM_PROXY_PROVIDERS` (upstream
`https://chatgpt.com/backend-api/codex`, bearer + ChatGPT-Account-Id header
injection via `getFreshCodexAccessToken`) and swap `writeOpenCodeAuth` to a
token — nothing else changes.

## Token lifecycle
`src/lib/agent/llm-proxy/token.ts`: `bfap_<32B>` bound in Redis to
`{userId, projectId, turnId, provider, credMode, modelId, modelAllowlist}`;
30-min SLIDING TTL (touched per request — long detached turns keep working);
revoked by the NEXT turn's prepare/spawn or the stop route via the turn
registry (`llmProxyToken` field) — never by the streaming route's `finally`
(detached bridges legitimately outlive routes; reattach contract). The model
allowlist is enforced hard in platform mode, advisory (log
`model_off_allowlist_advisory`) on personal creds — Claude Code runs
Haiku-class background models.

## Billing plane (the whole point)
Nothing money-related is read from the sandbox; opencode's self-reported
usage drives ONLY the UI context bar. The proxy tees every 2xx response
(client branch returned untouched — parser bugs can only undercount, never
corrupt user traffic) and parses authoritative usage per dialect:

| Dialect | Usage source | Cached tokens |
|---|---|---|
| anthropic | `message_start` (+ last `message_delta` output) | explicit: `cache_read_input_tokens` + BILLED `cache_creation_input_tokens` (writes cost 1.25×; `calculateCredits` prices them). Note anthropic reports UNCACHED input — the meter normalizes to total-in. |
| openai-chat | final usage chunk — the proxy INJECTS `stream_options.include_usage` | `prompt_tokens_details.cached_tokens` (passive, discounted reads) |
| openai-responses | `response.completed` | `input_tokens_details.cached_tokens` |
| google | last `usageMetadata` (output = candidates + thoughts) | `cachedContentTokenCount` |
| fireworks / together | openai-chat dialect; often report NOTHING | **clock heuristic** (ported from /api/agent): no explicit report + previous call on the same key < 5 min ago ⇒ input billed as cached. Keys `llm-proxy:last_call:<provider>:<credMode>:<user>:<project>` — namespaced so a BYOK call never marks the PLATFORM key's cache warm. |

Platform mode per request: worst-case reservation (bodyBytes/4 bounded by
context window + `LLM_PROXY_RESERVE_OUTPUT_TOKENS`, default 8192 — NOT the
32K hard cap, which alone would exceed the free tier's weekly budget on
high-output-multiplier models) → atomic `reserveWeeklyCredits` → settle to
observed usage (`adjustWeeklyCredits`, exactly-once; aborts settle partials;
zero-usage errors release fully). Monthly + tier gates run at MINT time in
the agent routes (limitReachedResponse — same upgrade UI), weekly INCRBY is
the per-request limiter: the same split /api/agent used. Exhaustion returns
a 402 in the provider's native error dialect ("Botflow credits exhausted…")
so the agent surfaces it verbatim. Personal modes record usage with
credits=0 (audit parity). `usage_records.agentTurns` keeps meaning TURNS:
proxy rows pass `countTurn:false`; agent routes write a zero-token turn
marker at spawn (CC turns now appear in usage_records for the first time).
The settlement fires `incomplete_usage` log lines when a billable stream
ends without a terminal usage frame — watch these during the bake (silent
undercount = revenue leak, never user harm).

## Env vars
- `LLM_PROXY_ORIGIN` — override the proxy origin the sandbox calls
  (default: the turn request's origin). Escape hatch for protected previews.
- `LLM_PROXY_RESERVE_OUTPUT_TOKENS` (8192), `PLATFORM_MAX_OUTPUT_TOKENS`
  (32000), `RL_LLM_PROXY` (120/min per user).
- Platform keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `FIREWORKS_API_KEY`,
  `TOGETHER_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`. Missing key ⇒ the
  agent route 412s and the legacy engine serves (bake safety net).

## Preview deployments
Deployment Protection answers the sandbox's cookie-less calls with HTML.
Bypass rides `x-vercel-protection-bypass` via opencode `provider.options.
headers` and Claude Code's `ANTHROPIC_CUSTOM_HEADERS` (both preview-only,
like the MCP callback bypass). If either vehicle fails verification, set
`LLM_PROXY_ORIGIN` to the production origin (tokens are origin-agnostic;
Redis is shared).

## Rollout runbook
1. Land dark (flag opt-in restored in the same branch — previews/staging
   need `NEXT_PUBLIC_OPENCODE_BACKEND_ENABLED=true` set explicitly).
2. Staging bake with the e2e checklist: usage_records old-vs-new diff on
   identical prompts per model family; CC-through-proxy parity (OAuth+BYOK,
   reattach after route death, stop, 40-min sliding-TTL turn); sandbox
   hostility (`cat` env/auth/credentials → only bfap_ + codex exception;
   off-allowlist platform model → 403; cross-provider token → 401);
   credits-exhausted mid-turn (402 surfaces verbatim, no stranded
   reservation, no retry loop); 412 fallback with a platform key unset;
   preview-deployment turns on both agents; concurrency ttfb/cost sanity
   via the `tag:"llm-proxy"` log lines.
3. Prod: enable the flag; watch `incomplete_usage` + `model_off_allowlist`
   advisories + invocation duration dashboards; kill switch = flag off
   (full legacy, including real-credential Claude Code).
4. Post-bake: delete /api/agent + per-provider fetch wrappers (separate
   phase), remove the retired `preferredAnthropicBackend` GET field, fold
   the Codex exception when upstream allows.
