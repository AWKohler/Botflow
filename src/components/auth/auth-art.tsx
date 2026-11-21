"use client";

import { useSyncExternalStore } from "react";
import { ArrowUp } from "lucide-react";
import { Canvas, supportsHtmlInCanvas } from "@/components/canvasui/Canvas";

const noSubscribe = () => () => {};

/**
 * The artwork beside the sign-in and sign-up forms: an abstract painting in
 * the brand's own colours (warm paper running into cobalt and ink) on woven
 * artist canvas, with the product's one-line promise as a prompt box.
 *
 * Where the browser can paint HTML onto a canvas, the whole panel is rendered
 * as paint on a woven surface and the pointer lays wet strokes that dry. Where
 * it cannot, the same painting is shown with a CSS weave, so it never looks
 * unfinished.
 */
export function AuthArt() {
  const painted = useSyncExternalStore(noSubscribe, supportsHtmlInCanvas, () => false);
  return (
    <div className="auth-art relative h-full w-full overflow-hidden rounded-2xl border border-border">
      <Canvas
        className="h-full w-full"
        // A fine weave and almost no halftone: the surface should read as canvas
        // up close and stay out of the way from a distance.
        threadSize={2.5}
        texture={0.36}
        halftone={0.02}
        grain={0.24}
        relief={0.38}
        gloss={0.3}
      >
        <div className="auth-art__painting relative h-full w-full overflow-hidden">
          <div aria-hidden="true" className="auth-art__wash absolute inset-0" />
          <div aria-hidden="true" className="auth-art__stroke auth-art__stroke--deep absolute" />
          <div aria-hidden="true" className="auth-art__stroke auth-art__stroke--light absolute" />
          <div aria-hidden="true" className="auth-art__stroke auth-art__stroke--beam absolute" />
          <div aria-hidden="true" className="auth-art__grain absolute inset-0" />
          {!painted && <div aria-hidden="true" className="auth-art__weave absolute inset-0" />}
        </div>
      </Canvas>

      {/* The prompt box sits above the canvas, not in it: the painting keeps its
          weave, and the one thing to read stays perfectly clean. Pointer events
          pass through, so the brush still works underneath. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-8 lg:px-12">
        <div className="auth-art__prompt flex w-full max-w-[452px] items-center gap-3 rounded-2xl py-3 pl-5 pr-3">
          <p className="min-w-0 flex-1 truncate text-base">Ask Botflow to build your project</p>
          <span className="auth-art__send flex h-10 w-10 shrink-0 items-center justify-center rounded-full">
            <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.25} />
          </span>
        </div>
      </div>

      {painted && (
        <p className="auth-art__hint pointer-events-none absolute bottom-5 left-6 text-xs motion-reduce:hidden">
          Move your cursor to paint
        </p>
      )}
    </div>
  );
}

/**
 * The same painting as a short band, for the top of the phone layout: paint
 * and weave only. No live canvas (there is no pointer to paint with, and a
 * phone should not run a WebGL surface for decoration) and no prompt box,
 * which above a real form would read as a field.
 */
export function AuthArtBand({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={`auth-art relative overflow-hidden rounded-2xl border border-border ${className ?? ""}`}>
      <div className="auth-art__painting relative h-full w-full overflow-hidden">
        <div className="auth-art__wash absolute inset-0" />
        <div className="auth-art__stroke auth-art__stroke--deep absolute" />
        <div className="auth-art__stroke auth-art__stroke--light absolute" />
        <div className="auth-art__stroke auth-art__stroke--beam absolute" />
        <div className="auth-art__grain absolute inset-0" />
        <div className="auth-art__weave absolute inset-0" />
      </div>
    </div>
  );
}
