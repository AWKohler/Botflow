'use client';

import { useLayoutEffect, useRef } from 'react';

/**
 * Keep an absolutely positioned popover inside the browser window.
 *
 * Popovers are anchored to their trigger with CSS (left-0 / right-0), which
 * works until the trigger sits near a window edge — e.g. the agent panel
 * pinned to the left of the workspace, where a leftward tooltip runs off
 * screen. While `open`, this measures the popover and shifts it horizontally
 * (via the CSS `translate` property, so Tailwind transforms are untouched)
 * just enough to keep a `margin` from both edges. Re-measures on resize.
 *
 * The popover should also cap its width, e.g. `max-w-[calc(100vw-16px)]`, so
 * a shift alone can always make it fit.
 */
export function useClampToViewport<T extends HTMLElement>(open: boolean, margin = 8) {
  const ref = useRef<T>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    const clamp = () => {
      el.style.translate = '';
      const rect = el.getBoundingClientRect();
      const viewport = document.documentElement.clientWidth;
      let dx = 0;
      if (rect.right > viewport - margin) dx = viewport - margin - rect.right;
      if (rect.left + dx < margin) dx = margin - rect.left;
      if (dx !== 0) el.style.translate = `${Math.round(dx)}px 0`;
    };
    clamp();
    window.addEventListener('resize', clamp);
    return () => {
      window.removeEventListener('resize', clamp);
      el.style.translate = '';
    };
  }, [open, margin]);

  return ref;
}
