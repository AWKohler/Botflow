# Anthropic Traffic Proxy — Credential Protection for Shared Sandboxes

Status: **PROPOSED — planning only, no implementation.** Prerequisite for any future multi-user project-sharing feature.

Owner-facing goal: **no user's Anthropic credential (OAuth access/refresh token or BYOK API key) should ever be readable by a co-tenant with a shell in the sandbox.** Today it is — this plan closes that.

---

## 0. Why this exists

The Claude Code agent runs **inside** the per-project Vercel Sandbox microVM. To authenticate to Anthropic, the owner's credential is written onto the sandbox filesystem:

- OAuth: `~/.claude/.credentials.json` holds `claudeAiOauth.accessToken` **+ `refreshToken`**, plaintext, `chmod 600` — see [`writeClaudeCredentials`](../../src/lib/agent/claude-code/setup.ts) (`setup.ts:207-246`), called from `route.ts:340-345`.
- BYOK: `ANTHROPIC_API_KEY` is set on the bridge subprocess env — `route.ts:473-474`.

`chmod 600` isolates by **Unix user, not by person.** One sandbox = one owner today, so the credential in the box is the box owner's own — no cross-user exposure. **The moment two users share one microVM, a co-tenant reads `~/.claude/.credentials.json` (or `/proc/<pid>/environ`) and walks away with the owner's refresh token → persistent account takeover + inference billed to the owner's plan.** That is the specific risk that blocks shared sandboxes.

This plan removes the real credential from the sandbox entirely and replaces it with a short-lived, project-scoped, proxy-only token. The real credential stays server-side and is injected by a Botflow proxy that sits between the sandbox and `api.anthropic.com`.

---

## 1. Current architecture — the seam we're replacing

```
browser ──> /api/agent/claude-code ──(sandbox.runCommand: node bridge.js)──> BRIDGE (in sandbox)
                                                                                 │
                                          @anthropic-ai/claude-agent-sdk query() │  env: {...process.env}
                                                                                 ▼
                                                              reads ~/.claude/.credentials.json
                                                                                 │
                                                                                 ▼
                                                                    HTTPS ──> api.anthropic.com   ← credential leaves here
```

Key facts (verified in code):

| Fact | Location |
|---|---|
| Agent runs inside the sandbox as a spawned `node` subprocess | `route.ts:478-484` |
| SDK inherits full process env | `bridge-script.ts:724` (`env: { ...process.env }`) |
| OAuth cred written to a sandbox file | `setup.ts:236-241` |
| BYOK cred set as sandbox env var | `route.ts:473-474` |
| OAuth is refreshed **server-side** before the turn | `route.ts:321-328` (`getFreshAnthropicAccessToken`) |
| Server-side tool callbacks already proxy back via a scoped token | `tool-token.ts` + `/api/internal/claude-code-tool` |

The last row is the important precedent: **we already run one server-side proxy (for tools) authenticated by a per-turn Redis-bound bearer.** This plan applies the exact same shape to Anthropic inference traffic.

### The lever: `ANTHROPIC_BASE_URL`

The Anthropic SDK and Claude Code both honor `ANTHROPIC_BASE_URL`. Set it, and all `/v1/*` calls go to our host instead of `api.anthropic.com`, carrying whatever auth material is in the credentials file. So we can:

1. Put a **Botflow proxy token** (not the real credential) in `~/.claude/.credentials.json`.
2. Point `ANTHROPIC_BASE_URL` at a Botflow proxy route.
3. Proxy validates the token, swaps in the real credential server-side, forwards, streams back.

The sandbox never holds anything that works against Anthropic directly.

---

## 2. Target architecture

```
BRIDGE (in sandbox)
   │  ~/.claude/.credentials.json.accessToken = <botflow-proxy-token>   (short-lived, project-scoped)
   │  ANTHROPIC_BASE_URL = https://<botflow>/api/internal/anthropic-proxy
   ▼
POST /api/internal/anthropic-proxy/v1/messages   (Authorization: Bearer <botflow-proxy-token>)
   │
   ├─ resolve token → { userId, projectId, turnId } from Redis   (reuse tool-token pattern)
   ├─ load owner (or acting-user) real credential server-side
   │     • OAuth: refresh if near expiry (getFreshAnthropicAccessToken), attach Bearer + oauth beta header
   │     • BYOK:  attach x-api-key
   ├─ enforce: project active, token unexpired, rate limits, model allowlist
   ▼
HTTPS ──> api.anthropic.com  ──(SSE stream)──> pass through, byte-for-byte, back to the bridge
```

The real credential is loaded from the DB and used **only** in the proxy request handler's memory. It is never written to disk, never returned to the sandbox, never logged.

---

## 3. Component design

### 3.1 Sandbox side (what changes in the spawn path)

`route.ts` / `setup.ts` changes (conceptual):

- **Mint a proxy token** per turn, bound to `{ userId, projectId, turnId, authMode }`, TTL = turn length + small grace. Reuse `tool-token.ts` verbatim or add a sibling `anthropic-proxy-token.ts` with the same Redis shape. (Recommend a **separate** key namespace so the two tokens have independent scopes and revocation.)
- **`writeClaudeCredentials`** writes the *proxy token* as `claudeAiOauth.accessToken` instead of the real OAuth token. Keep `scopes: ["user:inference"]`. Do **not** write a real `refreshToken` — the sandbox has no business refreshing; put `refreshToken: undefined` (or a dummy). Refresh happens only in the proxy.
- **Always** set `ANTHROPIC_BASE_URL = <origin>/api/internal/anthropic-proxy` on the bridge env.
- **Stop setting `ANTHROPIC_API_KEY`** with the real key in the BYOK path. Standardize on the OAuth-shaped credentials file carrying the proxy token, regardless of whether the owner's real credential is OAuth or a key — the proxy decides the upstream auth mode. (This also removes the "API key env var takes precedence over credentials file" special-case noted at `route.ts:470-472`.)
- **Revoke the proxy token** in the `finally` block alongside `revokeToolToken` (`route.ts:541-544`). After the turn, the token in `credentials.json` is dead.

Net: the only Anthropic-relevant secret in the sandbox is a token that (a) only works against our proxy, (b) is bound to one project, (c) expires, (d) is revoked at turn end.

### 3.2 Server side — the proxy route

New route: `POST/GET /api/internal/anthropic-proxy/[...path]` (catch-all so `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models`, etc. all pass through).

Responsibilities:

1. **AuthN** — read `Authorization: Bearer` (and/or `x-api-key`), resolve against Redis. Reject if missing/expired/unknown → `401`.
2. **AuthZ** — confirm the bound project still exists / is active / the acting user still has access. In shared-sandbox world, this is where "who is allowed to spend on whose account" is enforced (§6).
3. **Credential injection** — load the real credential for the billing identity:
   - **OAuth**: call `getFreshAnthropicAccessToken(...)` (already exists, already handles refresh + persistence). Set `Authorization: Bearer <fresh>` and the OAuth beta header the CLI normally sends.
   - **BYOK**: set `x-api-key: <owner key>`, drop the bearer.
   - Strip the inbound proxy token from forwarded headers.
4. **Forward** — re-issue the request to `https://api.anthropic.com/<path>` preserving method, body, and Anthropic headers (`anthropic-version`, `anthropic-beta`, model params, etc.).
5. **Stream passthrough** — return upstream's `ReadableStream` directly (SSE). No buffering; backpressure preserved. Propagate upstream status + `content-type`.
6. **Fail closed** — any resolution/authz error returns a clean Anthropic-shaped error so the SDK surfaces it normally.

Keep the handler **thin and allocation-light** — it is on the hot path of every token.

### 3.3 Token module

`src/lib/agent/claude-code/anthropic-proxy-token.ts` mirroring `tool-token.ts`:

```
mintProxyToken({ userId, projectId, turnId, billingUserId, authMode }) -> token
resolveProxyToken(token) -> binding | null
revokeProxyToken(token)
```

Binding stored in Redis, TTL bounded to the turn. `billingUserId` is explicit (defaults to project owner today; becomes the acting user or owner per the §6 decision).

---

## 4. Credential-mode matrix

| Owner's real credential | In sandbox today | In sandbox after proxy | Upstream auth the proxy sets |
|---|---|---|---|
| Claude subscription (OAuth) | access **+ refresh** token, file | proxy token only | `Authorization: Bearer <fresh oauth>` + oauth beta header |
| BYOK Anthropic API key | `ANTHROPIC_API_KEY` env | proxy token only (file) | `x-api-key: <owner key>` |

Refresh logic already lives server-side (`getFreshAnthropicAccessToken`), so moving it behind the proxy is a relocation, not new logic. Bonus: refresh races between concurrent turns are easier to serialize on the server than in N sandboxes.

---

## 5. Hard constraints / risks to design around

1. **Long-lived streaming vs. function duration.** A single `/v1/messages` call streams for as long as the model generates — potentially minutes — and there are several per turn. The proxy function must outlive each stream. The existing `/api/agent/claude-code` route already holds a turn-length stream (`cmd.logs()`), so turn-length streaming works in our infra, but the proxy adds **many concurrent long streams** (one per active turn across all users). **Decision required:** confirm runtime + `maxDuration`, and whether this belongs on Fluid compute / a dedicated always-on service rather than a standard serverless function. This is the single biggest feasibility item.
2. **Bandwidth + cost.** Every inference byte now transits Botflow (ingress + egress). For subscription users there's no per-token API cost, but there is real bandwidth and function-time cost that scales with total agent usage. Model it before enabling broadly.
3. **Latency.** One extra hop (sandbox → Botflow → Anthropic). Dominated by model time; marginal. Keep the proxy in a region close to both the sandboxes and Anthropic.
4. **Residual in-turn risk.** During a live turn a co-tenant can still read the proxy token and make it call the proxy. Blast radius is bounded to: inference billed to that turn's identity, that project, until TTL/turn-end revocation — **not** account takeover. Shrink further with: single-turn TTLs, aggressive revoke, per-identity rate limits on the proxy, and anomaly alerts. Note that file-vs-env doesn't change co-tenant exposure (same-user `/proc` access) — the protection comes from the token being proxy-only and ephemeral, not from where it's stored.
5. **SDK/CLI base-URL fidelity.** Verify the pinned `@anthropic-ai/claude-agent-sdk` + Claude Code CLI versions (`setup.ts:98-101`) honor `ANTHROPIC_BASE_URL` for *all* endpoints they hit (messages, count_tokens, model list, any telemetry). Any endpoint that ignores the base URL and goes straight to `api.anthropic.com` with the credentials-file token would break (it'd send our proxy token to Anthropic and get a 401). Pin versions and add a smoke test.
6. **Header/beta drift.** The OAuth beta header value the CLI sends can change across CLI versions. The proxy must forward the client's `anthropic-beta`/`anthropic-version` rather than hardcode, and only override the auth header.

---

## 6. How this plugs into project-sharing

The proxy is what *makes* sharing safe, but it also forces one product decision:

- **Billing identity.** When user B takes a turn in user A's shared project, whose credential pays?
  - *Owner-pays*: proxy always binds `billingUserId = project.owner`. Simple; owner funds all agent usage; needs guardrails (per-collaborator rate/spend caps in the proxy).
  - *Actor-pays*: proxy binds `billingUserId = actingUser`; each collaborator must have their own connected Anthropic credential. Fairer cost; requires every collaborator to be connected.
  - The proxy enforces whichever is chosen server-side — the sandbox can't influence it.
- **Per-turn identity.** The spawn path already knows `userId` for the turn. Extend the binding to carry both `actingUserId` and `billingUserId`. No credential for *any* user ever lands in the shared box.
- **Isolation win.** With the proxy, even the *acting* user's own token is protected from co-tenants, because nobody's real token is ever in the sandbox. This is strictly better than "each user gets their own sandbox" for the credential-exposure axis (though separate sandboxes remain better for filesystem/data isolation — the two are orthogonal).

---

## 7. What this does NOT solve

- Filesystem/data co-tenancy in a shared sandbox (one user reading another's project files, the `BOTFLOW_TOOL_TOKEN`, dev-server secrets). Those need separate treatment; `BOTFLOW_TOOL_TOKEN` is already project-scoped and low-risk, but revisit it under the sharing threat model.
- Secrets users hand-write into the sandbox (covered separately by the `.env` bundle-exclusion fix).
- Abuse of a live in-turn proxy token (mitigated, not eliminated — see §5.4).

---

## 8. Rollout / phasing

1. **Phase 0 — spike (no user impact).** Stand up the proxy route behind a flag; point one internal test project's `ANTHROPIC_BASE_URL` at it. Verify OAuth + BYOK both stream end-to-end, session resume works, count_tokens works. Measure added latency and function duration under a long turn.
2. **Phase 1 — proxy on, credential still in box.** Ship the proxy but keep writing the real credential too, so a proxy failure falls back. Compare behavior. (Feature-flagged, dogfood only.)
3. **Phase 2 — credential removed from box.** Flip to proxy-token-only in `writeClaudeCredentials`; stop setting `ANTHROPIC_API_KEY`. This is the security win. Single-tenant only still.
4. **Phase 3 — enable sharing.** Add acting/billing identity to the binding + proxy-side spend/rate caps. Turn on multi-user-per-sandbox.

Security benefit lands at Phase 2 and is independently valuable even if sharing never ships.

---

## 9. Testing

- **Unit**: token mint/resolve/revoke; credential-mode selection; header rewriting (proxy token stripped, upstream auth attached, client betas preserved).
- **Integration**: real turn against the proxy in OAuth mode and BYOK mode; long (multi-minute) streamed completion; multiple sequential `/v1/messages` in one turn; session resume; count_tokens.
- **Security**: post-turn token is revoked (proxy returns 401); a token from project A cannot bill project B; a stolen live token is rate-limited and can't retrieve the real credential; no credential material in proxy logs.
- **Failure**: Anthropic 429/5xx passthrough; refresh-token failure surfaces cleanly; proxy timeout doesn't wedge the sandbox.

---

## 10. File-by-file change surface (for when we build)

| File | Change |
|---|---|
| `src/lib/agent/claude-code/anthropic-proxy-token.ts` | **New.** Mint/resolve/revoke, Redis-bound, mirrors `tool-token.ts`. |
| `src/app/api/internal/anthropic-proxy/[...path]/route.ts` | **New.** The streaming proxy. Runtime + maxDuration TBD (§5.1). |
| `src/lib/agent/claude-code/setup.ts` | `writeClaudeCredentials` writes the proxy token, not the real cred; no refresh token in box. |
| `src/app/api/agent/claude-code/route.ts` | Mint proxy token; set `ANTHROPIC_BASE_URL`; stop setting real `ANTHROPIC_API_KEY`; revoke in `finally`. |
| `src/lib/anthropic-oauth*` (wherever `getFreshAnthropicAccessToken` lives) | Reused server-side by the proxy; ensure it's callable outside the turn route. |
| Feature flag + config | Gate Phases 1–3; proxy origin/region config. |

---

## 11. Decisions to lock before building

1. **Runtime for the proxy** — standard serverless vs Fluid vs dedicated service (driven by §5.1 duration/scale). *Biggest open question.*
2. **Billing model for shared turns** — owner-pays vs actor-pays (§6).
3. **Token lifetime policy** — per-turn TTL length, whether to single-use, revoke aggressiveness.
4. **Fallback policy** — if the proxy is down, do we fall back to in-box credential (Phase 1) or fail the turn (Phase 2+)? Phase 2+ must fail closed to preserve the security property.
5. **Rate/spend caps** — per-project and per-collaborator limits enforced at the proxy.
