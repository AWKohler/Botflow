"use client";

/**
 * Agent backend UI elements.
 *
 *  - <BackendGlyphInfo> — the backend glyph fused into the composer's model
 *      selector, with a hover tooltip naming the agent (Claude Code / OpenCode).
 *  - <BackendChip> — inline info chip rendered below the header. Always
 *      informational (no toggle). Clicking opens a popover explaining WHY
 *      the user is on the current agent for the current model. Hidden when
 *      there's nothing meaningful to surface (plan-credit turns).
 *
 * The agent is fully derived from (model, platform, creds); the user can't
 * toggle backends here.
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { AgentBackend } from "@/lib/agent/backend-resolution";
import { describeDerivation, type DerivationReason } from "@/lib/agent/derive-backend";

interface GlyphProps {
  size?: number;
  className?: string;
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

/** Inline terminal-prompt mark for OpenCode — self-contained SVG (no asset),
 *  drawn in currentColor so it inherits the pill's text color. */
function OpenCodeGlyph({ size = 14, className }: GlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0", className)}
      aria-hidden
    >
      <rect x="1" y="1" width="14" height="14" rx="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.5 5.5 7 8l-2.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.5 10.5h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function BackendGlyph({ backend, size = 14, className }: { backend: AgentBackend; size?: number; className?: string }) {
  if (backend === "claude-code") return <AnthropicGlyph size={size} className={className} />;
  return <OpenCodeGlyph size={size} className={className} />;
}

function backendLabel(backend: AgentBackend): string {
  if (backend === "claude-code") return "Claude Code";
  return "OpenCode";
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
  opencode:
    "The open-source OpenCode agent, running the model directly inside your project sandbox with your own credentials.",
};

export function BackendGlyphInfo({
  backend,
  tooltipPlacement = "below-start",
}: {
  backend: AgentBackend;
  /** Where the tooltip opens relative to the glyph. 'above-end' suits a pill at
   *  the bottom-right of a prompt box, where a downward or rightward tooltip
   *  would run off the panel. */
  tooltipPlacement?: "below-start" | "above-end";
}) {
  return (
    <span className="group/glyph relative inline-flex items-center">
      <BackendGlyph backend={backend} size={14} />
      {/* Tooltip — anchored to the glyph, just outside the pill.
          pointer-events-none so it never swallows the pill's click. */}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute z-50 hidden w-60 rounded-lg border border-border bg-surface p-2.5 text-left font-normal shadow-xl group-hover/glyph:block",
          tooltipPlacement === "above-end" ? "right-0 bottom-full mb-2.5" : "left-0 top-full mt-2",
        )}
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
 * Inline info chip
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Reasons that warrant the inline chip. Plan-credit turns
 * (platform_key_opencode) are "boring" — the glyph in the model selector
 * already says which agent runs, and the user doesn't need a popover for it.
 *
 * The chip surfaces specifically when:
 *  - The user is on a path that's worth explaining (OAuth → Claude Code)
 *  - The user has a choice they might want to learn about (BYOK)
 *  - The model can't actually run on this project (an error state worth showing)
 */
const CHIP_VISIBLE_REASONS: ReadonlySet<DerivationReason> = new Set<DerivationReason>([
  "oauth_claude_code",
  "byok_claude_code",
  "unsupported_platform",
  "no_credentials",
  "codex_oauth_opencode",
  "byok_opencode",
  // Error state: the model exists but this plan can't run it on credits.
  "tier_too_low",
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
    <div ref={wrapperRef} className="relative flex w-full items-center">
      <button
        type="button"
        onClick={() => setPopoverOpen((v) => !v)}
        className={cn(
          "flex w-full flex-wrap items-center justify-center gap-1.5 rounded-full border px-3 py-1.5 text-center text-[11px] font-medium transition",
          errorStyle
            ? "bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/15"
            : "bg-accent/10 border-accent/30 text-fg hover:bg-accent/15",
        )}
      >
        <BackendGlyph backend={backend} size={12} />
        <span className="leading-snug">{copy.chipTitle}</span>
        <span className={cn("text-[10px] leading-snug", errorStyle ? "text-red-400/70" : "text-muted")}>·</span>
        <span
          className={cn(
            "text-[11px] leading-snug underline-offset-2 hover:underline",
            errorStyle ? "text-red-400" : "text-accent",
          )}
        >
          What&apos;s this?
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
