"use client";

/**
 * Agent backend UI elements.
 *
 * Two pieces:
 *  - <BackendBadge> — small always-visible pill at the top of AgentPanel.
 *      Shows the active backend's glyph + name. Pure visual, no interaction.
 *  - <BackendChip> — inline info chip rendered below the header. Always
 *      informational (no toggle). Clicking opens a popover explaining WHY
 *      the user is on the current agent for the current model. Hidden when
 *      there's nothing meaningful to surface (free user on a non-Anthropic
 *      model — the top badge says it all).
 *
 * The agent is fully derived from (model, platform, creds, preference); the
 * user can't toggle backends here. BYOK users override their default via
 * Settings → Connections.
 *
 * Both share brand glyphs from /brand/ + /model-icons/ so the agent identity
 * stays consistent across the panel.
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { AgentBackend } from "@/lib/agent/backend-resolution";
import { describeDerivation, type DerivationReason } from "@/lib/agent/derive-backend";

interface GlyphProps {
  size?: number;
  className?: string;
}

function BotflowGlyph({ size = 14, className }: GlyphProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/brand/botflow-glyph.svg"
      alt=""
      width={size}
      height={size}
      className={cn("shrink-0", className)}
    />
  );
}

function AnthropicGlyph({ size = 14, className }: GlyphProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/model-icons/anthropic.png"
      alt=""
      width={size}
      height={size}
      className={cn("shrink-0 rounded-sm", className)}
    />
  );
}

export function BackendGlyph({ backend, size = 14, className }: { backend: AgentBackend; size?: number; className?: string }) {
  return backend === "claude-code"
    ? <AnthropicGlyph size={size} className={className} />
    : <BotflowGlyph size={size} className={className} />;
}

function backendLabel(backend: AgentBackend): string {
  return backend === "claude-code" ? "Claude Code" : "Botflow";
}

/* ─────────────────────────────────────────────────────────────────────────
 * Glyph + hover tooltip — meant to be fused INTO the model-selector pill so
 * the agent identity and the model read as a single body. The glyph carries no
 * border/background of its own (the pill provides those). Hovering reveals a
 * tooltip describing the backend powering the experience.
 * ────────────────────────────────────────────────────────────────────── */

const BACKEND_DETAIL: Record<AgentBackend, string> = {
  "claude-code":
    "Anthropic's agentic coding harness, running the model directly inside your project sandbox.",
  botflow:
    "Botflow's native agent — the harness powering every model outside of Claude Code.",
};

export function BackendGlyphInfo({ backend }: { backend: AgentBackend }) {
  return (
    <span className="group/glyph relative inline-flex items-center">
      <BackendGlyph backend={backend} size={14} />
      {/* Tooltip — anchored to the glyph, drops just below the pill.
          pointer-events-none so it never swallows the pill's click. */}
      <span
        role="tooltip"
        className="pointer-events-none absolute left-0 top-full z-50 mt-2 hidden w-60 rounded-lg border border-border bg-surface p-2.5 text-left shadow-xl group-hover/glyph:block"
      >
        <span className="flex items-center gap-1.5">
          <BackendGlyph backend={backend} size={13} />
          <span className="text-xs font-medium text-fg leading-none">{backendLabel(backend)}</span>
        </span>
        <span className="mt-1.5 block text-[11px] leading-snug text-muted">
          {BACKEND_DETAIL[backend]}
        </span>
      </span>
    </span>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Top-of-panel badge
 * ────────────────────────────────────────────────────────────────────── */

export function BackendBadge({ backend }: { backend: AgentBackend }) {
  return (
    <div
      className="inline-flex items-center gap-1.5 rounded-full bg-elevated border border-border px-2 py-0.5 text-[11px] text-muted"
      title={`Agent: ${backendLabel(backend)}`}
    >
      <BackendGlyph backend={backend} size={12} />
      <span className="font-medium text-fg leading-none">{backendLabel(backend)}</span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Inline info chip
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Reasons that warrant the inline chip. Other reasons (non-Anthropic models,
 * platform-key fallback for paid tier) are "boring" — the top badge already
 * communicates "you're on Botflow" and the user doesn't need a popover for it.
 *
 * The chip surfaces specifically when:
 *  - The user is on a path that's worth explaining (OAuth → Claude Code)
 *  - The user has a choice they might want to learn about (BYOK)
 *  - The model can't actually run on this project (an error state worth showing)
 */
const CHIP_VISIBLE_REASONS: ReadonlySet<DerivationReason> = new Set<DerivationReason>([
  "oauth_claude_code",
  "byok_botflow",
  "byok_preference_claude_code",
  "oauth_no_path",
  "no_credentials",
]);

export interface BackendChipProps {
  backend: AgentBackend;
  reason: DerivationReason;
  /** When false, the chip shows an error-flavored style — the user picked a
   *  model that can't actually run on this project. */
  runnable: boolean;
}

export function BackendChip({ backend, reason, runnable }: BackendChipProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!popoverOpen) return;
    function handleClickAway(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) {
        setPopoverOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickAway);
    return () => document.removeEventListener("mousedown", handleClickAway);
  }, [popoverOpen]);

  if (!CHIP_VISIBLE_REASONS.has(reason)) return null;

  const copy = describeDerivation(reason);
  const errorStyle = !runnable;

  return (
    <div ref={wrapperRef} className="relative inline-flex items-center">
      <button
        type="button"
        onClick={() => setPopoverOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium transition",
          errorStyle
            ? "bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/15"
            : "bg-accent/10 border-accent/30 text-fg hover:bg-accent/15",
        )}
      >
        <BackendGlyph backend={backend} size={12} />
        <span className="leading-none">{copy.title}</span>
        <span className={cn("text-[10px] leading-none", errorStyle ? "text-red-400/70" : "text-muted")}>·</span>
        <span
          className={cn(
            "text-[11px] leading-none underline-offset-2 hover:underline",
            errorStyle ? "text-red-400" : "text-accent",
          )}
        >
          What this means?
        </span>
      </button>
      {popoverOpen && (
        <Popover title={copy.title} body={copy.body} onClose={() => setPopoverOpen(false)} />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Popover (positioned below the trigger, follows existing patterns)
 * ────────────────────────────────────────────────────────────────────── */

function Popover({ title, body, onClose }: { title: string; body: string; onClose: () => void }) {
  return (
    <div className="absolute left-0 top-full mt-1 z-50 w-80 rounded-xl border border-border bg-surface shadow-lg p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="font-semibold text-fg">{title}</div>
        <button
          type="button"
          onClick={onClose}
          className="text-muted hover:text-fg text-xs"
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      <p className="mt-2 text-[12px] leading-snug text-muted whitespace-pre-wrap">{body}</p>
    </div>
  );
}
