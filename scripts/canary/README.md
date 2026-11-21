# Live canary

Daily/weekly end-to-end check of **production** (botflow.io) with real
sandboxes and real model turns, run from an always-on Mac. It drives the same
HTTP API as the browser, using a dedicated test account, and deletes
everything it creates.

| Suite | When | What |
|---|---|---|
| `daily` | 06:00 every day | Claude Code × Sonnet 5.5, Opus 5.5 (Claude subscription) · OpenCode × GPT-6 Luna, GPT-6.1 Sol (ChatGPT subscription). Asserts zero platform credits charged. |
| `weekly` | Sundays 07:30 | OpenCode × Gemini 3.1 Pro, Grok 4.7, MiniMax-M3 on platform keys (cheapest per remaining provider). |
| `sweep` | manual | Only clean up leftovers. |

Fable 5.1 and GPT-6 Astra are intentionally not run (cost); if the cheaper
models on the same harness pass, they're covered.

Per harness group: create `[canary] …` project (no backend) → sandbox session
→ seed → dev server → preview URL answers → per model: new thread, one turn
writing a random nonce to `canary/check-<model>.txt`, verified via the files
API → delete project; the server must report `cleanup.sandbox: "deleted"` and
the project must 404.

## Account

- Dedicated account (`aronneyt+canary@gmail.com`), Pro/beta tier, Claude +
  ChatGPT connected in Settings → Connections. It must own nothing else.
- Password lives only in the Mac's **login** keychain (not the default
  `botflow-signing` keychain on that machine):

  ```bash
  read -s "PW?Botflow canary password: "; echo; security add-generic-password -U -s botflow-canary -a 'aronneyt+canary@gmail.com' -w "$PW" ~/Library/Keychains/login.keychain-db; unset PW
  ```

## Install (on the Mac, as the console user)

```bash
curl -fsSL https://raw.githubusercontent.com/AWKohler/Botflow/main/scripts/canary/install.sh -o /tmp/canary-install.sh
zsh /tmp/canary-install.sh ~/.local/node-v22.23.4-darwin-arm64/bin/node
```

Runs as LaunchAgents in the logged-in session because the keychain is locked
to SSH sessions. Each run `git pull`s `scripts/canary` from main first.

Optional `~/botflow-canary/config.json`:

```json
{ "ntfyTopic": "some-long-random-topic" }
```

With `ntfyTopic` set, failures (and the first success after a failure) are
pushed via ntfy.sh — subscribe to the topic in the ntfy app.

## Operating

- Run now: `launchctl kickstart gui/$(id -u)/io.botflow.canary.daily`
- Last result: `~/botflow-canary/state/last-daily.json` (history in `state/runs/`)
- Logs: `~/botflow-canary/state/logs/`
- Uninstall: `zsh ~/botflow-canary/repo/scripts/canary/install.sh --uninstall`

## Cleanup guarantees

Every project id is written to `state/ledger.json` before use and removed
only after a confirmed delete (200 + project 404s). Each run starts and ends
with a sweep of the ledger plus any `[canary]` project the account still
owns, so a crashed run is cleaned up by the next one. A delete that reports
the sandbox was not released fails the run.
