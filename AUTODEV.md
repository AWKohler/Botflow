# AUTODEV.md

A field guide for AI agents doing autonomous dev + verify cycles on **Botflow.io** (the SaaS) backed by this repo (`AWKohler/open-vibe-code`, deployed by Vercel from `main`).

You are continuing the work pattern an earlier agent used. This is a refinement of the original loop instructions, written after that agent shipped real fixes through it. The lessons it learned the hard way are folded in — read them first, save yourself the same rediscovery.

---

## 0. What "Botflow" is, in two sentences

Botflow.io is a Lovable/Base44-style platform where users build web apps by chatting with an AI agent. The current focus is the **Sandboxed Web** platform (Vercel Sandbox per project) — *not* the legacy WebContainer "Web" platform, which is being deprecated. You only work on Sandboxed Web unless explicitly told otherwise.

## 1. The loop, condensed

```
edit → commit → push → wait for Vercel → reload botflow.io tab → interact → 
   read console + network + server logs → decide (done or iterate)
```

Each arrow has a concrete tool. Each can fail in a specific way. The rest of this doc is *what each arrow actually means here*.

---

## 2. Required tool surface

Confirm at session start that you have all of these. If any is missing, say so — don't try to fake it.

| Capability | What you'll use it for | Notes |
| --- | --- | --- |
| Bash / file edit | Read/edit source, `git`, `curl`, `pnpm` | `cd` between commands does *not* persist in some sandboxed shells — use absolute paths |
| Chrome MCP (`Claude in Chrome`) | Drive botflow.io, take screenshots, read console & network, run JS in page context | `browser_batch` for any sequence ≥ 2 actions (much faster) |
| GitHub API access (PAT or SSH) | `git push` to `AWKohler/open-vibe-code`, *and* fast remote-side setup (creating files, commits) | The SaaS deploys from `main` — without push you can't ship code changes |
| Wait/scheduler | Pause for Vercel deploy without polling every second | Prefer `Monitor` with an `until` loop, or `ScheduleWakeup` with delay ≥ 270s. Don't chain short `sleep`s. |

Tools that the host may surface deferred — call `ToolSearch` to load schemas before invoking:
`mcp__Claude_in_Chrome__browser_batch`, `mcp__Claude_in_Chrome__navigate`, `mcp__Claude_in_Chrome__computer`, `mcp__Claude_in_Chrome__javascript_tool`, `mcp__Claude_in_Chrome__read_console_messages`, `mcp__Claude_in_Chrome__read_network_requests`, `mcp__Claude_in_Chrome__tabs_create_mcp`, `mcp__Claude_in_Chrome__tabs_context_mcp`, `Monitor`, `TaskCreate`/`TaskUpdate`.

---

## 3. Project landmarks

You almost certainly need these paths and URLs more than once:

- **Live site:** https://botflow.io/
- **Test workspace URL pattern:** `https://botflow.io/workspace/<projectId>`
- **Source repo on GitHub:** `AWKohler/open-vibe-code` — Vercel auto-deploys `main`
- **Sandbox filesystem (per-project):** `/vercel/sandbox` inside each Vercel Sandbox. Project files live there; `.git`, `node_modules`, etc.
- **GitHub OAuth token storage:** Clerk `privateMetadata` (don't migrate, don't expose)
- **Two agent backends in the codebase:**
  - `src/lib/agent/*` — Botflow AI-SDK path (default; tools like `gitCommit`, `gitPush`, etc.)
  - `src/lib/agent/claude-code/*` — Claude Code Agent SDK path with an MCP bridge calling back to `/api/internal/claude-code-tool`

When you change behavior, **check both backends** unless the change is path-specific. The agent panel routes to one or the other based on the selected model.

---

## 4. The Vercel deploy reality

- Vercel typically takes **2–4 minutes** from `git push` to a new deployment URL serving the new chunks.
- The most painful trap: you push a fix, immediately reload the page, click the button, and the toast still says the *old* text — because the client JS chunk hasn't rolled yet. You then assume the fix didn't work and start re-investigating. **Don't.** Wait for the new deploy first.
- **Right freshness check (use this):** poll the GitHub commit status for the SHA you just pushed:
  ```bash
  curl -s -H "Authorization: token $TOKEN" \
    "https://api.github.com/repos/AWKohler/open-vibe-code/commits/$SHA/status" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("state"))'
  ```
  Returns `pending` → `success` or `failure`. **Always check this** — Vercel keeps serving the last green build when subsequent builds fail, so the live deploy ID will *not* change and you'll wait forever thinking it's "still deploying."
- **Wrong freshness check (the trap):** comparing `dpl_…` from the live homepage HTML across pushes. Silent build failures keep that ID frozen at the last green deploy; you'll burn cycles wondering why your fix isn't there.
- **When the build fails**, pull logs immediately:
  ```bash
  # Get the deployment URL from the GitHub status
  DPL=$(curl -s -H "Authorization: token $TOKEN" \
    "https://api.github.com/repos/AWKohler/open-vibe-code/commits/$SHA/status" \
    | python3 -c 'import sys,json
  for s in json.load(sys.stdin).get("statuses",[]):
    if s.get("context")=="Vercel":
      import re; m=re.search(r"/([^/]+)$", s.get("target_url",""))
      if m: print("dpl_"+m.group(1)); break')
  npx -y vercel@latest inspect "$DPL" --logs --scope bot-flow | tail -50
  ```
  Vercel CLI auths to the user's local credentials; scope is `bot-flow`. Build failures may have *nothing to do with your change* — pre-existing breakage on `main` from other commits can block your push. Fix the blocker, then your fix ships too.
- For waits, prefer `Monitor` with a polling loop on the commit-status endpoint (see above). One notification on success or failure.
- After a deploy lands, **hard-refresh the workspace tab** (navigate to the same URL again) to bust the client cache of stale React/JS chunks.

---

## 5. Driving the browser without losing your mind

### Always batch

`browser_batch` is dramatically faster than serial actions. If you're about to do click → wait → screenshot, that's one batch. Treat single-action `computer`/`navigate` calls as a code smell unless you actually need to read the previous result before deciding what's next.

### Toasts auto-dismiss in ~3.5s

This will burn you. The previous loop's toasts (`Saved to GitHub`, `Pull failed`, etc.) disappear before you can screenshot them. There are now two backstops:

1. The `ToastProvider` (`src/components/ui/toast.tsx`) mirrors every toast to `console.log` / `console.error`. So `mcp__Claude_in_Chrome__read_console_messages` with a pattern like `toast|fail|error` gets you the history.
2. Belt and suspenders — at the start of every browser session, install a `MutationObserver` on the toast container so even if the mirror is removed someone else can read recent toasts:
   ```js
   (function(){
     if (window.__toastMirrorInstalled) return 'already';
     window.__toastMirrorInstalled = true;
     const seen = new WeakSet();
     const obs = new MutationObserver(() => {
       document.querySelectorAll('div.fixed.bottom-4.right-4 > div').forEach(el => {
         if (seen.has(el)) return;
         seen.add(el);
         console.log('[toast-dom] ' + el.innerText.replace(/\n+/g,' — '));
       });
     });
     obs.observe(document.body, { childList: true, subtree: true });
     return 'installed';
   })();
   ```

### Console reads need a `pattern`

`read_console_messages` will error or flood you without a regex. Sensible defaults:
- `toast|fail|error` — UX failures
- `Pulled|Already|conflict|merge` — git flow
- `\\[claude-code\\]|\\[botflow\\]` — agent backend logs

### Network reads start when you first call them

`read_network_requests` only sees requests made *after* the first call. If you need to inspect a request that happens on page load, call `read_network_requests` first (it'll return nothing), then navigate/reload, then call it again.

### Skip the UI when the API is faster

When you're setting up state (creating a repo, editing a file remotely, etc.), the GitHub REST API and direct `fetch()` calls in the page context are way faster and less brittle than clicking through the GitHub UI. Examples:

```bash
# Create a remote commit without touching GitHub's editor
SHA=$(curl -s -H "Authorization: token $TOKEN" \
  https://api.github.com/repos/<owner>/<repo>/contents/README.md \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["sha"])')
CONTENT=$(printf '...' | base64)
curl -s -X PUT -H "Authorization: token $TOKEN" \
  https://api.github.com/repos/<owner>/<repo>/contents/README.md \
  -d "{\"message\":\"msg\",\"content\":\"$CONTENT\",\"sha\":\"$SHA\"}"
```

```js
// Hit a project API directly from the browser console
fetch('/api/projects/<id>/github/sandbox/pull', { method: 'POST' })
  .then(r => r.text()).then(console.log);
```

Mixing UI for the path you're *actually verifying* with API for setup is the fastest cycle.

### The IDE editor caches file content

After `git pull` updates a file on disk, the open editor pane in the IDE may still show the previous content. Don't trust the editor as ground truth — read the file from disk (terminal `cat`, or a follow-up API call) when verifying.

### The in-IDE terminal quirks

The "Persistent sandbox terminal" at the bottom of the Code view runs in `/` (not `/vercel/sandbox`) and **`cd dir && cmd` is NOT parsed as expected** — the `&&` becomes part of the path argument. Use `;` to chain, or run commands separately. Confirm: project files (README.md, package.json…) are visible at the shell's PWD even though git operations live under `/vercel/sandbox`.

---

## 6. The push problem: getting code into Vercel

The repo deploys from `AWKohler/open-vibe-code` `main`. To ship a fix you must push to that.

- `gh` CLI is **not** installed on the dev box by default.
- The local `~/.ssh/id_ed25519` is **not** authorized on GitHub for this user.
- `.env.local` has the GitHub OAuth *client secret*, not a PAT.

**If you cannot push, stop and ask the user for a PAT before going further.** Don't pretend to deploy.

Once you have a PAT, the simplest setup:
```bash
git remote set-url origin https://AWKohler:<PAT>@github.com/AWKohler/open-vibe-code.git
git push
```
Verify with `git ls-remote origin main` after push (sha should match local HEAD).

---

## 7. Verifying the change actually shipped

After the wait + reload:

1. **Visual check:** screenshot the workspace, confirm the relevant UI is showing what you expect.
2. **Toast check:** read console messages with a tight pattern. Look for *unexpected* error/fail messages too, not just the one you were watching for.
3. **Network check:** confirm your API calls fire and return the right shape. `read_network_requests` with `urlPattern` like `sandbox/pull` zooms in. Statuses 4xx/5xx are bugs.
4. **Server-side reality check:** for state-mutation flows (git, db writes), don't trust the toast — query the API directly to see the actual stored/computed state. Example: pull toast said "Up to date" but `/sandbox/status` showed `conflicted: ['README.md']`. Toast was lying.
5. **GitHub side, when applicable:** use the GitHub API to confirm the commit actually landed on the remote (`/repos/<owner>/<repo>/commits`). A toast saying "saved" doesn't mean the push ran.

If any of (2)/(3)/(4)/(5) disagree with the UI, the UI is the least authoritative.

---

## 8. Typecheck / build / tests

- The repo's `package.json` has no `tsc` and no top-level lint/test scripts wired in. `npx tsc --noEmit` will install the wrong package (`tsc@2.0.4`, a different tool) — **don't.**
- Effective check: rely on Vercel's build step. If your push deploys without a build error, types and the production bundle are healthy enough.
- For local feedback while editing, `pnpm install && pnpm dev` runs Next.js locally but it does *not* exercise the deployed Vercel Sandboxes. Most flows you care about require the live site.

---

## 9. Knowing what to test

When the user says "make sure GitHub works", that's not a test list — it's a scope. Decompose it.

For the GitHub integration specifically, the verified test matrix is:

- [ ] Existing project: link new private repo → save initial → edit on GitHub → pull → "Pulled latest from GitHub"
- [ ] Brand-new project (sandboxed-web platform): create → link → seed save → divergent edit → pull
- [ ] Conflict path: local + remote edit same line → pull → modal opens → `Use mine` writes local content, `Use GitHub's` writes remote content (verify by reading the file from disk)
- [ ] Agent autonomy flow: after linking, the agent calls `askQuestion` → user picks → agent calls `setGitAutonomy` → DB stores it
- [ ] Agent git tools: with `autonomous` mode, ask the agent to make a change → it should `edit` → `gitCommit` → `gitPush` (without claiming pushed before `gitPush` returns)
- [ ] Abort merge: trigger conflict → click "Discard my changes" → working tree restored, no orphan WIP commit

If you're adding a new feature instead of verifying an existing one, **build the test matrix before you start coding** and read it back to yourself when you think you're done.

---

## 10. Diagnosing the "UI says success but it didn't work" class of bug

This is the most common bug shape in this codebase and the easiest to miss. The previous loop hit it twice:

1. **`Use GitHub's` wrote local content** because `git stash pop` swaps `ours`/`theirs` semantics from the user's mental model. The toast said success.
2. **Agent claimed "pushed to GitHub"** without calling `gitPush`. The chat said success.

Both surfaced only after **directly verifying the side effect** — reading the file from disk in one case, listing GitHub commits in the other. The lesson: when the user reports something subtle, never rely on the UI's word for what happened. Pull the actual artifact (file contents, commit list, DB row) and compare.

---

## 11. Working with the agent panel

If your work touches the chat / agent loop:

- `AgentPanel` uses `useChat` from `@ai-sdk/react`. The agent only runs when `sendMessage` is called. **Inserting a row into `chat_messages` from the server does NOT trigger an agent turn.** This was the bug behind the autonomy question never appearing.
- The chip-style "system note" renderer keys off text starting with `[system-note]`. Server-side bookkeeping that needs the agent to react should fire a `window` event that `AgentPanel` listens for; the listener calls `sendMessageRef.current({ text: "[system-note] …" })`. That both persists the chip and triggers a turn.
- Existing precedent events: `github-conflict-delegate`, `github-linked`, `agent-turn-finished`, `agent-busy-change`, `preview-refresh`. Follow the same shape if you add a new one.
- The chat input has a queueing UI ("Type to queue a message…") while the agent is busy. Typing and pressing Enter may queue rather than send immediately. If a message you sent doesn't actually fire, look at the small send button next to the input.

---

## 12. Working with the sandbox git layer

- All git operations live in `src/lib/sandbox-git.ts`. They `cwd` to `/vercel/sandbox` and shell out via `sandboxRun`.
- Auth is injected just-in-time via `withAuthRemote()` (token in the URL, restored to bare on `finally`). The token never persists in `origin`.
- Pulls always go through a "commit local changes as WIP, then merge" path now — *not* stash/pop. This was changed because stash-pop puts the stash on stage 3 (theirs) and HEAD on stage 2 (ours), which silently inverted the conflict modal's labels. Don't reintroduce stash/pop.
- `abortMerge` undoes the pre-pull WIP commit so "Discard my changes" lands the user back where they started.
- Conflict tool semantics from the user's POV: `ours` = my local edits, `theirs` = what GitHub has. Don't ever flip this; if you're tempted to, you're recreating the original bug.

---

## 13. Cost-aware waiting

The Anthropic prompt cache has a 5-minute TTL. Sleeping past 300s in a way that holds your context means the next turn re-reads everything uncached — slower and pricier.

- 60–270s waits keep the cache warm. Good for "watching a CI step that runs in ~1–4 minutes."
- 300s is the worst-of-both — you pay the cache miss without amortizing it. Skip it.
- For Vercel deploys (3–5 minutes) and longer external waits, accept the cache miss once and use `Monitor` with a polling `until` loop, or `ScheduleWakeup` with `delaySeconds ≥ 1200`.
- Don't chain shorter `sleep`s to dodge minimums — the runtime blocks that.

---

## 14. Safety + permissions

You have permission to:
- Edit code, commit, push to `AWKohler/open-vibe-code`.
- Create **private** test repos under the user's GitHub account.
- Make GitHub API calls with the provided PAT.
- Drive the browser as the logged-in user on botflow.io and github.com.
- Use the sandboxed terminal in the IDE to inspect state (`git`, `cat`, `ls`).

You do **not** have permission to (without asking first):
- Push to anyone else's repos.
- Modify `main` of unrelated repos.
- Delete repos, force-push, rewrite history with `--force` or `reset --hard` to remote refs.
- Bypass git hooks (`--no-verify`) or signing flags.
- Touch sensitive files (`.env*`, credentials) beyond reading them for diagnostic context.
- Make purchases or accept ToS on the user's behalf.

When in doubt about an irreversible action, ask. The cost of pausing is low; the cost of an unwanted force-push is high.

---

## 14a. You are probably not the only agent running

Assume other agents may be working in this repo at the same time as you. That means interference is possible — a remote that moved under you, a file changed between your read and your commit, a Vercel build that reflects someone else's push, or a test repo that appeared without you creating it.

- **Generally each agent is kept on its own branch.** Stay on yours. Don't commit to or push another agent's branch, and don't rebase/force-push a branch you didn't create.
- Before you push, re-check the remote (`git fetch` + `git log origin/<branch>`). If it moved, someone else (an agent or a human) touched it — reconcile deliberately, don't blindly `--force`.
- If a deploy, toast, or piece of state looks wrong, consider that a *concurrent* agent's push or change may be the cause, not your own — verify the SHA/branch you're actually looking at before assuming your change broke something.
- Don't touch shared mutable state (the `main` branch, shared test repos, another agent's working branch) on the assumption you're alone. When branches are isolated, conflicts are rare; the failure mode is acting as if no one else exists.

---

## 15. Reporting back

When you finish a cycle:

- State the **observable** result (the change is now live at X URL, the file on GitHub contains Y, the toast now says Z), not just "I pushed the fix."
- List commit URLs as Markdown links (`[abc1234](https://github.com/AWKohler/open-vibe-code/commit/abc1234)`), not bare SHAs.
- Call out any test repos or branches you created so the user can clean them up.
- If the PAT was used, note it's still in the local `origin` URL and offer to wipe it (`git remote set-url origin https://github.com/AWKohler/open-vibe-code.git`).
- Be honest about model-quality issues vs code bugs. If the agent under test hallucinated a tool call, say that explicitly — it's a prompt/model issue, not a code one, and the fix is different.

---

## 16. Concrete loop template

```
1. Read the relevant files (Bash → Read).
2. Sketch the smallest possible change. One concern per cycle.
3. Edit (Edit / Write tools).
4. git add <specific files>; git commit -m "<why>"; git push.
5. Monitor for new Vercel deployment ID, then sleep 30s more for chunks to settle.
6. Hard-navigate the workspace tab(s).
7. Install the toast→console MutationObserver (idempotent).
8. Drive the UI for the path you changed, in a batch:
     navigate → wait → click → wait → screenshot.
9. Read console (pattern), read network (urlPattern), call the affected APIs directly to compare.
10. If something disagrees, the UI is wrong. Investigate the source of truth (file on disk, commit on GitHub, DB row).
11. If green: write a tight summary with file references and commit links.
    If red: note the *specific* disagreement, narrow next change, loop.
```

---

## 17. Anti-patterns that previously cost real cycles

- Sending many serial `computer` / `navigate` calls when one `browser_batch` would do.
- Polling Vercel by re-clicking the same UI button every 30s.
- Trusting toasts as ground truth.
- Editing files in the IDE editor without realizing the file the agent will see on disk may differ until the editor's "Save" actually syncs.
- Asking the model under test to "just push it again" instead of checking *why* it didn't push the first time.
- Adding new features when the original task was verification.
- Chaining `sleep 60; sleep 60; sleep 60` to dodge the 300s rule.
- Forgetting that `cd a && b` is one literal arg in the IDE terminal.
- Creating public test repos (always `--private` or set Private toggle in the UI).
- Pushing without first verifying the diff is what you intended (`git diff HEAD` before commit).

---

## 18. Last thing

If the user has provided a project ID and "make sure this works" — that's an invitation to think like a tester, not just a coder. Write the test matrix before you trust any "fix." Then run it.

Good luck.
