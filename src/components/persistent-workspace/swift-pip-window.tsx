"use client";

// Adaptive wrapper for the Swift simulator preview. Always rendered at the
// SAME React tree position regardless of mode — that's what lets the
// simulator child component (and its WebSocket session) survive tab toggles
// without unmounting.
//
// Modes:
//  - "full" : fills its parent (the Preview tab slot). Pass-through wrapper.
//  - "pip"  : draggable, resizable, position:fixed overlay. Rect persisted
//             per project to localStorage.
//
// Drag/resize use pointer events directly — small enough not to need a
// library (react-rnd, react-draggable) which would add ~30kb for a fairly
// trivial state machine.

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface PipRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SwiftPipWindowProps {
  projectId: string;
  /** "full" = fill parent (Preview tab); "pip" = draggable PIP overlay. */
  mode: "full" | "pip";
  children: React.ReactNode;
}

// iPhone 17 Pro aspect ratio: 1206 × 2622 ≈ 1 : 2.174. We pick 280 × 575
// (close to that aspect) as the default size — wide enough to read,
// narrow enough to leave room for the editor.
const DEFAULT_W = 280;
const DEFAULT_H = 575;
const MIN_W = 200;
const MIN_H = 400;
const MAX_W = 600;
const MAX_H = 1100;
// Margin from the viewport edges for the default position and clamp logic.
const EDGE_MARGIN = 16;

const rectKey = (projectId: string): string =>
  `swift-preview:pip-rect:${projectId}`;

function loadInitialRect(projectId: string): PipRect {
  if (typeof window === "undefined") {
    return { x: 0, y: 0, w: DEFAULT_W, h: DEFAULT_H };
  }
  try {
    const raw = window.localStorage.getItem(rectKey(projectId));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PipRect>;
      if (
        typeof parsed.x === "number" &&
        typeof parsed.y === "number" &&
        typeof parsed.w === "number" &&
        typeof parsed.h === "number"
      ) {
        return clampToViewport({
          x: parsed.x,
          y: parsed.y,
          w: parsed.w,
          h: parsed.h,
        });
      }
    }
  } catch {
    /* fall through */
  }
  // Default: bottom-right.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    x: Math.max(EDGE_MARGIN, vw - DEFAULT_W - EDGE_MARGIN),
    y: Math.max(EDGE_MARGIN, vh - DEFAULT_H - EDGE_MARGIN),
    w: DEFAULT_W,
    h: DEFAULT_H,
  };
}

function clampToViewport(rect: PipRect): PipRect {
  if (typeof window === "undefined") return rect;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.max(MIN_W, Math.min(MAX_W, Math.min(rect.w, vw - 2 * EDGE_MARGIN)));
  const h = Math.max(MIN_H, Math.min(MAX_H, Math.min(rect.h, vh - 2 * EDGE_MARGIN)));
  const x = Math.max(EDGE_MARGIN, Math.min(vw - w - EDGE_MARGIN, rect.x));
  const y = Math.max(EDGE_MARGIN, Math.min(vh - h - EDGE_MARGIN, rect.y));
  return { x, y, w, h };
}

export function SwiftPipWindow({ projectId, mode, children }: SwiftPipWindowProps) {
  // SSR-safe initial state — bail to a placeholder rect and load real value
  // in an effect (loadInitialRect reads window.innerWidth).
  const [rect, setRect] = useState<PipRect>({ x: 0, y: 0, w: DEFAULT_W, h: DEFAULT_H });
  const [mounted, setMounted] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; startRect: PipRect } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; startRect: PipRect } | null>(null);

  // Load persisted rect on mount.
  useEffect(() => {
    setRect(loadInitialRect(projectId));
    setMounted(true);
  }, [projectId]);

  // Persist on rect change (after mount, to avoid clobbering with placeholder).
  useEffect(() => {
    if (!mounted) return;
    try {
      window.localStorage.setItem(rectKey(projectId), JSON.stringify(rect));
    } catch {
      /* quota / blocked — fine */
    }
  }, [rect, projectId, mounted]);

  // Re-clamp on viewport resize.
  useEffect(() => {
    const onResize = (): void => setRect((r) => clampToViewport(r));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onHeaderPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Don't initiate drag when clicking a button inside the header.
      if ((e.target as HTMLElement).closest("button")) return;
      e.preventDefault();
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startRect: rect,
      };
    },
    [rect],
  );

  const onHeaderPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    setRect(
      clampToViewport({
        x: d.startRect.x + dx,
        y: d.startRect.y + dy,
        w: d.startRect.w,
        h: d.startRect.h,
      }),
    );
  }, []);

  const onHeaderPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      resizeRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startRect: rect,
      };
    },
    [rect],
  );

  const onResizePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const r = resizeRef.current;
    if (!r) return;
    const dw = e.clientX - r.startX;
    const dh = e.clientY - r.startY;
    setRect(
      clampToViewport({
        x: r.startRect.x,
        y: r.startRect.y,
        w: r.startRect.w + dw,
        h: r.startRect.h + dh,
      }),
    );
  }, []);

  const onResizePointerUp = useCallback(() => {
    resizeRef.current = null;
  }, []);

  // CRITICAL: this function MUST return one structurally-identical JSX tree
  // regardless of mode. React reconciles by position; if we early-return a
  // different tree per mode, the simulator child remounts on every toggle —
  // which throws away the WS session and forces a 30s rebuild. So:
  //   • outer <div> is always the same element type;
  //   • className/style switch by mode;
  //   • the children slot stays at the SAME index in the JSX tree (1) across
  //     modes — the drag/resize siblings collapse to `false` in full mode
  //     but the positional indices don't shift.
  const isPip = mode === "pip";
  return (
    <div
      className={cn(
        "flex flex-col",
        isPip
          ? "fixed z-50 overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
          // Full mode owns NO padding — the inner SwiftSimulatorPreview supplies
          // the `pb-2.5 pr-2.5` gap so it isn't double-applied (this wrapper puts
          // children in a flow `flex-1` div, which respects padding).
          : "absolute inset-0 z-10",
      )}
      style={
        isPip
          ? {
              left: rect.x,
              top: rect.y,
              width: rect.w,
              height: rect.h,
            }
          : undefined
      }
    >
      {/* Drag handle — present only in PIP mode, but the slot is always at
          index 0 (collapses to `false` for full). Sits ABOVE the simulator's
          own header so we don't intercept its buttons. */}
      {isPip ? (
        <div
          onPointerDown={onHeaderPointerDown}
          onPointerMove={onHeaderPointerMove}
          onPointerUp={onHeaderPointerUp}
          onPointerCancel={onHeaderPointerUp}
          className="flex h-3 flex-shrink-0 cursor-move items-center justify-center bg-elevated/80 hover:bg-elevated"
          title="Drag to move"
        >
          <span className="h-0.5 w-8 rounded-full bg-border" />
        </div>
      ) : (
        false
      )}

      {/* Simulator child — ALWAYS at index 1. Same component instance survives
          mode flips because its tree position is stable. */}
      <div className="relative min-h-0 flex-1">{children}</div>

      {/* Resize handle — also slot-stable (index 2). */}
      {isPip ? (
        <div
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
          className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize"
          title="Drag to resize"
          style={{
            backgroundImage:
              "linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.25) 50%, rgba(255,255,255,0.25) 60%, transparent 60%, transparent 70%, rgba(255,255,255,0.25) 70%, rgba(255,255,255,0.25) 80%, transparent 80%)",
          }}
        />
      ) : (
        false
      )}
    </div>
  );
}
