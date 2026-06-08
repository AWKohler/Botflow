"use client";

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { twMerge } from "tailwind-merge";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
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
      className="fixed z-[70] flex flex-col rounded-xl border border-border bg-elevated shadow-2xl text-sm overflow-hidden"
      style={{ left: pos.left, top: pos.top, width: PANEL_WIDTH, maxHeight: pos.maxHeight }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface/60">
        <span className="px-1.5 py-0.5 rounded bg-accent/15 text-accent text-xs font-semibold">
          {selection.tag}
        </span>
        <span className="flex-1 truncate text-xs text-muted" title={selection.loc ?? ""}>
          {selection.loc ?? "no source mapping"}
        </span>
        <span className="text-[11px] text-muted min-w-[42px] text-right">
          {status === "saving" && "Saving…"}
          {status === "saved" && "Saved"}
          {status === "error" && <span className="text-red-500">Error</span>}
        </span>
        <button onClick={onClose} className="text-muted hover:text-fg" title="Close">
          <X size={15} />
        </button>
      </div>

      {!editable ? (
        <div className="p-4 text-xs text-muted">
          This element has no source mapping (it may come from a library or a
          dynamic component). Try selecting a nearby element, or use the agent.
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto modern-scrollbar p-3 space-y-4">
          {errorMsg && (
            <div className="text-[11px] text-red-500 bg-red-500/10 rounded px-2 py-1">
              {errorMsg}
            </div>
          )}

          {/* Tailwind classes */}
          <Section label="Tailwind classes">
            <div className="flex flex-wrap gap-1.5">
              {classes.length === 0 && (
                <span className="text-xs text-muted">No classes</span>
              )}
              {classes.map((c) => (
                <span
                  key={c}
                  className="group inline-flex items-center gap-1 rounded bg-soft px-1.5 py-0.5 text-xs text-fg border border-border"
                >
                  {c}
                  <button
                    onClick={() => removeClass(c)}
                    className="text-muted hover:text-red-500"
                    title="Remove"
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
            <input
              value={addInput}
              onChange={(e) => setAddInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  commitAddInput();
                }
              }}
              onBlur={commitAddInput}
              placeholder="Add classes…"
              className="mt-2 w-full bg-surface rounded px-2 py-1 text-xs text-fg outline-none border border-border focus:border-accent"
            />
          </Section>

          {/* Background */}
          <Section label="Background">
            <Swatches swatches={BG_SWATCHES} active={current(BG_SWATCHES.map((s) => s.token))} onPick={applyBackground} />
          </Section>

          {/* Text color */}
          <Section label="Text color">
            <Swatches swatches={TEXT_SWATCHES} active={current(TEXT_SWATCHES.map((s) => s.token))} onPick={applyToken} />
          </Section>

          {/* Font size + weight */}
          <div className="grid grid-cols-2 gap-3">
            <Section label="Font size">
              <Select group={FONT_SIZES} value={current(FONT_SIZES)} onChange={applyToken} />
            </Section>
            <Section label="Weight">
              <Select group={WEIGHTS} value={current(WEIGHTS)} onChange={applyToken} />
            </Section>
          </div>

          {/* Align */}
          <Section label="Text align">
            <div className="flex gap-1">
              {ALIGN.map((a) => (
                <button
                  key={a}
                  onClick={() => applyToken(a)}
                  className={cn(
                    "flex-1 rounded border px-2 py-1 text-xs capitalize",
                    current(ALIGN) === a
                      ? "border-accent text-accent bg-accent/10"
                      : "border-border text-muted hover:text-fg",
                  )}
                >
                  {a.replace("text-", "")}
                </button>
              ))}
            </div>
          </Section>

          {/* Padding + radius */}
          <div className="grid grid-cols-2 gap-3">
            <Section label="Padding">
              <Select group={PADDING} value={current(PADDING)} onChange={applyToken} />
            </Section>
            <Section label="Radius">
              <Select group={RADIUS} value={current(RADIUS)} onChange={applyToken} />
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
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted mb-1.5">
        {label}
      </div>
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
          onClick={() => onPick(s.token)}
          className={cn(
            "h-6 w-6 rounded border",
            active === s.token ? "ring-2 ring-accent border-accent" : "border-border",
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

function Select({
  group,
  value,
  onChange,
}: {
  group: string[];
  value: string;
  onChange: (token: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => e.target.value && onChange(e.target.value)}
      className="w-full bg-surface rounded px-2 py-1 text-xs text-fg outline-none border border-border focus:border-accent"
    >
      <option value="">—</option>
      {group.map((g) => (
        <option key={g} value={g}>
          {g}
        </option>
      ))}
    </select>
  );
}
