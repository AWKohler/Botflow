"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  CameraOff,
  ChevronDown,
  ChevronUp,
  Loader2,
  Maximize2,
  RefreshCw,
  RotateCw,
  Smartphone,
  Square,
  Tablet,
} from "lucide-react";
import {
  SwiftStreamClient,
  type SimBuildStatus,
  type SimCalibration,
  type SimLogStream,
  type SimSessionState,
  type SimVideoConfig,
} from "./swift-stream-client";
import { SwiftCameraCapture, type CameraCaptureState } from "./swift-camera-capture";
import {
  DeviceFrame,
  type DeviceModelUI,
  type OrientationUI,
} from "./device-frame";
import {
  loadDevicePref,
  saveDevicePref,
  loadOrientationPref,
  saveOrientationPref,
} from "./swift-preview-prefs";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import { BuildIssuesPanel } from "./build-issues-panel";
import type { SimBuildDiagnostic } from "./swift-stream-client";
import {
  acquireSession,
  forceEndSession,
  releaseSession,
} from "./swift-preview-session-pool";

// Device bezel geometry lives in <DeviceFrame>. Both devices default to portrait
// (the orientation they actually boot in) so a session never depends on a
// rotation to come up; landscape is reached via the orientation toggle.
function naturalOrientation(_model: DeviceModelUI): OrientationUI {
  return "portrait";
}

/**
 * Draw a decoded frame to the canvas, compensating for the iOS-26 simulator
 * quirk where the captured framebuffer stays portrait even when the app is in
 * landscape (content rendered sideways). For a landscape display we swap the
 * canvas to landscape dims and rotate the source 90° clockwise so it shows
 * upright; for portrait we draw 1:1. `sw`/`sh` are the source's natural dims.
 */
function blitToCanvas(
  canvas: HTMLCanvasElement,
  source: CanvasImageSource,
  sw: number,
  sh: number,
  landscape: boolean,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  if (landscape) {
    if (canvas.width !== sh || canvas.height !== sw) {
      canvas.width = sh;
      canvas.height = sw;
    }
    ctx.save();
    ctx.translate(canvas.width, 0); // = sh
    ctx.rotate(Math.PI / 2); // 90° clockwise
    ctx.drawImage(source, 0, 0, sw, sh);
    ctx.restore();
  } else {
    if (canvas.width !== sw || canvas.height !== sh) {
      canvas.width = sw;
      canvas.height = sh;
    }
    ctx.drawImage(source, 0, 0, sw, sh);
  }
}

interface SwiftSimulatorPreviewProps {
  projectId: string;
  /** Layout mode. "full" is the original Preview-tab layout. "pip" is a
   * compact draggable picture-in-picture suitable for overlaying the code
   * editor. */
  mode?: "full" | "pip";
  /** Open a project file at the given 1-based line. Wired by the workspace
   * shell so error rows in the Issues panel are click-to-jump. */
  onOpenFile?: (path: string, line: number) => void;
  /** Stop the session. Caller (workspace) is expected to unmount the preview
   * after this; the session DELETE happens in our cleanup effect. */
  onStop?: () => void;
  /** Pop the PIP back to full-screen Preview tab. Pip-only. */
  onExpand?: () => void;
  /** Last-seen simulator screenshots per device family. Shown blurred inside
   * the device screen while the session boots; de-blurs on the first frame. */
  screenshots?: { iphone?: string | null; ipad?: string | null };
}

type PillState =
  | { kind: "idle" }
  | { kind: "starting"; label: string }
  | { kind: "building"; startedAt: number }
  | { kind: "installing" }
  | { kind: "live" }
  | { kind: "failed"; message: string; exitCode?: number }
  | { kind: "ended"; reason?: string }
  | { kind: "error"; message: string };

interface LogLine {
  line: string;
  stream: SimLogStream;
}

const LOG_RING = 400;

export function SwiftSimulatorPreview({
  projectId,
  mode = "full",
  onOpenFile,
  onStop,
  onExpand,
  screenshots,
}: SwiftSimulatorPreviewProps) {
  const isPip = mode === "pip";
  const { toast } = useToast();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pill, setPill] = useState<PillState>({ kind: "starting", label: "Provisioning…" });
  const [calibration, setCalibration] = useState<SimCalibration | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<SimBuildDiagnostic[]>([]);
  const [diagnosticsFinalized, setDiagnosticsFinalized] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [fps, setFps] = useState(0);
  const [kbdFocused, setKbdFocused] = useState(false);
  const [cameraState, setCameraState] = useState<CameraCaptureState>("idle");

  // Device family + orientation. Changing device restarts the session (different
  // simulator); changing orientation rotates live (no rebuild). `liveOrientation`
  // is what the host reports — used for the bezel so it matches the real stream
  // even if a rotate silently fails.
  // Default to the device/orientation the user last used (persisted globally).
  const [deviceModel, setDeviceModel] = useState<DeviceModelUI>(loadDevicePref);
  const [orientation, setOrientation] = useState<OrientationUI>(loadOrientationPref);
  const [liveOrientation, setLiveOrientation] = useState<OrientationUI | null>(null);
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The orientation currently shown (live takes precedence). Held in a ref so the
  // draw/input callbacks (which capture state once) always see the latest value.
  // On iOS 26 the simulator's captured frame is ALWAYS portrait even when the app
  // is landscape — so for a landscape orientation we rotate the video 90° in the
  // canvas and inverse-map pointer coordinates. See blitFrameToCanvas / norm().
  const displayOrientationRef = useRef<OrientationUI>(loadOrientationPref());
  const clientRef = useRef<SwiftStreamClient | null>(null);
  const logBoxRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pos: { normX: number; normY: number } } | null>(null);
  const buildStartedAtRef = useRef<number | null>(null);
  const frameCountRef = useRef(0);
  const fpsTimeRef = useRef(Date.now());
  const videoDecoderRef = useRef<VideoDecoder | null>(null);
  const videoConfiguredRef = useRef(false);
  const waitingForVideoKeyframeRef = useRef(true);
  const cameraRef = useRef<SwiftCameraCapture | null>(null);
  // Orientation the user just asked for via the toggle; compared against what
  // the host reports back so we can tell the user when a rotate didn't apply.
  const pendingOrientationRef = useRef<OrientationUI | null>(null);

  // ── Last-seen screenshot overlay + capture ───────────────────────────────
  // While the session boots, the previous run's screenshot (if any) covers the
  // black screen under a blur; the FIRST decoded frame triggers a ~700ms
  // de-blur, then the overlay unmounts. The canvas is also grabbed (toBlob)
  // periodically and on Stop so the next stopped state shows fresh content.
  const [hasFrame, setHasFrame] = useState(false);
  const hasFrameRef = useRef(false);
  const [screenshotOverlayGone, setScreenshotOverlayGone] = useState(false);
  const deviceModelRef = useRef<DeviceModelUI>(loadDevicePref());
  const lastScreenshotAtRef = useRef(0);

  const markFrame = useCallback(() => {
    if (!hasFrameRef.current) {
      hasFrameRef.current = true;
      setHasFrame(true);
    }
  }, []);

  const captureScreenshot = useCallback((force = false) => {
    const canvas = canvasRef.current;
    if (!canvas || !hasFrameRef.current) return;
    if (!force && Date.now() - lastScreenshotAtRef.current < 10_000) return;
    lastScreenshotAtRef.current = Date.now();
    try {
      canvas.toBlob(
        (blob) => {
          if (!blob) return;
          const form = new FormData();
          form.append("file", blob, "simulator.jpg");
          form.append(
            "deviceModel",
            deviceModelRef.current === "iPad-Pro" ? "iPad-Pro" : "iPhone-16-Pro",
          );
          // NO keepalive here: keepalive caps the body at 64KB and a frame
          // JPEG is far bigger — the browser would reject the request outright.
          // A plain fetch survives component unmount (only page navigation
          // kills it), which covers the Stop-then-unmount path.
          void fetch(`/api/projects/${projectId}/swift-preview/screenshot`, {
            method: "POST",
            body: form,
          }).then((res) => {
            if (!res.ok) console.warn("[swift-screenshot] upload failed:", res.status);
          }).catch((e) => console.warn("[swift-screenshot] upload failed:", e));
        },
        "image/jpeg",
        0.85,
      );
    } catch {
      // Canvas hiccup — next interval tries again.
    }
  }, [projectId]);

  // ────────────────────────────────────────────────────────────────────────────
  // Session lifecycle — delegated to a refcounted pool keyed by projectId.
  //
  // Why a pool: React Strict Mode (dev) double-invokes effects (mount →
  // cleanup → mount). The old code POSTed `/swift-preview/start` on each
  // mount, producing two sessions per page open — slot pressure, racing
  // WebSockets, "Provisioning…" hangs. The pool dedupes by projectId so
  // strict-mode's second mount RE-CLAIMS the in-flight session instead of
  // creating a parallel one.
  //
  // Cleanup releases the refcount; the pool defers the actual DELETE by a
  // short grace window. On real unmount the timer fires; on strict-mode
  // remount the new acquire cancels the timer.
  //
  // The Stop button (parent's onStop callback) calls forceEndSession()
  // *before* unmounting so user intent to stop bypasses the grace window.
  // ────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let client: SwiftStreamClient | null = null;

    // Fresh session (mount or device switch) — frames from the previous
    // session don't count toward the de-blur.
    hasFrameRef.current = false;
    setHasFrame(false);
    setScreenshotOverlayGone(false);
    deviceModelRef.current = deviceModel;

    (async () => {
      try {
        setPill({ kind: "starting", label: "Provisioning…" });
        const data = await acquireSession(projectId, { deviceModel, orientation });
        if (cancelled) return;
        setSessionId(data.sessionId);
        setPill({ kind: "starting", label: "Connecting…" });

        client = new SwiftStreamClient(data.wsUrl, {
          onOpen: () => setPill({ kind: "starting", label: "Waiting for host…" }),
          onClose: () => setPill((p) => (p.kind === "live" ? { kind: "ended" } : p)),
          onState: handleState,
          onCalibration: setCalibration,
          onFrame: drawFrame,
          onVideoConfig: handleVideoConfig,
          onVideoChunk: handleVideoChunk,
          onStatus: (msg) => appendLog(msg, "stdout"),
          onError: (msg) => setPill({ kind: "error", message: msg }),
          onBuildStatus: handleBuildStatus,
          onBuildLog: appendLog,
          onBuildDiagnostics: handleBuildDiagnostics,
          onCameraRequest: (active) => {
            // The app opened/closed its camera — auto start/stop the webcam so
            // the user gets the permission prompt exactly when it's needed.
            if (active) startCamera();
            else stopCamera();
          },
          onOrientation: (o) => {
            setLiveOrientation(o);
            const pending = pendingOrientationRef.current;
            if (pending) {
              pendingOrientationRef.current = null;
              if (o !== pending) {
                // The host couldn't rotate the device (needs Accessibility
                // permission on the companion Mac). Sync the control to reality
                // and tell the user instead of silently doing nothing.
                setOrientation(o);
                toast({
                  title: "Couldn't rotate the simulator",
                  description:
                    "The companion Mac needs Accessibility permission to rotate the device, so it stays in " +
                    o +
                    " for now.",
                });
              }
            }
          },
        });
        clientRef.current = client;
        client.start();
      } catch (e) {
        if (cancelled) return;
        setPill({ kind: "error", message: (e as Error).message });
      }
    })();

    return () => {
      cancelled = true;
      // Stop the webcam (turns off the browser indicator light) before the WS.
      if (cameraRef.current) {
        cameraRef.current.stop();
        cameraRef.current = null;
      }
      if (clientRef.current) {
        clientRef.current.close();
        clientRef.current = null;
      }
      if (videoDecoderRef.current) {
        try {
          videoDecoderRef.current.close();
        } catch {
          /* ignore */
        }
        videoDecoderRef.current = null;
        videoConfiguredRef.current = false;
      }
      // Refcounted: the pool may defer the actual DELETE in case a strict-
      // mode remount re-claims within the grace window. Keyed by deviceModel so
      // switching device tears down the old simulator and starts a new one.
      releaseSession(projectId, { deviceModel });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, deviceModel]);

  // Stop is special: the user explicitly wants the simulator gone. Bypass
  // the pool grace window so the slot is freed immediately on click. Grab a
  // final screenshot first — it becomes the blurred stopped-state image.
  const handleStop = useCallback(() => {
    captureScreenshot(true);
    forceEndSession(projectId, { deviceModel });
    onStop?.();
  }, [projectId, onStop, deviceModel, captureScreenshot]);

  // Switch device family (iPhone ↔ iPad). The session effect (keyed on
  // deviceModel) tears down the old simulator and starts a new one in the new
  // device's natural orientation.
  const switchDevice = useCallback(
    (m: DeviceModelUI) => {
      setDeviceMenuOpen(false);
      if (m === deviceModel) return;
      setDeviceModel(m);
      setOrientation(naturalOrientation(m));
      setLiveOrientation(null);
      saveDevicePref(m);
      saveOrientationPref(naturalOrientation(m));
    },
    [deviceModel],
  );

  // Rotate the device live (no rebuild). The host rotates the simulator and
  // reports back via onOrientation, which updates the bezel to match.
  const toggleOrientation = useCallback(() => {
    const next: OrientationUI = orientation === "portrait" ? "landscape" : "portrait";
    pendingOrientationRef.current = next;
    setOrientation(next);
    setLiveOrientation(null);
    saveOrientationPref(next);
    clientRef.current?.sendSetOrientation(next);
  }, [orientation]);

  // ────────────────────────────────────────────────────────────────────────────
  // Webcam → simulator camera. getUserMedia (browser permission prompt) → JPEG
  // frames over the WS → host agent → injected camera shim. Started either
  // automatically when the app opens its camera (onCameraRequest) or manually
  // via the toolbar toggle.
  // ────────────────────────────────────────────────────────────────────────────
  const startCamera = useCallback(() => {
    if (cameraRef.current && cameraRef.current.state !== "idle") return;
    const capture =
      cameraRef.current ??
      new SwiftCameraCapture({
        onFrame: (jpeg, ts) => clientRef.current?.sendCameraFrame(jpeg, ts),
        onStateChange: (s) => {
          setCameraState(s);
          if (s === "active") clientRef.current?.sendCameraState(true);
          else if (s === "idle") clientRef.current?.sendCameraState(false);
          else if (s === "denied") {
            toast({
              title: "Camera blocked",
              description: "Allow camera access in your browser to use the webcam in the simulator.",
            });
          } else if (s === "unsupported") {
            toast({ title: "Camera unsupported", description: "This browser can't share a webcam." });
          }
        },
      });
    cameraRef.current = capture;
    void capture.start();
  }, [toast]);

  const stopCamera = useCallback(() => {
    cameraRef.current?.stop();
  }, []);

  const toggleCamera = useCallback(() => {
    const s = cameraRef.current?.state ?? "idle";
    if (s === "active" || s === "requesting") stopCamera();
    else startCamera();
  }, [startCamera, stopCamera]);

  // ────────────────────────────────────────────────────────────────────────────
  // Event handlers
  // ────────────────────────────────────────────────────────────────────────────
  const handleState = useCallback(
    (state: SimSessionState, queuePosition?: number, reason?: string) => {
      // Side-effect (toast) must live outside the setPill updater, which has
      // to stay pure. The inactivity reaper is the one case we explain loudly.
      if (state === "ended" && reason === "inactivity") {
        toast({
          title: "Simulator closed",
          description: "Closed after 3 minutes of inactivity. Click Preview to start a new one.",
        });
      }
      setPill((current) => {
        switch (state) {
          case "queued": {
            // queuePosition flows from the controller via the WS state msg;
            // when undefined (briefly between placement and first heartbeat)
            // we fall back to the generic "Reserving slot…" label rather than
            // flashing "#?" which looks broken.
            const label =
              typeof queuePosition === "number"
                ? `Queued — #${queuePosition} in line`
                : "Reserving slot…";
            return { kind: "starting", label };
          }
          case "building":
            // build_status 'started' will install a timer.
            return current.kind === "building"
              ? current
              : { kind: "building", startedAt: buildStartedAtRef.current ?? Date.now() };
          case "starting":
            return { kind: "installing" };
          case "streaming":
            setRebuilding(false);
            return { kind: "live" };
          case "ended":
            return { kind: "ended", reason };
          case "error":
            return current.kind === "failed"
              ? current
              : { kind: "error", message: "Session error" };
        }
      });
    },
    [toast],
  );

  const handleBuildStatus = useCallback(
    (status: SimBuildStatus) => {
      switch (status.state) {
        case "started":
          buildStartedAtRef.current = Date.now();
          // Reset all build buffers — the panel should not show stale issues
          // from the previous build attempt.
          setLogs([]);
          setDiagnostics([]);
          setDiagnosticsFinalized(false);
          setIssuesOpen(false);
          setPill({ kind: "building", startedAt: buildStartedAtRef.current });
          break;
        case "succeeded":
          setPill({ kind: "installing" });
          break;
        case "failed":
          setPill({
            kind: "failed",
            message: status.message ?? "Build failed",
            exitCode: status.exitCode,
          });
          if (isPip) {
            // In PIP we don't render the Issues panel — bounce the user to
            // the Preview tab via a toast action so they can see the errors.
            toast({
              title: "Build failed",
              description: "Click to view errors",
              // Toast helper has no native action prop; we just expand for now.
            });
            onExpand?.();
          } else {
            // Auto-open the structured Issues panel so the failure is visible.
            setIssuesOpen(true);
          }
          break;
      }
    },
    [isPip, onExpand, toast],
  );

  const appendLog = useCallback((line: string, stream: SimLogStream) => {
    setLogs((prev) => {
      const next = [...prev, { line, stream }];
      if (next.length > LOG_RING) next.splice(0, next.length - LOG_RING);
      return next;
    });
  }, []);

  const handleBuildDiagnostics = useCallback(
    (diags: SimBuildDiagnostic[], final: boolean) => {
      if (final) {
        // Authoritative xcresult set: replace whatever live ones we had.
        setDiagnostics(diags);
        setDiagnosticsFinalized(true);
      } else {
        // Live incremental — dedupe so the regex parser firing repeatedly
        // doesn't pile up the same issue.
        setDiagnostics((prev) => {
          const key = (d: SimBuildDiagnostic): string =>
            `${d.file}:${d.line}:${d.column}:${d.severity}:${d.message}`;
          const seen = new Set(prev.map(key));
          const merged = [...prev];
          for (const d of diags) {
            if (!seen.has(key(d))) {
              seen.add(key(d));
              merged.push(d);
            }
          }
          return merged;
        });
      }
      // On a successful build with warnings, auto-show the panel so the
      // warning chip isn't a silent secret.
      if (final && diags.length > 0) setIssuesOpen(true);
    },
    [],
  );

  // Auto-scroll log to bottom of the raw-log disclosure (when the Issues panel
  // is open AND the user has expanded the raw log inside it). The Panel owns
  // its own scroll for the issues list; this ref is unused now but kept for
  // potential future raw-log scroll-to-bottom inside the panel.
  useEffect(() => {
    if (!issuesOpen) return;
    const el = logBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, issuesOpen]);

  // Keep the draw/input callbacks' view of the current orientation fresh.
  useEffect(() => {
    displayOrientationRef.current = liveOrientation ?? orientation;
  }, [orientation, liveOrientation]);

  // Keep the screenshot uploader's device label fresh.
  useEffect(() => {
    deviceModelRef.current = deviceModel;
  }, [deviceModel]);

  // ── Publish actual stream state (agent's getSimulatorStatus reads this) ──
  useEffect(() => {
    const state =
      pill.kind === "starting"
        ? "starting"
        : pill.kind === "building"
          ? "building"
          : pill.kind === "installing"
            ? "installing"
            : pill.kind === "live"
              ? "live"
              : pill.kind === "failed" || pill.kind === "error"
                ? "failed"
                : "stopped"; // idle | ended
    void fetch(`/api/projects/${projectId}/swift-preview/state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, deviceModel }),
      keepalive: true,
    }).catch(() => {});
  }, [pill.kind, projectId, deviceModel]);

  // Publish "stopped" when the preview unmounts (Stop button / tab close).
  useEffect(() => {
    return () => {
      void fetch(`/api/projects/${projectId}/swift-preview/state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "stopped", deviceModel: null }),
        keepalive: true,
      }).catch(() => {});
    };
  }, [projectId]);

  // ── Periodic screenshot while live ───────────────────────────────────────
  useEffect(() => {
    if (pill.kind !== "live") return;
    // First grab shortly after going live, then every 30s.
    const first = setTimeout(() => captureScreenshot(), 5_000);
    const timer = setInterval(() => captureScreenshot(), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [pill.kind, captureScreenshot]);

  // ── Screenshot overlay de-blur: first frame → 700ms transition → unmount ─
  useEffect(() => {
    if (!hasFrame) return;
    const t = setTimeout(() => setScreenshotOverlayGone(true), 750);
    return () => clearTimeout(t);
  }, [hasFrame]);

  // ── Agent-panel screenshot bridge ────────────────────────────────────────
  // The AgentPanel shows a "screenshot the simulator" button but can't reach
  // this canvas directly. We coordinate over window events (scoped by
  // projectId): broadcast whether a frame is grabbable so the button can
  // enable/grey itself, and on request hand the current canvas back as a JPEG
  // blob for the panel to attach like an uploaded image.
  const simShotAvailable = pill.kind === "live" && hasFrame;
  const availableRef = useRef(false);
  availableRef.current = simShotAvailable;

  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("swift-sim-availability", {
        detail: { projectId, available: simShotAvailable },
      }),
    );
  }, [projectId, simShotAvailable]);

  useEffect(() => {
    const onQuery = (e: Event) => {
      const d = (e as CustomEvent<{ projectId: string }>).detail;
      if (!d || d.projectId !== projectId) return;
      window.dispatchEvent(
        new CustomEvent("swift-sim-availability", {
          detail: { projectId, available: availableRef.current },
        }),
      );
    };
    const onCapture = (e: Event) => {
      const d = (e as CustomEvent<{ projectId: string; requestId: string }>).detail;
      if (!d || d.projectId !== projectId) return;
      const respond = (detail: { blob?: Blob; error?: string }) =>
        window.dispatchEvent(
          new CustomEvent("swift-sim-capture-response", {
            detail: {
              projectId,
              requestId: d.requestId,
              deviceModel: deviceModelRef.current,
              ...detail,
            },
          }),
        );
      const canvas = canvasRef.current;
      if (!canvas || !hasFrameRef.current) {
        respond({ error: "The simulator isn't streaming a frame yet." });
        return;
      }
      try {
        canvas.toBlob(
          (blob) => respond(blob ? { blob } : { error: "Couldn't read the simulator screen." }),
          "image/jpeg",
          0.9,
        );
      } catch {
        respond({ error: "Couldn't read the simulator screen." });
      }
    };
    window.addEventListener("swift-sim-availability-query", onQuery);
    window.addEventListener("swift-sim-capture-request", onCapture);
    return () => {
      window.removeEventListener("swift-sim-availability-query", onQuery);
      window.removeEventListener("swift-sim-capture-request", onCapture);
      // Unmounting (Stop / tab close) — tell the panel the grab is gone so its
      // button greys out.
      window.dispatchEvent(
        new CustomEvent("swift-sim-availability", { detail: { projectId, available: false } }),
      );
    };
  }, [projectId]);

  const drawFrame = useCallback((b64: string) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const img = new Image();
    img.onload = () => {
      blitToCanvas(
        canvas,
        img,
        img.naturalWidth,
        img.naturalHeight,
        displayOrientationRef.current === "landscape",
      );
      markFrame();
      frameCountRef.current++;
      const now = Date.now();
      const elapsed = now - fpsTimeRef.current;
      if (elapsed >= 1000) {
        setFps(Math.round((frameCountRef.current * 1000) / elapsed));
        frameCountRef.current = 0;
        fpsTimeRef.current = now;
      }
    };
    img.src = `data:image/jpeg;base64,${b64}`;
  }, [markFrame]);

  const handleVideoConfig = useCallback((config: SimVideoConfig) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!("VideoDecoder" in window)) {
      setPill({
        kind: "error",
        message: "This browser does not support WebCodecs VideoDecoder. Use Chrome or Edge for H.264 simulator streaming.",
      });
      return;
    }

    if (videoDecoderRef.current) {
      try {
        videoDecoderRef.current.close();
      } catch {
        /* ignore */
      }
    }

    canvas.width = config.width;
    canvas.height = config.height;
    const decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        const c = canvasRef.current;
        if (c) {
          blitToCanvas(
            c,
            frame,
            frame.displayWidth,
            frame.displayHeight,
            displayOrientationRef.current === "landscape",
          );
        }
        frame.close();
        markFrame();
        frameCountRef.current++;
        const now = Date.now();
        const elapsed = now - fpsTimeRef.current;
        if (elapsed >= 1000) {
          setFps(Math.round((frameCountRef.current * 1000) / elapsed));
          frameCountRef.current = 0;
          fpsTimeRef.current = now;
        }
      },
      error: (e: Error) => {
        setPill({ kind: "error", message: `Video decoder error: ${e.message}` });
      },
    });

    decoder.configure({
      codec: "avc1.42E01F",
      codedWidth: config.width,
      codedHeight: config.height,
      optimizeForLatency: true,
      avc: { format: "annexb" },
    } as VideoDecoderConfig);
    videoDecoderRef.current = decoder;
    videoConfiguredRef.current = true;
    waitingForVideoKeyframeRef.current = true;
  }, [markFrame]);

  const handleVideoChunk = useCallback((chunk: Uint8Array, timestampMs: number, keyframe: boolean) => {
    const decoder = videoDecoderRef.current;
    if (!decoder || !videoConfiguredRef.current) return;
    if (waitingForVideoKeyframeRef.current && !keyframe) return;
    if (keyframe) waitingForVideoKeyframeRef.current = false;
    try {
      if (typeof EncodedVideoChunk === "undefined") return;
      decoder.decode(
        new EncodedVideoChunk({
          type: keyframe ? "key" : "delta",
          timestamp: timestampMs * 1000,
          data: chunk,
        }),
      );
    } catch (e) {
      setPill({ kind: "error", message: `Video decode failed: ${(e as Error).message}` });
    }
  }, []);

  // ────────────────────────────────────────────────────────────────────────────
  // Input plumbing — only active when streaming
  // ────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (pill.kind !== "live") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const norm = (e: MouseEvent | WheelEvent): { normX: number; normY: number } => {
      const r = canvas.getBoundingClientRect();
      const dnx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const dny = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
      // In landscape the canvas shows the portrait device surface rotated 90° CW,
      // so invert that to get coordinates in the device's (portrait) surface space
      // — which is what the host's tap mapping expects. (CW: snx=dny, sny=1-dnx.)
      if (displayOrientationRef.current === "landscape") {
        return { normX: dny, normY: 1 - dnx };
      }
      return { normX: dnx, normY: dny };
    };

    const onDown = (e: MouseEvent): void => {
      // preventDefault() suppresses text-selection during a drag — but it also
      // blocks the canvas from receiving keyboard focus, so focus it explicitly.
      e.preventDefault();
      canvas.focus();
      dragRef.current = { pos: norm(e) };
    };
    const onUp = (e: MouseEvent): void => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      const end = norm(e);
      const dx = end.normX - drag.pos.normX;
      const dy = end.normY - drag.pos.normY;
      const client = clientRef.current;
      if (!client) return;
      if (Math.hypot(dx, dy) < 0.015) {
        client.sendInput({ kind: "tap", normX: end.normX, normY: end.normY });
      } else {
        client.sendInput({
          kind: "swipe",
          startX: drag.pos.normX,
          startY: drag.pos.normY,
          endX: end.normX,
          endY: end.normY,
        });
      }
    };
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const { normX, normY } = norm(e);
      clientRef.current?.sendInput({
        kind: "scroll",
        normX,
        normY,
        deltaX: e.deltaX,
        deltaY: e.deltaY,
      });
    };
    const onCtx = (e: MouseEvent): void => e.preventDefault();

    // Keyboard: the canvas is focusable (tabIndex=0). Single printable chars go
    // as `text`; named non-printables (Enter, Backspace, arrows…) go as `key`
    // and the host maps them to HID codes. We let copy/paste/devtools shortcuts
    // (Cmd/Ctrl combos) fall through to the browser.
    const SPECIAL_KEYS = new Set([
      "Enter",
      "Backspace",
      "Tab",
      "Escape",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Delete",
    ]);
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return; // let browser shortcuts through
      const client = clientRef.current;
      if (!client) return;
      if (e.key.length === 1) {
        e.preventDefault();
        client.sendInput({ kind: "text", text: e.key });
      } else if (SPECIAL_KEYS.has(e.key)) {
        e.preventDefault();
        client.sendInput({ kind: "key", key: e.key });
      }
    };
    const onFocusChange = (): void => setKbdFocused(document.activeElement === canvas);

    canvas.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onCtx);
    canvas.addEventListener("keydown", onKeyDown);
    canvas.addEventListener("focus", onFocusChange);
    canvas.addEventListener("blur", onFocusChange);
    return () => {
      canvas.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onCtx);
      canvas.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("focus", onFocusChange);
      canvas.removeEventListener("blur", onFocusChange);
    };
  }, [pill.kind]);


  // ────────────────────────────────────────────────────────────────────────────
  // Rebuild
  // ────────────────────────────────────────────────────────────────────────────
  const onRebuild = useCallback(async () => {
    if (!sessionId || rebuilding) return;
    setRebuilding(true);
    setPill({ kind: "building", startedAt: Date.now() });
    // Reset all build buffers — same logic as a fresh 'build_status:started'.
    setLogs([]);
    setDiagnostics([]);
    setDiagnosticsFinalized(false);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/swift-preview/rebuild?sessionId=${encodeURIComponent(sessionId)}`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      // Subsequent build_status / state events drive the UI from here.
    } catch (e) {
      setPill({ kind: "error", message: (e as Error).message });
      setRebuilding(false);
    }
  }, [projectId, sessionId, rebuilding]);

  // ────────────────────────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────────────────────────
  return (
    <div
      className={cn(
        "absolute inset-0 flex flex-col",
        // Full mode: flush to top/left, 10px gap on right/bottom — matches the
        // Code/Database cards exactly. PIP keeps its tight all-around padding.
        isPip ? "gap-1 p-1.5" : "gap-2 pb-2.5 pr-2.5",
      )}
    >
      {/* Status bar — compact in PIP mode */}
      <div
        className={cn(
          "flex-shrink-0 items-center rounded-xl border border-border bg-elevated/60",
          isPip ? "flex h-7 gap-1 px-1.5" : "flex h-9 gap-2 px-3",
        )}
      >
        <StatusPill pill={pill} compact={isPip} />
        <div className={cn("ml-auto flex items-center", isPip ? "gap-1" : "gap-1.5")}>
          {/* FPS counter — full mode only */}
          {!isPip && pill.kind === "live" && (
            <span className="rounded-md bg-elevated px-2 py-0.5 font-mono text-[10px] text-muted">
              {fps} fps
            </span>
          )}
          {/* Device picker — switch iPhone ↔ iPad (restarts the session). */}
          <div className="relative">
            <button
              onClick={() => setDeviceMenuOpen((v) => !v)}
              className={cn(
                "flex items-center rounded-md border border-border bg-elevated text-muted hover:text-fg",
                isPip ? "h-5 w-5 justify-center" : "gap-1.5 px-2 py-1 text-[11px]",
              )}
              title={deviceModel === "iPad-Pro" ? "iPad Pro" : "iPhone 17 Pro"}
            >
              {deviceModel === "iPad-Pro" ? (
                <Tablet size={isPip ? 11 : 12} />
              ) : (
                <Smartphone size={isPip ? 11 : 12} />
              )}
              {!isPip && (
                <span>{deviceModel === "iPad-Pro" ? "iPad Pro" : "iPhone 17 Pro"}</span>
              )}
              {!isPip && <ChevronDown size={12} />}
            </button>
            {deviceMenuOpen && (
              <>
                <div
                  className="fixed inset-0 z-[60]"
                  onClick={() => setDeviceMenuOpen(false)}
                />
                <div className="absolute right-0 z-[61] mt-1 w-40 overflow-hidden rounded-md border border-border bg-elevated shadow-lg">
                  {([
                    { id: "iPhone-16-Pro" as DeviceModelUI, label: "iPhone 17 Pro", Icon: Smartphone },
                    { id: "iPad-Pro" as DeviceModelUI, label: "iPad Pro", Icon: Tablet },
                  ]).map(({ id, label, Icon }) => (
                    <button
                      key={id}
                      onClick={() => switchDevice(id)}
                      className={cn(
                        "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] hover:bg-surface",
                        id === deviceModel ? "text-accent" : "text-fg/80",
                      )}
                    >
                      <Icon size={13} />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          {/* Orientation toggle — live rotate (no rebuild) while streaming. */}
          <button
            onClick={toggleOrientation}
            disabled={pill.kind !== "live"}
            className={cn(
              "flex items-center rounded-md border border-border bg-elevated text-muted hover:text-fg",
              "disabled:cursor-not-allowed disabled:opacity-40",
              isPip ? "h-5 w-5 justify-center" : "gap-1.5 px-2 py-1 text-[11px]",
            )}
            title={`Rotate to ${orientation === "portrait" ? "landscape" : "portrait"}`}
          >
            <RotateCw size={isPip ? 11 : 12} />
            {!isPip && (
              <span className="capitalize">{liveOrientation ?? orientation}</span>
            )}
          </button>
          {/* Refresh — both modes; iconic in PIP */}
          <button
            onClick={onRebuild}
            disabled={
              !sessionId ||
              pill.kind === "starting" ||
              pill.kind === "building" ||
              pill.kind === "ended" ||
              rebuilding
            }
            className={cn(
              "flex items-center rounded-md border border-border bg-elevated text-muted hover:text-fg",
              "disabled:cursor-not-allowed disabled:opacity-40",
              isPip ? "h-5 w-5 justify-center" : "gap-1.5 px-2 py-1 text-[11px]",
            )}
            title="Tar the sandbox and rebuild"
          >
            <RefreshCw size={isPip ? 11 : 12} className={rebuilding ? "animate-spin" : ""} />
            {!isPip && <span>Refresh build</span>}
          </button>
          {/* Webcam toggle — routes the browser camera into the simulator */}
          <button
            onClick={toggleCamera}
            disabled={pill.kind !== "live"}
            className={cn(
              "flex items-center rounded-md border border-border bg-elevated hover:text-fg",
              "disabled:cursor-not-allowed disabled:opacity-40",
              cameraState === "active"
                ? "text-accent"
                : cameraState === "denied"
                  ? "text-red-400"
                  : "text-muted",
              isPip ? "h-5 w-5 justify-center" : "gap-1.5 px-2 py-1 text-[11px]",
            )}
            title={
              cameraState === "active"
                ? "Stop sharing your webcam"
                : cameraState === "denied"
                  ? "Camera blocked — allow access in your browser"
                  : "Share your webcam with the simulator"
            }
          >
            {cameraState === "requesting" ? (
              <Loader2 size={isPip ? 11 : 12} className="animate-spin" />
            ) : cameraState === "active" ? (
              <Camera size={isPip ? 11 : 12} />
            ) : (
              <CameraOff size={isPip ? 11 : 12} />
            )}
            {!isPip && <span>{cameraState === "active" ? "Webcam on" : "Webcam"}</span>}
          </button>
          {/* Issues — full mode only */}
          {!isPip && (
            <button
              onClick={() => setIssuesOpen((v) => !v)}
              className="flex items-center gap-1 rounded-md border border-border bg-elevated px-2 py-1 text-[11px] text-muted hover:text-fg"
              title={issuesOpen ? "Hide issues" : "Show issues"}
            >
              Issues
              {diagnostics.length > 0 && (
                <span className="ml-0.5 rounded-full bg-elevated px-1.5 text-[10px] text-fg/80">
                  {diagnostics.length}
                </span>
              )}
              {issuesOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          )}
          {/* Expand back to full Preview tab — PIP only */}
          {isPip && onExpand && (
            <button
              onClick={onExpand}
              className="flex h-5 w-5 items-center justify-center rounded-md border border-border bg-elevated text-muted hover:text-fg"
              title="Expand to full preview"
            >
              <Maximize2 size={11} />
            </button>
          )}
          {/* Stop — always when caller provided handler */}
          {onStop && (
            <button
              onClick={handleStop}
              className={cn(
                "flex items-center rounded-md border border-border bg-elevated text-muted hover:text-red-400",
                isPip ? "h-5 w-5 justify-center" : "gap-1.5 px-2 py-1 text-[11px]",
              )}
              title="Stop the simulator"
            >
              <Square size={isPip ? 10 : 11} className="fill-current" />
              {!isPip && <span>Stop</span>}
            </button>
          )}
        </div>
      </div>

      {/* Stream / state surface — canvas inside the device bezel. DeviceFrame
          owns geometry, orientation, and fit-scaling for both iPhone + iPad.
          The bordered card mirrors the stopped-state placeholder exactly (same
          border + bg-elevated/60) so the device doesn't shift or change
          background when the preview starts. PIP keeps its bare look since the
          SwiftPipWindow already provides the border. */}
      <div
        className={cn(
          "relative flex min-h-0 flex-1 flex-col overflow-hidden",
          !isPip && "rounded-xl border border-border bg-elevated/60",
        )}
      >
        <DeviceFrame
          deviceModel={deviceModel}
          orientation={liveOrientation ?? orientation}
          overlay={
            pill.kind !== "live" ? (
              <CenterContent pill={pill} hasCalibration={!!calibration} />
            ) : undefined
          }
          footer={
            !isPip && pill.kind === "live" ? (
              <div className="rounded-md bg-black/55 px-2 py-0.5 text-[10px] text-white/70 backdrop-blur whitespace-nowrap">
                {kbdFocused
                  ? "Keyboard connected — typing goes to the device"
                  : "Click the screen to enable keyboard"}
              </div>
            ) : undefined
          }
        >
          <canvas
            ref={canvasRef}
            tabIndex={pill.kind === "live" ? 0 : -1}
            className={cn(
              "block max-h-full max-w-full select-none outline-none",
              pill.kind === "live"
                ? "relative cursor-crosshair"
                : "pointer-events-none absolute opacity-0",
              kbdFocused && "ring-2 ring-accent/70",
            )}
            style={{ touchAction: "none" }}
          />
          {/* Last-seen screenshot — covers the black screen (blurred) while the
              session provisions/builds; de-blurs away on the first real frame. */}
          {(() => {
            const screenshotUrl =
              deviceModel === "iPad-Pro" ? screenshots?.ipad : screenshots?.iphone;
            if (!screenshotUrl || screenshotOverlayGone) return null;
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={screenshotUrl}
                alt=""
                // object-contain mirrors the live canvas's max-w/h letterboxing,
                // so the de-blur hands off to the stream without a size jump.
                className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain"
                style={{
                  filter: hasFrame
                    ? "blur(0px) brightness(1)"
                    : "blur(7px) brightness(0.75)",
                  opacity: hasFrame ? 0 : 1,
                  transition: "filter 700ms ease, opacity 700ms ease",
                }}
              />
            );
          })()}
        </DeviceFrame>
      </div>

      {/* Structured build Issues panel — full mode only.
          In PIP, a build failure pops a toast and the user expands. */}
      {!isPip && issuesOpen && (
        <div className="flex-shrink-0">
          <BuildIssuesPanel
            diagnostics={diagnostics}
            rawLog={logs}
            finalized={diagnosticsFinalized}
            buildState={
              pill.kind === "building"
                ? "started"
                : pill.kind === "failed"
                  ? "failed"
                  : pill.kind === "live" || pill.kind === "installing"
                    ? "succeeded"
                    : null
            }
            failureMessage={pill.kind === "failed" ? pill.message : undefined}
            onOpenFile={onOpenFile}
            onCopied={(n) =>
              toast({
                title: "Copied",
                description: `${n} ${n === 1 ? "issue" : "issues"} copied to clipboard`,
              })
            }
          />
        </div>
      )}
    </div>
  );
}

function StatusPill({ pill, compact = false }: { pill: PillState; compact?: boolean }) {
  // PIP `compact` mode shrinks text + drops verbose labels so the pill fits
  // a 280px-wide header. The status icon and color stay identical so the
  // visual semantics match between modes.
  const textCls = compact ? "text-[10px]" : "text-xs";
  const gapCls = compact ? "gap-1.5" : "gap-2";
  const icoSize = compact ? 10 : 12;
  switch (pill.kind) {
    case "idle":
      return null;
    case "starting":
      return (
        <span className={cn("flex items-center", gapCls, textCls)}>
          <Loader2 size={icoSize} className="animate-spin text-blue-400" />
          <span className="text-fg/80 truncate">{compact ? "Starting" : pill.label}</span>
        </span>
      );
    case "building":
      return <BuildingPill startedAt={pill.startedAt} compact={compact} />;
    case "installing":
      return (
        <span className={cn("flex items-center", gapCls, textCls)}>
          <Loader2 size={icoSize} className="animate-spin text-emerald-400" />
          <span className="text-fg/80 truncate">
            {compact ? "Installing" : "Installing on simulator…"}
          </span>
        </span>
      );
    case "live":
      return (
        <span className={cn("flex items-center", gapCls, textCls)}>
          <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_0_3px_rgba(74,222,128,0.2)]" />
          <span className="text-fg/80">Live</span>
        </span>
      );
    case "failed":
      return (
        <span className={cn("flex items-center text-red-300", gapCls, textCls)}>
          <span className="h-2 w-2 rounded-full bg-red-500" />
          <span className="truncate">
            {compact
              ? "Build failed"
              : `Build failed${typeof pill.exitCode === "number" ? ` (exit ${pill.exitCode})` : ""}`}
          </span>
        </span>
      );
    case "ended":
      return (
        <span className={cn("flex items-center", gapCls, textCls)}>
          <span className="h-2 w-2 rounded-full bg-muted" />
          <span className="text-muted">{compact ? "Ended" : "Session ended"}</span>
        </span>
      );
    case "error":
      return (
        <span className={cn("flex items-center text-red-300", gapCls, textCls)}>
          <span className="h-2 w-2 rounded-full bg-red-500" />
          <span className="truncate" title={pill.message}>
            {compact ? "Error" : pill.message}
          </span>
        </span>
      );
  }
}

function BuildingPill({ startedAt, compact = false }: { startedAt: number; compact?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const seconds = Math.floor((now - startedAt) / 1000);
  return (
    <span className={cn("flex items-center", compact ? "gap-1.5 text-[10px]" : "gap-2 text-xs")}>
      <Loader2 size={compact ? 10 : 12} className="animate-spin text-amber-400" />
      <span className="text-fg/80">
        Building <span className="font-mono text-muted">{formatTimer(seconds)}</span>
      </span>
    </span>
  );
}

function formatTimer(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function CenterContent({
  pill,
  hasCalibration,
}: {
  pill: PillState;
  hasCalibration: boolean;
}): React.JSX.Element | null {
  if (pill.kind === "live") return null;
  if (pill.kind === "failed") {
    return (
      <div className="max-w-sm px-6 text-center">
        <p className="mb-2 font-semibold text-red-300">Build failed</p>
        <p className="text-xs text-muted">
          Expand the log below for xcodebuild output. Fix the error in the editor and
          click <span className="text-fg/80">Refresh build</span>.
        </p>
      </div>
    );
  }
  if (pill.kind === "ended") {
    const inactive = pill.reason === "inactivity";
    return (
      <div className="max-w-sm px-6 text-center text-muted">
        <p className="mb-1 font-semibold">
          {inactive ? "Closed for inactivity" : "Session ended"}
        </p>
        <p className="text-xs">
          {inactive
            ? "The simulator was shut down after 3 minutes of inactivity. Click Preview to start a new one."
            : "Click Preview again to start a new one."}
        </p>
      </div>
    );
  }
  return (
    <div className="max-w-sm px-6 text-center text-muted">
      <p className="mb-1 font-semibold">
        {pill.kind === "starting" ? "Starting Swift preview" : "Working…"}
      </p>
      <p className="text-xs">
        {hasCalibration
          ? "Stream wiring up — first frame imminent."
          : "Provisioning a Mac simulator and building your app."}
      </p>
    </div>
  );
}
