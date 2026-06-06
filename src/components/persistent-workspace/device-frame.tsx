"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export type DeviceModelUI = "iPhone-16-Pro" | "iPad-Pro";
export type OrientationUI = "portrait" | "landscape";

interface Geometry {
  /** The orientation the bezel asset is drawn in. */
  natural: OrientationUI;
  /** Bezel image dimensions, in device px, in its natural orientation. */
  box: { w: number; h: number };
  /** Screen content rect within the bezel, natural orientation, device px. */
  screen: { x: number; y: number; w: number; h: number };
  /** Inner screen corner radius (device px, natural orientation). */
  radius: number;
  /** Public asset for the bezel. */
  asset: string;
  /** iPhone PNG has a transparent screen hole → canvas sits BEHIND the bezel.
   *  iPad SVG has a solid (switched-off) screen → canvas sits ON TOP of it. */
  canvasInFront: boolean;
}

// Geometry measured from the bezel assets.
//   iPhone 17 Pro PNG: 1350×2760, transparent hole at x=72 y=69 w=1206 h=2622.
//   iPad Pro SVG: 776×595 (landscape); screen centered at 719.06×538.211 with a
//   ~28px symmetric inset (matches the separated Screen-HERE.svg mockup).
const GEOMETRY: Record<DeviceModelUI, Geometry> = {
  "iPhone-16-Pro": {
    natural: "portrait",
    box: { w: 1350, h: 2760 },
    screen: { x: 72, y: 69, w: 1206, h: 2622 },
    radius: 130,
    asset: "/iphone_17_pro.png",
    canvasInFront: false,
  },
  "iPad-Pro": {
    natural: "landscape",
    box: { w: 776, h: 595 },
    screen: { x: (776 - 719.06) / 2, y: (595 - 538.211) / 2, w: 719.06, h: 538.211 },
    radius: 16.65,
    asset: "/ipad_pro.svg",
    canvasInFront: true,
  },
};

interface DeviceFrameProps {
  deviceModel: DeviceModelUI;
  orientation: OrientationUI;
  /** The live stream surface (a <canvas>). Positioned inside the screen rect. */
  children: ReactNode;
  /** Optional centered overlay (status text), rendered above the device at
   * natural size — not affected by the device's fit-scale. */
  overlay?: ReactNode;
  /** Optional element pinned to the bottom of the stream area (keyboard hint). */
  footer?: ReactNode;
}

export function DeviceFrame({
  deviceModel,
  orientation,
  children,
  overlay,
  footer,
}: DeviceFrameProps): React.JSX.Element {
  const g = GEOMETRY[deviceModel];
  const rotated = orientation !== g.natural;

  // Oriented outer box + screen rect. A 90° rotation swaps the box dims and
  // maps the screen rect; we rotate ONLY the bezel image (below), keeping the
  // canvas axis-aligned so pointer→device coordinate mapping stays correct.
  const box = rotated ? { w: g.box.h, h: g.box.w } : g.box;
  const screen = rotated
    ? { x: g.box.h - g.screen.y - g.screen.h, y: g.screen.x, w: g.screen.h, h: g.screen.w }
    : g.screen;

  const outerRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0.2);
  useEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;
    const ro = new ResizeObserver(() => {
      const h = outer.clientHeight;
      const w = outer.clientWidth;
      const base = Math.min(h / box.h, w / box.w);
      setScale(Math.max(0.05, Math.min(base * 0.92, 2)));
    });
    ro.observe(outer);
    return () => ro.disconnect();
  }, [box.w, box.h]);

  const canvasZ = g.canvasInFront ? 2 : 1;
  const bezelZ = g.canvasInFront ? 1 : 2;

  return (
    <div ref={outerRef} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
      <div
        style={{
          position: "relative",
          width: box.w,
          height: box.h,
          transform: `scale(${scale})`,
          transformOrigin: "center center",
          flexShrink: 0,
        }}
      >
        {/* Screen content (canvas) — clipped to the rounded screen rect. */}
        <div
          style={{
            position: "absolute",
            left: screen.x,
            top: screen.y,
            width: screen.w,
            height: screen.h,
            borderRadius: g.radius,
            overflow: "hidden",
            background: "#000",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: canvasZ,
          }}
        >
          {children}
        </div>

        {/* Bezel image — rotated for the non-natural orientation. Decoration
            only (pointer-events none), so rotating it never affects input. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={g.asset}
          alt=""
          style={{
            position: "absolute",
            left: (box.w - g.box.w) / 2,
            top: (box.h - g.box.h) / 2,
            width: g.box.w,
            height: g.box.h,
            // Tailwind's preflight sets `img { max-width: 100%; height: auto }`,
            // which would cap the rotated bezel (e.g. a 776px-wide image inside a
            // 595px-wide box) and squish it — breaking the frame alignment.
            // Pin the intrinsic size explicitly.
            maxWidth: "none",
            maxHeight: "none",
            transform: rotated ? "rotate(90deg)" : "none",
            transformOrigin: "center center",
            pointerEvents: "none",
            userSelect: "none",
            zIndex: bezelZ,
          }}
        />
      </div>

      {overlay && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          {overlay}
        </div>
      )}
      {footer && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2">{footer}</div>
      )}
    </div>
  );
}
