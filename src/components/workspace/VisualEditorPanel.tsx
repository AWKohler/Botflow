"use client";

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { twMerge } from "tailwind-merge";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Select, TextInput } from "@/components/ui/field";
import { popoverClass } from "@/components/ui/menu";
import { Tabs } from "@/components/ui/tabs";
import type { BfSelection, BfBox } from "@/components/workspace/preview";

interface VisualEditorPanelProps {
  projectId: string;
  selection: BfSelection;
  box: BfBox | null;
  /** Apply a className optimistically in the iframe (instant, pre-commit). */
  onPreview: (className: string) => void;
  /** Persist succeeded — caller should re-select to refresh geometry. */
  onCommitted?: (loc: string) => void;
  onClose: () => void;
}

const BG_SWATCHES: { token: string; hex: string }[] = [
  { token: "bg-white", hex: "#ffffff" },
  { token: "bg-black", hex: "#000000" },
  { token: "bg-slate-500", hex: "#64748b" },
  { token: "bg-gray-200", hex: "#e5e7eb" },
  { token: "bg-red-500", hex: "#ef4444" },
  { token: "bg-orange-500", hex: "#f97316" },
  { token: "bg-amber-400", hex: "#fbbf24" },
  { token: "bg-yellow-300", hex: "#fde047" },
  { token: "bg-green-500", hex: "#22c55e" },
  { token: "bg-teal-500", hex: "#14b8a6" },
  { token: "bg-blue-500", hex: "#3b82f6" },
  { token: "bg-indigo-500", hex: "#6366f1" },
  { token: "bg-violet-500", hex: "#8b5cf6" },
  { token: "bg-pink-500", hex: "#ec4899" },
  { token: "bg-transparent", hex: "transparent" },
];

const TEXT_SWATCHES: { token: string; hex: string }[] = [
  { token: "text-white", hex: "#ffffff" },
  { token: "text-black", hex: "#000000" },
  { token: "text-slate-500", hex: "#64748b" },
  { token: "text-gray-600", hex: "#4b5563" },
  { token: "text-red-600", hex: "#dc2626" },
  { token: "text-orange-600", hex: "#ea580c" },
  { token: "text-amber-600", hex: "#d97706" },
  { token: "text-green-600", hex: "#16a34a" },
  { token: "text-teal-600", hex: "#0d9488" },
  { token: "text-blue-600", hex: "#2563eb" },
  { token: "text-indigo-600", hex: "#4f46e5" },
  { token: "text-violet-600", hex: "#7c3aed" },
  { token: "text-pink-600", hex: "#db2777" },
];

const FONT_SIZES = ["text-xs", "text-sm", "text-base", "text-lg", "text-xl", "text-2xl", "text-3xl", "text-4xl"];
const WEIGHTS = ["font-light", "font-normal", "font-medium", "font-semibold", "font-bold"];
const ALIGN = ["text-left", "text-center", "text-right"];
const PADDING = ["p-0", "p-1", "p-2", "p-3", "p-4", "p-6", "p-8", "p-12"];
const RADIUS = ["rounded-none", "rounded", "rounded-md", "rounded-lg", "rounded-xl", "rounded-2xl", "rounded-full"];

// Gradient utilities that a solid background should replace (they set
// background-image / color-stops, which tailwind-merge won't drop for a bg-color).
const GRADIENT_RE = /^(bg-gradient-to-|bg-linear-|bg-radial|bg-conic|from-|via-|to-)/;

const PANEL_WIDTH = 288;
const VIEWPORT_MARGIN = 8; // keep this gap from any viewport edge
const ELEMENT_GAP = 12; // gap between the selected element and the panel

interface PanelPos {
  left: number;
  top: number;
  maxHeight: number;
}

/**
 * Place the panel like a native context menu: prefer the right of the selected
 * element, flip to the left when there isn't room, and shift/clamp vertically
 * so the whole panel stays on screen. Falls back to a scrollable panel only
 * when it's taller than the viewport. Pure — caller passes measured size.
 */
function placePanel(
  box: BfBox | null,
  pw: number,
  ph: number,
  vw: number,
  vh: number,
): PanelPos {
  const maxHeight = vh - VIEWPORT_MARGIN * 2;
  const effPh = Math.min(ph || 0, maxHeight);

  // Horizontal: right of the element → left of it → clamp into the viewport.
  let left = box ? box.left + box.width + ELEMENT_GAP : vw - pw - 16;
  if (box && left + pw > vw - VIEWPORT_MARGIN) {
    const leftSide = box.left - pw - ELEMENT_GAP;
    left = leftSide >= VIEWPORT_MARGIN ? leftSide : vw - pw - VIEWPORT_MARGIN;
  }
  left = Math.min(Math.max(left, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, vw - pw - VIEWPORT_MARGIN));

  // Vertical: align near the element's top, then shift up to fit, then clamp.
  let top = box ? box.top : 16;
  if (top + effPh > vh - VIEWPORT_MARGIN) top = vh - effPh - VIEWPORT_MARGIN;
  if (top < VIEWPORT_MARGIN) top = VIEWPORT_MARGIN;

  return { left, top, maxHeight };
}

function initialPanelPos(box: BfBox | null): PanelPos {
  if (typeof window === "undefined") return { left: 16, top: 16, maxHeight: 9999 };
  // Estimate before measuring; the layout effect refines this before paint.
  return placePanel(box, PANEL_WIDTH, 0, window.innerWidth, window.innerHeight);
}

export function VisualEditorPanel({
  projectId,
  selection,
  box,
  onPreview,
  onCommitted,
  onClose,
}: VisualEditorPanelProps) {
  const [classes, setClasses] = useState<string[]>([]);
  const [addInput, setAddInput] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest not-yet-committed className, so we can flush on unmount.
  const pendingRef = useRef<string | null>(null);

  const editable = !!selection.loc;

  // Resync class list when a *different* element is selected (not on every
  // re-select of the same element, so in-progress edits aren't clobbered).
  useEffect(() => {
    setClasses(selection.className.split(/\s+/).filter(Boolean));
    setStatus("idle");
    setErrorMsg(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.loc]);

  const commit = useCallback(
    (className: string) => {
      if (!selection.loc) return;
      setStatus("saving");
      setErrorMsg(null);
      fetch(`/api/projects/${projectId}/visual-edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loc: selection.loc, op: "className", className }),
        keepalive: true,
      })
        .then(async (r) => {
          if (!r.ok) {
            const j = (await r.json().catch(() => ({}))) as { error?: string };
            throw new Error(j.error || r.statusText);
          }
          if (pendingRef.current === className) pendingRef.current = null;
          setStatus("saved");
          if (selection.loc) onCommitted?.(selection.loc);
        })
        .catch((e: unknown) => {
          setStatus("error");
          setErrorMsg(e instanceof Error ? e.message : "Save failed");
        });
    },
    [projectId, selection.loc, onCommitted],
  );

  // Flush a pending debounced commit if the panel unmounts mid-edit.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => {
    return () => {
      if (commitTimer.current) clearTimeout(commitTimer.current);
      if (pendingRef.current != null) commitRef.current(pendingRef.current);
    };
  }, []);

  const applyClassName = useCallback(
    (next: string) => {
      const arr = next.split(/\s+/).filter(Boolean);
      setClasses(arr);
      const cn = arr.join(" ");
      pendingRef.current = cn;
      onPreview(cn);
      if (commitTimer.current) clearTimeout(commitTimer.current);
      commitTimer.current = setTimeout(() => commit(cn), 350);
    },
    [onPreview, commit],
  );

  // Apply a single utility token, resolving Tailwind conflicts (drops prior
  // bg-*, text size, padding, etc.) via tailwind-merge.
  const applyToken = useCallback(
    (token: string) => applyClassName(twMerge([...classes, token].join(" "))),
    [applyClassName, classes],
  );

  // Background color is special: tailwind-merge treats `bg-gradient-to-r` /
  // `from-*` / `to-*` (background-image) as a different group than a solid
  // `bg-*` color, so a gradient would visually win. Strip gradient utilities
  // when applying a solid background.
  const applyBackground = useCallback(
    (token: string) => {
      const kept = classes.filter((c) => !GRADIENT_RE.test(c));
      applyClassName(twMerge([...kept, token].join(" ")));
    },
    [applyClassName, classes],
  );

  const removeClass = useCallback(
    (cls: string) => applyClassName(classes.filter((c) => c !== cls).join(" ")),
    [applyClassName, classes],
  );

  const commitAddInput = useCallback(() => {
    const toAdd = addInput.split(/\s+/).filter(Boolean);
    if (toAdd.length) applyClassName(twMerge([...classes, ...toAdd].join(" ")));
    setAddInput("");
  }, [addInput, applyClassName, classes]);

  const current = useCallback(
    (group: string[]) => classes.find((c) => group.includes(c)) || "",
    [classes],
  );

  // Position the panel so it never leaves the viewport (measured, native-menu
  // style). `box` updates as the element moves (scroll-follow); a ResizeObserver
  // catches content-height changes (e.g. the class list growing).
  const panelRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef(box);
  boxRef.current = box;
  const [pos, setPos] = useState<PanelPos>(() => initialPanelPos(box));

  const reposition = useCallback(() => {
    const el = panelRef.current;
    if (!el || typeof window === "undefined") return;
    const next = placePanel(
      boxRef.current,
      el.offsetWidth || PANEL_WIDTH,
      el.offsetHeight,
      window.innerWidth,
      window.innerHeight,
    );
    setPos((prev) =>
      prev.left === next.left && prev.top === next.top && prev.maxHeight === next.maxHeight
        ? prev
        : next,
    );
  }, []);

  // Reposition when the anchor element moves.
  useLayoutEffect(() => {
    reposition();
  }, [box, reposition]);

  // Reposition when the panel's own size changes or the window resizes.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(reposition);
    ro.observe(el);
    window.addEventListener("resize", reposition);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", reposition);
    };
  }, [reposition]);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Edit element"
      className={cn(
        popoverClass,
        "fixed z-[70] flex flex-col overflow-hidden text-sm shadow-xl",
        // Phone: docked across the bottom half of the screen (these win over the
        // measured position below), so the element being edited stays in view above it.
        "max-sm:bottom-2! max-sm:left-2! max-sm:right-2! max-sm:top-auto! max-sm:w-auto! max-sm:max-h-[52dvh]!",
      )}
      style={{ left: pos.left, top: pos.top, width: PANEL_WIDTH, maxHeight: pos.maxHeight }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header: what is selected, where it lives, and whether it is saved. */}
      <div className="flex items-start gap-2 border-b border-border px-3.5 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-[13px] font-semibold text-fg">Edit element</h3>
            <Badge tone="accent" className="font-mono">{selection.tag}</Badge>
            <span className="ml-auto text-[11px] text-muted" aria-live="polite">
              {status === "saving" && "Saving…"}
              {status === "saved" && <span className="text-success">Saved</span>}
              {status === "error" && <span className="text-danger">Not saved</span>}
            </span>
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-muted" title={selection.loc ?? ""}>
            {selection.loc ?? "No source file for this element"}
          </p>
        </div>
        <button
          onClick={onClose}
          className="-mr-1.5 -mt-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-fg dark:hover:bg-soft"
          title="Close"
          aria-label="Close"
        >
          <X size={15} />
        </button>
      </div>

      {!editable ? (
        <div className="p-4 text-[13px] leading-relaxed text-muted">
          This element can&apos;t be edited here: it comes from a library or is generated at run time. Select an
          element near it, or ask the agent to change it.
        </div>
      ) : (
        <div className="modern-scrollbar flex-1 space-y-4 overflow-y-auto p-3.5">
          {errorMsg && (
            <div className="rounded-md border border-danger-border bg-danger-soft px-2.5 py-1.5 text-xs text-danger">
              {errorMsg}
            </div>
          )}

          <Section label="Classes">
            <div className="flex flex-wrap gap-1.5">
              {classes.length === 0 && <span className="text-xs text-muted">No classes yet</span>}
              {classes.map((c) => (
                <span
                  key={c}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface py-0.5 pl-1.5 pr-1 font-mono text-[11px] text-fg dark:bg-soft"
                >
                  {c}
                  <button
                    onClick={() => removeClass(c)}
                    className="rounded text-subtle transition-colors hover:text-danger"
                    title={`Remove ${c}`}
                    aria-label={`Remove ${c}`}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
            <TextInput
              value={addInput}
              onChange={(e) => setAddInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  commitAddInput();
                }
              }}
              onBlur={commitAddInput}
              placeholder="Add a class"
              aria-label="Add a class"
              className="mt-2 h-8 font-mono text-xs"
            />
          </Section>

          <Section label="Background">
            <Swatches swatches={BG_SWATCHES} active={current(BG_SWATCHES.map((s) => s.token))} onPick={applyBackground} />
          </Section>

          <Section label="Text colour">
            <Swatches swatches={TEXT_SWATCHES} active={current(TEXT_SWATCHES.map((s) => s.token))} onPick={applyToken} />
          </Section>

          <div className="grid grid-cols-2 gap-3">
            <Section label="Font size">
              <TokenSelect group={FONT_SIZES} value={current(FONT_SIZES)} onChange={applyToken} label="Font size" />
            </Section>
            <Section label="Weight">
              <TokenSelect group={WEIGHTS} value={current(WEIGHTS)} onChange={applyToken} label="Weight" />
            </Section>
          </div>

          <Section label="Alignment">
            <Tabs
              size="sm"
              stretch
              options={ALIGN.map((a) => ({ value: a, text: a.replace("text-", "").replace(/^./, (ch) => ch.toUpperCase()) }))}
              selected={current(ALIGN)}
              onSelect={applyToken}
            />
          </Section>

          <div className="grid grid-cols-2 gap-3">
            <Section label="Padding">
              <TokenSelect group={PADDING} value={current(PADDING)} onChange={applyToken} label="Padding" />
            </Section>
            <Section label="Corner radius">
              <TokenSelect group={RADIUS} value={current(RADIUS)} onChange={applyToken} label="Corner radius" />
            </Section>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-medium text-muted">{label}</div>
      {children}
    </div>
  );
}

function Swatches({
  swatches,
  active,
  onPick,
}: {
  swatches: { token: string; hex: string }[];
  active: string;
  onPick: (token: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {swatches.map((s) => (
        <button
          key={s.token}
          title={s.token}
          aria-label={s.token}
          aria-pressed={active === s.token}
          onClick={() => onPick(s.token)}
          className={cn(
            // A hairline inside the swatch keeps pale colours visible on a pale panel.
            "h-6 w-6 rounded-md shadow-[inset_0_0_0_1px_rgb(0_0_0/0.12)] transition-shadow dark:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.14)]",
            active === s.token && "ring-2 ring-accent ring-offset-2 ring-offset-bg dark:ring-offset-elevated",
          )}
          style={{
            backgroundColor: s.hex === "transparent" ? undefined : s.hex,
            backgroundImage:
              s.hex === "transparent"
                ? "linear-gradient(45deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%),linear-gradient(45deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%)"
                : undefined,
            backgroundSize: s.hex === "transparent" ? "8px 8px" : undefined,
            backgroundPosition: s.hex === "transparent" ? "0 0,4px 4px" : undefined,
          }}
        />
      ))}
    </div>
  );
}

function TokenSelect({
  group,
  value,
  onChange,
  label,
}: {
  group: string[];
  value: string;
  onChange: (token: string) => void;
  label: string;
}) {
  return (
    <Select
      aria-label={label}
      value={value}
      onChange={(e) => e.target.value && onChange(e.target.value)}
      className="h-8 pl-2 font-mono text-xs"
    >
      <option value="">—</option>
      {group.map((g) => (
        <option key={g} value={g}>
          {g}
        </option>
      ))}
    </Select>
  );
}
