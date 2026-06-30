"use client";

import { Input } from "@/components/ui/input";
import React, { useState, useRef, useCallback, useEffect } from "react";
import html2canvas from "html2canvas";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import {
  RefreshCw,
  ExternalLink,
  Monitor,
  Smartphone,
  Tablet,
  RotateCcw,
  ChevronDown,
  Play,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { VisualEditorPanel } from "@/components/workspace/VisualEditorPanel";
import { renderHtmlThumbnail } from "@/lib/html-thumbnail";
import { PreviewInfo } from "@/lib/preview-store";
import {
  isWebLikePlatform,
  type ProjectPlatform,
} from "@/lib/project-platform";

interface PreviewProps {
  previews: PreviewInfo[];
  activePreviewIndex: number;
  onActivePreviewChange: (index: number) => void;
  // Optional to allow headerless/controlled mode
  showHeader?: boolean;
  currentPath?: string;
  selectedDevice?: keyof typeof DEVICE_SIZES;
  isLandscape?: boolean;
  reloadKey?: number;
  // Dev server control
  isDevServerRunning?: boolean;
  isInstalling?: boolean;
  isStartingServer?: boolean;
  onToggleDevServer?: () => void;
  platform?: ProjectPlatform;
  expUrl?: string | null;
  htmlSnapshotUrl?: string | null;
  isAgentWorking?: boolean;
  /** True while the agent is working on the very FIRST message of a brand-new
   *  project. Drives the loading carousel / blur veil over the live preview.
   *  Follow-up messages never blur. */
  isInitialBuild?: boolean;
  /** Fetch page HTML via WebContainer (bypasses CORS) */
  onFetchHtml?: (url: string) => Promise<string>;
  /** Visual editor: when true, clicking an element in the preview selects it. */
  editMode?: boolean;
  /** Visual editor: called when an element is selected in the preview. */
  onElementSelected?: (selection: BfSelection | null) => void;
  /** Visual editor: project id, required for committing edits. */
  projectId?: string;
}

/** A visual-editor selection reported by the in-iframe runtime. */
export interface BfSelection {
  loc: string | null;
  id: string | null;
  tag: string;
  className: string;
  text: string;
  computed: Record<string, string>;
  /** Element bounds in the iframe's own viewport coordinates. */
  rect: { left: number; top: number; width: number; height: number };
}

/** A box positioned in parent-viewport (fixed) coordinates. */
export interface BfBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

const DEVICE_SIZES = {
  desktop: { name: "Desktop", width: "100%", height: "100%", icon: Monitor },
  tablet: { name: "Tablet", width: 768, height: 1024, icon: Tablet },
  mobile: { name: "Mobile", width: 375, height: 667, icon: Smartphone },
  responsive: { name: "Responsive", width: "100%", height: "100%", icon: Monitor },
  figma: { name: "Figma", width: "100%", height: "100%", icon: Monitor },
};

const RESPONSIVE_VIEWPORTS = [
  { key: "desktop", label: "Desktop", width: 1440, height: 900 },
  { key: "tablet", label: "Tablet", width: 768, height: 1024 },
  { key: "mobile", label: "Mobile", width: 375, height: 812 },
] as const;

/* ──────────────────────────────────────────
   Responsive Canvas – Figma-style multi-viewport view
   Each iframe uses its standard viewport dimensions so
   media-queries and vh units behave correctly.
   ────────────────────────────────────────── */
function ResponsiveCanvas({ iframeUrl }: { iframeUrl: string }) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(0.3);
  const [pan, setPan] = useState({ x: 40, y: 40 });
  const isPanning = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });

  // Wheel to zoom (Ctrl/Cmd+scroll) or pan (regular scroll)
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setZoom((z) => Math.min(1.5, Math.max(0.08, z - e.deltaY * 0.001)));
    } else {
      setPan((p) => ({
        x: p.x - e.deltaX,
        y: p.y - e.deltaY,
      }));
    }
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1 || (e.target as HTMLElement).dataset.canvas === "bg") {
      e.preventDefault();
      isPanning.current = true;
      lastMouse.current = { x: e.clientX, y: e.clientY };
    }
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning.current) return;
    const dx = e.clientX - lastMouse.current.x;
    const dy = e.clientY - lastMouse.current.y;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
  }, []);

  const handleMouseUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  const GAP = 60;

  return (
    <div
      ref={canvasRef}
      className="w-full h-full overflow-hidden relative select-none"
      style={{
        background: `radial-gradient(circle, var(--color-border) 1px, transparent 1px)`,
        backgroundSize: "24px 24px",
        cursor: isPanning.current ? "grabbing" : "default",
      }}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      data-canvas="bg"
    >
      {/* Zoom controls */}
      <div className="absolute top-3 right-3 z-20 flex items-center gap-2 bg-elevated/95 backdrop-blur-sm border border-border rounded-full px-3 py-1.5 shadow-sm">
        <button
          onClick={() => setZoom((z) => Math.max(0.08, z - 0.05))}
          className="text-muted hover:text-fg text-sm font-medium w-5 h-5 flex items-center justify-center"
        >
          -
        </button>
        <span className="text-xs text-muted min-w-[40px] text-center tabular-nums">
          {Math.round(zoom * 100)}%
        </span>
        <button
          onClick={() => setZoom((z) => Math.min(1.5, z + 0.05))}
          className="text-muted hover:text-fg text-sm font-medium w-5 h-5 flex items-center justify-center"
        >
          +
        </button>
        <div className="w-px h-3 bg-border" />
        <button
          onClick={() => {
            setZoom(0.3);
            setPan({ x: 40, y: 40 });
          }}
          className="text-xs text-muted hover:text-fg"
        >
          Reset
        </button>
      </div>

      {/* Pannable & zoomable surface */}
      <div
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: "0 0",
        }}
        className="flex items-start"
        data-canvas="bg"
      >
        {RESPONSIVE_VIEWPORTS.map((vp, i) => (
          <div
            key={vp.key}
            style={{ marginLeft: i === 0 ? 0 : GAP, width: vp.width }}
            className="flex-shrink-0"
          >
            {/* Top bar */}
            <div
              className="flex items-center justify-between px-4 py-2"
              style={{
                background: "var(--color-accent)",
                borderTop: "3px solid var(--color-accent)",
                borderLeft: "2px solid var(--color-accent)",
                borderRight: "2px solid var(--color-accent)",
              }}
            >
              <span className="text-accent-foreground text-sm font-semibold">
                {vp.label}
              </span>
              <span className="text-accent-foreground/70 text-xs tabular-nums">
                {vp.width} x {vp.height}
              </span>
            </div>

            {/* Iframe container */}
            <div
              className="overflow-hidden bg-white"
              style={{
                width: vp.width,
                height: vp.height,
                borderLeft: "2px solid var(--color-accent)",
                borderRight: "2px solid var(--color-accent)",
                borderBottom: "2px solid var(--color-accent)",
              }}
            >
              <iframe
                src={iframeUrl || undefined}
                style={{
                  width: vp.width,
                  height: vp.height,
                  border: "none",
                  display: "block",
                }}
                title={`${vp.label} Preview`}
                sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-storage-access-by-user-activation"
                allow="cross-origin-isolated"
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────
   Figma Canvas – Static full-page capture view

   1. HTML is fetched via WebContainer (bypasses CORS)
   2. Rendered in hidden same-origin srcdoc iframes at correct viewport dims
   3. Captured to images via html2canvas (windowHeight preserves correct vh)
   4. Displayed as static <img> elements – no iframes, no scrollbars
   ────────────────────────────────────────── */
const FIGMA_VIEWPORTS = [
  { key: "desktop", label: "Desktop", width: 1440, height: 900 },
  { key: "tablet", label: "Tablet", width: 768, height: 1024 },
  { key: "mobile", label: "Mobile", width: 375, height: 812 },
] as const;

interface CapturedFrame {
  key: string;
  label: string;
  width: number;
  height: number;
  dataUrl: string;
}

function FigmaCanvas({
  previewUrl,
  reloadKey,
  fetchHtml,
}: {
  previewUrl: string;
  reloadKey: number;
  fetchHtml: (url: string) => Promise<string>;
}) {
  const [zoom, setZoom] = useState(0.3);
  const [pan, setPan] = useState({ x: 40, y: 40 });
  const isPanning = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const [frames, setFrames] = useState<CapturedFrame[]>([]);
  const [isCapturing, setIsCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const captureId = useRef(0);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setZoom((z) => Math.min(1.5, Math.max(0.08, z - e.deltaY * 0.001)));
    } else {
      setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
    }
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (
      e.button === 1 ||
      (e.target as HTMLElement).dataset.canvas === "bg"
    ) {
      e.preventDefault();
      isPanning.current = true;
      lastMouse.current = { x: e.clientX, y: e.clientY };
    }
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning.current) return;
    setPan((p) => ({
      x: p.x + e.clientX - lastMouse.current.x,
      y: p.y + e.clientY - lastMouse.current.y,
    }));
    lastMouse.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  /* Capture a single viewport from the fetched HTML */
  const captureViewport = useCallback(
    (
      html: string,
      vp: (typeof FIGMA_VIEWPORTS)[number],
      thisCapture: number,
    ): Promise<CapturedFrame | null> =>
      new Promise((resolve) => {
        if (captureId.current !== thisCapture) return resolve(null);

        const iframe = document.createElement("iframe");
        iframe.style.cssText = `position:fixed;left:-9999px;top:0;width:${vp.width}px;height:${vp.height}px;border:none;visibility:hidden;`;
        iframe.setAttribute("sandbox", "allow-same-origin allow-scripts");
        document.body.appendChild(iframe);
        iframe.srcdoc = html;

        iframe.onload = async () => {
          try {
            // Give JS time to hydrate / render
            await new Promise((r) => setTimeout(r, 1500));
            if (captureId.current !== thisCapture) {
              document.body.removeChild(iframe);
              return resolve(null);
            }

            const doc = iframe.contentDocument;
            if (!doc) throw new Error("No contentDocument");

            const scrollH = doc.documentElement.scrollHeight;

            const canvas = await html2canvas(
              doc.documentElement,
              {
                width: vp.width,
                height: scrollH,
                useCORS: true,
                logging: false,
                imageTimeout: 8000,
                // windowHeight keeps 100vh at the real viewport height
                // even though we capture the full scrollHeight
                windowWidth: vp.width,
                windowHeight: vp.height,
              } as Parameters<typeof html2canvas>[1],
            );

            const dataUrl = canvas.toDataURL("image/png");
            document.body.removeChild(iframe);

            resolve({
              key: vp.key,
              label: vp.label,
              width: vp.width,
              height: scrollH,
              dataUrl,
            });
          } catch (err) {
            console.error(`Figma capture ${vp.label}:`, err);
            if (iframe.parentNode) document.body.removeChild(iframe);
            resolve(null);
          }
        };
      }),
    [],
  );

  /* Capture all viewports */
  const captureAll = useCallback(async () => {
    if (!previewUrl) return;
    const thisCapture = ++captureId.current;
    setIsCapturing(true);
    setError(null);

    try {
      let html = await fetchHtml(previewUrl);

      // Inject <base> so relative asset URLs (JS/CSS/images) resolve
      // to the preview server origin
      const baseTag = `<base href="${previewUrl}">`;
      if (html.includes("<head>")) {
        html = html.replace("<head>", `<head>${baseTag}`);
      } else {
        html = `<head>${baseTag}</head>` + html;
      }

      // Disable animations/transitions for a clean static capture
      html = html.replace(
        "</head>",
        `<style>*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;scroll-behavior:auto!important;}</style></head>`,
      );

      const results: CapturedFrame[] = [];
      for (const vp of FIGMA_VIEWPORTS) {
        const frame = await captureViewport(html, vp, thisCapture);
        if (frame) results.push(frame);
      }

      if (captureId.current === thisCapture) {
        setFrames(results);
      }
    } catch (err) {
      console.error("Figma capture failed:", err);
      if (captureId.current === thisCapture) {
        setError(
          "Could not capture preview. Make sure the dev server is running.",
        );
      }
    } finally {
      if (captureId.current === thisCapture) {
        setIsCapturing(false);
      }
    }
  }, [previewUrl, fetchHtml, captureViewport]);

  // Capture on mount and when reloadKey changes
  useEffect(() => {
    captureAll();
  }, [captureAll, reloadKey]);

  const GAP = 60;

  return (
    <div
      className="w-full h-full overflow-hidden relative select-none"
      style={{
        background: `radial-gradient(circle, var(--color-border) 1px, transparent 1px)`,
        backgroundSize: "24px 24px",
        cursor: isPanning.current ? "grabbing" : "default",
      }}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      data-canvas="bg"
    >
      {/* Zoom controls */}
      <div className="absolute top-3 right-3 z-20 flex items-center gap-2 bg-elevated/95 backdrop-blur-sm border border-border rounded-full px-3 py-1.5 shadow-sm">
        <button
          onClick={() => setZoom((z) => Math.max(0.08, z - 0.05))}
          className="text-muted hover:text-fg text-sm font-medium w-5 h-5 flex items-center justify-center"
        >
          &minus;
        </button>
        <span className="text-xs text-muted min-w-[40px] text-center tabular-nums">
          {Math.round(zoom * 100)}%
        </span>
        <button
          onClick={() => setZoom((z) => Math.min(1.5, z + 0.05))}
          className="text-muted hover:text-fg text-sm font-medium w-5 h-5 flex items-center justify-center"
        >
          +
        </button>
        <div className="w-px h-3 bg-border" />
        <button
          onClick={() => {
            setZoom(0.3);
            setPan({ x: 40, y: 40 });
          }}
          className="text-xs text-muted hover:text-fg"
        >
          Reset
        </button>
        <div className="w-px h-3 bg-border" />
        <button
          onClick={captureAll}
          disabled={isCapturing}
          className="text-xs text-muted hover:text-fg disabled:opacity-50"
        >
          {isCapturing ? "Capturing…" : "Recapture"}
        </button>
      </div>

      {/* Loading overlay */}
      {isCapturing && frames.length === 0 && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center"
          data-canvas="bg"
        >
          <div className="flex flex-col items-center gap-3 bg-elevated/95 backdrop-blur-sm border border-border rounded-xl px-6 py-4 shadow-lg">
            <span className="inline-flex h-6 w-6 rounded-full border-2 border-accent border-t-transparent animate-spin" />
            <span className="text-sm text-muted">
              Capturing viewports…
            </span>
          </div>
        </div>
      )}

      {/* Error state */}
      {error && !isCapturing && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center"
          data-canvas="bg"
        >
          <div className="flex flex-col items-center gap-3 bg-elevated/95 backdrop-blur-sm border border-border rounded-xl px-6 py-4 shadow-lg max-w-sm text-center">
            <span className="text-sm text-muted">{error}</span>
            <button
              onClick={captureAll}
              className="text-xs text-accent hover:underline"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Pannable & zoomable surface — static images, no iframes */}
      <div
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: "0 0",
        }}
        className="flex items-start"
        data-canvas="bg"
      >
        {frames.map((frame, i) => (
          <div
            key={frame.key}
            style={{ marginLeft: i === 0 ? 0 : GAP, width: frame.width }}
            className="flex-shrink-0"
          >
            {/* Top bar */}
            <div
              className="flex items-center justify-between px-4 py-2"
              style={{
                background: "var(--color-accent)",
                borderTop: "3px solid var(--color-accent)",
                borderLeft: "2px solid var(--color-accent)",
                borderRight: "2px solid var(--color-accent)",
              }}
            >
              <span className="text-accent-foreground text-sm font-semibold">
                {frame.label}
              </span>
              <span className="text-accent-foreground/70 text-xs tabular-nums">
                {frame.width} x {frame.height}
              </span>
            </div>

            {/* Captured image — full page, no scrollbar */}
            <div
              style={{
                width: frame.width,
                borderLeft: "2px solid var(--color-accent)",
                borderRight: "2px solid var(--color-accent)",
                borderBottom: "2px solid var(--color-accent)",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={frame.dataUrl}
                alt={`${frame.label} – ${frame.width}×${frame.height}`}
                style={{ width: frame.width, display: "block" }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const LOADING_MESSAGES = [
  "Setting up your project...",
  "Scaffolding files and folders...",
  "Installing dependencies...",
  "Configuring your app...",
  "Writing components...",
  "Almost there...",
  "Putting the finishing touches on...",
  "Brewing some code...",
];

function AgentLoadingCarousel() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setIndex((prev) => (prev + 1) % LOADING_MESSAGES.length);
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="text-center max-w-md px-6">
      <div className="flex items-center justify-center mb-4">
        <span className="inline-flex h-8 w-8 rounded-full border-2 border-accent border-t-transparent animate-spin" />
      </div>
      <p
        className="text-lg font-medium text-fg transition-opacity duration-500"
        key={index}
      >
        {LOADING_MESSAGES[index]}
      </p>
      <p className="text-sm text-muted mt-2">
        The agent is building your app
      </p>
    </div>
  );
}

export function Preview({
  previews,
  activePreviewIndex,
  onActivePreviewChange,
  showHeader = true,
  currentPath,
  selectedDevice,
  isLandscape,
  reloadKey,
  isDevServerRunning,
  isInstalling,
  isStartingServer,
  onToggleDevServer,
  platform = "web",
  expUrl,
  htmlSnapshotUrl,
  isAgentWorking,
  isInitialBuild,
  onFetchHtml,
  editMode = false,
  onElementSelected,
  projectId,
}: PreviewProps) {
  const [internalDevice, setInternalDevice] =
    useState<keyof typeof DEVICE_SIZES>("desktop");
  const [internalLandscape, setInternalLandscape] = useState(false);
  const [isPortDropdownOpen, setIsPortDropdownOpen] = useState(false);
  const [internalPath, setInternalPath] = useState("/");
  const [iframeUrl, setIframeUrl] = useState<string>("");
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Scale device SVG to fit container height
  const deviceContainerRef = useRef<HTMLDivElement>(null);
  const deviceOuterRef = useRef<HTMLDivElement>(null);
  const [deviceScale, setDeviceScale] = useState(1);
  const [fitMode, setFitMode] = useState<"height" | "width">("height");
  const [zoom, setZoom] = useState(1);
  const [showSnapshot, setShowSnapshot] = useState(true);
  const [snapshotHtml, setSnapshotHtml] = useState<string | null>(null);
  const [isRealPreviewLoaded, setIsRealPreviewLoaded] = useState(false);
  // De-blur staging: once the real preview has loaded behind the snapshot,
  // we flip to "clearing" (CSS transition animates the blur/opacity away),
  // then unmount the overlay entirely.
  const [veilClearing, setVeilClearing] = useState(false);
  // Initial-build veil (first prompt of a new project): blur over the live
  // preview with the loading carousel on top. The X lets the user peek.
  const [initialVeilDismissed, setInitialVeilDismissed] = useState(false);
  const [initialVeilClearing, setInitialVeilClearing] = useState(false);
  const [showInitialVeil, setShowInitialVeil] = useState(true);
  // Multiplatform: toggle between web and mobile preview modes
  const [multiPreviewMode, setMultiPreviewMode] = useState<"web" | "mobile">("web");

  // Visual editor overlay state. Boxes are in parent-viewport (fixed) coords.
  const [hoverBox, setHoverBox] = useState<BfBox | null>(null);
  const [selectedBox, setSelectedBox] = useState<BfBox | null>(null);
  const [selection, setSelection] = useState<BfSelection | null>(null);
  const editModeRef = useRef(editMode);
  editModeRef.current = editMode;

  const activePreview = previews[activePreviewIndex];

  // Translate an iframe-viewport rect into parent-viewport (fixed) coords.
  const toParentBox = useCallback(
    (rect: { left: number; top: number; width: number; height: number }): BfBox | null => {
      const el = iframeRef.current;
      if (!el) return null;
      const ir = el.getBoundingClientRect();
      return {
        left: ir.left + rect.left,
        top: ir.top + rect.top,
        width: rect.width,
        height: rect.height,
      };
    },
    [],
  );

  const postToIframe = useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(msg, "*");
  }, []);

  // Enable/disable the in-iframe runtime when editMode flips.
  useEffect(() => {
    postToIframe({ type: editMode ? "BF_EDITOR_ENABLE" : "BF_EDITOR_DISABLE" });
    if (!editMode) {
      setHoverBox(null);
      setSelectedBox(null);
      setSelection(null);
      onElementSelected?.(null);
    }
  }, [editMode, postToIframe, onElementSelected]);

  // Receive selection/hover events from the in-iframe runtime.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (
        !event.origin.endsWith(".vercel.run") &&
        !event.origin.startsWith("http://localhost")
      ) {
        return;
      }
      const data = event.data as Record<string, unknown> | undefined;
      if (!data || typeof data !== "object") return;

      switch (data.type) {
        case "BF_EDITOR_READY":
          // Runtime (re)loaded — sync current mode.
          postToIframe({
            type: editModeRef.current ? "BF_EDITOR_ENABLE" : "BF_EDITOR_DISABLE",
          });
          break;
        case "BF_EDITOR_HOVER": {
          const rect = data.rect as BfSelection["rect"] | null;
          setHoverBox(rect ? toParentBox(rect) : null);
          break;
        }
        case "BF_EDITOR_SELECTED": {
          const sel = data as unknown as BfSelection;
          setSelection(sel);
          setSelectedBox(toParentBox(sel.rect));
          onElementSelected?.(sel);
          break;
        }
        case "BF_EDITOR_RECT": {
          // Selected element moved (scroll/resize) — keep the outline aligned.
          const rect = data.rect as BfSelection["rect"] | null;
          if (rect) setSelectedBox(toParentBox(rect));
          break;
        }
        default:
          break;
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [postToIframe, toParentBox, onElementSelected]);

  // Fetch HTML snapshot content
  useEffect(() => {
    if (htmlSnapshotUrl && !snapshotHtml) {
      fetch(htmlSnapshotUrl)
        .then(res => res.text())
        .then(html => setSnapshotHtml(html))
        .catch(err => console.error('Failed to fetch HTML snapshot:', err));
    }
  }, [htmlSnapshotUrl, snapshotHtml]);

  // Hide the snapshot only when the real preview has loaded — and do it in two
  // stages: ~400ms settle (avoids a white flash while the app paints), then a
  // 700ms de-blur transition, then unmount.
  useEffect(() => {
    if (!(isDevServerRunning && isRealPreviewLoaded && showSnapshot)) return;
    const settle = setTimeout(() => setVeilClearing(true), 400);
    const done = setTimeout(() => {
      setShowSnapshot(false);
      setVeilClearing(false);
    }, 400 + 750);
    return () => {
      clearTimeout(settle);
      clearTimeout(done);
    };
  }, [isDevServerRunning, isRealPreviewLoaded, showSnapshot]);

  // Show snapshot again when dev server stops
  useEffect(() => {
    if (!isDevServerRunning) {
      setShowSnapshot(true);
      setVeilClearing(false);
      setIsRealPreviewLoaded(false);
    }
  }, [isDevServerRunning]);

  // ── Initial-build veil lifecycle ─────────────────────────────────────
  // While the agent works on the project's first message, the live preview is
  // veiled. When that first turn ends, animate the veil away (same de-blur).
  useEffect(() => {
    if (isInitialBuild) {
      setShowInitialVeil(true);
      setInitialVeilClearing(false);
      return;
    }
    if (!showInitialVeil) return;
    setInitialVeilClearing(true);
    const done = setTimeout(() => {
      setShowInitialVeil(false);
      setInitialVeilClearing(false);
    }, 750);
    return () => clearTimeout(done);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInitialBuild]);

  // ── Snapshot capture (sandboxed-web only) ────────────────────────────
  // Ask the injected runtime inside the live iframe for a serialized render of
  // the DOM (BF_SNAPSHOT_REQUEST → BF_SNAPSHOT_RESULT), then persist it (plus
  // an html2canvas thumbnail) via POST /api/projects/:id/snapshot. Triggers:
  //   1. ~8s after the real preview loads (fresh "last seen" state).
  //   2. When the agent finishes a turn while the server runs (it likely
  //      changed the app).
  // Uploads are throttled to one per 30s.
  const lastSnapshotUploadAtRef = useRef(0);
  const snapshotUploadInFlightRef = useRef(false);
  const prevAgentWorkingRef = useRef(Boolean(isAgentWorking));

  const requestSnapshotGrab = useCallback(() => {
    if (platform !== "sandboxed-web" || !projectId) return;
    if (!iframeRef.current?.contentWindow) return;
    if (snapshotUploadInFlightRef.current) return;
    if (Date.now() - lastSnapshotUploadAtRef.current < 30_000) return;
    iframeRef.current.contentWindow.postMessage(
      { type: "BF_SNAPSHOT_REQUEST", id: Date.now() },
      "*",
    );
  }, [platform, projectId]);

  useEffect(() => {
    if (platform !== "sandboxed-web" || !projectId) return;

    async function handleResult(event: MessageEvent) {
      if (
        !event.origin.endsWith(".vercel.run") &&
        !event.origin.startsWith("http://localhost")
      ) return;
      const data = event.data as { type?: string; html?: string | null } | null;
      if (!data || data.type !== "BF_SNAPSHOT_RESULT") return;
      if (typeof data.html !== "string" || !data.html.trim()) return;
      if (snapshotUploadInFlightRef.current) return;
      if (Date.now() - lastSnapshotUploadAtRef.current < 30_000) return;

      snapshotUploadInFlightRef.current = true;
      try {
        const html = data.html;
        const thumbnailDataUrl = await renderHtmlThumbnail(html);
        const res = await fetch(`/api/projects/${projectId}/snapshot`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            html,
            ...(thumbnailDataUrl ? { thumbnailDataUrl } : {}),
          }),
        });
        if (res.ok) {
          lastSnapshotUploadAtRef.current = Date.now();
          // Keep the in-memory copy fresh so the next stopped state shows
          // what the user just saw, not a stale fetch of the old URL.
          setSnapshotHtml(html);
        }
      } catch (err) {
        console.warn("[snapshot] upload failed:", err);
      } finally {
        snapshotUploadInFlightRef.current = false;
      }
    }

    window.addEventListener("message", handleResult);
    return () => window.removeEventListener("message", handleResult);
  }, [platform, projectId]);

  // Trigger 1: after the real preview loads.
  useEffect(() => {
    if (!isRealPreviewLoaded || !isDevServerRunning) return;
    const t = setTimeout(() => requestSnapshotGrab(), 8_000);
    return () => clearTimeout(t);
  }, [isRealPreviewLoaded, isDevServerRunning, requestSnapshotGrab]);

  // Trigger 2: agent finished a turn while the server is running.
  useEffect(() => {
    const was = prevAgentWorkingRef.current;
    prevAgentWorkingRef.current = Boolean(isAgentWorking);
    if (was && !isAgentWorking && isDevServerRunning && isRealPreviewLoaded) {
      // Give HMR a moment to apply the agent's last edits.
      const t = setTimeout(() => requestSnapshotGrab(), 2_000);
      return () => clearTimeout(t);
    }
  }, [isAgentWorking, isDevServerRunning, isRealPreviewLoaded, requestSnapshotGrab]);

  const reloadPreview = useCallback(() => {
    if (iframeRef.current && iframeRef.current.src) {
      // Add cache-busting timestamp to force fresh reload
      const url = new URL(iframeRef.current.src);
      url.searchParams.set("_t", Date.now().toString());
      iframeRef.current.src = url.toString();
    }
  }, []);

  const openInNewTab = useCallback(() => {
    if (activePreview?.baseUrl) {
      const previewUrl = activePreview.baseUrl + (currentPath ?? internalPath ?? "/");
      window.open(
        `/preview-popup?url=${encodeURIComponent(previewUrl)}`,
        "_blank"
      );
    }
  }, [activePreview, currentPath, internalPath]);

  const handlePathChange = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        const newPath = (e.target as HTMLInputElement).value;
        const normalizedPath = newPath.startsWith("/")
          ? newPath
          : "/" + newPath;
        setInternalPath(normalizedPath);

        if (activePreview) {
          // Add cache-busting to ensure fresh content
          const url = new URL(activePreview.baseUrl + normalizedPath);
          url.searchParams.set("_t", Date.now().toString());
          setIframeUrl(url.toString());
        }
      }
    },
    [activePreview],
  );

  // Update iframe URL when active preview or path changes
  useEffect(() => {
    const path = (currentPath ?? internalPath) || "/";
    if (activePreview) {
      // Add cache-busting to prevent stale content from being displayed
      const url = new URL(activePreview.baseUrl + path);
      url.searchParams.set("_t", Date.now().toString());
      setIframeUrl(url.toString());
      // Reset loaded state when URL changes so we wait for new content
      setIsRealPreviewLoaded(false);
    }
  }, [activePreview, currentPath, internalPath]);

  // Auto-scale the device mockup to fit available height/width with padding
  useEffect(() => {
    const outer = deviceOuterRef.current;
    if (!outer) return;
    const ro = new ResizeObserver(() => {
      const h = outer.clientHeight;
      const w = outer.clientWidth;
      const targetH = 881;
      const targetW = 427;
      const padding = 36; // account for top/bottom bars and controls
      const base =
        fitMode === "height"
          ? (h - padding) / targetH
          : (w - padding) / targetW;
      const comfort = base * 0.92 * zoom; // a touch smaller to avoid edge contact
      setDeviceScale(Math.max(0.2, Math.min(comfort, 2)));
    });
    ro.observe(outer);
    return () => ro.disconnect();
  }, [fitMode, zoom]);

  // React to external reload requests
  useEffect(() => {
    if (reloadKey != null) {
      reloadPreview();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  const effectiveDevice = selectedDevice ?? internalDevice;
  const effectiveLandscape = isLandscape ?? internalLandscape;

  const getIframeStyles = useCallback(() => {
    if (effectiveDevice === "desktop" || effectiveDevice === "responsive" || effectiveDevice === "figma") {
      return { width: "100%", height: "100%" };
    }

    const device = DEVICE_SIZES[effectiveDevice];
    const width = effectiveLandscape ? device.height : device.width;
    const height = effectiveLandscape ? device.width : device.height;

    return {
      width: `${width}px`,
      height: `${height}px`,
      maxWidth: "100%",
      maxHeight: "100%",
    };
  }, [effectiveDevice, effectiveLandscape]);

  if (!activePreview) {
    // Show HTML snapshot if available. snapshotHtml can come from the stored
    // UploadThing URL (prop) or from a grab taken earlier in this session.
    if (snapshotHtml) {
      // Mobile platform - show snapshot in iPhone mockup
      if (platform === "mobile" || (platform === "multiplatform" && multiPreviewMode === "mobile")) {
        return (
          <div className="h-full grid grid-cols-1 md:grid-cols-2 gap-3 p-3 overflow-hidden bg-surface rounded-xl border border-border">
            {/* Left: QR code + Expo Go install guidance */}
            <div className="rounded-xl border border-border bg-elevated p-5 flex flex-col items-center justify-center min-h-[320px] gap-4">
              <div className="flex items-center gap-3">
                <Image
                  src="/ExpoIcon76x76.png"
                  alt="Expo Go"
                  width={44}
                  height={44}
                  className="rounded-[22%] shadow"
                />
                <div className="flex flex-col">
                  <div className="text-sm font-semibold text-fg">Expo Go</div>
                  <div className="text-xs text-muted">
                    Install the app to open the QR
                  </div>
                </div>
              </div>
              <div className="text-center text-sm text-muted">
                Start the server to generate an Expo URL
              </div>
              <div className="flex items-center gap-2 mt-1">
                <a
                  href="https://apps.apple.com/us/app/expo-go/id982107779"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs px-3 py-1.5 rounded-full border border-border bg-white hover:bg-neutral-50 transition text-neutral-800"
                  title="Download on the App Store"
                >
                  App Store
                </a>
                <a
                  href="https://play.google.com/store/apps/details?id=host.exp.exponent&hl=en_US&pli=1"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs px-3 py-1.5 rounded-full border border-border bg-white hover:bg-neutral-50 transition text-neutral-800"
                  title="Get it on Google Play"
                >
                  Google Play
                </a>
              </div>
            </div>
            {/* Right: iPhone 15 SVG mockup with embedded snapshot iframe */}
            <div className="relative flex items-center justify-center overflow-hidden">
              {/* Controls overlay */}
              <div className="absolute top-2 right-2 z-10 bg-elevated/90 backdrop-blur-sm border border-border rounded-full px-2 py-1 flex items-center gap-2">
                <button
                  className={cn(
                    "text-xs px-2 py-0.5 rounded-full",
                    fitMode === "height"
                      ? "bg-accent text-accent-foreground"
                      : "text-muted hover:text-fg",
                  )}
                  onClick={() => setFitMode("height")}
                  title="Fit to height"
                >
                  H
                </button>
                <button
                  className={cn(
                    "text-xs px-2 py-0.5 rounded-full",
                    fitMode === "width"
                      ? "bg-accent text-accent-foreground"
                      : "text-muted hover:text-fg",
                  )}
                  onClick={() => setFitMode("width")}
                  title="Fit to width"
                >
                  W
                </button>
                <input
                  type="range"
                  min={0.8}
                  max={1.2}
                  step={0.02}
                  value={zoom}
                  onChange={(e) => setZoom(parseFloat(e.target.value))}
                  className="w-24"
                  title="Zoom"
                />
              </div>
              <div
                ref={deviceOuterRef}
                className="w-full h-full flex items-center justify-center mt-52"
              >
                <div
                  ref={deviceContainerRef}
                  className="relative"
                  style={{
                    width: 427,
                    height: 881,
                    transform: `scale(${deviceScale})`,
                    transformOrigin: "top center",
                  }}
                  dangerouslySetInnerHTML={{
                    __html: `
<svg width="393" height="852" viewBox="0 0 427 881" fill="none" xmlns="http://www.w3.org/2000/svg" class="w-full h-full" filter="url(#shadow)">
  <defs>
    <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="8" stdDeviation="16" flood-color="rgba(0,0,0,0.15)"></feDropShadow>
    </filter>
    <filter id="filter0_f_2905_1090" x="-0.166992" y="0.166504" width="427" height="880.667" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood>
      <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend>
      <feGaussianBlur stdDeviation="0.5" result="effect1_foregroundBlur_2905_1090"></feGaussianBlur>
    </filter>
    <filter id="filter1_f_2905_1090" x="6.33236" y="6.33382" width="414" height="868" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood>
      <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend>
      <feGaussianBlur stdDeviation="0.333333" result="effect1_foregroundBlur_2905_1090"></feGaussianBlur>
    </filter>
    <clipPath id="clip0_2905_1090"><rect width="426.667" height="880.667" rx="70" fill="white"></rect></clipPath>
    <clipPath id="clip1_2905_1090"><rect x="18" y="18" width="390" height="844" rx="55" fill="white"></rect></clipPath>
  </defs>
  <g clip-path="url(#clip0_2905_1090)">
    <rect width="426.667" height="880.667" rx="70" fill="black"></rect>
    <rect x="3.83268" y="3.83366" width="419" height="873" rx="66.1667" class="stroke-[#dcdcdf] dark:stroke-[#454548]" stroke-width="4.33333"></rect>
    <rect x="0.833333" y="0.833333" width="425" height="879" rx="69.1667" class="stroke-[#c1c2c4] dark:stroke-[#37373a]" stroke-width="1.66667"></rect>
    <g opacity="0.9" filter="url(#filter0_f_2905_1090)"><rect x="1.66602" y="2" width="423.333" height="877" rx="68.6667" class="stroke-[#b2b2b9] dark:stroke-[#454548]" stroke-width="1.66667"></rect></g>
    <g opacity="0.8" filter="url(#filter1_f_2905_1090)"><rect x="7.33268" y="7.33366" width="412" height="866" rx="62.6667" stroke="#646464" stroke-width="0.666667"></rect></g>
    <rect x="18" y="18" width="390" height="844" rx="55" fill="#ffffff" clip-path="url(#clip1_2905_1090)"></rect>
    <foreignObject x="18" y="18" width="390" height="844">
      <div class="size-full overflow-hidden rounded-[55.75px] object-contain relative" style="transform-origin: center center; background:#ffffff; padding-top:62px; padding-bottom:34px;">
        <div class="w-full h-full relative overflow-hidden">
          <iframe srcdoc="${snapshotHtml?.replace(/"/g, '&quot;').replace(/\$/g, '$$$$') || ""}" class="border-0 w-full select-none h-full" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" style="opacity: 0.6;"></iframe>
          <div class="flex flex-col items-center justify-center absolute inset-0 z-[3] bg-black/40 backdrop-blur-[1px]" style="transform-origin: center center;">
            <button class="flex items-center justify-center w-20 h-20 rounded-full bg-white/90 hover:bg-white hover:scale-110 shadow-2xl transition-all duration-300" onclick="this.innerHTML='<span class=\\'inline-flex h-8 w-8 rounded-full border-4 border-green-600 border-t-transparent animate-spin\\'></span>'">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M8 5v14l11-7z" fill="#16a34a" stroke="#16a34a" stroke-width="2" stroke-linejoin="round"/>
              </svg>
            </button>
            <p class="text-white text-sm font-medium drop-shadow-lg mt-4">${isInstalling ? "Installing dependencies..." : isStartingServer ? "Starting server..." : "Click to start dev server"}</p>
          </div>
        </div>
      </div>
    </foreignObject>
    <rect width="139" height="5" rx="2.5" transform="matrix(-1 0 0 1 284 849)" class="fill-[black] dark:fill-[#ffffffa2]"></rect>
    <path d="M73.7471 43.5257C76.5938 43.5257 78.966 45.522 78.966 50.0516V50.0695C78.966 54.3395 76.9876 56.8908 73.6934 56.8908C71.3032 56.8908 69.5129 55.5122 69.11 53.5607L69.0921 53.4622H71.3838L71.4106 53.5428C71.7598 54.429 72.5475 55.002 73.7023 55.002C75.7791 55.002 76.6475 53.0146 76.737 50.5708C76.7459 50.4365 76.7549 50.3022 76.7549 50.159H76.7012C76.1909 51.3407 74.9019 52.2358 73.1563 52.2358C70.6676 52.2358 68.9131 50.4455 68.9131 48.0195V48.0016C68.9131 45.3966 70.9631 43.5257 73.7471 43.5257ZM73.7471 50.4544C75.2241 50.4544 76.3521 49.416 76.3521 47.9748V47.9658C76.3521 46.5335 75.2241 45.4146 73.7739 45.4146C72.3416 45.4146 71.1868 46.5246 71.1868 47.9211V47.939C71.1868 49.4071 72.279 50.4544 73.7471 50.4544ZM81.8485 48.2165C81.1234 48.2165 80.5505 47.6436 80.5505 46.9185C80.5505 46.1934 81.1234 45.6294 81.8485 45.6294C82.5736 45.6294 83.1375 46.1934 83.1375 46.9185C83.1375 47.6436 82.5736 48.2165 81.8485 48.2165ZM81.8485 54.7871C81.1234 54.7871 80.5505 54.2142 80.5505 53.4891C80.5505 52.764 81.1234 52.2 81.8485 52.2C82.5736 52.2 83.1375 52.764 83.1375 53.4891C83.1375 54.2142 82.5736 54.7871 81.8485 54.7871ZM91.0778 56.667V54.1873H84.6325V52.2179L89.9946 43.7495H93.2799V52.2896H95.0345V54.1873H93.2799V56.667H91.0778ZM86.7093 52.3433H91.1136V45.4951H91.0599L86.7093 52.2806V52.3433ZM99.7163 56.667V45.9517H99.6626L96.3236 48.2433V46.1217L99.6984 43.7495H101.981V56.667H99.7163Z" class="fill-[black] dark:fill-[white]"></path>
    <g opacity="0.9"><rect x="297.333" y="50" width="3.33333" height="4" rx="0.333333" class="fill-[black] dark:fill-[white]"></rect><rect x="302" y="48" width="3.33333" height="6" rx="0.333333" class="fill-[black] dark:fill-[white]"></rect><rect x="307" y="45.667" width="3.33333" height="8.33333" rx="0.333333" class="fill-[black] dark:fill-[white]"></rect><rect x="311.666" y="43" width="3.33333" height="11" rx="0.333333" class="fill-[black] dark:fill-[white]"></rect></g>
    <g opacity="0.9"><path d="M341.382 45.8776C339.208 43.6888 336.196 42.3335 332.867 42.3335C329.528 42.3335 326.508 43.6969 324.333 45.8974L326.219 47.7831C327.911 46.0652 330.265 45.0002 332.867 45.0002C335.459 45.0002 337.805 46.057 339.496 47.7633L341.382 45.8776Z" class="fill-[black] dark:fill-[white]"></path><path d="M338.318 48.9418C336.928 47.5371 334.999 46.6668 332.867 46.6668C330.725 46.6668 328.788 47.5453 327.397 48.9616L329.283 50.8474C330.191 49.9136 331.462 49.3335 332.867 49.3335C334.263 49.3335 335.525 49.9053 336.432 50.8275L338.318 48.9418Z" class="fill-[black] dark:fill-[white]"></path><path d="M335.253 52.006C334.648 51.3855 333.803 51.0002 332.867 51.0002C331.922 51.0002 331.068 51.3938 330.462 52.0261L332.847 54.412L335.253 52.006Z" class="fill-[black] dark:fill-[white]"></path></g>
    <rect opacity="0.6" x="351.166" y="43.167" width="22.3333" height="10.6667" rx="2.16667" class="stroke-[black] dark:stroke-[white]"></rect>
    <rect opacity="0.9" x="352.333" y="44.3335" width="20" height="8.33333" rx="1.33333" class="fill-[black] dark:fill-[white]"></rect>
    <path opacity="0.6" d="M374.666 47V47C375.402 47 375.999 47.597 375.999 48.3333V48.6667C375.999 49.403 375.402 50 374.666 50V50V47Z" class="fill-[black] dark:fill-[white]"></path>
    <rect x="151.666" y="31.667" width="123.333" height="36" rx="18" fill="black"></rect>
  </g>
  </svg>`,
                  }}
                />
                {/* Clickable overlay for play button (since button in SVG can't call React functions) */}
                <div
                  className="absolute inset-0 flex items-center justify-center pointer-events-none"
                  style={{
                    transform: `scale(${deviceScale})`,
                    transformOrigin: "top center",
                    marginTop: "208px",
                  }}
                >
                  <button
                    onClick={onToggleDevServer}
                    disabled={
                      Boolean(isInstalling) || Boolean(isStartingServer)
                    }
                    className={cn(
                      "pointer-events-auto flex items-center justify-center w-20 h-20 rounded-full transition-all duration-300",
                      "bg-white/90 hover:bg-white hover:scale-110 shadow-2xl",
                      (isInstalling || isStartingServer) &&
                        "cursor-not-allowed",
                    )}
                  >
                    {isInstalling || isStartingServer ? (
                      <span className="inline-flex h-8 w-8 rounded-full border-4 border-green-600 border-t-transparent animate-spin" />
                    ) : (
                      <Play
                        size={32}
                        className="text-green-600 fill-green-600 ml-1"
                      />
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      }

      // Web platform — the last-seen app, frozen under a heavy blur veil. The
      // play button starts the dev server; the veil stays up while it boots
      // and de-blurs once the real preview loads (handled in the running
      // branch below).
      return (
        <div className="h-full flex flex-col bg-surface rounded-xl border border-border relative overflow-hidden">
          {/* HTML Snapshot Content */}
          <div className="flex-1 relative">
            <iframe
              srcDoc={snapshotHtml || ''}
              className="w-full h-full border-none"
              title="Project Snapshot"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
            {/* Blur veil with play button — emphasizes "switched off" while
                keeping the app recognizable underneath */}
            <div className="absolute inset-0 bg-black/20 backdrop-blur-[7px] flex items-center justify-center">
              <button
                onClick={onToggleDevServer}
                disabled={Boolean(isInstalling) || Boolean(isStartingServer)}
                className={cn(
                  "group relative flex items-center justify-center w-24 h-24 rounded-full transition-all duration-300",
                  "bg-white/90 hover:bg-white hover:scale-110 shadow-2xl",
                  (isInstalling || isStartingServer) && "cursor-not-allowed",
                )}
              >
                {isInstalling || isStartingServer ? (
                  <span className="inline-flex h-10 w-10 rounded-full border-4 border-green-600 border-t-transparent animate-spin" />
                ) : (
                  <Play
                    size={40}
                    className="text-green-600 fill-green-600 ml-1"
                  />
                )}
              </button>
            </div>
          </div>
          {/* Status text */}
          <div className="absolute bottom-6 left-0 right-0 text-center">
            <p className="text-white text-sm font-medium drop-shadow-lg">
              {isInstalling
                ? "Installing dependencies..."
                : isStartingServer
                  ? "Starting server..."
                  : "Click to start dev server"}
            </p>
          </div>
        </div>
      );
    }

    // Agent is working on the first prompt - show engaging loading carousel
    if (isAgentWorking || isInitialBuild) {
      return (
        <div className="h-full flex items-center justify-center bg-surface text-muted rounded-xl border border-border">
          <AgentLoadingCarousel />
        </div>
      );
    }

    // No snapshot available - show default "No Preview Yet" message
    return (
      <div className="h-full flex items-center justify-center bg-surface text-muted rounded-xl border border-border">
        <div className="text-center max-w-md px-6">
          <div className="text-4xl mb-3">🚀</div>
          <h3 className="text-2xl font-semibold mb-2 text-fg tracking-tight">
            No Preview Yet
          </h3>
          <p className="text-md mb-4 tracking-normal">
            Start the development server to see your app here. We&apos;ll open
            the first active port automatically and keep this preview in sync.
          </p>
          <div className="flex items-center justify-center gap-2">
            <Button
              variant="default"
              size="sm"
              onClick={onToggleDevServer}
              disabled={Boolean(isInstalling) || Boolean(isStartingServer)}
              className={cn(
                "inline-flex items-center gap-2 rounded-full px-4",
                isDevServerRunning
                  ? "bg-red-600 hover:bg-red-700"
                  : "bg-green-600 hover:bg-green-700",
              )}
            >
              {isInstalling || isStartingServer ? (
                <>
                  <span className="inline-flex h-3 w-3 rounded-full border-2 border-white border-t-transparent animate-spin" />
                  <span>{isInstalling ? "Installing…" : "Starting…"}</span>
                </>
              ) : isDevServerRunning ? (
                <>
                  <span>Stop Dev Server</span>
                </>
              ) : (
                <>
                  <span>Start Dev Server</span>
                </>
              )}
            </Button>
          </div>
          <p className="text-xs mt-3 text-muted">
            Equivalent command:{" "}
            <code className="bg-elevated px-1 rounded border border-border">
              {(platform === "mobile" || platform === "multiplatform")
                ? "pnpm exec expo start --web"
                : "pnpm dev"}
            </code>
          </p>
        </div>
      </div>
    );
  }

  // For multiplatform, determine effective rendering mode
  const effectivePlatform = platform === "multiplatform"
    ? multiPreviewMode
    : platform;

  return (
    <div className="h-full flex flex-col bg-surface rounded-xl border border-border">
      {/* Visual editor overlay (fixed = parent-viewport coords) */}
      {editMode && hoverBox && (
        <div
          className="fixed z-[60] pointer-events-none border-2 border-accent/50 bg-accent/5 rounded-sm"
          style={{
            left: hoverBox.left,
            top: hoverBox.top,
            width: hoverBox.width,
            height: hoverBox.height,
          }}
        />
      )}
      {editMode && selectedBox && (
        <div
          className="fixed z-[61] pointer-events-none border-2 border-accent rounded-sm"
          style={{
            left: selectedBox.left,
            top: selectedBox.top,
            width: selectedBox.width,
            height: selectedBox.height,
          }}
        >
          {selection && (
            <span className="absolute -top-6 left-0 px-1.5 py-0.5 rounded bg-accent text-accent-foreground text-[11px] font-medium whitespace-nowrap shadow">
              {selection.tag}
              {selection.loc ? ` · ${selection.loc}` : " · (no source)"}
            </span>
          )}
        </div>
      )}
      {editMode && selection && projectId && (
        <VisualEditorPanel
          projectId={projectId}
          selection={selection}
          box={selectedBox}
          onPreview={(className) =>
            postToIframe({
              type: "BF_EDITOR_PREVIEW",
              loc: selection.loc,
              className,
            })
          }
          onCommitted={(loc) => {
            // Let HMR apply the source change, then refresh selection geometry.
            window.setTimeout(
              () => postToIframe({ type: "BF_EDITOR_RESELECT", loc }),
              250,
            );
          }}
          onClose={() => {
            setSelection(null);
            setSelectedBox(null);
            setHoverBox(null);
            onElementSelected?.(null);
          }}
        />
      )}

      {/* Multiplatform: Web / Mobile toggle tabs */}
      {platform === "multiplatform" && (
        <div className="flex items-center gap-1 px-3 pt-2 pb-0">
          <button
            onClick={() => setMultiPreviewMode("web")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-t-lg text-xs font-medium transition-colors border border-b-0",
              multiPreviewMode === "web"
                ? "bg-surface border-border text-accent"
                : "bg-transparent border-transparent text-muted hover:text-fg"
            )}
          >
            <Monitor size={13} />
            Web
          </button>
          <button
            onClick={() => setMultiPreviewMode("mobile")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-t-lg text-xs font-medium transition-colors border border-b-0",
              multiPreviewMode === "mobile"
                ? "bg-surface border-border text-accent"
                : "bg-transparent border-transparent text-muted hover:text-fg"
            )}
          >
            <Smartphone size={13} />
            Mobile
          </button>
        </div>
      )}

      {/* Preview Header (optional) */}
      {showHeader && (effectivePlatform === "web") && (
        <div className="flex items-center gap-2 p-3 border-b border-border">
          {/* Controls */}
          <Button
            variant="ghost"
            size="sm"
            onClick={reloadPreview}
            className="text-muted hover:text-fg"
          >
            <RefreshCw size={16} />
          </Button>

          {/* Port Selector */}
          {previews.length > 1 && (
            <div className="relative">
              <button
                onClick={() => setIsPortDropdownOpen(!isPortDropdownOpen)}
                className="flex items-center gap-1 px-2 py-1 bg-elevated hover:bg-elevated/80 rounded text-sm text-muted border border-border"
              >
                <span>:{activePreview.port}</span>
                <ChevronDown size={14} />
              </button>

              {isPortDropdownOpen && (
                <div className="absolute top-full left-0 mt-1 bg-elevated border border-border rounded shadow-lg z-50">
                  {previews.map((preview, index) => (
                    <button
                      key={preview.port}
                      onClick={() => {
                        onActivePreviewChange(index);
                        setIsPortDropdownOpen(false);
                      }}
                      className={cn(
                        "block w-full px-3 py-2 text-left text-sm hover:bg-soft",
                        index === activePreviewIndex
                          ? "text-accent"
                          : "text-muted",
                      )}
                    >
                      Port {preview.port}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* URL Bar */}
          <div className="flex-1 flex items-center bg-elevated rounded px-3 py-1 border border-border">
            <span className="text-muted text-sm mr-2">
              {activePreview.baseUrl}
            </span>
            <Input
              type="text"
              defaultValue={internalPath}
              onKeyDown={handlePathChange}
              placeholder="/"
              className="flex-1 bg-transparent text-fg text-sm outline-none"
            />
          </div>

          {/* Device Controls */}
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setInternalDevice("desktop")}
              className={cn(
                "text-muted hover:text-fg",
                internalDevice === "desktop" && "text-accent",
              )}
              title="Desktop View"
            >
              <Monitor size={16} />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => setInternalDevice("tablet")}
              className={cn(
                "text-muted hover:text-fg",
                internalDevice === "tablet" && "text-accent",
              )}
              title="Tablet View"
            >
              <Tablet size={16} />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => setInternalDevice("mobile")}
              className={cn(
                "text-muted hover:text-fg",
                internalDevice === "mobile" && "text-accent",
              )}
              title="Mobile View"
            >
              <Smartphone size={16} />
            </Button>

            {internalDevice !== "desktop" && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setInternalLandscape(!internalLandscape)}
                className="text-muted hover:text-fg"
                title="Rotate Device"
              >
                <RotateCcw size={16} />
              </Button>
            )}
          </div>

          {/* External Link */}
          <Button
            variant="ghost"
            size="sm"
            onClick={openInNewTab}
            className="text-muted hover:text-fg"
            title="Open in New Tab"
          >
            <ExternalLink size={16} />
          </Button>
        </div>
      )}

      {/* Preview Content */}
      {effectivePlatform === "mobile" ? (
        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-3 p-3 overflow-hidden">
          {/* Left: QR code + Expo Go install guidance */}
          <div className="rounded-xl border border-border bg-elevated p-5 flex flex-col items-center justify-center min-h-[320px] gap-4">
            <div className="flex items-center gap-3">
              <Image
                src="/ExpoIcon76x76.png"
                alt="Expo Go"
                width={44}
                height={44}
                className="rounded-[22%] shadow"
              />
              <div className="flex flex-col">
                <div className="text-sm font-semibold text-fg">Expo Go</div>
                <div className="text-xs text-muted">
                  Install the app to open the QR
                </div>
              </div>
            </div>

            {!expUrl ? (
              <div className="text-center text-sm text-muted">
                Start the server to generate an Expo URL
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(expUrl)}`}
                  alt="Expo Go QR"
                  className="rounded bg-white p-2 border border-border"
                  width={220}
                  height={220}
                />
                <div className="text-xs text-muted break-all max-w-[260px] text-center">
                  {expUrl}
                </div>
              </div>
            )}

            <div className="flex items-center gap-2 mt-1">
              <a
                href="https://apps.apple.com/us/app/expo-go/id982107779"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs px-3 py-1.5 rounded-full border border-border bg-white hover:bg-neutral-50 transition text-neutral-800"
                title="Download on the App Store"
              >
                App Store
              </a>
              <a
                href="https://play.google.com/store/apps/details?id=host.exp.exponent&hl=en_US&pli=1"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs px-3 py-1.5 rounded-full border border-border bg-white hover:bg-neutral-50 transition text-neutral-800"
                title="Get it on Google Play"
              >
                Google Play
              </a>
            </div>
          </div>
          {/* Right: iPhone 15 SVG mockup with embedded iframe (auto-scale to fit) */}
          <div className="relative flex items-center justify-center overflow-hidden">
            {/* Controls overlay */}
            <div className="absolute top-2 right-2 z-10 bg-elevated/90 backdrop-blur-sm border border-border rounded-full px-2 py-1 flex items-center gap-2">
              <button
                className={cn(
                  "text-xs px-2 py-0.5 rounded-full",
                  fitMode === "height"
                    ? "bg-accent text-accent-foreground"
                    : "text-muted hover:text-fg",
                )}
                onClick={() => setFitMode("height")}
                title="Fit to height"
              >
                H
              </button>
              <button
                className={cn(
                  "text-xs px-2 py-0.5 rounded-full",
                  fitMode === "width"
                    ? "bg-accent text-accent-foreground"
                    : "text-muted hover:text-fg",
                )}
                onClick={() => setFitMode("width")}
                title="Fit to width"
              >
                W
              </button>
              <input
                type="range"
                min={0.8}
                max={1.2}
                step={0.02}
                value={zoom}
                onChange={(e) => setZoom(parseFloat(e.target.value))}
                className="w-24"
                title="Zoom"
              />
            </div>
            <div
              ref={deviceOuterRef}
              className="w-full h-full flex items-center justify-center mt-52"
            >
              <div
                ref={deviceContainerRef}
                className="relative"
                style={{
                  width: 427,
                  height: 881,
                  transform: `scale(${deviceScale})`,
                  transformOrigin: "top center",
                }}
                dangerouslySetInnerHTML={{
                  __html: `
<svg width="393" height="852" viewBox="0 0 427 881" fill="none" xmlns="http://www.w3.org/2000/svg" class="w-full h-full" filter="url(#shadow)">
  <defs>
    <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="8" stdDeviation="16" flood-color="rgba(0,0,0,0.15)"></feDropShadow>
    </filter>
    <filter id="filter0_f_2905_1090" x="-0.166992" y="0.166504" width="427" height="880.667" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood>
      <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend>
      <feGaussianBlur stdDeviation="0.5" result="effect1_foregroundBlur_2905_1090"></feGaussianBlur>
    </filter>
    <filter id="filter1_f_2905_1090" x="6.33236" y="6.33382" width="414" height="868" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood>
      <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend>
      <feGaussianBlur stdDeviation="0.333333" result="effect1_foregroundBlur_2905_1090"></feGaussianBlur>
    </filter>
    <filter id="filter2_f_2905_1090" x="244.143" y="44.0955" width="6.19085" height="11.143" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood>
      <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend>
      <feGaussianBlur stdDeviation="0.928572" result="effect1_foregroundBlur_2905_1090"></feGaussianBlur>
    </filter>
    <filter id="filter3_f_2905_1090" x="244.762" y="45.8098" width="4.95257" height="7.71429" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood>
      <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend>
      <feGaussianBlur stdDeviation="0.928572" result="effect1_foregroundBlur_2905_1090"></feGaussianBlur>
    </filter>
    <filter id="filter4_f_2905_1090" x="245.808" y="45.7839" width="3.86682" height="6.88293" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood>
      <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend>
      <feGaussianBlur stdDeviation="0.619048" result="effect1_foregroundBlur_2905_1090"></feGaussianBlur>
    </filter>
    <filter id="filter5_f_2905_1090" x="250.332" y="44.0955" width="6.19085" height="11.143" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood>
      <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend>
      <feGaussianBlur stdDeviation="0.928572" result="effect1_foregroundBlur_2905_1090"></feGaussianBlur>
    </filter>
    <filter id="filter6_f_2905_1090" x="250.951" y="45.8098" width="4.95257" height="7.71429" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood>
      <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend>
      <feGaussianBlur stdDeviation="0.928572" result="effect1_foregroundBlur_2905_1090"></feGaussianBlur>
    </filter>
    <filter id="filter7_f_2905_1090" x="250.991" y="45.7839" width="3.86682" height="6.88293" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood>
      <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend>
      <feGaussianBlur stdDeviation="0.619048" result="effect1_foregroundBlur_2905_1090"></feGaussianBlur>
    </filter>
    <filter id="filter8_f_2905_1090" x="169.666" y="42.6468" width="7.80012" height="14.0399" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood>
      <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend>
      <feGaussianBlur stdDeviation="1.17" result="effect1_foregroundBlur_2905_1090"></feGaussianBlur>
    </filter>
    <filter id="filter9_f_2905_1090" x="170.446" y="44.807" width="6.23957" height="9.72004" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood>
      <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend>
      <feGaussianBlur stdDeviation="1.17" result="effect1_foregroundBlur_2905_1090"></feGaussianBlur>
    </filter>
    <filter id="filter10_f_2905_1090" x="171.276" y="45.5545" width="3.31098" height="7.11225" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood>
      <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend>
      <feGaussianBlur stdDeviation="0.39" result="effect1_foregroundBlur_2905_1090"></feGaussianBlur>
    </filter>
    <filter id="filter11_f_2905_1090" x="161.865" y="42.6468" width="7.80012" height="14.0399" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood>
      <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend>
      <feGaussianBlur stdDeviation="1.17" result="effect1_foregroundBlur_2905_1090"></feGaussianBlur>
    </filter>
    <filter id="filter12_f_2905_1090" x="162.645" y="44.807" width="6.23957" height="9.72004" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood>
      <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend>
      <feGaussianBlur stdDeviation="1.17" result="effect1_foregroundBlur_2905_1090"></feGaussianBlur>
    </filter>
    <filter id="filter13_f_2905_1090" x="164.744" y="45.5545" width="3.31098" height="7.11225" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
      <feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood>
      <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape"></feBlend>
      <feGaussianBlur stdDeviation="0.39" result="effect1_foregroundBlur_2905_1090"></feGaussianBlur>
    </filter>
    <clipPath id="clip0_2905_1090"><rect width="426.667" height="880.667" rx="70" fill="white"></rect></clipPath>
    <clipPath id="clip1_2905_1090"><rect x="18" y="18" width="390" height="844" rx="55" fill="white"></rect></clipPath>
  </defs>
  <g clip-path="url(#clip0_2905_1090)">
    <rect width="426.667" height="880.667" rx="70" fill="black"></rect>
    <rect x="3.83268" y="3.83366" width="419" height="873" rx="66.1667" class="stroke-[#dcdcdf] dark:stroke-[#454548]" stroke-width="4.33333"></rect>
    <rect x="0.833333" y="0.833333" width="425" height="879" rx="69.1667" class="stroke-[#c1c2c4] dark:stroke-[#37373a]" stroke-width="1.66667"></rect>
    <g opacity="0.9" filter="url(#filter0_f_2905_1090)"><rect x="1.66602" y="2" width="423.333" height="877" rx="68.6667" class="stroke-[#b2b2b9] dark:stroke-[#454548]" stroke-width="1.66667"></rect></g>
    <g opacity="0.8" filter="url(#filter1_f_2905_1090)"><rect x="7.33268" y="7.33366" width="412" height="866" rx="62.6667" stroke="#646464" stroke-width="0.666667"></rect></g>
    <rect x="18" y="18" width="390" height="844" rx="55" fill="#ffffff" clip-path="url(#clip1_2905_1090)"></rect>
    <foreignObject x="18" y="18" width="390" height="844">
      <div class="size-full overflow-hidden rounded-[55.75px] object-contain" style="transform-origin: center center; background:#ffffff; padding-top:62px; padding-bottom:34px;">
        <div class="w-full h-full relative overflow-hidden">
          <iframe src="${iframeUrl || ""}" class="border-0 w-full select-none h-full" allow="geolocation; camera; microphone" style="opacity: 1;"></iframe>
          <div class="flex flex-col absolute inset-0 z-[3] pointer-events-none" style="transform-origin: center center;"></div>
        </div>
      </div>
    </foreignObject>
    <rect width="139" height="5" rx="2.5" transform="matrix(-1 0 0 1 284 849)" class="fill-[black] dark:fill-[#ffffffa2]"></rect>
    <path d="M73.7471 43.5257C76.5938 43.5257 78.966 45.522 78.966 50.0516V50.0695C78.966 54.3395 76.9876 56.8908 73.6934 56.8908C71.3032 56.8908 69.5129 55.5122 69.11 53.5607L69.0921 53.4622H71.3838L71.4106 53.5428C71.7598 54.429 72.5475 55.002 73.7023 55.002C75.7791 55.002 76.6475 53.0146 76.737 50.5708C76.7459 50.4365 76.7549 50.3022 76.7549 50.159H76.7012C76.1909 51.3407 74.9019 52.2358 73.1563 52.2358C70.6676 52.2358 68.9131 50.4455 68.9131 48.0195V48.0016C68.9131 45.3966 70.9631 43.5257 73.7471 43.5257ZM73.7471 50.4544C75.2241 50.4544 76.3521 49.416 76.3521 47.9748V47.9658C76.3521 46.5335 75.2241 45.4146 73.7739 45.4146C72.3416 45.4146 71.1868 46.5246 71.1868 47.9211V47.939C71.1868 49.4071 72.279 50.4544 73.7471 50.4544ZM81.8485 48.2165C81.1234 48.2165 80.5505 47.6436 80.5505 46.9185C80.5505 46.1934 81.1234 45.6294 81.8485 45.6294C82.5736 45.6294 83.1375 46.1934 83.1375 46.9185C83.1375 47.6436 82.5736 48.2165 81.8485 48.2165ZM81.8485 54.7871C81.1234 54.7871 80.5505 54.2142 80.5505 53.4891C80.5505 52.764 81.1234 52.2 81.8485 52.2C82.5736 52.2 83.1375 52.764 83.1375 53.4891C83.1375 54.2142 82.5736 54.7871 81.8485 54.7871ZM91.0778 56.667V54.1873H84.6325V52.2179L89.9946 43.7495H93.2799V52.2896H95.0345V54.1873H93.2799V56.667H91.0778ZM86.7093 52.3433H91.1136V45.4951H91.0599L86.7093 52.2806V52.3433ZM99.7163 56.667V45.9517H99.6626L96.3236 48.2433V46.1217L99.6984 43.7495H101.981V56.667H99.7163Z" class="fill-[black] dark:fill-[white]"></path>
    <g opacity="0.9"><rect x="297.333" y="50" width="3.33333" height="4" rx="0.333333" class="fill-[black] dark:fill-[white]"></rect><rect x="302" y="48" width="3.33333" height="6" rx="0.333333" class="fill-[black] dark:fill-[white]"></rect><rect x="307" y="45.667" width="3.33333" height="8.33333" rx="0.333333" class="fill-[black] dark:fill-[white]"></rect><rect x="311.666" y="43" width="3.33333" height="11" rx="0.333333" class="fill-[black] dark:fill-[white]"></rect></g>
    <g opacity="0.9"><path d="M341.382 45.8776C339.208 43.6888 336.196 42.3335 332.867 42.3335C329.528 42.3335 326.508 43.6969 324.333 45.8974L326.219 47.7831C327.911 46.0652 330.265 45.0002 332.867 45.0002C335.459 45.0002 337.805 46.057 339.496 47.7633L341.382 45.8776Z" class="fill-[black] dark:fill-[white]"></path><path d="M338.318 48.9418C336.928 47.5371 334.999 46.6668 332.867 46.6668C330.725 46.6668 328.788 47.5453 327.397 48.9616L329.283 50.8474C330.191 49.9136 331.462 49.3335 332.867 49.3335C334.263 49.3335 335.525 49.9053 336.432 50.8275L338.318 48.9418Z" class="fill-[black] dark:fill-[white]"></path><path d="M335.253 52.006C334.648 51.3855 333.803 51.0002 332.867 51.0002C331.922 51.0002 331.068 51.3938 330.462 52.0261L332.847 54.412L335.253 52.006Z" class="fill-[black] dark:fill-[white]"></path></g>
    <rect opacity="0.6" x="351.166" y="43.167" width="22.3333" height="10.6667" rx="2.16667" class="stroke-[black] dark:stroke-[white]"></rect>
    <rect opacity="0.9" x="352.333" y="44.3335" width="20" height="8.33333" rx="1.33333" class="fill-[black] dark:fill-[white]"></rect>
    <path opacity="0.6" d="M374.666 47V47C375.402 47 375.999 47.597 375.999 48.3333V48.6667C375.999 49.403 375.402 50 374.666 50V50V47Z" class="fill-[black] dark:fill-[white]"></path>
    <rect x="151.666" y="31.667" width="123.333" height="36" rx="18" fill="black"></rect>
  </g>
  </svg>`,
                }}
              />
            </div>
          </div>
        </div>
      ) : effectiveDevice === "responsive" ? (
        <div className="flex-1 overflow-hidden relative">
          <ResponsiveCanvas iframeUrl={iframeUrl} />
        </div>
      ) : effectiveDevice === "figma" && onFetchHtml ? (
        <div className="flex-1 overflow-hidden relative">
          <FigmaCanvas
            previewUrl={
              activePreview.baseUrl +
              ((currentPath ?? internalPath) || "/")
            }
            reloadKey={reloadKey ?? 0}
            fetchHtml={onFetchHtml}
          />
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center overflow-auto relative">
          <div
            className={cn(
              "bg-surface overflow-hidden rounded-xl",
              (selectedDevice ?? internalDevice) !== "desktop" && "",
            )}
            style={getIframeStyles()}
          >
            <iframe
              ref={iframeRef}
              src={iframeUrl || undefined}
              className="w-full h-full border-none"
              title="Preview"
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-storage-access-by-user-activation"
              allow="cross-origin-isolated"
              // The workspace page sets COEP: credentialless. Cross-origin
              // iframes under that policy need either CORP headers on the
              // response (Vercel's *.vercel.run proxy doesn't send them) OR
              // the `credentialless` HTML attribute on the iframe element.
              // We only apply it for the sandbox preview — WebContainer URLs
              // already include "credentialless" in their hostname.
              {...(platform === "sandboxed-web" ? { credentialless: "" } : {})}
              onLoad={() => {
                if (iframeUrl) {
                  setIsRealPreviewLoaded(true);
                }
              }}
            />
          </div>

          {/* Snapshot overlay — covers the loading dev server, then de-blurs
              away once the real preview has painted (the "lazy switch"). */}
          {showSnapshot && snapshotHtml && (
            <div
              className="absolute inset-0 flex items-center justify-center pointer-events-none"
              style={{
                opacity: veilClearing ? 0 : 1,
                transition: "opacity 700ms ease",
              }}
            >
              <div className="w-full h-full relative bg-surface">
                <iframe
                  srcDoc={snapshotHtml || ''}
                  className="w-full h-full border-none"
                  title="Project Snapshot"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                />
                <div
                  className="absolute inset-0"
                  style={{
                    backgroundColor: veilClearing ? "rgba(0,0,0,0)" : "rgba(0,0,0,0.2)",
                    backdropFilter: veilClearing ? "blur(0px)" : "blur(7px)",
                    WebkitBackdropFilter: veilClearing ? "blur(0px)" : "blur(7px)",
                    transition:
                      "backdrop-filter 700ms ease, -webkit-backdrop-filter 700ms ease, background-color 700ms ease",
                  }}
                />
              </div>
            </div>
          )}

          {/* Initial-build veil — only while the agent works on the project's
              FIRST message. Blur over the live preview + loading carousel, so
              in-progress errors never flash at the user. The X reveals the raw
              preview for the curious. */}
          {showInitialVeil && !initialVeilDismissed && isDevServerRunning && (
            <div
              className="absolute inset-0 z-10 flex items-center justify-center"
              style={{
                opacity: initialVeilClearing ? 0 : 1,
                backdropFilter: initialVeilClearing ? "blur(0px)" : "blur(8px)",
                WebkitBackdropFilter: initialVeilClearing ? "blur(0px)" : "blur(8px)",
                backgroundColor: initialVeilClearing
                  ? "rgba(0,0,0,0)"
                  : "rgba(0,0,0,0.25)",
                transition:
                  "backdrop-filter 700ms ease, -webkit-backdrop-filter 700ms ease, background-color 700ms ease, opacity 700ms ease",
                pointerEvents: initialVeilClearing ? "none" : "auto",
              }}
            >
              <button
                onClick={() => setInitialVeilDismissed(true)}
                className="absolute top-3 right-3 flex h-7 w-7 items-center justify-center rounded-full bg-black/40 text-white/80 hover:bg-black/60 hover:text-white transition-colors"
                title="Watch the agent work"
              >
                <X size={15} />
              </button>
              <div className="text-white [&_p]:!text-white [&_.text-muted]:!text-white/70 [&_.text-fg]:!text-white">
                <AgentLoadingCarousel />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Device Info */}
      {platform && isWebLikePlatform(platform) &&
        (selectedDevice ?? internalDevice) !== "desktop" &&
        (selectedDevice ?? internalDevice) !== "responsive" &&
        (selectedDevice ?? internalDevice) !== "figma" && (
          <div className="px-4 py-2 bg-soft border-t border-border text-center text-xs text-muted">
            {DEVICE_SIZES[selectedDevice ?? internalDevice].name} •{" "}
            {(isLandscape ?? internalLandscape) ? "Landscape" : "Portrait"} •{" "}
            {(isLandscape ?? internalLandscape)
              ? `${DEVICE_SIZES[selectedDevice ?? internalDevice].height} × ${DEVICE_SIZES[selectedDevice ?? internalDevice].width}`
              : `${DEVICE_SIZES[selectedDevice ?? internalDevice].width} × ${DEVICE_SIZES[selectedDevice ?? internalDevice].height}`}
          </div>
        )}
    </div>
  );
}
