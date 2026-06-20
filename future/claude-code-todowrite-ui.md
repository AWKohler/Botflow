# Claude Code parity #2 — TodoWrite checklist UI

Surface Claude Code's `TodoWrite` tool as a live checklist in the agent panel
instead of a raw JSON blob. This is item #2 of the Claude-Code-via-Agent-SDK
parity work (item #1, subagent nesting, shipped in `b8e795d`).

## Why

`TodoWrite` is one of Claude Code's most useful surfaces — it's the model's
running plan, updated as work progresses. Today it renders as a generic
`ToolStep` showing `{ "todos": [...] }` as pretty-printed JSON. t3code parses it
into `{step, status}` and renders a live checklist
(`apps/server/src/provider/Layers/ClaudeAdapter.ts:512`). We want the same.

## Current behavior (as of b8e795d)

- The SDK emits `TodoWrite` as a normal `tool_use` block. Input shape:
  `{ todos: [{ content: string, status: "pending"|"in_progress"|"completed", activeForm?: string }] }`.
- `translator.ts` `normalizeToolName()` lowercases `TodoWrite` → `todowrite`
  (`src/lib/agent/claude-code/translator.ts:102`) and emits the standard
  `tool-input-available` / `tool-output-available` chunks with the `todos` input
  intact. **The data already reaches the UI** — no new translator plumbing is
  strictly required.
- In `AgentPanel.tsx`, the timeline renders it via the generic `ToolStep`
  fallback (`src/components/agent/AgentPanel.tsx`, the tool-rendering block where
  `task` is special-cased — TodoWrite hits the `return <ToolStep .../>` default).
- Claude calls `TodoWrite` **repeatedly** within a turn, each call carrying the
  **full updated list**. So a single assistant message contains many `todowrite`
  tool parts; only the last reflects current state.

## Design

Two viable approaches; **recommend Option A** (UI-only, no persistence/translator
change) and note B as the upgrade path.

### Option A — UI-only (recommended)

Render the checklist directly from the tool part's `input.todos` in AgentPanel,
mirroring the `task`/`SubagentCard` special-case already in place.

- Add a `TodoChecklist` component near `SubagentCard` in `AgentPanel.tsx`:
  rows with an icon per status (pending = empty circle, in_progress = spinner,
  completed = check + strikethrough), using `input.activeForm` for the
  in-progress label when present, else `input.content`.
- In the timeline tool loop, **collapse repeated `todowrite` parts**: within a
  message, find the index of the *last* `todowrite` tool part; render the
  checklist only for that one and skip (return `null` for) the earlier ones, so
  the panel shows a single live-updating list rather than N stale snapshots.
- Pin placement: render it as its own block in the timeline (not hidden behind a
  collapse), since the plan is high-signal. Keep it compact.

Pros: zero translator/persistence change, data already flows, survives reload
(it's a normal tool part already persisted in `message.parts`).
Cons: the "show only the latest" dedupe is per-message render logic.

### Option B — translator data part (upgrade path, only if needed)

If we later want the plan **pinned across turns** (e.g. a persistent plan header
above the chat), accumulate in the translator like subagents: emit a reconciled
`data-claude-code-todos` part (single id, replace-by-id) holding the latest
todos, and render it in a fixed location. More plumbing; defer unless product
wants cross-turn pinning.

## Implementation checklist

- [ ] `AgentPanel.tsx`: add `TodoItem` type + `TodoChecklist` component
      (status icon, label from `activeForm`/`content`, strikethrough on done).
- [ ] In the timeline tool-group loop, special-case `toolName === 'todowrite'`:
      compute the index of the last `todowrite` part in the group/message;
      render `TodoChecklist` for it, `return null` for earlier ones.
- [ ] Read `todos` defensively: `(part.input as { todos?: TodoItem[] }).todos ?? []`;
      bail to the generic `ToolStep` if the shape is unexpected.
- [ ] Make sure the `todowrite` part is NOT also double-counted in the
      `LiveActions` action-builder effect in a confusing way (it currently
      becomes a generic action; decide whether to suppress `todowrite` there so
      the plan only shows as the checklist). Suppress it.
- [ ] Keep `endTurn`/other special-cases unaffected.
- [ ] `npx tsc --noEmit -p tsconfig.json` clean for `src/` (ignore stale
      `.next/types` validator errors — they're pre-existing).
- [ ] `npx eslint` clean on the touched file (no NEW warnings).

## Edge cases

- [ ] Empty `todos: []` → render nothing (or a subtle "plan cleared"), not an
      empty box.
- [ ] All items completed → show the finished list (don't hide it); useful as a
      record of what was done.
- [ ] Very long lists → cap height with scroll, consistent with other panels.
- [ ] `status` value outside the known enum → treat as pending, don't crash.
- [ ] Mixed agents in one conversation: Botflow native agent has no TodoWrite, so
      this only affects Claude Code turns — verify the native path is untouched.
- [ ] Reload mid-turn / after turn: the last `todowrite` part persists in
      `message.parts`, so the checklist should re-render identically on reload.

## Test matrix (AUTODEV §9 — build before coding, run when "done")

Requires a sandboxed-web project with an Anthropic model + Claude Code flag on,
and a prompt that reliably makes the model plan (e.g. a multi-step task like
"add a settings page with three tabs and wire up routing").

- [ ] Model emits an initial `TodoWrite` → checklist appears with all items
      `pending`.
- [ ] As work proceeds, items flip to `in_progress` (spinner + activeForm label)
      then `completed` (check + strikethrough) — and the panel shows ONE list,
      not a stack of snapshots.
- [ ] Final state: all items completed, list still visible.
- [ ] Hard-refresh the workspace tab (AUTODEV §4) mid-turn and after completion →
      checklist re-renders from persisted parts, same content.
- [ ] A turn with NO TodoWrite (simple one-shot edit) → no empty checklist box.
- [ ] Switch the same conversation to the Botflow backend → no regressions; no
      phantom checklist.
- [ ] Vercel build goes green for the pushed SHA (AUTODEV §8 = the typecheck/
      bundle gate).
- [ ] Screenshot the checklist in all three states for the PR/summary.

## Files in play

- `src/components/agent/AgentPanel.tsx` — checklist component + timeline
  special-case (primary change).
- `src/lib/agent/claude-code/translator.ts` — only if Option B is chosen.
- Reference: t3code `apps/server/src/provider/Layers/ClaudeAdapter.ts:512`
  (`extractPlanStepsFromTodoInput`) and `:1732` (plan emission).

## Out of scope (tracked separately)

- #3 file-edit diff rendering, #4 streaming (`includePartialMessages`),
  cost surfacing, `system:init`. See the parity summary.
