'use client';

import { useEffect } from 'react';

/**
 * Publishes the height of the on-screen keyboard as `--keyboard-inset` on
 * <html>, for layouts that fill the screen (the workspace) and for surfaces
 * anchored to its bottom edge (sheets).
 *
 * iOS Safari does not shrink the page when the keyboard opens: it only
 * shrinks the *visual* viewport and pans it, so a full-height layout keeps its
 * composer under the keyboard and a bottom sheet is half covered. Chrome on
 * Android resizes the page itself (see `interactiveWidget` in the root
 * layout), where this stays 0. Touch devices only; a pinch-zoomed page is not
 * measured, since zooming shrinks the visual viewport too.
 *
 * A screen marked `data-fills-screen` is also kept pinned to the top, undoing
 * the pan Safari applies before the layout has shrunk.
 */
export function KeyboardInset() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const touch = window.matchMedia('(pointer: coarse)');
    let last = -1;
    let pinning = 0;
    const apply = () => {
      const zoomed = Math.abs(vv.scale - 1) > 0.01;
      const covered = zoomed || !touch.matches ? 0 : window.innerHeight - vv.height;
      // Anything smaller is browser chrome moving, not a keyboard.
      const inset = covered > 120 ? Math.round(covered) : 0;
      if (inset !== last) {
        last = inset;
        root.style.setProperty('--keyboard-inset', `${inset}px`);
      }
      // At most once a frame, so it settles rather than fights Safari's own scrolling.
      if (inset > 0 && !pinning && (window.scrollY || vv.offsetTop) && document.querySelector('[data-fills-screen]')) {
        pinning = requestAnimationFrame(() => {
          pinning = 0;
          window.scrollTo(0, 0);
        });
      }
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    touch.addEventListener('change', apply);
    return () => {
      touch.removeEventListener('change', apply);
      cancelAnimationFrame(pinning);
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      root.style.removeProperty('--keyboard-inset');
    };
  }, []);
  return null;
}
