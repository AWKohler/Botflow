# Free-tier projects on sandbox-host

Free-tier projects run their persistent sandboxes on the self-hosted
**sandbox-host** service (Firecracker microVMs on ai-club-pc, control plane
public via Tailscale Funnel) instead of Vercel Sandbox. Paid tiers (pro/max,
and beta users via the pro floor) stay on Vercel Sandbox. Goal: cut the
Vercel Sandbox bill, which is dominated by free-tier VM time.

## How the split works

- `projects.sandbox_provider` (`'vercel' | 'sandbox-host'`, default
  `'vercel'`) is stamped **once at project creation** by
  `chooseProviderForNewProject()` and only changes via the offline migration
  script. Sticky-per-project means a project's files never straddle backends.
- `src/lib/sandbox-provider.ts` — provider resolution (60s in-memory cache),
  host credentials, rollout switch.
- `src/lib/vercel-sandbox.ts` — single dispatch point. `@sandbox-host/sdk` is
  a drop-in fork of `@vercel/sandbox` (same instance surface: `runCommand`,
  `writeFiles`, `readFileToBuffer`, `domain`, `stop/delete`, snapshots), so
  only `get`/`create`/`delete` and error handling branch on provider; the
  other ~20 helpers are provider-blind. Both SDKs throw their *own* `APIError`
  class — anything status-based must go through `apiErrorStatus()`, never
  `instanceof APIError` directly.
- Sandbox names are identical on both backends: `botflow-project-<projectId>`.

## The SDK vendoring

`@sandbox-host/sdk` is not on npm. It's vendored as a packed tarball:

```
vendor/sandbox-host-sdk-0.1.0.tgz   ← npm pack of ~/Documents/sandbox-host/sdk
package.json: "@sandbox-host/sdk": "file:vendor/sandbox-host-sdk-0.1.0.tgz"
```

To update: `cd ~/Documents/sandbox-host/sdk && pnpm build && npm pack
--pack-destination <repo>/vendor`, bump the filename if the version changed,
`pnpm install`.

## Env contract (server-side)

| Var | Meaning |
|---|---|
| `SANDBOX_API_URL` | Host control plane, e.g. `https://ai-club-pc-….ts.net/api`. Read natively by the fork SDK at client construction. Verified **not** read by `@vercel/sandbox@2.0.0-beta.14`, so it can't redirect real Vercel traffic. |
| `SANDBOX_HOST_TOKEN` | Bearer token (in `~ai-club-pc/sandbox-host-credentials` on the host). |
| `SANDBOX_HOST_TEAM_ID` / `SANDBOX_HOST_PROJECT_ID` | Tenant scoping; default `default`. |
| `SANDBOX_HOST_ENABLED` | `"1"` routes **new** free-tier projects to sandbox-host. Off by default. |
| `SANDBOX_HOST_STRICT` | `"1"` makes free-tier provider selection THROW instead of silently falling back to Vercel. Testing aid — leave off in production. |
| `PREVIEW_SIGNING_SECRET` | Shared with the host's `previewSigningSecret`; when set, sandbox-host preview URLs get a signed `?_bft` token. Unset = no-op (host running capability-URL-only). |

Credentials are always passed per-call — never via the SDK's own
`SANDBOX_TOKEN`/`SANDBOX_TEAM_ID` env fallback — to avoid any ambient
ambiguity with `@vercel/sandbox` in the same process.

## Rollout runbook

1. `node scripts/migrate-sandbox-provider.mjs` — adds the column (staging,
   then prod).
2. Set `SANDBOX_API_URL` + `SANDBOX_HOST_TOKEN` in Vercel env. Leave
   `SANDBOX_HOST_ENABLED` unset.
3. Smoke test: manually flip one throwaway project's `sandbox_provider` to
   `'sandbox-host'`, open it, run the agent, start the dev server, publish.
4. Set `SANDBOX_HOST_ENABLED=1` → new free-tier projects land on the
   host.
5. Bulk-move existing free projects:
   `node scripts/migrate-free-projects-to-sandbox-host.mjs --dry-run`, then
   without `--dry-run` (Vercel sandboxes are kept, stopped, for rollback),
   then later with `--delete-vercel` to reclaim Vercel storage.
   Rollback for any project = flip its column back to `'vercel'` (as long as
   the Vercel sandbox wasn't deleted).

## Behavioral differences vs Vercel Sandbox

- **Previews: Cloudflare tunnel (implemented) or tailnet-only (fallback).**
  With `previewDomain` configured on the host (sandbox-host branch
  `feat/preview-tunnel`, runbook `sandbox-host/docs/preview-tunnel.md`),
  preview routes become public `https://p-<24hex>-<port>.<domain>` URLs
  served by the host's subdomain router behind cloudflared — embeddable in
  the workspace iframe with no mixed-content block. Access control: signed
  tokens minted here (`src/lib/preview-token.ts`, shared
  `PREVIEW_SIGNING_SECRET` env) appended as `?_bft=…`; the router exchanges
  the query token for a host-only `__bf_preview` cookie covering
  subresources and the Vite HMR websocket. `workspace-control.ts` picks the
  probe strategy by URL scheme: `https://` → external probe (Vercel and
  tunneled host previews alike), plain `http://` (tailnet-only host route,
  no tunnel configured) → in-VM curl probe, and `verifyDevServerReachable`
  skips non-https URLs. Without the tunnel, iframes stay white from an
  HTTPS frontend (mixed content) — local dev on the tailnet still works.
- **Sessions cap at 45 min.** `extend-timeout` is additive but the host caps
  total session lifetime at `MaxTimeoutMs` (2 700 000 ms). Sessions are
  created at 30 min; the wrapper heartbeat extends toward the cap (expiry is
  computed from the host session's `startedAt + timeout` since the fork
  exposes no `expiresAt`), after which the session stops/snapshots and the
  next wrapper call auto-resumes a fresh one. A running dev server dies on
  rollover; the workspace reconciler flips state to stopped and the user/agent
  restarts it.
- **Egress allowlist.** Host VMs can only reach npm, jsdelivr, GitHub, Google
  Fonts, Tier-1 OAuth, Stripe, Convex, Anthropic. Vercel sandboxes are
  allow-all. Free-tier workloads (vite templates, pnpm, GitHub, publish
  builds) fit; anything new that needs another domain must be added to the
  host's admin ceiling.
- **Concurrency: 25 running VMs per token** (`maxSessions`; ~62 GB ÷ 2 GB/VM with headroom). 429s surface through the
  existing `withSandboxRetry` / `SandboxRateLimitError` path. Watch this as
  free-tier adoption grows; it's a host-side capacity knob.
- **Free tier has `maxConvexProjects: 0`**, so the Convex/OAuth-redirect
  flows that would need a public sandbox URL don't apply to host projects
  today.

## Files

- `src/lib/sandbox-provider.ts` — new
- `src/lib/vercel-sandbox.ts` — dispatch + dual-APIError handling
- `src/lib/workspace-control.ts` — provider-aware dev-server probing
- `src/app/api/projects/route.ts` — stamps `sandboxProvider` at creation
- `src/db/schema.ts` + `drizzle/0007_sandbox_provider.sql` +
  `scripts/migrate-sandbox-provider.mjs`
- `scripts/migrate-free-projects-to-sandbox-host.mjs` — bulk mover
- `vendor/sandbox-host-sdk-0.1.0.tgz` — vendored SDK
