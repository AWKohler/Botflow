"use client";

// The iPhone Duo preview: the device as an object you can turn, fold and use.
// Both of its screens play the simulator's video; touching either one touches
// the app. This component owns the canvas and the controls laid over it; the
// 3D work is in duo-scene.ts.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { BookOpen, House, Laptop, RotateCcw, RotateCw, ScanLine, Smartphone, Tablet } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/components/ui/use-media-query";
import type { SimDuoState, SimInput } from "../swift-stream-client";
import { simInputForKey } from "../sim-key-input";
import { DUO_POSES, hingePostureLabel, type DuoDisplay, type DuoPoseId } from "./duo-geometry";
import type { DuoFinishId } from "./duo-model";
import type { DuoScene, DuoSceneInput } from "./duo-scene";

export interface DuoViewerHandle {
  /** A decoded frame for a panel. The viewer takes it over and closes it. */
  pushFrame: (display: DuoDisplay, frame: VideoFrame) => void;
  /** Forget the pictures (a new session is starting). */
  clearFrames: () => void;
  /** The picture on the panel in use, upright, as a JPEG. */
  capture: (display?: DuoDisplay, quality?: number) => Promise<Blob | null>;
  focus: () => void;
}

interface DuoViewerProps {
  /** The simulator is streaming: touches, keys and the hinge reach it. */
  live: boolean;
  /** The host's latest report of the hinge and panels. Null until it streams. */
  state: SimDuoState | null;
  /** Optional input the session's host honours. */
  features: string[];
  onInput: (input: SimInput) => void;
  /** Small picture-in-picture layout: the device and little else. */
  compact?: boolean;
  /** Shown over the device while it is not live (status, errors, a play button). */
  overlay?: ReactNode;
  /** The overlay brings its own look (a play button): no backdrop behind it. */
  overlayBare?: boolean;
  onKeyboardFocusChange?: (focused: boolean) => void;
  className?: string;
}

const FINISH_KEY = "swift-preview:duo-finish";
const HINT_KEY = "swift-preview:duo-hint-seen";

function loadFinish(): DuoFinishId {
  try {
    return window.localStorage.getItem(FINISH_KEY) === "graphite" ? "graphite" : "natural";
  } catch {
    return "natural";
  }
}

const POSE_ICONS: Record<DuoPoseId, typeof Smartphone> = {
  closed: Smartphone,
  open: Tablet,
  book: BookOpen,
  tabletop: Laptop,
};

/** How often the hinge angle is sent while it is being dragged. */
const HINGE_SEND_MS = 33;

export const DuoViewer = forwardRef<DuoViewerHandle, DuoViewerProps>(function DuoViewer(
  { live, state, features, onInput, compact = false, overlay, overlayBare = false, onKeyboardFocusChange, className },
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<DuoScene | null>(null);
  /** Frames that arrive before the scene has loaded. */
  const earlyFrames = useRef<Partial<Record<DuoDisplay, VideoFrame>>>({});

  const [hinge, setHinge] = useState(180);
  const [pose, setPose] = useState<DuoPoseId | null>("open");
  const [finish, setFinish] = useState<DuoFinishId>("natural");
  const [failed, setFailed] = useState<string | null>(null);
  const [hintVisible, setHintVisible] = useState(false);
  const dark = useMediaQuery("(prefers-color-scheme: dark)");

  // The latest props, for callbacks the scene holds on to.
  const liveRef = useRef(live);
  liveRef.current = live;
  const featuresRef = useRef(features);
  featuresRef.current = features;
  const onInputRef = useRef(onInput);
  onInputRef.current = onInput;

  const hingeSend = useRef<{ timer: ReturnType<typeof setTimeout> | null; last: number; pending: number | null }>({
    timer: null,
    last: 0,
    pending: null,
  });
  /** The hinge angle last asked of the host, to avoid repeats. */
  const hingeSent = useRef<number | null>(null);

  const sendHinge = useCallback((angle: number) => {
    if (!liveRef.current || !featuresRef.current.includes("duo-hinge")) return;
    const rounded = Math.round(angle * 10) / 10;
    if (hingeSent.current === rounded) return;
    hingeSent.current = rounded;
    onInputRef.current({ kind: "hinge", angle: rounded });
  }, []);

  const requestHinge = useCallback(
    (angle: number, settled: boolean) => {
      const s = hingeSend.current;
      if (settled) {
        if (s.timer) clearTimeout(s.timer);
        s.timer = null;
        s.pending = null;
        s.last = performance.now();
        sendHinge(angle);
        return;
      }
      s.pending = angle;
      if (s.timer) return;
      const wait = Math.max(0, HINGE_SEND_MS - (performance.now() - s.last));
      s.timer = setTimeout(() => {
        s.timer = null;
        s.last = performance.now();
        if (s.pending !== null) sendHinge(s.pending);
        s.pending = null;
      }, wait);
    },
    [sendHinge],
  );

  // ── Scene lifetime ────────────────────────────────────────────────────────
  // three.js is loaded only when a Duo is actually shown.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let scene: DuoScene | null = null;
    setFinish(loadFinish());

    void import("./duo-scene")
      .then(({ DuoScene: Scene }) => {
        if (cancelled) return;
        scene = new Scene(
          canvas,
          {
            onInput: (input: DuoSceneInput) => {
              if (!liveRef.current) return;
              if (input.kind === "touch" && input.finger === 1 && !featuresRef.current.includes("multi-touch")) return;
              onInputRef.current(input);
            },
            onHingeRequest: requestHinge,
            onHingeShown: (angle) => setHinge(Math.round(angle)),
            onOrientation: (orientation) => {
              if (liveRef.current && featuresRef.current.includes("device-orientation")) {
                onInputRef.current({ kind: "device_orientation", orientation });
              }
            },
            onEngage: () => {
              canvas.focus({ preventScroll: true });
              setHintVisible(false);
              try {
                window.localStorage.setItem(HINT_KEY, "1");
              } catch {
                /* storage blocked */
              }
            },
          },
          loadFinish(),
        );
        sceneRef.current = scene;
        scene.setLive(liveRef.current);
        for (const display of ["cover", "inner"] as const) {
          const frame = earlyFrames.current[display];
          if (frame) scene.setFrame(display, frame);
        }
        earlyFrames.current = {};
        measure();
        try {
          if (!window.localStorage.getItem(HINT_KEY)) setHintVisible(true);
        } catch {
          /* storage blocked */
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        console.error("[duo-viewer] could not start the 3D view:", e);
        setFailed("This browser could not start the 3D view (WebGL is unavailable).");
      });

    const measure = (): void => {
      const container = containerRef.current;
      if (!container || !sceneRef.current) return;
      const controls = controlsRef.current;
      // Keep the device clear of the controls along the bottom.
      const bottom = controls ? controls.offsetHeight + 14 : 0;
      sceneRef.current.setSize(container.clientWidth, container.clientHeight, { top: 6, bottom });
    };
    const observer = new ResizeObserver(measure);
    if (containerRef.current) observer.observe(containerRef.current);
    if (controlsRef.current) observer.observe(controlsRef.current);
    const sending = hingeSend.current;

    return () => {
      cancelled = true;
      observer.disconnect();
      if (sending.timer) clearTimeout(sending.timer);
      sending.timer = null;
      scene?.dispose();
      sceneRef.current = null;
      for (const frame of Object.values(earlyFrames.current)) frame?.close();
      earlyFrames.current = {};
    };
    // The scene is created once; everything it reads later comes through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      pushFrame: (display, frame) => {
        const scene = sceneRef.current;
        if (scene) {
          scene.setFrame(display, frame);
          return;
        }
        earlyFrames.current[display]?.close();
        earlyFrames.current[display] = frame;
      },
      clearFrames: () => {
        sceneRef.current?.clearFrames();
        for (const frame of Object.values(earlyFrames.current)) frame?.close();
        earlyFrames.current = {};
      },
      capture: (display, quality) => sceneRef.current?.capture(display, quality) ?? Promise.resolve(null),
      focus: () => canvasRef.current?.focus({ preventScroll: true }),
    }),
    [],
  );

  // ── Keeping the scene in step with the session ────────────────────────────
  useEffect(() => {
    sceneRef.current?.setLive(live);
    sceneRef.current?.setDim(live ? 0 : 0.55);
    if (!live) hingeSent.current = null;
  }, [live]);

  // A session comes up open and upright. The first time it reports in, the
  // device here may already be folded or turned (posed while the app was
  // building): then the session is told, instead of the device being put
  // back. After that the host's reports are followed.
  const announced = useRef(false);
  useEffect(() => {
    if (!live || !state) {
      announced.current = false;
      return;
    }
    const scene = sceneRef.current;
    if (!scene) return;
    scene.setLit({ cover: state.cover.lit, inner: state.inner.lit });
    if (announced.current) {
      scene.setReportedHinge(state.hingeAngle);
      return;
    }
    announced.current = true;
    if (Math.abs(scene.getHinge() - state.hingeAngle) > 1) {
      // Through the scene, so it also holds off the host's reports while the hinge eases there.
      scene.setHinge(scene.getHinge(), true);
    } else {
      scene.setReportedHinge(state.hingeAngle);
    }
    const held = scene.getOrientation();
    if (held !== (state.orientation ?? "portrait") && features.includes("device-orientation")) {
      onInputRef.current({ kind: "device_orientation", orientation: held });
    }
  }, [live, state, features]);

  useEffect(() => {
    sceneRef.current?.setDarkBackdrop(dark);
  }, [dark]);

  useEffect(() => {
    sceneRef.current?.setFinish(finish);
  }, [finish]);

  // ── Controls ──────────────────────────────────────────────────────────────
  const choosePose = (id: DuoPoseId): void => {
    setPose(id);
    sceneRef.current?.applyPose(id);
  };
  const toggleFinish = (): void => {
    const next: DuoFinishId = finish === "natural" ? "graphite" : "natural";
    setFinish(next);
    try {
      window.localStorage.setItem(FINISH_KEY, next);
    } catch {
      /* storage blocked */
    }
  };
  const activePose: DuoPoseId | null =
    hinge <= 3 ? "closed" : hinge >= 177 ? "open" : pose && DUO_POSES.find((p) => p.id === pose)?.hinge === hinge ? pose : null;

  const iconButton =
    "flex h-7 w-7 items-center justify-center rounded-md text-muted transition hover:bg-soft hover:text-fg disabled:pointer-events-none disabled:opacity-40 " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 pointer-coarse:h-9 pointer-coarse:w-9";

  return (
    <div
      ref={containerRef}
      className={cn("@container relative min-h-0 flex-1 select-none overflow-hidden", className)}
    >
      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="application"
        aria-label="iPhone Duo simulator. Drag to turn the device, scroll to zoom. The controls below fold and rotate it."
        className="absolute inset-0 block h-full w-full outline-none"
        style={{ touchAction: "none" }}
        onKeyDown={(e) => {
          if (!live) return;
          const input = simInputForKey(e);
          if (!input) return;
          e.preventDefault();
          onInput(input);
        }}
        onFocus={() => onKeyboardFocusChange?.(true)}
        onBlur={() => onKeyboardFocusChange?.(false)}
      />

      {failed && (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted" role="alert">
          {failed}
        </div>
      )}

      {overlay && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          {overlayBare ? (
            overlay
          ) : (
            <div className="flex max-w-[min(26rem,80%)] justify-center rounded-2xl bg-black/60 px-4 py-3 backdrop-blur-md">
              {overlay}
            </div>
          )}
        </div>
      )}

      {hintVisible && !compact && !overlay && (
        <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 whitespace-nowrap rounded-full border border-border bg-elevated/90 px-3 py-1 text-[11px] text-muted shadow-sm backdrop-blur @max-[30rem]:hidden">
          Drag to turn · scroll to zoom · pull an outer edge to fold
        </div>
      )}

      {/* Controls. Compact (picture-in-picture) keeps just open and closed. */}
      <div className="pointer-events-none absolute inset-x-2 bottom-2.5 flex justify-center">
      <div
        ref={controlsRef}
        className={cn(
          "pointer-events-auto flex max-w-full items-center rounded-xl border border-border bg-elevated/90 shadow-sm backdrop-blur",
          compact ? "gap-0.5 p-0.5" : "flex-wrap justify-center gap-x-2 gap-y-1 px-1.5 py-1",
        )}
      >
        <div className="flex items-center gap-0.5" role="group" aria-label="Posture">
          {DUO_POSES.filter((p) => !compact || p.id === "closed" || p.id === "open").map((p) => {
            const Icon = POSE_ICONS[p.id];
            const active = activePose === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => choosePose(p.id)}
                aria-pressed={active}
                title={p.hint}
                className={cn(
                  "flex items-center gap-1.5 rounded-md text-[11px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                  compact ? "h-6 px-1.5" : "h-7 px-2 pointer-coarse:h-9 pointer-coarse:px-2.5 pointer-coarse:text-xs",
                  active
                    ? "bg-bg text-fg shadow-sm ring-1 ring-border-strong/50 dark:bg-soft dark:ring-border-strong"
                    : "text-muted hover:text-fg",
                )}
              >
                <Icon size={compact ? 11 : 13} />
                <span className={cn(!compact && "@max-[34rem]:sr-only")}>{p.label}</span>
              </button>
            );
          })}
        </div>

        {!compact && (
          <>
            <span className="h-4 w-px bg-border @max-[26rem]:hidden" aria-hidden />
            <label className="flex items-center gap-2 text-[11px] text-muted">
              <span className="@max-[44rem]:sr-only">Hinge</span>
              <input
                type="range"
                min={0}
                max={180}
                step={1}
                value={hinge}
                aria-label="Hinge angle"
                aria-valuetext={`${hinge} degrees, ${hingePostureLabel(hinge).toLowerCase()}`}
                onChange={(e) => {
                  setPose(null);
                  sceneRef.current?.setHinge(Number(e.target.value), false);
                }}
                onPointerUp={(e) => sceneRef.current?.setHinge(Number(e.currentTarget.value), true)}
                onKeyUp={(e) => sceneRef.current?.setHinge(Number(e.currentTarget.value), true)}
                className="h-1 w-28 cursor-pointer accent-accent @max-[30rem]:w-20"
              />
              <span className="w-8 text-right font-mono tabular-nums text-fg/80">{hinge}°</span>
            </label>
            <span className="h-4 w-px bg-border @max-[26rem]:hidden" aria-hidden />
            <div className="flex items-center gap-0.5" role="group" aria-label="Device and view">
              {features.includes("hardware-buttons") && (
                <button
                  type="button"
                  className={iconButton}
                  disabled={!live}
                  onClick={() => onInput({ kind: "button", button: "home" })}
                  title="Go to the Home Screen"
                  aria-label="Go to the Home Screen"
                >
                  <House size={13} />
                </button>
              )}
              <button
                type="button"
                className={iconButton}
                onClick={() => sceneRef.current?.rollQuarter("left")}
                title="Turn the device left"
                aria-label="Turn the device left"
              >
                <RotateCcw size={13} />
              </button>
              <button
                type="button"
                className={iconButton}
                onClick={() => sceneRef.current?.rollQuarter("right")}
                title="Turn the device right"
                aria-label="Turn the device right"
              >
                <RotateCw size={13} />
              </button>
              <button
                type="button"
                className={iconButton}
                onClick={() => sceneRef.current?.resetView()}
                title="Face the device and reset the zoom (or double-click the background)"
                aria-label="Reset the view"
              >
                <ScanLine size={13} />
              </button>
              <button
                type="button"
                className={iconButton}
                onClick={toggleFinish}
                title={finish === "natural" ? "Finish: Natural. Switch to Graphite" : "Finish: Graphite. Switch to Natural"}
                aria-label={`Device finish: ${finish}. Switch finish`}
              >
                <span
                  className="h-3.5 w-3.5 rounded-full ring-1 ring-border-strong"
                  style={{
                    background:
                      finish === "natural"
                        ? "linear-gradient(135deg,#e9e5dc,#bdb8ae)"
                        : "linear-gradient(135deg,#5b5c61,#2a2b2e)",
                  }}
                />
              </button>
            </div>
          </>
        )}
      </div>
      </div>
    </div>
  );
});
