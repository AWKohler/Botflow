'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls, isToolUIPart, getToolName, type UIMessage } from 'ai';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/ui/markdown';
import { ChevronDown, ChevronRight, ArrowUp, X as IconX, Cog, AlertCircle, RotateCcw, Loader2, ListPlus, Check, ImagePlus, Smartphone } from 'lucide-react';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { cn } from '@/lib/utils';
import { LiveActions } from '@/components/agent/LiveActions';
import { useToast } from '@/components/ui/toast';
import type { ToolCallData } from '@/lib/agent/ui-types';
import { MODEL_CONFIGS, modelSupportsImages, resolveModelId, isOpenAIModel, effectiveContextTokens, type ModelId } from '@/lib/agent/models';
import { ModelSelector } from '@/components/ui/ModelSelector';
import { LimitModal, parseLimitPayload, type LimitReachedPayload } from '@/components/ui/LimitModal';
import { CreditGauge } from '@/components/ui/CreditGauge';
import type { AgentErrorType } from '@/lib/agent/errors';
import { processImageForUpload } from '@/lib/image-processing';
import { ImageLightbox } from '@/components/ui/ImageLightbox';
import { isSandboxPlatform } from '@/lib/project-platform';
import type { ProjectPlatform } from '@/lib/project-platform';
import { ANTHROPIC_OAUTH_ENABLED } from '@/lib/feature-flags';
import {
  type AgentBackend,
} from '@/lib/agent/backend-resolution';
import { deriveAgentBackend } from '@/lib/agent/derive-backend';
import { BackendChip, BackendGlyphInfo } from './BackendBadge';
import { ThinkingBlock } from './ThinkingBlock';
import { QuestionPrompt, type QuestionConfig, type QuestionAnswerPayload } from './QuestionPrompt';
import {
  BOTFLOW_NATIVE_TOOLS,
  CLAUDE_CODE_TO_BOTFLOW,
  OPENCODE_TO_BOTFLOW,
  sanitizeToolUseId,
} from '@/lib/agent/tool-name-map';
import type { SubagentStep } from '@/lib/agent/claude-code/translator';
import { transcriptHasUnfinishedTail } from '@/lib/agent/transcript-tail';

type Props = { className?: string; projectId: string; initialPrompt?: string; platform?: ProjectPlatform };

interface PendingImage {
  id: string;
  file: File;
  localUrl: string;
  uploading: boolean;
  uploaded: boolean;
  error?: string;
  dbId?: string;
  url?: string;
  key?: string;
}

// ============================================================================
// Structured error from the API
// ============================================================================
interface StructuredError {
  message: string;
  type: AgentErrorType;
  retryAfter?: number;
}

function parseError(raw: string): StructuredError {
  try {
    const parsed = JSON.parse(raw) as { error?: string; errorType?: AgentErrorType; retryAfter?: number; message?: string };
    return {
      message: parsed.error ?? parsed.message ?? raw,
      type: (parsed.errorType as AgentErrorType) ?? 'unknown',
      retryAfter: parsed.retryAfter,
    };
  } catch {
    return { message: raw, type: 'unknown' };
  }
}

// ============================================================================
// ToolCard subcomponent
// ============================================================================
function ToolStep({ toolName, state, content }: { toolName: string; state: string; content: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const isDone = state === 'output-available';
  const isRunning = state === 'input-available' || state === 'partial-call';

  return (
    <div>
      {/* Flex row — fixed height, circle is first item so line position is exact */}
      <div className="flex items-center gap-2.5 h-7">
        {/* Circle — 14px wide, opaque bg-surface hides the line behind it */}
        <div className="shrink-0 z-10 size-[14px] rounded-full border-[1.5px] border-border bg-surface flex items-center justify-center">
          {isDone && <Check size={8} className="text-muted" />}
          {isRunning && <Loader2 size={8} className="animate-spin text-muted" />}
        </div>
        {/* Clickable label */}
        <button
          type="button"
          className="flex items-center gap-1 p-0 text-sm text-muted hover:text-fg transition-colors"
          onClick={() => setOpen(v => !v)}
        >
          <span className="font-medium">{toolName}</span>
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </button>
      </div>
      {/* Expanded content */}
      {open && <div className="pl-[26px] pb-1.5">{content}</div>}
    </div>
  );
}

// ============================================================================
// Subagent (Task) nested timeline
// ============================================================================
//
// When Claude Code spins up a Task subagent, the translator routes the
// subagent's inner work (text, thinking, tool calls) into a single
// `data-claude-code-subagent` part keyed by the parent Task tool-use id,
// rather than flattening it into the main thread. Here we render those steps
// as a collapsible block nested under the Task step so the subagent's actions
// are clearly attributed to it.
function SubagentStepRow({ step }: { step: SubagentStep }) {
  const [open, setOpen] = useState(false);
  if (step.kind === 'text') {
    return <div className="text-xs text-fg/80 py-0.5 min-w-0 break-words [overflow-wrap:anywhere]"><Markdown content={step.text} /></div>;
  }
  if (step.kind === 'thinking') {
    return <div className="text-xs italic text-muted py-0.5 whitespace-pre-wrap break-words">{step.text}</div>;
  }
  return (
    <div className="py-0.5">
      <button
        type="button"
        className="flex items-center gap-1.5 text-xs text-muted hover:text-fg transition-colors w-full text-left"
        onClick={() => setOpen(v => !v)}
      >
        {step.status === 'running'
          ? <Loader2 size={9} className="animate-spin shrink-0" />
          : step.status === 'error'
            ? <AlertCircle size={9} className="text-red-500 shrink-0" />
            : <Check size={9} className="shrink-0 text-muted" />}
        <span className="font-medium truncate">{step.toolName}</span>
        {open ? <ChevronDown size={10} className="ml-auto shrink-0" /> : <ChevronRight size={10} className="ml-auto shrink-0" />}
      </button>
      {open && (
        <pre className="mt-1 text-[10px] overflow-auto bg-surface p-1.5 rounded border border-border whitespace-pre-wrap break-words max-h-40">
          {JSON.stringify(step.input, null, 2)}
          {step.output ? `\n\n— output —\n${step.output}` : ''}
        </pre>
      )}
    </div>
  );
}

function SubagentCard({ steps, label }: { steps: SubagentStep[]; label?: string }) {
  const [open, setOpen] = useState(true);
  const toolCount = steps.reduce((n, s) => (s.kind === 'tool' ? n + 1 : n), 0);
  if (steps.length === 0) return null;
  return (
    <div className="ml-[26px] mt-1 mb-1.5 border-l-2 border-accent/30 pl-3">
      <button
        type="button"
        className="flex items-center gap-1.5 text-xs w-full text-left hover:opacity-80 transition-opacity"
        onClick={() => setOpen(v => !v)}
      >
        <span className="font-medium text-accent/80">Subagent{label ? ` · ${label}` : ''}</span>
        <span className="text-[10px] text-muted tabular-nums">{toolCount} action{toolCount !== 1 ? 's' : ''}</span>
        {open ? <ChevronDown size={10} className="ml-auto shrink-0 text-muted" /> : <ChevronRight size={10} className="ml-auto shrink-0 text-muted" />}
      </button>
      {open && (
        <div className="mt-1 space-y-0.5">
          {steps.map((s, i) => <SubagentStepRow key={i} step={s} />)}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Token display formatter
// ============================================================================
/** Hover wrapper for the header gauges — shows a small labelled tooltip so
 *  the user knows which usage each ring measures. */
function GaugeWithTooltip({
  label,
  lines,
  children,
}: {
  label: string;
  lines: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="relative group inline-flex">
      {children}
      <div className="pointer-events-none absolute left-0 top-full mt-1.5 z-50 hidden group-hover:block w-max max-w-[240px] rounded-lg border border-border bg-elevated px-3 py-2 shadow-xl">
        <div className="text-[11px] font-medium text-fg">{label}</div>
        {lines.map((line, i) => (
          <div key={i} className="text-[11px] text-muted leading-relaxed">{line}</div>
        ))}
      </div>
    </div>
  );
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

// ============================================================================
// Cross-agent message transform
// ============================================================================
//
// Rewrites a single UIMessage so it's safe to send to the Botflow agent's
// Anthropic-backed `/api/agent` route, even when the message originated from
// a turn that ran through Claude Code. Anthropic strictly validates that
// every `tool_use` block in the request references a tool name registered
// in the current `tools` parameter; foreign names cause a 400.
//
// Strategy:
//   1. For tool parts whose name maps to a Botflow tool (CLAUDE_CODE_TO_BOTFLOW
//      entry with a `to`/`mapInput`): rename + rewrite input. Keep state +
//      output untouched so the matching tool_result still pairs correctly.
//   2. For tool parts with no Botflow counterpart (entry === null): collapse
//      the whole part into a text part summarizing what happened, so the
//      receiving agent has prose context without a phantom tool call.
//   3. For tool parts that are already native to Botflow (in BOTFLOW_NATIVE_TOOLS):
//      pass through unchanged.
//   4. Sanitize toolCallId on every tool part as belt-and-suspenders against
//      legacy data with invalid characters.
//
// Going to Claude Code: this transform is NOT applied — the Claude Code
// route only takes a string prompt, and the route's own preamble logic
// summarizes prior conversation as text.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPart = any;

function transformMessageForBotflow(message: AnyPart): AnyPart {
  if (!message || !Array.isArray(message.parts)) return message;
  const newParts: AnyPart[] = [];
  for (const part of message.parts) {
    const transformed = transformPartForBotflow(part);
    // A transform may emit zero (rare), one, or more parts. Spread.
    if (Array.isArray(transformed)) {
      for (const p of transformed) newParts.push(p);
    } else if (transformed) {
      newParts.push(transformed);
    }
  }
  return { ...message, parts: newParts };
}

function transformPartForBotflow(part: AnyPart): AnyPart | AnyPart[] | null {
  if (!part || typeof part !== 'object') return part;
  const type: string = part.type ?? '';

  // Non-tool parts pass through (text, reasoning, file, data-*, step-start, etc.).
  if (!type.startsWith('tool-') && type !== 'dynamic-tool') return part;

  // Extract the tool name from either static-typed (`tool-Read`) or dynamic
  // (`dynamic-tool` with .toolName) shape.
  const rawName: string =
    type === 'dynamic-tool'
      ? String(part.toolName ?? '')
      : type.slice('tool-'.length);

  if (!rawName) return part;

  // Native Botflow tool — pass through, just sanitize the id.
  if (BOTFLOW_NATIVE_TOOLS.has(rawName)) {
    if (part.toolCallId) {
      const safe = sanitizeToolUseId(String(part.toolCallId));
      if (safe !== part.toolCallId) return { ...part, toolCallId: safe };
    }
    return part;
  }

  // Look up in the cross-agent maps: Claude Code names first (PascalCase +
  // MCP snake_case), then OpenCode-only natives (lowercase). The key spaces
  // are disjoint, and platform (MCP) tools arrive pre-stripped by the
  // OpenCode translator under the exact names the CC map already rewrites.
  const rule = CLAUDE_CODE_TO_BOTFLOW[rawName] ?? OPENCODE_TO_BOTFLOW[rawName];

  // No mapping — could be a tool we don't know about. Collapse to a text
  // summary so the receiving agent has prose context but doesn't try to
  // replay an unknown tool call.
  if (rule === null || rule === undefined) {
    return summarizeUnmappedToolPart(rawName, part);
  }

  // Mapped — rename and rewrite the input. Preserve state + output so the
  // tool_use/tool_result pairing inside the AI SDK serialization stays valid.
  const newType = `tool-${rule.to}`;
  const newInput =
    part.input !== undefined ? rule.mapInput(part.input) : part.input;

  const safeId = part.toolCallId
    ? sanitizeToolUseId(String(part.toolCallId))
    : part.toolCallId;

  // Static-typed shape: drop dynamic-tool's `toolName` field; just change `type`.
  if (type === 'dynamic-tool') {
    return {
      ...part,
      type: newType,
      toolName: rule.to,
      ...(safeId !== part.toolCallId ? { toolCallId: safeId } : {}),
      ...(newInput !== part.input ? { input: newInput } : {}),
    };
  }
  return {
    ...part,
    type: newType,
    ...(safeId !== part.toolCallId ? { toolCallId: safeId } : {}),
    ...(newInput !== part.input ? { input: newInput } : {}),
  };
}

function summarizeUnmappedToolPart(name: string, part: AnyPart): AnyPart {
  // Build a short, prose-style summary the next agent can read like a log
  // entry. We deliberately don't include the full input/output dumps to
  // keep token cost down; an interested agent can re-derive specifics by
  // reading the current filesystem.
  let summary = `[Earlier turn used \`${name}\``;
  const state = part.state ?? '';
  if (state === 'output-available' && part.output !== undefined) {
    const out = typeof part.output === 'string'
      ? part.output
      : (() => { try { return JSON.stringify(part.output); } catch { return String(part.output); } })();
    summary += ` and got a result (${truncatePreview(out)})`;
  } else if (state === 'output-error' && part.errorText) {
    summary += ` and errored: ${truncatePreview(String(part.errorText))}`;
  }
  summary += '. The project filesystem reflects whatever changed.]';
  return { type: 'text', text: summary };
}

function truncatePreview(s: string, max = 200): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * Repair orphaned tool calls in the message list before the next API request.
 *
 * When the user clicks Stop (X) mid-stream, the streaming response is aborted.
 * If the abort happened while a tool call was in-flight (state !== 'output-available'),
 * the assistant message has a `tool_use` block with no matching `tool_result`.
 * Anthropic rejects any request containing such a conversation with a 400 error:
 *   "messages: tool_use block must be followed by a tool_result"
 *
 * This function converts orphaned tool parts to plain text notes so the
 * history is always in a state the API accepts.
 */
function repairOrphanedToolCalls(messages: AnyPart[]): AnyPart[] {
  return messages.map((msg: AnyPart) => {
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.parts)) return msg;

    let changed = false;
    const repairedParts = msg.parts.map((part: AnyPart) => {
      if (!part || typeof part !== 'object') return part;
      const type = String(part.type ?? '');

      // Only care about tool parts (static `tool-<name>` or dynamic `dynamic-tool`)
      if (!type.startsWith('tool-') && type !== 'dynamic-tool') return part;

      // Parts with output are fine; orphaned = no output yet
      const state = String(part.state ?? '');
      if (state === 'output-available' || state === 'output-error') return part;

      const toolName =
        type === 'dynamic-tool'
          ? String(part.toolName ?? 'unknown')
          : type.slice('tool-'.length);

      changed = true;
      return {
        type: 'text',
        text: `[Tool call \`${toolName}\` was interrupted — the agent was stopped before it completed.]`,
      };
    });

    return changed ? { ...msg, parts: repairedParts } : msg;
  });
}

// ============================================================================
// Main AgentPanel
// ============================================================================
export function AgentPanel({ className, projectId, initialPrompt, platform = 'web' }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const savedIdsRef = useRef<Set<string>>(new Set());
  const [initialized, setInitialized] = useState(false);
  const [actions, setActions] = useState<ToolCallData[]>([]);
  const lastAssistantSavedRef = useRef<{ id: string; hash: string } | null>(null);
  const [model, setModel] = useState<ModelId>('gpt-5.6-luna');
  const [hasOpenAIKey, setHasOpenAIKey] = useState<boolean | null>(null);
  const [hasAnthropicKey, setHasAnthropicKey] = useState<boolean | null>(null);
  const [hasClaudeOAuth, setHasClaudeOAuth] = useState<boolean | null>(null);
  const [hasCodexOAuth, setHasCodexOAuth] = useState<boolean | null>(null);
  const [hasMoonshotKey, setHasMoonshotKey] = useState<boolean | null>(null);
  const [hasFireworksKey, setHasFireworksKey] = useState<boolean | null>(null);
  const [hasGoogleKey, setHasGoogleKey] = useState<boolean | null>(null);
  const [hasXaiKey, setHasXaiKey] = useState<boolean | null>(null);
  const [hasTogetherKey, setHasTogetherKey] = useState<boolean | null>(null);
  // Server flag (USE_TOGETHER_KIMI): Kimi K2.7 is served by Together AI, not Fireworks.
  const [useTogetherKimi, setUseTogetherKimi] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [agentError, setAgentError] = useState<StructuredError | null>(null);
  const [retryCountdown, setRetryCountdown] = useState<number | null>(null);
  const [limitPayload, setLimitPayload] = useState<LimitReachedPayload | null>(null);
  const [userTier, setUserTier] = useState<'free' | 'pro' | 'max'>('free');
  const { toast } = useToast();

  // --- Input state (v6: managed externally) ---
  const [input, setInput] = useState('');

  // --- Image attachment state ---
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const pendingUploadsRef = useRef<Map<string, Promise<void>>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- Simulator screenshot state (swift projects only) ---
  // `simShotAvailable` mirrors whether the sibling SwiftSimulatorPreview has a
  // live frame to grab; `capturingSimShot` debounces the in-flight grab.
  const isSwift = platform === 'swift';
  const [simShotAvailable, setSimShotAvailable] = useState(false);
  const [capturingSimShot, setCapturingSimShot] = useState(false);

  // --- Lightbox state ---
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  // --- Message queue ---
  const [messageQueue, setMessageQueue] = useState<string[]>([]);

  // --- endTurn detection ---
  const [endTurnCalled, setEndTurnCalled] = useState(false);
  const [showCompletionWarning, setShowCompletionWarning] = useState(false);

  // --- Credit gauge state ---
  const [creditPct, setCreditPct] = useState(0);

  // --- Claude plan usage gauge (OAuth subscription only) ---
  // Mirrors Claude Code's /usage numbers: session (5h) and week (7d)
  // utilization of the user's Claude subscription. Only fetched/shown when
  // the turn actually runs on Claude Code via OAuth.
  const [claudePlanUsage, setClaudePlanUsage] = useState<{
    fiveHour: number | null;
    sevenDay: number | null;
  } | null>(null);

  // Sharing: when the owner shares credits, this project's model access
  // follows the OWNER's tier — the server sends sharedTier on the project GET
  // and re-derives it authoritatively per turn. Wins over the personal tier.
  const sharedTierRef = useRef<'pro' | 'max' | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${encodeURIComponent(projectId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((p: { sharedTier?: string } | null) => {
        if (cancelled) return;
        if (p?.sharedTier === 'pro' || p?.sharedTier === 'max') {
          sharedTierRef.current = p.sharedTier;
          setUserTier(p.sharedTier);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId]);

  const fetchCredits = useCallback(() => {
    fetch('/api/usage/credits')
      .then(r => r.ok ? r.json() : null)
      .then((d: { pct?: number; tier?: string } | null) => {
        if (d?.pct !== undefined) setCreditPct(d.pct);
        if (!sharedTierRef.current && (d?.tier === 'pro' || d?.tier === 'max')) setUserTier(d.tier as 'pro' | 'max');
      })
      .catch(() => {});
  }, []);

  const fetchClaudePlanUsage = useCallback(() => {
    fetch('/api/usage/claude-plan')
      .then(r => r.ok ? r.json() : null)
      .then((d: { available?: boolean; fiveHour?: number | null; sevenDay?: number | null } | null) => {
        if (d?.available) {
          setClaudePlanUsage({ fiveHour: d.fiveHour ?? null, sevenDay: d.sevenDay ?? null });
        } else {
          setClaudePlanUsage(null);
        }
      })
      .catch(() => {});
  }, []);

  // --- Fetch user tier + credits for model gating ---
  useEffect(() => {
    fetchCredits();
  }, [fetchCredits]);

  // Refresh credits after each completed agent turn
  useEffect(() => {
    const handler = () => fetchCredits();
    window.addEventListener('agent-turn-finished', handler);
    return () => window.removeEventListener('agent-turn-finished', handler);
  }, [fetchCredits]);

  // Pre-fill the input with the conflict-resolution prompt when the GitHub
  // panel's conflict modal asks the assistant to fix things. Scoped to this
  // project so opening a second workspace tab won't cross-fire.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId: string; prompt: string }>).detail;
      if (!detail || detail.projectId !== projectId) return;
      setInput(detail.prompt);
    };
    window.addEventListener('github-conflict-delegate', handler);
    return () => window.removeEventListener('github-conflict-delegate', handler);
  }, [projectId]);

  // Sandbox publish panel "Fix with Agent" — same shape as github-conflict-delegate.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId: string; prompt: string }>).detail;
      if (!detail || detail.projectId !== projectId) return;
      setInput(detail.prompt);
    };
    window.addEventListener('sandbox-build-error-delegate', handler);
    return () => window.removeEventListener('sandbox-build-error-delegate', handler);
  }, [projectId]);

  // Linking a GitHub repo only inserts a DB bookkeeping row — by itself
  // that doesn't run the agent. The github-panel fires this event after a
  // successful link so we can send a [system-note] user message, which
  // both renders as a chip and triggers a real agent turn so it can call
  // askQuestion → setGitAutonomy.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { projectId: string; owner: string; name: string }
        | undefined;
      if (!detail || detail.projectId !== projectId) return;
      const text = [
        `[system-note] The user just linked the GitHub repo \`${detail.owner}/${detail.name}\` to this project.`,
        "",
        "Your first task: call the askQuestion tool to ask the user how they want git commits handled. Provide three options:",
        " (a) autonomous — you commit and push on your own after meaningful changes;",
        " (b) manual — you never run git; the user pushes from the panel;",
        " (c) ask-each-time — you confirm with askQuestion before every commit.",
        "",
        "Then call setGitAutonomy with the value they picked ('autonomous', 'manual', or 'ask-each-time').",
        "Do not perform any other work until autonomy is set.",
      ].join("\n");
      sendMessageRef.current({ text });
    };
    window.addEventListener('github-linked', handler);
    return () => window.removeEventListener('github-linked', handler);
  }, [projectId]);

  // --- Provider access for ModelSelector ---
  // Anthropic models need a path that actually runs them. OAuth-only is real
  // access only when the project is a sandbox (Claude Code path); on a
  // WebContainer project, OAuth-only can't run Anthropic models (the OAuth
  // token can't be used as a bare API key, and Claude Code needs a sandbox).
  const providerAccess = useMemo(() => {
    const oauthRunnable =
      ANTHROPIC_OAUTH_ENABLED &&
      Boolean(hasClaudeOAuth) &&
      Boolean(platform && isSandboxPlatform(platform));
    const anthropic = oauthRunnable || hasAnthropicKey || null;
    return {
      openai: hasCodexOAuth || hasOpenAIKey || null,
      anthropic,
      fireworks: hasFireworksKey === true ? true : null,
      google: hasGoogleKey === true ? true : null,
      xai: hasXaiKey === true ? true : null,
    };
  }, [
    hasCodexOAuth,
    hasOpenAIKey,
    hasClaudeOAuth,
    hasAnthropicKey,
    hasFireworksKey,
    hasGoogleKey,
    hasXaiKey,
    platform,
  ]);

  // --- Agent backend is fully derived ---
  // Single source of truth lives in deriveAgentBackend(). Both the chip badge
  // and the transport's routing decision read from this memo. No more separate
  // useState, no more auto-coerce effect, no more confirmation modal — when
  // the user picks a different model, the agent flips silently. Credentials
  // pick the MODE (codex-oauth / byok / platform via the LLM proxy); the
  // backend itself is fully determined by model + platform + flag.
  const derivedBackend = useMemo(
    () =>
      deriveAgentBackend({
        model,
        platform,
        creds: {
          hasClaudeOAuth: Boolean(hasClaudeOAuth),
          hasAnthropicKey: Boolean(hasAnthropicKey),
          hasCodexOAuth: Boolean(hasCodexOAuth),
          hasOpenAIKey: Boolean(hasOpenAIKey),
          hasFireworksKey: Boolean(hasFireworksKey),
          hasGoogleKey: Boolean(hasGoogleKey),
          hasXaiKey: Boolean(hasXaiKey),
          hasTogetherKey: Boolean(hasTogetherKey),
        },
        tier: userTier,
        useTogetherKimi,
      }),
    [
      model,
      platform,
      hasClaudeOAuth,
      hasAnthropicKey,
      hasCodexOAuth,
      hasOpenAIKey,
      hasFireworksKey,
      hasGoogleKey,
      hasXaiKey,
      hasTogetherKey,
      userTier,
      useTogetherKimi,
    ],
  );
  const agentBackend = derivedBackend.backend;

  // Claude Code running on the user's Claude subscription (OAuth) — the only
  // case where turns consume their Claude plan instead of platform credits
  // alone, so the only case where the plan-usage gauge is shown.
  const usesClaudePlan = derivedBackend.reason === 'oauth_claude_code';

  useEffect(() => {
    if (!usesClaudePlan) {
      setClaudePlanUsage(null);
      return;
    }
    fetchClaudePlanUsage();
    const handler = () => fetchClaudePlanUsage();
    window.addEventListener('agent-turn-finished', handler);
    return () => window.removeEventListener('agent-turn-finished', handler);
  }, [usesClaudePlan, fetchClaudePlanUsage]);

  // --- Chat segment tracking ---
  // Each message belongs to a segment_id; switching agents mints a new one.
  // We load ALL segments so the user can scroll back through history, but
  // we only SEND the current segment's messages to the agent so the new
  // backend doesn't see foreign tool calls from the prior agent.
  const [currentSegmentId, setCurrentSegmentId] = useState<string | null>(null);
  const segmentByMessageIdRef = useRef<Map<string, string>>(new Map());
  const currentSegmentIdRef = useRef<string | null>(null);
  currentSegmentIdRef.current = currentSegmentId;

  // --- Token tracking ---
  // For Botflow projects: char/4 estimate of accumulated message content.
  // For Claude Code projects: the real usage number reported by the SDK via
  // the transient `data-claude-code-usage` part — claude knows its own context
  // size after any internal compaction, so the bar tracks reality.
  const [tokenEstimate, setTokenEstimate] = useState(0);
  const [claudeCodeUsage, setClaudeCodeUsage] = useState<{
    tokens: number;
    breakdown: { input: number; output: number; cacheCreate: number; cacheRead: number };
  } | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  // Context meter limit: personal-cred Anthropic turns (Claude OAuth/BYOK →
  // the claude-code backend) get the provider's 1M window, not the 200K
  // platform default — otherwise the meter reads "227k / 200k" on a turn
  // that's perfectly within budget. Display only; billing is server-side.
  const maxTokens = effectiveContextTokens(model, derivedBackend.backend === 'claude-code');

  // --- First message tracking ---
  const [hasAgentResponded, setHasAgentResponded] = useState(false);

  // --- Manual busy state (doesn't flicker between tool rounds) ---
  const [isBusy, setIsBusy] = useState(false);
  const busyDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- AbortController for tool calls ---
  const toolAbortRef = useRef<AbortController | null>(null);

  // Turn pin for reattach: set from the turn-status response just before
  // resumeStream(), read by the transport's reconnect request builder. The
  // reattach route 204s unless its record still has this exact turnId, so a
  // NEW turn spawned between the status check and the reattach can never be
  // replayed against the wrong transcript (TOCTOU guard).
  const reattachTurnIdRef = useRef<string | null>(null);

  // --- Auto-continue (self-healing turn completion) ---
  // A turn can end without endTurn for reasons that are NOT the user's
  // problem: the model emitted a text-only step mid-work (nothing for the
  // resubmit helper to fire on), the platform killed a long stream, or a
  // stale resubmit hit the Claude Code replay guard. Instead of stranding
  // the user at the "may not have finished" banner, we silently nudge the
  // agent to continue — hard-capped per user message so a genuinely stuck
  // agent can't loop and burn credits.
  const MAX_AUTO_CONTINUES = 3;
  const autoContinuesUsedRef = useRef(0);
  // True after the user hits Stop — suppresses auto-continue until the next
  // real user message (stopping means "I want it to stop", not "continue").
  const userStoppedRef = useRef(false);
  // Late-bound so useChat's onError (defined below, before sendMessage
  // exists) can trigger a continue.
  const maybeAutoContinueRef = useRef<() => boolean>(() => false);

  // True when the LAST agent request was actually served by an in-sandbox
  // agent route — /api/agent/claude-code OR /api/agent/opencode — (i.e. it
  // didn't 412-fall-back to /api/agent). In-sandbox turns are single-shot:
  // the bridge runs the whole agentic loop inside one POST, so the client
  // must NEVER auto-resubmit them: a resubmit carries a trailing assistant
  // message, which both routes reject with 409 ("Last message must be a user
  // message") and the agent stops.
  const lastTurnServedByInSandboxAgentRef = useRef(false);

  // --- Ref that the transport's prepare/fetch closures read at request time.
  //     Holds the project's persisted agent_backend so we route every turn to
  //     the right endpoint. Updates whenever the user (or load) changes the
  //     backend; the transport (a useRef) sees fresh values without rebuild. ---
  const agentBackendRef = useRef<AgentBackend>(agentBackend);
  agentBackendRef.current = agentBackend;

  // --- Stable transport ref (v6) ---
  // Endpoint is chosen per-request from the project's persisted agentBackend.
  // The 412 fallback from /api/agent/claude-code is kept as a safety net: if
  // creds went stale between turns, we transparently retry /api/agent.
  const transportRef = useRef(new DefaultChatTransport({
    api: '/api/agent',
    body: { projectId, platform },
    // resumeStream() → GET the reattach route, which replays the current
    // in-sandbox turn's event file (Claude Code or OpenCode — the turn record
    // picks the translator) and follows it while the bridge lives. The
    // recovery logic only calls resumeStream() for in-sandbox turns. A 204
    // (nothing to resume) is a clean no-op.
    prepareReconnectToStreamRequest: () => ({
      api: `/api/agent/claude-code/reattach?projectId=${encodeURIComponent(projectId)}${
        reattachTurnIdRef.current ? `&turnId=${encodeURIComponent(reattachTurnIdRef.current)}` : ''
      }`,
    }),
    prepareSendMessagesRequest: ({ body, messages, api }) => {
      const backend = agentBackendRef.current;
      const useInSandboxAgent = backend === 'claude-code' || backend === 'opencode';
      // Assume the intended endpoint serves this turn; the fetch wrapper
      // flips this off if a 412 falls the request back to /api/agent.
      lastTurnServedByInSandboxAgentRef.current = useInSandboxAgent;

      // Scope to the current segment. Segments now only break on explicit
      // Reset (no longer on agent switch), so most of the time this is a
      // no-op and the full history flows through.
      const segment = currentSegmentIdRef.current;
      const segmentMap = segmentByMessageIdRef.current;
      const scoped = segment
        ? messages.filter((m) => {
            const owner = segmentMap.get(m.id);
            // Messages without a known segment are brand-new (just typed).
            return owner === undefined || owner === segment;
          })
        : messages;

      // For Botflow outgoing: rewrite any foreign (Claude Code / OpenCode)
      // tool_use parts into Botflow's tool vocabulary so Anthropic doesn't
      // reject the request with `messages.X.content.Y.tool_use` errors.
      // Unmapped tool parts are collapsed into text summaries. Also
      // defensively sanitize any tool_use IDs that don't match Anthropic's
      // regex.
      //
      // For in-sandbox outgoing (Claude Code / OpenCode): the bridges take
      // only the user prompt (no messages array), so we pass `scoped`
      // through unchanged — the routes build their own prior-conversation
      // preamble.
      const transformed = useInSandboxAgent
        ? scoped
        : scoped.map(transformMessageForBotflow);

      // Repair any orphaned tool calls (tool_use with no tool_result) that
      // were left by a Stop-button abort mid-stream.
      const finalMessages = repairOrphanedToolCalls(transformed);

      return {
        body: { ...(body ?? {}), messages: finalMessages },
        ...(backend === 'claude-code'
          ? { api: '/api/agent/claude-code' }
          : backend === 'opencode'
            ? { api: '/api/agent/opencode' }
            : { api }),
      };
    },
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const res = await fetch(input, init);
      // 412 from an in-sandbox route = "not eligible / creds went stale" —
      // transparently land the turn on /api/agent. Rare: the derivation
      // should already match what's available server-side.
      if (res.status === 412 && /\/api\/agent\/(claude-code|opencode)/.test(url)) {
        // This turn is now Botflow-served — its tool loop needs resubmits.
        lastTurnServedByInSandboxAgentRef.current = false;
        return fetch(url.replace(/\/api\/agent\/(claude-code|opencode)/, '/api/agent'), init);
      }
      return res;
    },
  }));

  const { messages, sendMessage, setMessages, addToolOutput, stop, status, resumeStream } = useChat({
    transport: transportRef.current,
    // Receive Claude Code's transient data parts: real token usage + compact
    // boundaries. These never persist to message.parts (they're `transient: true`
    // server-side), so we capture them here on the live stream and store in
    // local state.
    onData(part) {
      const p = part as { type: string; data?: unknown };
      if (p.type === 'data-claude-code-usage' || p.type === 'data-opencode-usage') {
        const data = p.data as {
          tokens?: number;
          breakdown?: { input: number; output: number; cacheCreate: number; cacheRead: number };
        } | undefined;
        if (data && typeof data.tokens === 'number') {
          setClaudeCodeUsage({
            tokens: data.tokens,
            breakdown: data.breakdown ?? { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
          });
          // Receiving fresh usage means compaction (if any) is done.
          setIsCompacting(false);
        }
      } else if (p.type === 'data-claude-code-compact-boundary' || p.type === 'data-opencode-compact-boundary') {
        const data = p.data as { trigger?: 'manual' | 'auto'; preTokens?: number } | undefined;
        // Reset the bar — claude just compacted; the next usage event will
        // show the new (much smaller) size.
        setClaudeCodeUsage(null);
        setIsCompacting(false);
        toast({
          title: 'Context compacted',
          description: data?.trigger === 'manual'
            ? 'Conversation history summarized to free up context.'
            : `Conversation history auto-summarized at ~${formatTokenCount(data?.preTokens ?? 0)} tokens to free up context.`,
        });
      } else if (p.type === 'data-claude-code-status') {
        const data = p.data as { status?: string } | undefined;
        if (data?.status === 'compacting') setIsCompacting(true);
      }
      // data-opencode-status ("retrying") is deliberately not surfaced yet —
      // opencode retries transparently and the busy spinner already covers it.
    },
    onFinish({ message, isAbort }) {
      // Don't clear busy on finish — let debounce handle it
      // (onFinish fires between tool rounds in multi-step, causing premature busy=false)

      if (isAbort) return;

      // Persist final assistant message
      (async () => {
        try {
          await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId, message }),
          });
          savedIdsRef.current.add(message.id);
          // Stamp the message with the current segment so subsequent
          // `prepareSendMessagesRequest` calls keep including it in scope.
          if (currentSegmentIdRef.current) {
            segmentByMessageIdRef.current.set(message.id, currentSegmentIdRef.current);
          }
        } catch (err) {
          console.error('Failed to persist assistant message:', err);
        }
      })();

      // Emit event to trigger snapshot capture
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('agent-turn-finished', { detail: { projectId } }));
      }
    },
    onError(error) {
      // Clear busy state on error
      setIsBusy(false);
      if (busyDebounceRef.current) {
        clearTimeout(busyDebounceRef.current);
        busyDebounceRef.current = null;
      }

      const msg = error.message || 'An error occurred. Please try again.';

      // A stale automatic resubmission hit the Claude Code replay guard
      // (409 "Last message must be a user message"). This is a protocol
      // hiccup, not a model/provider failure — recover silently by nudging
      // the session to continue (it resumes via the persisted sessionId)
      // instead of stranding the user at an error banner.
      if (msg.includes('Last message must be a user message')) {
        if (!endTurnCalledRef.current && !maybeAutoContinueRef.current()) {
          setShowCompletionWarning(true);
        }
        return;
      }

      // Check for structured limit_reached payload first
      try {
        const parsed = JSON.parse(msg);
        const limitP = parseLimitPayload(parsed);
        if (limitP) {
          setLimitPayload(limitP);
          return;
        }
      } catch { /* not JSON, fall through */ }

      const structured = parseError(msg);
      setAgentError(structured);

      // Start countdown for rate limit errors
      if (structured.retryAfter && structured.retryAfter > 0) {
        setRetryCountdown(structured.retryAfter);
      }
    },
    async onToolCall({ toolCall }) {
      try {
        // Check if abort was requested
        if (toolAbortRef.current?.signal.aborted) {
          addToolOutput({ tool: toolCall.toolName as 'endTurn', toolCallId: toolCall.toolCallId, output: 'Tool execution aborted by user.' });
          return;
        }

        const args = toolCall.input as Record<string, unknown>;

        // --- Handle endTurn tool ---
        if (toolCall.toolName === 'endTurn') {
          setEndTurnCalled(true);
          setShowCompletionWarning(false);
          const summary = String((args as { summary?: string }).summary ?? 'Task completed.');
          addToolOutput({ tool: 'endTurn', toolCallId: toolCall.toolCallId, output: summary });
          return;
        }

        // Record tool invocation. Replace any existing entry for the same
        // toolCallId — for sandbox platforms the messages-derived effect may
        // have already pushed one, and a second blind append would produce a
        // duplicate React key until the next merge.
        setActions((prev) => {
          const idx = prev.findIndex((a) => a.toolCallId === toolCall.toolCallId);
          const entry = {
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            args,
            status: 'invoked' as const,
            startedAt: Date.now(),
          };
          if (idx >= 0) {
            const next = prev.slice();
            next[idx] = entry;
            return next;
          }
          return [...prev, entry];
        });

        // Client-side WebContainer tool execution was removed with the WebContainer
        // deprecation. Sandbox/swift platforms execute tools server-side (the client
        // never receives onToolCall for them); only endTurn (handled above) reaches here.
      } catch (err: unknown) {
        console.error('Tool error', err);
        const message = err instanceof Error ? err.message : String(err);
        addToolOutput({ tool: toolCall.toolName as 'endTurn', toolCallId: toolCall.toolCallId, output: `Tool execution failed: ${message}` });
        setActions((prev) => prev.map((a) => a.toolCallId === toolCall.toolCallId ? ({
          ...a,
          status: 'error',
          finishedAt: Date.now(),
          resultPreview: message,
        }) : a));
      }
    },
    // v6: auto-resubmit when tool calls are complete (replaces maxSteps).
    //
    // Wrap the default helper so we DON'T auto-resubmit once the turn has
    // explicitly ended. A completed `endTurn` tool part — the real one the
    // Botflow agent calls, or the synthetic one the Claude Code translator
    // appends to EVERY turn — is our "stop here" marker, and it overrides
    // whatever other tools ran in the same turn. The previous guard only
    // suppressed resubmission when endTurn was the ONLY tool in the message,
    // so any Claude Code turn that did real work (its bash/read/mcp parts all
    // stream into the same single-step assistant message) tripped the helper
    // into re-POSTing — and /api/agent/claude-code replays the last user
    // prompt on every POST, so the turn looped until the user intervened.
    sendAutomaticallyWhen: ({ messages }) => {
      // In-sandbox turns (Claude Code / OpenCode) are single-shot: the bridge
      // runs the whole agentic loop inside one POST and every tool part
      // arrives already complete, so the helper below would re-POST after
      // EVERY turn that did real work. Worse, when a turn dies early (bridge
      // crash, maxDuration kill) the synthetic endTurn marker never arrives
      // and the resubmit hits the route's replay guard — 409, agent stops.
      // Never auto-resubmit a turn an in-sandbox agent actually served
      // (fallback-served turns still may).
      if (lastTurnServedByInSandboxAgentRef.current) return false;
      if (!lastAssistantMessageIsCompleteWithToolCalls({ messages })) return false;
      const last = messages[messages.length - 1];
      if (!last || last.role !== 'assistant') return false;
      for (const part of last.parts ?? []) {
        if (!isToolUIPart(part) || getToolName(part) !== 'endTurn') continue;
        const state = (part as { state?: string }).state;
        if (state === 'output-available' || state === 'output-error') {
          return false;
        }
      }
      return true;
    },
  });

  // Note: the previous explicit "switch backend" flow (modal + POST to
  // /api/projects/:id/agent-backend) has been replaced by automatic derivation.
  // The user picks a model; deriveAgentBackend decides which agent runs the
  // turn; the chip badge reflects the result. No imperative switch needed.
  // BYOK users who want to override the default go to Settings → Connections.

  // --- Refs for values needed in effects (avoid deps that change every render) ---
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const messageQueueRef = useRef(messageQueue);
  messageQueueRef.current = messageQueue;
  // Wrapped so EVERY send through the ref bumps the recovery epoch first
  // (see recoveryEpochRef below): any new outgoing turn supersedes an
  // in-flight reattach recovery. Direct sendMessage() call sites bump
  // explicitly.
  const sendMessageRef = useRef<typeof sendMessage>(sendMessage);
  sendMessageRef.current = (...args: Parameters<typeof sendMessage>) => {
    recoveryEpochRef.current++;
    return sendMessage(...args);
  };
  const endTurnCalledRef = useRef(endTurnCalled);
  endTurnCalledRef.current = endTurnCalled;
  const agentErrorRef = useRef(agentError);
  agentErrorRef.current = agentError;
  const limitPayloadRef = useRef(limitPayload);
  limitPayloadRef.current = limitPayload;
  const isBusyRef = useRef(false);
  isBusyRef.current = isBusy;

  // Silently nudge the agent to finish an interrupted turn. Returns false when
  // continuing would be wrong (user pressed Stop) or the per-message cap is
  // spent — the caller falls back to the visible completion warning.
  // The [system-note] prefix renders as a subtle chip instead of a user bubble.
  const maybeAutoContinue = useCallback((): boolean => {
    if (userStoppedRef.current) return false;
    if (autoContinuesUsedRef.current >= MAX_AUTO_CONTINUES) return false;
    autoContinuesUsedRef.current += 1;
    setShowCompletionWarning(false);
    setIsBusy(true);
    toolAbortRef.current = new AbortController();
    // Per-backend wording: both in-sandbox agents (Claude Code + OpenCode)
    // have reattach-first recovery, so their nudge only fires after a failed
    // reattach and leans on the resumed session transcript. Botflow keys on
    // endTurn.
    const backend = agentBackendRef.current;
    const nudge = backend === 'claude-code' || backend === 'opencode'
      ? '[system-note] Automatic continuation: your previous turn stopped before finishing and could not be re-attached. Your resumed session transcript is the source of truth for what already happened — trust it, do not re-read files or re-verify work it already shows as done. Continue from where it leaves off; if the task is already complete, give a brief summary of what was done.'
      : '[system-note] Automatic continuation: the previous response ended without calling endTurn. Continue the remaining work; if everything is already complete, call endTurn now with a brief summary.';
    sendMessageRef.current({ text: nudge });
    return true;
  }, [MAX_AUTO_CONTINUES]);
  maybeAutoContinueRef.current = maybeAutoContinue;

  // --- Reattach-first recovery (Claude Code + OpenCode) ---
  // Both in-sandbox bridges run detached, so a settled stream usually means
  // the VIEWER's pipe died (route maxDuration), not the turn. Check
  // turn-status; if the turn is alive (or finished unseen), drop the partial
  // assistant tail and resumeStream() — the reattach route replays the turn's
  // event file from zero (through the backend's translator) and follows it
  // live. Only when the turn is truly dead do we fall back to the
  // auto-continue nudge (whose spawn also clears any corpse). This is what
  // makes a >5-minute turn a reconnect instead of a second racing agent.
  const reattachInFlightRef = useRef(false);
  const lastReattachSigRef = useRef<string | null>(null);

  // Send/recovery serialization. Every real outgoing send bumps this BEFORE
  // sendMessage() — synchronously, in the same task as the user's action —
  // and the recovery core re-reads it after each await, yielding
  // ('superseded') if it moved. This closes the gap the tail-id recheck
  // can't: a send scheduled but not yet flushed to messagesRef when the
  // status response lands. A user message always wins over a recovery.
  const recoveryEpochRef = useRef(0);

  // Shared reattach core, used by BOTH recovery triggers (the busy-settle
  // pass below and the mount-time effect further down): ask turn-status
  // whether the project's in-sandbox turn is worth reattaching to; if so,
  // drop the partial assistant tail and resumeStream().
  //
  //   reattached — the replay delivered; the turn is live in the UI again
  //   no-turn    — nothing reattachable FOR THIS TURN (no record, dead, user
  //                stopped, or the record belongs to an earlier turn);
  //                recordExists is true only when a record positively matched
  //                to this turn exists but is dead — the caller may warn
  //   superseded — the transcript tail changed while checking (the user sent
  //                a new message); do nothing, the new turn owns the UI
  //   vanished   — status said active but the reattach 204'd (finish race)
  //   wedged     — no progress since the last cycle; bridge killed
  //   error      — status/reattach unreachable
  //
  // Turn-identity opts (mount-time callers): expectedUserMessageId matches
  // the record's spawning user message against the transcript's trailing user
  // message — the exact-identity check. staleIfStartedBefore (epoch ms) is
  // the fallback for records written before the userMessageId field: treat an
  // active record as another turn's when its startedAt predates the trailing
  // message (each spawn overwrites the record, so the record for THIS message
  // can't be older than it). expectedTailId aborts if the transcript moved on
  // mid-check.
  const reattachToLiveTurn = useCallback(async (
    opts?: {
      expectedUserMessageId?: string;
      staleIfStartedBefore?: number;
      expectedTailId?: string;
    },
  ): Promise<{
    outcome: 'reattached' | 'no-turn' | 'superseded' | 'vanished' | 'wedged' | 'error';
    recordExists: boolean;
  }> => {
    if (reattachInFlightRef.current) return { outcome: 'error', recordExists: false };
    reattachInFlightRef.current = true;
    const epoch = recoveryEpochRef.current;
    try {
      const res = await fetch(
        `/api/agent/claude-code/turn-status?projectId=${encodeURIComponent(projectId)}`,
      );
      const data = res.ok
        ? ((await res.json()) as {
            active?: boolean;
            turnId?: string | null;
            startedAt?: number | null;
            userMessageId?: string | null;
          })
        : null;
      if (!data) return { outcome: 'error', recordExists: false };
      // The user sent a new message while the status check was in flight —
      // this recovery attempt is about a tail that no longer exists. The
      // epoch check catches sends not yet flushed into messagesRef; the
      // tail-id check catches everything already flushed.
      if (recoveryEpochRef.current !== epoch) {
        return { outcome: 'superseded', recordExists: false };
      }
      if (opts?.expectedTailId) {
        const tail = messagesRef.current[messagesRef.current.length - 1];
        if (tail?.id !== opts.expectedTailId) {
          return { outcome: 'superseded', recordExists: false };
        }
      }
      // Turn identity: prefer the exact user-message match; fall back to the
      // timestamp heuristic only for records that predate the field.
      const foreignTurn = opts?.expectedUserMessageId !== undefined
        && (typeof data.userMessageId === 'string'
          ? data.userMessageId !== opts.expectedUserMessageId
          : typeof opts.staleIfStartedBefore === 'number'
            && typeof data.startedAt === 'number'
            && data.startedAt < opts.staleIfStartedBefore);
      // A record for some OTHER turn is no record at all as far as this
      // recovery is concerned — callers must not warn on its account.
      const recordExists = Boolean(data.turnId) && !foreignTurn;
      if (!data.active || foreignTurn || userStoppedRef.current) {
        return { outcome: 'no-turn', recordExists };
      }
      // No-progress guard: two consecutive reattach cycles with an
      // identical last message means the turn is wedged (bridge alive but
      // silent) — kill it and let the caller fall through to its fallback.
      const msgs = messagesRef.current;
      const last = msgs[msgs.length - 1];
      const sig = `${msgs.length}:${last?.role === 'assistant' ? JSON.stringify(last.parts ?? []).length : 0}`;
      if (lastReattachSigRef.current === sig) {
        fetch('/api/agent/claude-code/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId }),
        }).catch(() => {});
        return { outcome: 'wedged', recordExists };
      }
      lastReattachSigRef.current = sig;
      // Drop the partial assistant tail: the replay rebuilds the whole
      // turn's message from event zero, so keeping the partial would
      // duplicate its parts.
      setMessages(prev => {
        const out = [...prev];
        while (out.length > 0 && out[out.length - 1].role === 'assistant') out.pop();
        return out;
      });
      // The resumed turn is in-sandbox by definition — make sure a LATER
      // cut of this same stream re-enters reattach-first recovery instead
      // of auto-resubmitting (which would 409 on the replay guard).
      lastTurnServedByInSandboxAgentRef.current = true;
      // Pin the reattach to the exact turn the status check validated — a
      // turn spawned between these two requests 204s instead of replaying.
      reattachTurnIdRef.current = typeof data.turnId === 'string' ? data.turnId : null;
      setIsBusy(true);
      toolAbortRef.current = new AbortController();
      await resumeStream();
      // Give React a beat to flush the resumed stream into state, then
      // check whether anything actually streamed. A rebuilt assistant
      // tail means the reattach delivered — the next busy-settle pass
      // re-evaluates (endTurn → done; cut again → reattach again).
      await new Promise<void>(r => setTimeout(r, 150));
      const nowLast = messagesRef.current[messagesRef.current.length - 1];
      if (nowLast?.role === 'assistant') return { outcome: 'reattached', recordExists };
      // 204 — the turn vanished between status check and reattach.
      setIsBusy(false);
      return { outcome: 'vanished', recordExists };
    } catch {
      return { outcome: 'error', recordExists: false };
    } finally {
      reattachInFlightRef.current = false;
    }
  }, [projectId, resumeStream, setMessages]);

  const attemptTurnRecovery = useCallback(async () => {
    if (userStoppedRef.current) return;
    if (reattachInFlightRef.current) return;
    const backend = agentBackendRef.current;
    if ((backend === 'claude-code' || backend === 'opencode') && lastTurnServedByInSandboxAgentRef.current) {
      const { outcome } = await reattachToLiveTurn();
      if (outcome === 'reattached') return;
      // A user message arrived mid-recovery — its turn owns the flow now;
      // neither a nudge nor a warning belongs to this stale attempt.
      if (outcome === 'superseded') return;
      if (userStoppedRef.current || endTurnCalledRef.current) return;
    }
    if (!maybeAutoContinue()) {
      setShowCompletionWarning(true);
    }
  }, [maybeAutoContinue, reattachToLiveTurn]);

  // --- Mount-time reattach ---
  // The busy-settle recovery below only fires on a busy→idle transition,
  // which a fresh mount never produces: after a page reload mid-turn the
  // detached bridge keeps working, but the panel rehydrates from the DB
  // (user message only — assistant messages persist in onFinish) and sits
  // there looking idle. So once the transcript loads, if it ends on a user
  // message (the tell for a turn that never finished persisting), ask the
  // turn registry. A live turn reattaches exactly like a mid-session cut:
  // the replay rebuilds the lost tool calls from event zero and follows the
  // stream to endTurn. A dead-but-recent turn gets the visible completion
  // warning instead of a silent auto-continue — a cold mount is too
  // ambiguous to spend an agent turn without the user's say-so.
  const mountReattachAttemptedRef = useRef(false);
  useEffect(() => {
    if (!initialized || mountReattachAttemptedRef.current) return;
    mountReattachAttemptedRef.current = true;
    const msgs = messagesRef.current;
    if (!transcriptHasUnfinishedTail(msgs)) return;
    // Turn identity: only reattach to the record spawned BY the trailing
    // user message (exact id match, stored in the turn record). Records
    // written before the userMessageId field fall back to a createdAt
    // heuristic — the 60s grace absorbs clock skew and the persist/spawn
    // race. expectedTailId aborts the attempt if the user sends a new
    // message while the status check is in flight.
    const tail = msgs[msgs.length - 1] as { id: string; createdAt?: string | number | Date };
    const tailCreatedAtMs = tail?.createdAt ? new Date(tail.createdAt).getTime() : NaN;
    void (async () => {
      const { outcome, recordExists } = await reattachToLiveTurn({
        expectedUserMessageId: tail.id,
        expectedTailId: tail.id,
        staleIfStartedBefore: Number.isFinite(tailCreatedAtMs)
          ? tailCreatedAtMs - 60_000
          : undefined,
      });
      // Nothing live to show — but if THIS turn's record exists (and is
      // dead), the turn really did die unfinished; let the user decide
      // whether to continue. (No record, or another turn's record = stay
      // quiet rather than nag on every open.) Re-check the tail so a
      // message the user sent meanwhile never gets a stale warning.
      if (outcome !== 'reattached' && outcome !== 'error' && outcome !== 'superseded' && recordExists) {
        const nowTail = messagesRef.current[messagesRef.current.length - 1];
        if (nowTail?.id === tail.id) setShowCompletionWarning(true);
      }
    })();
  }, [initialized, reattachToLiveTurn]);

  // --- Late modal completions → tell the agent ---
  // When the user finishes a tool-opened modal (OAuth credentials, env var)
  // AFTER the agent stopped waiting for it, the workspace fires this event
  // (the completion route reports agentWaiting=false). Without it the agent
  // never learns the credentials arrived and keeps reporting them missing.
  // Busy → queue the note for after the turn; idle → send it right away.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{
        projectId: string;
        kind: 'oauth-provider' | 'env-var' | 'stripe-connect';
        subject: string;
      }>).detail;
      if (!detail || detail.projectId !== projectId) return;
      let note: string;
      switch (detail.kind) {
        case 'oauth-provider':
          note =
            `[system-note] The user just saved ${detail.subject} OAuth credentials in the workspace modal — it was still pending from earlier and was never dismissed. ` +
            'Finish the wiring now: call the setup_oauth_provider / setupOAuthProvider tool again — with credentials saved it returns INSTANTLY with the exact registration snippet (including any required profile() mapping). ' +
            'Register the provider in convex/auth.ts exactly as that snippet shows (keep existing providers), run the Convex deploy, complete the snippet\'s remaining platform steps (web: the sign-in button; Swift: none — the hosted page updates automatically), then ask the user for one test sign-in and check the Convex logs for auth errors before reporting success.';
          break;
        case 'env-var':
          note =
            `[system-note] The user just entered the ${detail.subject} environment variable in the workspace modal — it was still pending from earlier and was never dismissed. ` +
            'Continue the work that needed it (the value is stored server-side; never ask to see it).';
          break;
        case 'stripe-connect':
          note =
            '[system-note] The user just connected their Stripe account — the earlier connect request completed. ' +
            'Call initialize_stripe_payments again to finish setup (it will return already-connected with next steps).';
          break;
      }
      if (isBusyRef.current) {
        setMessageQueue(q => [...q, note]);
      } else {
        userStoppedRef.current = false;
        sendMessageRef.current({ text: note });
      }
    };
    window.addEventListener('agent-modal-completed', handler);
    return () => window.removeEventListener('agent-modal-completed', handler);
  }, [projectId]);

  // --- Debounced busy state: goes true immediately on activity, only goes false after a delay ---
  useEffect(() => {
    const active = status === 'streaming' || status === 'submitted';
    if (active) {
      if (busyDebounceRef.current) {
        clearTimeout(busyDebounceRef.current);
        busyDebounceRef.current = null;
      }
      setIsBusy(true);
      if (!toolAbortRef.current || toolAbortRef.current.signal.aborted) {
        toolAbortRef.current = new AbortController();
      }
    } else {
      // Delay clearing busy to absorb gaps between tool rounds (2s debounce)
      if (busyDebounceRef.current) clearTimeout(busyDebounceRef.current);
      busyDebounceRef.current = setTimeout(() => {
        setIsBusy(false);
        busyDebounceRef.current = null;
      }, 2000);
    }
  }, [status]);

  const isAgentWorking = isBusy;

  // --- First-turn detection ---
  // True while the agent is working on the very first message of a brand-new
  // project (exactly one user message when the turn starts). The workspace
  // uses this to veil the preview during the initial build — and ONLY then;
  // follow-up turns never blur.
  const [isFirstTurn, setIsFirstTurn] = useState(false);
  const prevBusyForFirstTurnRef = useRef(false);
  useEffect(() => {
    if (isBusy && !prevBusyForFirstTurnRef.current) {
      const userCount = messagesRef.current.filter((m) => m.role === 'user').length;
      setIsFirstTurn(userCount <= 1);
    } else if (!isBusy) {
      setIsFirstTurn(false);
    }
    prevBusyForFirstTurnRef.current = isBusy;
  }, [isBusy]);

  // Emit custom event when busy state changes (workspace listens for preview loading state)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('agent-busy-change', { detail: { isBusy, isFirstTurn } }));
    }
  }, [isBusy, isFirstTurn]);

  // --- Interrupted-turn recovery ---
  // When busy truly settles to false (debounced) and endTurn wasn't called,
  // the turn was cut short (text-only step, truncated stream, killed route).
  // Queued user messages take precedence — they continue the conversation
  // anyway. Otherwise try a capped silent auto-continue; only when that's
  // exhausted (or the user pressed Stop / an error banner is showing) fall
  // back to the visible "Agent may not have finished" warning.
  const prevBusyRef = useRef(false);
  useEffect(() => {
    // Detect transition from busy → not busy (the real end of agent work)
    if (prevBusyRef.current && !isBusy) {
      if (messageQueueRef.current.length > 0) {
        // Process message queue
        const [next, ...rest] = messageQueueRef.current;
        setMessageQueue(rest);
        autoContinuesUsedRef.current = 0;
        setTimeout(() => {
          sendMessageRef.current({ text: next });
        }, 300);
      } else if (
        !endTurnCalledRef.current
        && !agentErrorRef.current
        && !limitPayloadRef.current
        && messagesRef.current.some(m => m.role === 'assistant')
      ) {
        // Reattach-first for Claude Code; falls back to the auto-continue
        // nudge (and finally the visible warning) when there's nothing live.
        void attemptTurnRecovery();
      }
    }
    prevBusyRef.current = isBusy;
  }, [isBusy, attemptTurnRecovery]); // Only trigger on actual busy state transitions

  // Track first response — only check when message count changes
  useEffect(() => {
    if (!hasAgentResponded && messagesRef.current.some(m => m.role === 'assistant')) {
      setHasAgentResponded(true);
    }
  }, [messages.length, hasAgentResponded]);

  // Reset endTurn tracking when a new user message is sent
  // Refs shared between this turn-reset effect and the messages-derived effect
  // below. Declared up-front so both effects can reference them safely.
  const seenServerToolsRef = useRef<Set<string>>(new Set());
  const endTurnSeenRef = useRef(false);

  const lastMsgIdRef = useRef<string | null>(null);
  useEffect(() => {
    const msgs = messagesRef.current;
    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg?.role === 'user' && lastMsg.id !== lastMsgIdRef.current) {
      lastMsgIdRef.current = lastMsg.id;
      // Reset the messages-derived effect's "have I already seen endTurn"
      // flag so a fresh endTurn for the new turn is detected.
      endTurnSeenRef.current = false;
      setEndTurnCalled(false);
      setShowCompletionWarning(false);
      // New turn → fresh no-progress baseline for the reattach guard.
      lastReattachSigRef.current = null;
    }
  }, [messages.length]);

  // For server-executed tools (sandbox platforms) onToolCall does not fire.
  // Derive endTurn detection and live action entries from the streamed message parts.
  //
  // Performance note: this effect depends on `messages`, whose reference changes
  // on every streaming chunk. We rely on `seenServerToolsRef` to skip already-
  // processed (toolCallId, state) pairs, and we ONLY call setState when something
  // actually changed — otherwise we'd burn a render per chunk for no work.
  useEffect(() => {
    if (!platform || !isSandboxPlatform(platform)) return;
    let endTurnFound = false;
    const newActions: ToolCallData[] = [];
    for (const m of messages) {
      if (m.role !== 'assistant') continue;
      for (const part of m.parts) {
        if (!isToolUIPart(part)) continue;
        const toolName = getToolName(part);
        const tc = part as { toolCallId?: string; state?: string; input?: unknown; output?: unknown };
        const toolCallId = tc.toolCallId ?? '';
        const state = tc.state ?? '';
        // endTurn is a control-flow signal, not a visible action — skip it in
        // EVERY state so it never lands in Live Actions. Previously only the
        // final 'output-available' state was skipped; the earlier
        // 'input-available' event pushed endTurn with status 'invoked' (spinner)
        // and the later 'output-available' event hit this `continue` without
        // ever clearing it. endTurn is fire-and-forget, so nothing updates that
        // entry afterwards and the spinner runs forever.
        if (toolName === 'endTurn') {
          if (state === 'output-available') endTurnFound = true;
          continue;
        }
        const key = `${toolCallId}:${state}`;
        if (seenServerToolsRef.current.has(key)) continue;
        seenServerToolsRef.current.add(key);

        const args = (tc.input ?? {}) as Record<string, unknown>;
        const isDone = state === 'output-available';
        const isError = state === 'output-error';

        if (state === 'input-streaming' || state === 'input-available') {
          newActions.push({
            toolCallId,
            toolName,
            args,
            status: 'invoked',
            startedAt: Date.now(),
          });
        } else if (isDone || isError) {
          let preview = '';
          let derivedStatus: 'success' | 'error' = isError ? 'error' : 'success';
          try {
            const out = (tc.output as unknown) ?? '';
            if (typeof out === 'object' && out !== null) {
              const o = out as Record<string, unknown>;
              // For structured tool results use the human-readable message and
              // derive success/error from the `ok` field (server tools like
              // convexDeploy return { ok, message } even when !ok so state is
              // still 'output-available').
              if ('ok' in o) {
                if (!o.ok) derivedStatus = 'error';
                preview = typeof o.message === 'string' ? o.message : JSON.stringify(o);
              } else {
                preview = JSON.stringify(out);
              }
            } else {
              preview = typeof out === 'string' ? out : JSON.stringify(out);
            }
          } catch { preview = ''; }
          newActions.push({
            toolCallId,
            toolName,
            args,
            status: derivedStatus,
            startedAt: Date.now(),
            finishedAt: Date.now(),
            resultPreview: preview.slice(0, 400),
          });
        }
      }
    }
    // Only call setEndTurnCalled when the value actually changes. React bails
    // out on Object.is matches, but we shouldn't depend on that; calling
    // setState every chunk during streaming is wasteful and a known source of
    // "Maximum update depth exceeded" when other effects react to those calls.
    if (endTurnFound && !endTurnSeenRef.current) {
      endTurnSeenRef.current = true;
      setEndTurnCalled(true);
      setShowCompletionWarning(false);
    }
    if (newActions.length > 0) {
      setActions(prev => {
        // Merge: replace existing entries with same toolCallId, append new.
        const map = new Map(prev.map(a => [a.toolCallId, a]));
        for (const na of newActions) map.set(na.toolCallId, na);
        return Array.from(map.values());
      });
    }
  }, [messages, platform]);

  // Estimate total tokens in conversation (messages + system prompt + tools overhead)
  // Only recalculate when message count changes (not on every content update during streaming)
  useEffect(() => {
    const SYSTEM_PROMPT_TOKENS = 4500;
    const TOOLS_TOKENS = 800;
    let msgTokens = 0;
    for (const msg of messagesRef.current) {
      for (const part of msg.parts) {
        if (part.type === 'text') {
          msgTokens += Math.ceil(part.text.length / 4);
        } else if (isToolUIPart(part)) {
          const toolStr = JSON.stringify(part);
          msgTokens += Math.ceil(toolStr.length / 4);
        }
      }
      msgTokens += 4;
    }
    setTokenEstimate(SYSTEM_PROMPT_TOKENS + TOOLS_TOKENS + msgTokens);
  }, [messages.length]);

  // Rate limit countdown timer
  useEffect(() => {
    if (retryCountdown === null || retryCountdown <= 0) return;
    const timer = setInterval(() => {
      setRetryCountdown(prev => {
        if (prev === null || prev <= 1) {
          clearInterval(timer);
          return null;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [retryCountdown]);

  // Remove only the "prompt" query param from the URL without reloading
  const removePromptFromUrl = useCallback(() => {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('prompt')) {
        url.searchParams.delete('prompt');
        window.history.replaceState({}, document.title, url.toString());
      }
    } catch {}
  }, []);

  // Load initial chat history (all segments, for display). The transport's
  // prepareSendMessagesRequest scopes outgoing messages to the current segment.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/chat?projectId=${encodeURIComponent(projectId)}&includeAllSegments=true`);
        if (!res.ok) throw new Error('Failed to load chat');
        const data = await res.json();
        if (cancelled) return;
        if (typeof data?.currentSegmentId === 'string') {
          setCurrentSegmentId(data.currentSegmentId);
        }
        if (Array.isArray(data?.messages)) {
          setMessages(data.messages);
          const ids = new Set<string>();
          const segMap = new Map<string, string>();
          for (const m of data.messages) {
            ids.add(m.id);
            if (typeof m.segmentId === 'string') segMap.set(m.id, m.segmentId);
          }
          savedIdsRef.current = ids;
          segmentByMessageIdRef.current = segMap;
          const lastAssistant = [...data.messages].reverse().find((m: { role: string }) => m.role === 'assistant');
          if (lastAssistant) {
            try {
              lastAssistantSavedRef.current = { id: lastAssistant.id, hash: JSON.stringify(lastAssistant.parts ?? lastAssistant.content).slice(-512) };
            } catch {
              lastAssistantSavedRef.current = { id: lastAssistant.id, hash: String(lastAssistant.parts ?? lastAssistant.content) };
            }
          }
          // hasAgentResponded should reflect the current segment only.
          const currentAssistant = data.messages.find((m: { role: string; segmentId?: string }) =>
            m.role === 'assistant' && (!data.currentSegmentId || m.segmentId === data.currentSegmentId),
          );
          if (currentAssistant) setHasAgentResponded(true);
        }
      } catch (err) {
        console.warn('No existing chat or failed to load:', err);
      } finally {
        if (!cancelled) setInitialized(true);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [projectId, setMessages]);

  // Load project model and user settings (BYOK presence)
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`);
        if (res.ok) {
          const proj = await res.json();
          setModel(resolveModelId(proj?.model));
          // Note: project.agentBackend is no longer read — the agent backend
          // is derived per-render from (model, platform, creds, preference).
        }
      } catch {}
      try {
        const s = await fetch('/api/user-settings');
        if (s.ok) {
          const data = await s.json();
          setHasOpenAIKey(Boolean(data?.hasOpenAIKey));
          setHasAnthropicKey(Boolean(data?.hasAnthropicKey));
          setHasClaudeOAuth(Boolean(data?.hasClaudeOAuth));
          setHasCodexOAuth(Boolean(data?.hasCodexOAuth));
          setHasMoonshotKey(Boolean(data?.hasMoonshotKey));
          setHasFireworksKey(Boolean(data?.hasFireworksKey));
          setHasGoogleKey(Boolean(data?.hasGoogleKey));
          setHasXaiKey(Boolean(data?.hasXaiKey));
          setHasTogetherKey(Boolean(data?.hasTogetherKey));
          setUseTogetherKimi(Boolean(data?.useTogetherKimi));
        }
      } catch {}
    })();
  }, [projectId]);

  // Refresh provider access when settings modal closes
  useEffect(() => {
    const handler = () => {
      fetch('/api/user-settings')
        .then(r => r.ok ? r.json() : null)
        .then((data: Record<string, unknown> | null) => {
          if (!data) return;
          setHasOpenAIKey(Boolean(data?.hasOpenAIKey));
          setHasAnthropicKey(Boolean(data?.hasAnthropicKey));
          setHasClaudeOAuth(Boolean(data?.hasClaudeOAuth));
          setHasCodexOAuth(Boolean(data?.hasCodexOAuth));
          setHasMoonshotKey(Boolean(data?.hasMoonshotKey));
          setHasFireworksKey(Boolean(data?.hasFireworksKey));
          setHasGoogleKey(Boolean(data?.hasGoogleKey));
          setHasXaiKey(Boolean(data?.hasXaiKey));
          setHasTogetherKey(Boolean(data?.hasTogetherKey));
          setUseTogetherKimi(Boolean(data?.useTogetherKimi));
        })
        .catch(() => {});
    };
    window.addEventListener('settings-closed', handler);
    return () => window.removeEventListener('settings-closed', handler);
  }, []);

  // Persist new messages — only when message count changes (not during streaming content updates)
  useEffect(() => {
    if (!initialized) return;
    async function persistNewMessages() {
      for (const m of messagesRef.current) {
        if (m.role === 'assistant') continue; // Assistant messages are persisted in onFinish
        if (!savedIdsRef.current.has(m.id)) {
          try {
            await fetch('/api/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ projectId, message: m }),
            });
            savedIdsRef.current.add(m.id);
            if (currentSegmentIdRef.current) {
              segmentByMessageIdRef.current.set(m.id, currentSegmentIdRef.current);
            }
          } catch (err) {
            console.error('Failed to persist message:', err);
          }
        }
      }
    }
    void persistNewMessages();
  }, [messages.length, projectId, initialized]);

  // Initial prompt submission — fire once when initialized with no existing messages
  const initialPromptSentRef = useRef(false);
  useEffect(() => {
    if (initialized && initialPrompt && !initialPromptSentRef.current && messagesRef.current.length === 0) {
      initialPromptSentRef.current = true;
      setTimeout(() => {
        // Pick up any images attached on the landing page
        let fileParts: Array<{ type: 'file'; mediaType: string; url: string; filename?: string }> | undefined;
        try {
          const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('botflow_pending_images') : null;
          if (raw) {
            sessionStorage.removeItem('botflow_pending_images');
            fileParts = JSON.parse(raw) as typeof fileParts;
          }
        } catch {}
        sendMessageRef.current({ text: initialPrompt, files: fileParts ?? undefined });
        removePromptFromUrl();
      }, 0);
    }
  }, [initialized, initialPrompt, removePromptFromUrl]);

  // Keep scrolled to bottom on new messages or actions
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, actions.length]);

  // --- Submit handler ---
  const onFormSubmit = useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const hasText = input.trim().length > 0;
    const hasImages = pendingImages.length > 0;
    if (!hasText && !hasImages) return;

    const usingAnthropic = model === 'claude-sonnet-5' || model === 'claude-opus-4-8' || model === 'claude-fable-5';
    const hasAnthropicCreds = hasAnthropicKey || (ANTHROPIC_OAUTH_ENABLED && hasClaudeOAuth);
    const hasOpenAICreds = hasCodexOAuth || hasOpenAIKey;
    // Pro/Max users can use OpenAI and Anthropic models via platform server keys — only
    // block free-tier users who have no personal credentials for these providers.
    const isPayingTier = userTier === 'pro' || userTier === 'max';
    if (!isPayingTier) {
      if ((isOpenAIModel(model) && hasOpenAICreds === false) || (usingAnthropic && hasAnthropicCreds === false)) {
        toast({ title: 'Missing API key', description: `Please add your ${isOpenAIModel(model) ? 'OpenAI' : 'Anthropic'} API key in Settings, or upgrade to Pro.` });
        return;
      }
    }

    // Warn if model doesn't support images but images are attached
    if (hasImages && !modelSupportsImages(model)) {
      toast({ title: `${MODEL_CONFIGS[model].displayName} doesn't support images — images will be ignored` });
    }

    // --- Message queueing: if agent is working, queue the message ---
    if (isAgentWorking) {
      setMessageQueue(prev => [...prev, input.trim()]);
      setInput('');
      toast({ title: 'Message queued', description: `Will be sent when the agent finishes. (${messageQueue.length + 1} in queue)` });
      return;
    }

    // Wait for any in-flight uploads to complete
    if (pendingUploadsRef.current.size > 0) {
      await Promise.allSettled(Array.from(pendingUploadsRef.current.values()));
    }

    // Build file parts from successfully uploaded images
    const currentImages = pendingImages;
    const fileParts = currentImages
      .filter(img => img.uploaded && img.url)
      .map(img => ({
        type: 'file' as const,
        mediaType: (img.file.type || 'image/jpeg') as `image/${string}`,
        url: img.url!,
        filename: img.file.name,
      }));

    // Clean up pending images
    currentImages.forEach(img => URL.revokeObjectURL(img.localUrl));
    setPendingImages([]);

    setAgentError(null);
    setRetryCountdown(null);
    setEndTurnCalled(false);
    setShowCompletionWarning(false);
    setIsBusy(true);
    // Fresh user message → fresh auto-continue budget, and any prior Stop no
    // longer applies.
    userStoppedRef.current = false;
    autoContinuesUsedRef.current = 0;
    toolAbortRef.current = new AbortController();
    recoveryEpochRef.current++; // a real user send supersedes any in-flight recovery
    sendMessage({ text: input.trim(), files: fileParts.length > 0 ? fileParts : undefined });
    setInput('');
    removePromptFromUrl();
  }, [model, hasOpenAIKey, hasAnthropicKey, hasClaudeOAuth, hasCodexOAuth, isAgentWorking, input, pendingImages, messageQueue.length, sendMessage, removePromptFromUrl, toast]);

  // --- Re-prompt for lazy completion ---
  const handleReprompt = useCallback(() => {
    setShowCompletionWarning(false);
    setEndTurnCalled(false);
    setIsBusy(true);
    // Manual re-prompt = explicit user intent to continue: clear the Stop
    // latch and refill the auto-continue budget.
    userStoppedRef.current = false;
    autoContinuesUsedRef.current = 0;
    toolAbortRef.current = new AbortController();
    recoveryEpochRef.current++;
    sendMessage({ text: 'You stopped without calling endTurn. Please continue or call endTurn if done.' });
  }, [sendMessage]);

  // --- Token usage bar ---
  // For Claude Code projects we have authoritative usage from the SDK; use it
  // when present so the bar reflects the real (post-compaction) context size.
  // Falls back to our char/4 estimate before the first turn completes.
  const displayedTokens = (agentBackend === 'claude-code' || agentBackend === 'opencode') && claudeCodeUsage
    ? claudeCodeUsage.tokens
    : tokenEstimate;
  const tokenRatio = maxTokens > 0 ? displayedTokens / maxTokens : 0;
  const tokenBarColor = tokenRatio >= 0.9 ? 'bg-red-500' : tokenRatio >= 0.7 ? 'bg-yellow-500' : 'bg-accent';

  const placeholder = useMemo(() => 'Ask Botflow...', []);

  // --- Handle input change ---
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
  }, []);

  // --- Handle file selection for image attachments ---
  const MAX_IMAGES = 10;

  // Add a single image File to the pending strip and kick off its upload.
  // Shared by the file picker and the simulator-screenshot capture so both
  // paths produce identical attachments (process → /api/chat-images/upload).
  const enqueueImageFile = useCallback((file: File) => {
    const pendingId = crypto.randomUUID();
    const localUrl = URL.createObjectURL(file);

    setPendingImages(prev => [...prev, {
      id: pendingId,
      file,
      localUrl,
      uploading: true,
      uploaded: false,
    }]);

    const uploadPromise = (async () => {
      try {
        const processed = await processImageForUpload(file);
        const formData = new FormData();
        formData.append('file', processed);
        formData.append('projectId', projectId);

        const res = await fetch('/api/chat-images/upload', { method: 'POST', body: formData });
        if (!res.ok) {
          const data = await res.json().catch(() => ({})) as { error?: string };
          throw new Error((data as { error?: string }).error ?? 'Upload failed');
        }
        const { id: dbId, url, key } = await res.json() as { id: string; url: string; key: string };

        setPendingImages(prev => prev.map(img =>
          img.id === pendingId
            ? { ...img, uploading: false, uploaded: true, dbId, url, key }
            : img
        ));
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        setPendingImages(prev => prev.map(img =>
          img.id === pendingId
            ? { ...img, uploading: false, uploaded: false, error: msg }
            : img
        ));
      } finally {
        pendingUploadsRef.current.delete(pendingId);
      }
    })();

    pendingUploadsRef.current.set(pendingId, uploadPromise);
  }, [projectId]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const allFiles = Array.from(e.target.files ?? []);
    if (allFiles.length === 0) return;
    e.target.value = '';

    const slots = MAX_IMAGES - pendingImages.length;
    if (slots <= 0) {
      toast({ title: `Maximum ${MAX_IMAGES} images per message` });
      return;
    }
    const files = allFiles.slice(0, slots);
    if (files.length < allFiles.length) {
      toast({ title: `Maximum ${MAX_IMAGES} images per message — ${allFiles.length - files.length} file(s) skipped` });
    }

    for (const file of files) enqueueImageFile(file);
  }, [pendingImages.length, toast, enqueueImageFile]);

  // --- Remove a pending image ---
  const handleRemoveImage = useCallback((pendingId: string) => {
    setPendingImages(prev => {
      const img = prev.find(i => i.id === pendingId);
      if (img) {
        URL.revokeObjectURL(img.localUrl);
        if (img.dbId) {
          fetch('/api/chat-images/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: img.dbId }),
          }).catch(() => {});
        }
      }
      return prev.filter(i => i.id !== pendingId);
    });
  }, []);

  // --- Simulator screenshot bridge (swift projects) ---
  // The SwiftSimulatorPreview is a sibling component that owns the streaming
  // canvas and its live/stopped state. It can't be reached through props from
  // here, so we coordinate over window events (the pattern this codebase
  // already uses for cross-component signals), scoped by projectId:
  //   • it broadcasts `swift-sim-availability` whenever a live frame becomes
  //     (un)grabbable — we mirror that into `simShotAvailable` to enable/gray
  //     the button. We also fire a one-shot query on mount in case the sim
  //     went live before this listener attached.
  useEffect(() => {
    if (!isSwift) return;
    const onAvail = (e: Event) => {
      const d = (e as CustomEvent<{ projectId: string; available: boolean }>).detail;
      if (!d || d.projectId !== projectId) return;
      setSimShotAvailable(Boolean(d.available));
    };
    window.addEventListener('swift-sim-availability', onAvail);
    window.dispatchEvent(new CustomEvent('swift-sim-availability-query', { detail: { projectId } }));
    return () => window.removeEventListener('swift-sim-availability', onAvail);
  }, [isSwift, projectId]);

  // Request a fresh grab of the simulator screen and, when it comes back,
  // funnel it through the normal image-attachment pipeline so it rides along
  // with the next message exactly like a manually-uploaded screenshot.
  const handleCaptureSimShot = useCallback(() => {
    if (!simShotAvailable || capturingSimShot) return;
    if (pendingImages.length >= MAX_IMAGES) {
      toast({ title: `Maximum ${MAX_IMAGES} images per message` });
      return;
    }
    setCapturingSimShot(true);
    const requestId = crypto.randomUUID();
    // Mutable holder (vs. plain `let`s) so `finish` can clear the timeout and
    // guard against double-settle without tripping prefer-const / TDZ ordering.
    const pending: { settled: boolean; timer?: ReturnType<typeof setTimeout> } = { settled: false };

    const finish = (result: { blob?: Blob; error?: string }) => {
      if (pending.settled) return;
      pending.settled = true;
      window.removeEventListener('swift-sim-capture-response', onResp);
      if (pending.timer) clearTimeout(pending.timer);
      setCapturingSimShot(false);
      if (result.error || !result.blob) {
        toast({ title: "Couldn't capture the simulator", description: result.error ?? 'No frame available yet.' });
        return;
      }
      const ext = result.blob.type === 'image/png' ? 'png' : 'jpg';
      const file = new File([result.blob], `simulator-${Date.now()}.${ext}`, { type: result.blob.type || 'image/jpeg' });
      enqueueImageFile(file);
    };

    function onResp(e: Event) {
      const d = (e as CustomEvent<{ projectId: string; requestId: string; blob?: Blob; error?: string }>).detail;
      if (!d || d.projectId !== projectId || d.requestId !== requestId) return;
      finish({ blob: d.blob, error: d.error });
    }

    window.addEventListener('swift-sim-capture-response', onResp);
    pending.timer = setTimeout(() => finish({ error: 'The preview did not respond. Make sure it is running.' }), 5000);
    window.dispatchEvent(new CustomEvent('swift-sim-capture-request', { detail: { projectId, requestId } }));
  }, [simShotAvailable, capturingSimShot, pendingImages.length, projectId, enqueueImageFile, toast]);

  // --- Error display component ---
  const renderError = () => {
    if (!agentError) return null;

    let errorContent: React.ReactNode;
    switch (agentError.type) {
      case 'rate_limit':
        errorContent = (
          <p className="flex-1 text-xs leading-relaxed whitespace-pre-wrap">
            Rate limited.{retryCountdown !== null && retryCountdown > 0
              ? ` Resets in ${retryCountdown}s.`
              : ' Please wait a moment and try again.'}
          </p>
        );
        break;
      case 'auth':
        errorContent = (
          <p className="flex-1 text-xs leading-relaxed whitespace-pre-wrap">
            Authentication error. Check your API key in{' '}
            <button type="button" onClick={() => setShowSettings(true)} className="underline hover:text-red-300">Settings</button>.
          </p>
        );
        break;
      case 'context_overflow':
        errorContent = (
          <p className="flex-1 text-xs leading-relaxed whitespace-pre-wrap">
            Context too large. Try sending a shorter message or{' '}
            <button
              type="button"
              onClick={async () => {
                const confirmed = window.confirm('Reset chat to free up context? This will delete all messages.');
                if (!confirmed) return;
                try {
                  const r = await fetch(`/api/chat?projectId=${encodeURIComponent(projectId)}`, { method: 'DELETE' });
                  const data = await r.json().catch(() => ({} as { currentSegmentId?: string }));
                  if (typeof data.currentSegmentId === 'string') setCurrentSegmentId(data.currentSegmentId);
                  savedIdsRef.current.clear();
                  segmentByMessageIdRef.current.clear();
                  lastAssistantSavedRef.current = null;
                  setMessages([]);
                  setAgentError(null);
                  setPendingImages(prev => { prev.forEach(img => URL.revokeObjectURL(img.localUrl)); return []; });
                  // Wipe the browser-log ring buffer too — fresh segment, fresh slate.
                  fetch(`/api/projects/${encodeURIComponent(projectId)}/browser-log`, { method: 'DELETE' }).catch(() => {});
                } catch {}
              }}
              className="underline hover:text-red-300"
            >
              reset the conversation
            </button>.
          </p>
        );
        break;
      default:
        errorContent = <p className="flex-1 text-xs leading-relaxed whitespace-pre-wrap">{agentError.message}</p>;
    }

    return (
      <div className="flex items-start gap-2.5 rounded-xl px-3.5 py-3 bg-red-500/10 border border-red-500/20 text-red-400">
        <AlertCircle size={14} className="mt-0.5 shrink-0" />
        {errorContent}
        <div className="flex items-center gap-1 shrink-0">
          {agentError.type !== 'auth' && (
            <button
              type="button"
              onClick={() => {
                setAgentError(null);
                setRetryCountdown(null);
                // Re-submit the last user message as a retry
                const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
                if (lastUserMsg) {
                  const textPart = lastUserMsg.parts.find(p => p.type === 'text');
                  const content = textPart && 'text' in textPart ? textPart.text : '';
                  if (content) {
                    setIsBusy(true);
                    toolAbortRef.current = new AbortController();
                    recoveryEpochRef.current++;
                    sendMessage({ text: content });
                  }
                }
              }}
              className="text-red-400/60 hover:text-red-400 transition-colors"
              aria-label="Retry"
              title="Retry"
            >
              <RotateCcw size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={() => { setAgentError(null); setRetryCountdown(null); }}
            className="text-red-400/60 hover:text-red-400 transition-colors"
            aria-label="Dismiss"
          >
            <IconX size={13} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className={cn('flex h-full flex-col text-sm bg-surface text-fg p-2.5', className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-surface">
        <div className="flex items-center gap-2">
          <button onClick={() => setShowSettings(true)} title="Settings" aria-label="Settings" className="text-muted hover:text-fg">
            <Cog size={16} />
          </button>
          {(() => {
            // Shrink both gauges a touch when they sit side-by-side so they
            // don't crowd each other.
            const showClaudePlan = Boolean(usesClaudePlan && claudePlanUsage);
            const gaugeSize = showClaudePlan ? 'xs' : 'sm';
            return (
              <>
                <GaugeWithTooltip
                  label="Botflow credits"
                  lines={[`${Math.round(creditPct)}% of your weekly platform credits used.`]}
                >
                  <CreditGauge pct={creditPct} size={gaugeSize} />
                </GaugeWithTooltip>
                {showClaudePlan && claudePlanUsage && (
                  <GaugeWithTooltip
                    label="Claude plan usage"
                    lines={[
                      ...(claudePlanUsage.fiveHour !== null ? [`Session (5h): ${claudePlanUsage.fiveHour}% used`] : []),
                      ...(claudePlanUsage.sevenDay !== null ? [`Week (7d): ${claudePlanUsage.sevenDay}% used`] : []),
                      'Claude Code runs on your Claude subscription.',
                    ]}
                  >
                    <CreditGauge
                      pct={Math.max(claudePlanUsage.fiveHour ?? 0, claudePlanUsage.sevenDay ?? 0)}
                      size={gaugeSize}
                    />
                  </GaugeWithTooltip>
                )}
              </>
            );
          })()}
        </div>
        <div className="flex items-center gap-2">
          <ModelSelector
            value={model}
            onChange={async (next) => {
              const patchModel = () =>
                fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ model: next }),
                });
              try {
                let res = await patchModel();
                if (res.status === 429) {
                  // Rate-limited (e.g. bursty background traffic) — this is
                  // transient, so say so and retry once after Retry-After
                  // instead of a dead-end "failed".
                  const retryAfter = Math.min(
                    Math.max(Number(res.headers.get('Retry-After')) || 5, 1),
                    30,
                  );
                  toast({
                    title: 'Too many requests',
                    description: `Retrying in ${retryAfter}s…`,
                  });
                  await new Promise((r) => setTimeout(r, retryAfter * 1000));
                  res = await patchModel();
                }
                if (res.ok) setModel(next);
                else toast({ title: 'Failed to change model' });
              } catch {
                toast({ title: 'Failed to change model' });
              }
            }}
            providerAccess={providerAccess}
            userTier={userTier}
            onTierLocked={setLimitPayload}
            size="sm"
            useTogetherKimi={useTogetherKimi}
            leading={<BackendGlyphInfo backend={agentBackend} />}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={async () => {
              const confirmed = window.confirm('Reset chat? This will permanently delete all messages for this project.');
              if (!confirmed) return;
              try {
                const r = await fetch(`/api/chat?projectId=${encodeURIComponent(projectId)}`, { method: 'DELETE' });
                const data = await r.json().catch(() => ({} as { currentSegmentId?: string }));
                if (typeof data.currentSegmentId === 'string') setCurrentSegmentId(data.currentSegmentId);
                savedIdsRef.current.clear();
                segmentByMessageIdRef.current.clear();
                lastAssistantSavedRef.current = null;
                setMessages([]);
                setHasAgentResponded(false);
                setTokenEstimate(0);
                setClaudeCodeUsage(null);
                setIsCompacting(false);
                // Wipe browser-log ring buffer — new segment, fresh slate.
                fetch(`/api/projects/${encodeURIComponent(projectId)}/browser-log`, { method: 'DELETE' }).catch(() => {});
                // Clean up any pending image attachments
                setPendingImages(prev => {
                  prev.forEach(img => URL.revokeObjectURL(img.localUrl));
                  return [];
                });
              } catch (err) {
                console.error('Failed to reset chat:', err);
              }
            }}
          >
            Reset
          </Button>
        </div>
      </div>

      {/* Inline backend chip — info-only. Hidden when there's nothing
          meaningful to explain (e.g., non-Anthropic model on free tier). */}
      <div className="px-3 pb-1">
        <BackendChip
          backend={agentBackend}
          reason={derivedBackend.reason}
          runnable={derivedBackend.runnable}
        />
      </div>

      {/* Messages — v6 parts-based rendering. Segments from prior agents
          stay visible but visually de-emphasized; a divider marks the boundary. */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden space-y-3 p-3 modern-scrollbar min-w-0">
        {messages.map((m, idx) => {
          const mySeg = segmentByMessageIdRef.current.get(m.id) ?? currentSegmentId ?? null;
          const prevSeg = idx > 0
            ? (segmentByMessageIdRef.current.get(messages[idx - 1].id) ?? currentSegmentId ?? null)
            : null;
          const showSegmentDivider = idx > 0 && mySeg && prevSeg && mySeg !== prevSeg;
          const isOlderSegment = Boolean(currentSegmentId && mySeg && mySeg !== currentSegmentId);
          const dividerEl = showSegmentDivider ? (
            <div key={`seg-${idx}`} className="flex items-center gap-2 px-2 py-1 text-[10px] uppercase tracking-wider text-muted">
              <div className="flex-1 h-px bg-border" />
              <span>{mySeg === currentSegmentId ? 'New conversation' : 'Previous conversation'}</span>
              <div className="flex-1 h-px bg-border" />
            </div>
          ) : null;
          const olderClass = isOlderSegment ? 'opacity-60' : '';
          // Subagent timelines arrive as `data-claude-code-subagent` parts
          // keyed by their parent Task tool-use id. Collect them so we can nest
          // each one under its Task step (rendered separately, not in the
          // main part flow).
          const subagentStepsByParent = new Map<string, SubagentStep[]>();
          for (const part of m.parts) {
            if (part.type === 'data-claude-code-subagent') {
              const d = (part as { data?: { parentToolUseId?: string; steps?: SubagentStep[] } }).data;
              if (d?.parentToolUseId) subagentStepsByParent.set(d.parentToolUseId, d.steps ?? []);
            }
          }
          const filteredParts = m.parts.filter(part => {
            if (isToolUIPart(part) && getToolName(part) === 'endTurn') return false;
            // Subagent data parts are rendered nested under their Task step, not
            // inline — drop them from the main timeline flow.
            if (part.type === 'data-claude-code-subagent') return false;
            // Skip whitespace-only text parts — they would break up consecutive tool groups
            if (part.type === 'text' && !part.text.trim()) return false;
            return true;
          });
          const hasTools = filteredParts.some(p => isToolUIPart(p));

          // User messages or assistant messages with no tools — no timeline
          if (m.role === 'user' || !hasTools) {
            // System-note messages (the bookkeeping note inserted on GitHub link
            // and any similar future signals) render as a subtle chip, not a
            // normal user bubble. Detection is by text prefix to keep the chat
            // route unchanged.
            const firstText = filteredParts.find(p => p.type === 'text') as { type: 'text'; text: string } | undefined;
            const isSystemNote =
              m.role === 'user'
              && firstText
              && firstText.text.trimStart().startsWith('[system-note]');
            if (isSystemNote) {
              return (
                <Fragment key={m.id}>
                  {dividerEl}
                  <div className={cn('rounded-lg border border-border/60 bg-elevated/40 px-2.5 py-1.5 text-[11px] text-muted', olderClass)}>
                    {firstText.text.replace(/^\s*\[system-note\]\s*/, '')}
                  </div>
                </Fragment>
              );
            }
            return (
              <Fragment key={m.id}>
                {dividerEl}
                <div className={cn('rounded-xl px-2 py-3 text-[1.1rem] tracking tight min-w-0 max-w-full overflow-hidden break-words [overflow-wrap:anywhere]', m.role === 'user' ? 'bg-elevated' : '', olderClass)}>
                {filteredParts.map((part, i) => {
                  if (part.type === 'text') return <Markdown key={i} content={part.text} />;
                  if (part.type === 'reasoning') {
                    const rp = part as { type: 'reasoning'; text: string; state?: 'streaming' | 'done' };
                    return <ThinkingBlock key={i} content={rp.text} state={rp.state} />;
                  }
                  if (part.type === 'file' && 'mediaType' in part && typeof part.mediaType === 'string' && part.mediaType.startsWith('image/') && 'url' in part && typeof part.url === 'string') {
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setLightboxSrc(part.url as string)}
                        className="inline-block rounded-lg overflow-hidden border border-border mt-1 hover:opacity-90 transition-opacity"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={part.url as string} alt={'filename' in part && typeof part.filename === 'string' ? part.filename : ''} className="w-16 h-16 object-cover" crossOrigin="anonymous" />
                      </button>
                    );
                  }
                  return null;
                })}
                </div>
              </Fragment>
            );
          }

          // Assistant message with tools — grouped timeline segments
          // Group consecutive tool calls vs content
          const partGroups: Array<{ type: 'tools' | 'content'; items: Array<{ part: (typeof filteredParts)[number]; idx: number }> }> = [];
          for (let pi = 0; pi < filteredParts.length; pi++) {
            const part = filteredParts[pi];
            const gType = isToolUIPart(part) ? 'tools' as const : 'content' as const;
            const last = partGroups[partGroups.length - 1];
            if (last?.type === gType) last.items.push({ part, idx: pi });
            else partGroups.push({ type: gType, items: [{ part, idx: pi }] });
          }

          // Compute the timeline span: from first tool group to last tool group
          // Everything between them (including content) is connected by a single line
          const firstToolIdx = partGroups.findIndex(g => g.type === 'tools');
          let lastToolIdx = 0;
          for (let gi = partGroups.length - 1; gi >= 0; gi--) {
            if (partGroups[gi].type === 'tools') { lastToolIdx = gi; break; }
          }
          const preTimeline  = partGroups.slice(0, firstToolIdx);
          const timeline     = partGroups.slice(firstToolIdx, lastToolIdx + 1);
          const postTimeline = partGroups.slice(lastToolIdx + 1);

          const renderContentGroup = (group: typeof partGroups[number], key: string) =>
            group.items.map(({ part, idx }) => {
              if (part.type === 'text') return <Markdown key={`${key}-${idx}`} content={part.text} />;
              if (part.type === 'reasoning') {
                const rp = part as { type: 'reasoning'; text: string; state?: 'streaming' | 'done' };
                return <ThinkingBlock key={`${key}-${idx}`} content={rp.text} state={rp.state} />;
              }
              return null;
            });

          return (
            <Fragment key={m.id}>
              {dividerEl}
              <div className={cn('rounded-xl px-2 py-3 text-[1.1rem] tracking tight min-w-0 max-w-full overflow-hidden break-words [overflow-wrap:anywhere]', olderClass)}>
              {/* Content before the first tool call */}
              {preTimeline.map((group, gi) => (
                <div key={`pre-${gi}`}>{renderContentGroup(group, `pre-${gi}`)}</div>
              ))}

              {/* Single continuous timeline from first → last tool call */}
              <div className="relative">
                {/* One line spanning the full timeline height */}
                <div className="absolute left-[6px] top-[14px] bottom-0 w-px bg-border" />

                {timeline.map((group, ti) => {
                  const isLastInTimeline = ti === timeline.length - 1;
                  if (group.type === 'tools') {
                    return (
                      <div key={`tl-${ti}`} className={isLastInTimeline ? 'pb-2' : ''}>
                        {group.items.map(({ part, idx }) => {
                          if (!isToolUIPart(part)) return null;
                          const toolName = getToolName(part);

                          // askQuestion: render inline QuestionPrompt instead of the
                          // generic ToolStep. The input carries the questions array; we
                          // POST the user's pick to /chat/questions/answer keyed on
                          // the tool's call id, which unblocks the server-side execute.
                          // Claude Code wraps MCP tools with `mcp__botflow__` prefix
                          // and uses snake_case for the tool name.
                          if (
                            toolName === 'askQuestion'
                            || toolName === 'ask_question'
                            || toolName === 'mcp__botflow__ask_question'
                            || toolName === 'AskUserQuestion'
                          ) {
                            const tc = part as { toolCallId?: string; state?: string; input?: { questions?: QuestionConfig[] }; output?: unknown };
                            const qs = (tc.input?.questions ?? []) as QuestionConfig[];
                            const callId = tc.toolCallId ?? `${m.id}-${idx}`;
                            const isPending = tc.state === 'input-streaming' || tc.state === 'input-available';
                            const isDone = tc.state === 'output-available';
                            // Derive a collapsed-summary answer payload from the tool output
                            const summaryAnswer: QuestionAnswerPayload | undefined = (() => {
                              // A tool error here means the question was dismissed or timed
                              // out (Claude Code's native AskUserQuestion resolves the
                              // dismiss path as a denied/errored call).
                              if (tc.state === 'output-error') return { kind: 'skip' };
                              if (!isDone) return undefined;
                              const o = tc.output as { answered?: boolean; selectedIds?: string[]; selectedLabels?: string[]; customText?: string | null; dismissed?: boolean } | null;
                              if (!o) return undefined;
                              if (o.dismissed || o.answered === false) return { kind: 'skip' };
                              return {
                                kind: qs[0]?.multiSelect ? 'multi' : 'single',
                                selectedIds: o.selectedIds ?? [],
                                text: o.customText ?? undefined,
                              };
                            })();
                            return (
                              // `relative z-10` lifts the card above the
                              // absolutely-positioned timeline rail so the
                              // card's opaque background masks the line
                              // within its own bounds. The line still
                              // continues above and below the card,
                              // connecting it to neighboring tool steps.
                              <div key={idx} className="relative z-10 my-2">
                                <QuestionPrompt
                                  questions={qs}
                                  output={summaryAnswer}
                                  disabled={!isPending}
                                  onSubmit={async (answer) => {
                                    // Look up selected labels from the active (first) question.
                                    const activeQ = qs[0];
                                    const labels = (answer.selectedIds ?? [])
                                      .map((id) => activeQ?.options.find(o => o.id === id)?.label)
                                      .filter((l): l is string => Boolean(l));
                                    await fetch(`/api/projects/${encodeURIComponent(projectId)}/chat/questions/answer`, {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({
                                        toolCallId: callId,
                                        selectedIds: answer.selectedIds ?? [],
                                        selectedLabels: labels,
                                        text: answer.text,
                                      }),
                                    });
                                  }}
                                  onSkip={async () => {
                                    await fetch(`/api/projects/${encodeURIComponent(projectId)}/chat/questions/answer`, {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ toolCallId: callId, dismissed: true }),
                                    });
                                  }}
                                />
                              </div>
                            );
                          }

                          // Task subagent: render the standard step plus the
                          // subagent's nested inner timeline beneath it.
                          if (toolName === 'task') {
                            const tc = part as { toolCallId?: string; input?: { description?: string; subagent_type?: string; prompt?: string } };
                            const steps = tc.toolCallId ? subagentStepsByParent.get(tc.toolCallId) : undefined;
                            const desc = tc.input?.description?.trim();
                            const subType = tc.input?.subagent_type?.trim();
                            const label = [subType, desc].filter(Boolean).join(': ') || undefined;
                            return (
                              <Fragment key={idx}>
                                <ToolStep
                                  toolName={label ? `task — ${label}` : 'task'}
                                  state={part.state}
                                  content={
                                    <pre className="text-xs overflow-auto bg-surface p-2 rounded border border-border">
                                      {JSON.stringify('input' in part ? part.input : part, null, 2)}
                                    </pre>
                                  }
                                />
                                {steps && <SubagentCard steps={steps} label={label} />}
                              </Fragment>
                            );
                          }

                          return (
                            <ToolStep
                              key={idx}
                              toolName={toolName}
                              state={part.state}
                              content={
                                <pre className="text-xs overflow-auto bg-surface p-2 rounded border border-border">
                                  {JSON.stringify('input' in part ? part.input : part, null, 2)}
                                </pre>
                              }
                            />
                          );
                        })}
                      </div>
                    );
                  }
                  // Content between tool groups — indented to sit beside the line
                  return (
                    <div key={`tl-${ti}`} className="pl-6 py-1">
                      {renderContentGroup(group, `tl-${ti}`)}
                    </div>
                  );
                })}
              </div>

              {/* Content after the last tool call — full width, no line */}
              {postTimeline.map((group, gi) => (
                <div key={`post-${gi}`}>{renderContentGroup(group, `post-${gi}`)}</div>
              ))}
              </div>
            </Fragment>
          );
        })}

        {/* Error banner */}
        {renderError()}

        {/* Lazy completion warning */}
        {showCompletionWarning && !isAgentWorking && !agentError && (
          <div className="flex items-center gap-2.5 rounded-xl px-3.5 py-3 bg-yellow-500/10 border border-yellow-500/20 text-yellow-400">
            <AlertCircle size={14} className="shrink-0" />
            <p className="flex-1 text-xs leading-relaxed">Agent may not have finished.</p>
            <button
              type="button"
              onClick={handleReprompt}
              className="text-xs text-yellow-400 hover:text-yellow-300 underline shrink-0"
            >
              Re-prompt
            </button>
            <button
              type="button"
              onClick={() => setShowCompletionWarning(false)}
              className="text-yellow-400/60 hover:text-yellow-400 transition-colors shrink-0"
              aria-label="Dismiss"
            >
              <IconX size={13} />
            </button>
          </div>
        )}

        {/* Persistent thinking indicator */}
        {isAgentWorking && (
          <div className="flex items-center gap-2 py-2">
            <Loader2 size={14} className="animate-spin text-accent" />
            <span className="text-xs text-muted">Agent is working<span className="animate-pulse">...</span></span>
          </div>
        )}

      </div>

      {/* Compound input card */}
      <form
        onSubmit={(e) => { void onFormSubmit(e); }}
        className="group flex flex-col rounded-2xl border border-border bg-elevated transition-colors duration-150 ease-in-out relative mt-2"
      >
        {/* Inset top — Live Actions */}
        {actions.length > 0 && (
          <div className="border-b border-border">
            <LiveActions
              actions={actions}
              onClear={() => setActions([])}
              className="border-0 bg-transparent rounded-none"
            />
          </div>
        )}

        {/* Textarea */}
        <div data-state="closed" style={{ cursor: 'text' }} className="px-4 pt-3">
          <div className="relative flex flex-1 items-center">
            <textarea
              className="flex w-full ring-offset-background placeholder:text-muted focus-visible:outline-none focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-none text-[16px] leading-snug placeholder-shown:text-ellipsis placeholder-shown:whitespace-nowrap md:text-base focus-visible:ring-0 focus-visible:ring-offset-0 max-h-[200px] bg-transparent focus:bg-transparent flex-1 m-1 rounded-md p-0"
              id="chatinput"
              placeholder={isAgentWorking ? 'Type to queue a message...' : placeholder}
              maxLength={50000}
              style={{ minHeight: 40, height: 40 }}
              value={input}
              onChange={handleInputChange}
            />
          </div>
        </div>

        {/* Image thumbnail strip */}
        {pendingImages.length > 0 && (
          <div className="flex overflow-x-auto px-4 pb-1 gap-2 modern-scrollbar">
            {pendingImages.map(img => (
              <div key={img.id} className="relative group shrink-0">
                <div className="w-12 h-12 rounded-lg border border-border overflow-hidden bg-soft flex items-center justify-center">
                  {img.uploading ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.localUrl} alt="" className="w-full h-full object-cover opacity-50" />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Loader2 size={16} className="animate-spin text-accent" />
                      </div>
                    </>
                  ) : img.error ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img.localUrl} alt="" className="w-full h-full object-cover opacity-30" />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <AlertCircle size={16} className="text-red-400" />
                      </div>
                    </>
                  ) : (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={img.localUrl} alt={img.file.name} className="w-full h-full object-cover" />
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => handleRemoveImage(img.id)}
                  className="absolute -top-1.5 -right-1.5 flex items-center justify-center size-4 rounded-full bg-surface border border-border text-muted hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label="Remove image"
                >
                  <IconX size={10} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Buttons row */}
        <div className="flex items-center gap-1 px-4 pb-2">
          <input
            ref={fileInputRef}
            id="file-upload"
            className="hidden"
            accept="image/jpeg,.jpg,.jpeg,image/png,.png,image/webp,.webp"
            multiple
            tabIndex={-1}
            type="file"
            onChange={handleFileSelect}
          />

          {/* Attach image button */}
          {modelSupportsImages(model) && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center justify-center size-6 rounded-full text-muted hover:text-foreground transition-colors"
              title="Attach image"
              aria-label="Attach image"
            >
              <ImagePlus size={16} />
            </button>
          )}

          {/* Simulator screenshot button — swift projects only. Grabs the live
              simulator frame and attaches it like an upload. Grayed out when
              the simulator isn't running. */}
          {isSwift && modelSupportsImages(model) && (
            <button
              type="button"
              onClick={handleCaptureSimShot}
              disabled={!simShotAvailable || capturingSimShot}
              className="flex items-center justify-center size-6 rounded-full text-muted hover:text-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-muted"
              title={simShotAvailable ? 'Attach a screenshot of the simulator' : 'Start the simulator to attach a screenshot'}
              aria-label="Attach simulator screenshot"
            >
              {capturingSimShot ? <Loader2 size={16} className="animate-spin" /> : <Smartphone size={16} />}
            </button>
          )}

          {/* Queued message count */}
          {messageQueue.length > 0 && (
            <span className="text-[10px] text-muted bg-soft border border-border rounded-full px-2 py-0.5">
              {messageQueue.length} queued
            </span>
          )}

          <div className="ml-auto flex items-center gap-1">
            <div className="flex items-center gap-1">
              {isAgentWorking && input.trim() ? (
                /* Queue button: shown when agent is working AND user has typed something */
                <button
                  id="chatinput-queue-button"
                  type="submit"
                  className="flex size-6 items-center justify-center rounded-full bg-accent text-accent-foreground transition-colors duration-150 ease-out hover:opacity-80"
                  title="Queue message"
                  aria-label="Queue message"
                >
                  <ListPlus size={16} />
                </button>
              ) : isAgentWorking ? (
                /* Stop button: shown when agent is working and no text entered */
                <button
                  id="chatinput-stop-button"
                  type="button"
                  className={cn(
                    'flex size-6 items-center justify-center rounded-full bg-red-600 text-white hover:bg-red-700 transition-colors duration-150 ease-out'
                  )}
                  onClick={() => {
                    // Explicit user stop — auto-continue must not undo it.
                    userStoppedRef.current = true;
                    stop();
                    if (toolAbortRef.current) {
                      toolAbortRef.current.abort();
                    }
                    setIsBusy(false);
                    if (busyDebounceRef.current) {
                      clearTimeout(busyDebounceRef.current);
                      busyDebounceRef.current = null;
                    }
                    setShowCompletionWarning(false);
                    setMessageQueue([]);
                    // Both in-sandbox agents run DETACHED in the sandbox —
                    // aborting the client stream alone leaves them working.
                    // Kill for real via the shared stop route (the bridges'
                    // SIGTERM handlers stop their subprocesses cleanly:
                    // Claude Code interrupts claude, OpenCode aborts the
                    // session and nukes its server process group).
                    if (agentBackendRef.current === 'claude-code' || agentBackendRef.current === 'opencode') {
                      fetch('/api/agent/claude-code/stop', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ projectId }),
                      }).catch(() => {});
                    }
                    // Signal workspace to dismiss any pending tool-driven modals
                    // (e.g. OAuthProviderModal from setupOAuthProvider) and tell
                    // the server-side polling loops to terminate early.
                    window.dispatchEvent(new CustomEvent('agent-user-stopped'));
                  }}
                  title="Stop"
                  aria-label="Stop"
                >
                  <IconX size={18} />
                </button>
              ) : (
                <button
                  id="chatinput-send-message-button"
                  type="submit"
                  className={cn(
                    'flex size-6 items-center justify-center rounded-full bg-accent text-accent-foreground transition-opacity duration-150 ease-out',
                    !input.trim() && pendingImages.length === 0 ? 'disabled:cursor-not-allowed disabled:opacity-50 opacity-50' : ''
                  )}
                  disabled={!input.trim() && pendingImages.length === 0}
                  title="Send"
                  aria-label="Send"
                >
                  <ArrowUp size={20} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Inset bottom — Token counter. Shows real Claude Code usage when
            available; falls back to our char/4 estimate for Botflow. */}
        {(displayedTokens > 0 || isCompacting) && (
          <div
            className="flex items-center gap-2 px-4 py-2 border-t border-border cursor-help"
            title="Context window used vs. total — how much of the model's memory this conversation is using. Older messages are auto-summarized as it fills up."
          >
            <div className="flex-1 h-1 rounded-full bg-soft overflow-hidden">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-300',
                  isCompacting ? 'bg-accent animate-pulse' : tokenBarColor,
                )}
                style={{ width: `${Math.min(tokenRatio * 100, 100)}%` }}
              />
            </div>
            <span className={cn(
              'text-[10px] tabular-nums',
              isCompacting ? 'text-accent' :
              tokenRatio >= 0.9 ? 'text-red-400' : tokenRatio >= 0.7 ? 'text-yellow-400' : 'text-muted'
            )}>
              {isCompacting
                ? 'Compacting…'
                : `${formatTokenCount(displayedTokens)} / ${formatTokenCount(maxTokens)}`}
            </span>
          </div>
        )}
      </form>

      {/* Portals render to document.body — skip during SSR. */}
      {typeof document !== 'undefined' && createPortal(
        <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} workspaceContext />,
        document.body
      )}

      {typeof document !== 'undefined' && lightboxSrc && createPortal(
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />,
        document.body
      )}

      {typeof document !== 'undefined' && limitPayload && createPortal(
        <LimitModal payload={limitPayload} onClose={() => setLimitPayload(null)} />,
        document.body
      )}

    </div>
  );
}
