"use client";

import { BookOpen, Laptop, Smartphone } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

// iPhone Duo (beta): a book-style foldable with two integrated panels.
//   Inner panel: 951×669 pt, landscape, folds down the middle.
//   Cover panel: 466×678 pt, on the outside of the half that swings.
// Geometry is in points; the stage scales it to fit.
const HALF_W = 951 / 2;
const SCREEN_H = 669;
const BEZEL = 12;
const PANEL_W = HALF_W + BEZEL;
const PANEL_H = SCREEN_H + BEZEL * 2;
const COVER_W = 466;
const COVER_H = 678;
const CORNER = 44;

export type DuoPanel = "inner" | "cover";
export type DuoSurface = "inner-left" | "inner-right" | "cover";

export interface DuoStageHandle {
  /** Paint the live panel. `source` is already upright: the inner panel's
   *  landscape image, or the cover's portrait image. */
  paint(source: HTMLCanvasElement, panel: DuoPanel): void;
  /** The element pointer/keyboard input is attached to. */
  root(): HTMLDivElement | null;
}

interface DuoStageProps {
  /** Hinge angle the device was last commanded to (0 closed … 180 open flat). */
  hingeAngle: number;
  /** Which panel's stream is live; null until the first frame. */
  panel: DuoPanel | null;
  /** Controls are only usable while the session is streaming. */
  interactive: boolean;
  /** Send a hinge angle to the device. `final` marks the end of a gesture. */
  onHinge: (angle: number, final: boolean) => void;
  overlay?: ReactNode;
  footer?: ReactNode;
  focused?: boolean;
}

/** Map a pointer on one of the stage's surfaces to coordinates normalized to the
 *  streamed (raw) framebuffer. The inner panel is streamed sideways (its
 *  framebuffer is portrait, the panel is landscape) and shown rotated 90° CW,
 *  so undo that: display (dx, dy) → raw (dy, 1 − dx). Returns null for clicks
 *  that land on an unlit panel or off the screens. */
export function duoPointerToRaw(
  e: MouseEvent,
  panel: DuoPanel | null,
): { normX: number; normY: number } | null {
  const target = e.target as HTMLElement | null;
  const surface = target?.dataset?.duoSurface as DuoSurface | undefined;
  if (!target || !surface || !panel) return null;
  const w = target.clientWidth;
  const h = target.clientHeight;
  if (!w || !h) return null;
  const lx = Math.max(0, Math.min(1, e.offsetX / w));
  const ly = Math.max(0, Math.min(1, e.offsetY / h));
  if (surface === "cover") return panel === "cover" ? { normX: lx, normY: ly } : null;
  if (panel !== "inner") return null;
  const dx = surface === "inner-left" ? lx / 2 : 0.5 + lx / 2;
  return { normX: ly, normY: 1 - dx };
}

const PRESETS = [
  { angle: 0, label: "Close", Icon: Smartphone },
  { angle: 90, label: "Half open", Icon: Laptop },
  { angle: 180, label: "Open", Icon: BookOpen },
] as const;

export const DuoStage = forwardRef<DuoStageHandle, DuoStageProps>(function DuoStage(
  { hingeAngle, panel, interactive, onHinge, overlay, footer, focused },
  ref,
) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const leftRef = useRef<HTMLCanvasElement | null>(null);
  const rightRef = useRef<HTMLCanvasElement | null>(null);
  const coverRef = useRef<HTMLCanvasElement | null>(null);
  const [scale, setScale] = useState(0.5);
  // Angle shown by the model. Follows the commanded angle, and leads it while a
  // preset animates or the slider is dragged.
  const [visualAngle, setVisualAngle] = useState(hingeAngle);
  const [optionHeld, setOptionHeld] = useState(false);
  const [dragging, setDragging] = useState(false);
  const animRef = useRef<number | null>(null);
  const lastSentRef = useRef(0);

  useEffect(() => {
    if (animRef.current === null && !dragging) setVisualAngle(hingeAngle);
  }, [hingeAngle, dragging]);

  // Fit the open device (the widest pose) into the available space.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const fit = () => {
      const r = box.getBoundingClientRect();
      const s = Math.min((r.width - 48) / (PANEL_W * 2), (r.height - 96) / PANEL_H);
      setScale(Math.max(0.15, Math.min(1, s)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  useImperativeHandle(ref, () => ({
    paint(source, live) {
      if (live === "inner") {
        const half = Math.floor(source.width / 2);
        for (const [canvas, sx] of [[leftRef.current, 0], [rightRef.current, half]] as const) {
          if (!canvas) continue;
          if (canvas.width !== half || canvas.height !== source.height) {
            canvas.width = half;
            canvas.height = source.height;
          }
          canvas.getContext("2d")?.drawImage(source, sx, 0, half, source.height, 0, 0, half, source.height);
        }
      } else {
        const canvas = coverRef.current;
        if (!canvas) return;
        if (canvas.width !== source.width || canvas.height !== source.height) {
          canvas.width = source.width;
          canvas.height = source.height;
        }
        canvas.getContext("2d")?.drawImage(source, 0, 0);
      }
    },
    root: () => rootRef.current,
  }));

  // An unlit panel is black on the real device; clear whichever isn't live so a
  // stale frame never lingers after the fold switches panels.
  useEffect(() => {
    const clear = (c: HTMLCanvasElement | null) => {
      const ctx = c?.getContext("2d");
      if (c && ctx) ctx.clearRect(0, 0, c.width, c.height);
    };
    if (panel !== "inner") { clear(leftRef.current); clear(rightRef.current); }
    if (panel !== "cover") clear(coverRef.current);
  }, [panel]);

  // The hinge slider is a power-user control: it shows while Option is held.
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === "Alt") setOptionHeld(true); };
    const up = (e: KeyboardEvent) => { if (e.key === "Alt") setOptionHeld(false); };
    const blur = () => setOptionHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  const sendThrottled = useCallback((angle: number, final: boolean) => {
    const now = performance.now();
    if (final || now - lastSentRef.current >= 70) {
      lastSentRef.current = now;
      onHinge(Math.round(angle), final);
    }
  }, [onHinge]);

  // Presets sweep through the fold rather than jumping, like a real hinge.
  const animateTo = useCallback((target: number) => {
    if (animRef.current !== null) cancelAnimationFrame(animRef.current);
    const from = visualAngle;
    const duration = 450 + Math.abs(target - from) * 2;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const angle = from + (target - from) * eased;
      setVisualAngle(angle);
      if (t < 1) {
        sendThrottled(angle, false);
        animRef.current = requestAnimationFrame(step);
      } else {
        animRef.current = null;
        sendThrottled(target, true);
      }
    };
    animRef.current = requestAnimationFrame(step);
  }, [visualAngle, sendThrottled]);

  useEffect(() => () => { if (animRef.current !== null) cancelAnimationFrame(animRef.current); }, []);

  // ── Geometry ────────────────────────────────────────────────────────────────
  // The right half faces the viewer; the left half swings about the hinge (its
  // right edge) toward the viewer. Closed (0°) it lies flipped over the right
  // half, presenting its back — the cover screen.
  const fold = 180 - visualAngle;
  const rad = (fold * Math.PI) / 180;
  const leftEdge = -PANEL_W * Math.cos(rad); // projected x of the swinging edge, relative to the hinge
  const spanStart = Math.min(0, leftEdge);
  const centerShift = (spanStart + PANEL_W) / 2; // keep the visible device centered
  const tilt = Math.sin(rad) * 14; // a gentle yaw while partly folded shows depth
  const shade = Math.sin(rad) * 0.35;
  const showSlider = interactive && (optionHeld || dragging);

  return (
    <div ref={boxRef} className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden">
      <div
        ref={rootRef}
        tabIndex={interactive ? 0 : -1}
        className={cn("relative outline-none", interactive ? "cursor-crosshair" : "pointer-events-none")}
        style={{ width: PANEL_W * 2 * scale, height: PANEL_H * scale, perspective: 2400 * scale }}
      >
        <div
          className="absolute left-1/2 top-0"
          style={{
            width: PANEL_W * 2 * scale,
            height: PANEL_H * scale,
            transformStyle: "preserve-3d",
            transform: `translateX(${-PANEL_W * scale - centerShift * scale}px) rotateY(${-tilt}deg)`,
            transition: "transform 60ms linear",
          }}
        >
          {/* Right half — static */}
          <div
            className="absolute bg-[#1d1d20] shadow-[0_30px_60px_-20px_rgba(0,0,0,0.6)]"
            style={{
              left: PANEL_W * scale,
              width: PANEL_W * scale,
              height: PANEL_H * scale,
              borderRadius: `0 ${CORNER * scale}px ${CORNER * scale}px 0`,
              padding: `${BEZEL * scale}px ${BEZEL * scale}px ${BEZEL * scale}px 0`,
            }}
          >
            <canvas
              ref={rightRef}
              data-duo-surface="inner-right"
              className="block h-full w-full bg-black"
              style={{ borderRadius: `0 ${(CORNER - BEZEL) * scale}px ${(CORNER - BEZEL) * scale}px 0` }}
            />
          </div>

          {/* Left half — swings about the hinge */}
          <div
            className="absolute left-0 top-0"
            style={{
              width: PANEL_W * scale,
              height: PANEL_H * scale,
              transformOrigin: "right center",
              transformStyle: "preserve-3d",
              transform: `rotateY(${fold}deg)`,
            }}
          >
            {/* Inner face */}
            <div
              className="absolute inset-0 bg-[#1d1d20]"
              style={{
                backfaceVisibility: "hidden",
                borderRadius: `${CORNER * scale}px 0 0 ${CORNER * scale}px`,
                padding: `${BEZEL * scale}px 0 ${BEZEL * scale}px ${BEZEL * scale}px`,
              }}
            >
              <canvas
                ref={leftRef}
                data-duo-surface="inner-left"
                className="block h-full w-full bg-black"
                style={{ borderRadius: `${(CORNER - BEZEL) * scale}px 0 0 ${(CORNER - BEZEL) * scale}px` }}
              />
              <div
                className="pointer-events-none absolute inset-0"
                style={{ background: `rgba(0,0,0,${shade})`, borderRadius: `${CORNER * scale}px 0 0 ${CORNER * scale}px` }}
              />
            </div>
            {/* Outer face — cover screen. Hinge-side corners are square. */}
            <div
              className="absolute inset-0 flex items-center justify-center bg-[#26262b]"
              style={{
                backfaceVisibility: "hidden",
                transform: "rotateY(180deg)",
                borderRadius: `0 ${CORNER * scale}px ${CORNER * scale}px 0`,
              }}
            >
              <canvas
                ref={coverRef}
                data-duo-surface="cover"
                className="block bg-black"
                style={{
                  width: (PANEL_H - BEZEL * 2) * (COVER_W / COVER_H) * scale,
                  height: (PANEL_H - BEZEL * 2) * scale,
                  borderRadius: `${8 * scale}px ${(CORNER - BEZEL) * scale}px ${(CORNER - BEZEL) * scale}px ${8 * scale}px`,
                }}
              />
            </div>
          </div>

          {/* Hinge spine */}
          <div
            className="pointer-events-none absolute top-0 bg-gradient-to-r from-black/0 via-white/10 to-black/0"
            style={{ left: PANEL_W * scale - 1, width: 2, height: PANEL_H * scale }}
          />
        </div>
        {focused && <div className="pointer-events-none absolute -inset-2 rounded-[28px] ring-2 ring-accent/60" />}
        {overlay && <div className="pointer-events-none absolute inset-0 flex items-center justify-center">{overlay}</div>}
      </div>

      {/* Controls */}
      <div className="mt-5 flex items-center gap-2">
        {PRESETS.map(({ angle, label, Icon }) => (
          <button
            key={angle}
            type="button"
            title={label}
            aria-label={label}
            disabled={!interactive}
            onClick={() => animateTo(angle)}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-muted transition-colors",
              "hover:bg-soft hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
              Math.abs(visualAngle - angle) < 2 && "border-accent/50 text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
        <span className="ml-2 font-mono text-[11px] text-muted">
          {Math.round(visualAngle)}° · {panel === "cover" ? "Cover" : panel === "inner" ? "Inner" : "—"}
        </span>
      </div>
      <div className={cn("mt-2 flex h-7 items-center gap-2 transition-opacity", showSlider ? "opacity-100" : "pointer-events-none opacity-0")}>
        <span className="text-[11px] text-muted">Hinge</span>
        <input
          aria-label="Hinge angle"
          type="range"
          min={0}
          max={180}
          step={1}
          value={Math.round(visualAngle)}
          disabled={!showSlider}
          onPointerDown={() => {
            if (animRef.current !== null) { cancelAnimationFrame(animRef.current); animRef.current = null; }
            setDragging(true);
          }}
          onPointerUp={(e) => {
            setDragging(false);
            sendThrottled(Number((e.target as HTMLInputElement).value), true);
          }}
          onChange={(e) => {
            const angle = Number(e.target.value);
            setVisualAngle(angle);
            sendThrottled(angle, false);
          }}
          className="w-56 accent-[var(--color-accent)]"
        />
      </div>
      {!showSlider && interactive && (
        <div className="mt-1 text-[10px] text-muted">Hold ⌥ Option for the hinge slider</div>
      )}
      {footer && <div className="mt-2">{footer}</div>}
    </div>
  );
});
