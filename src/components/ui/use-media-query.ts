"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Whether a media query matches, kept up to date (a rotated phone, a resized
 * window). False on the server and while hydrating, so the first client render
 * matches the server's; what depends on it settles right after. For anything
 * visible in the first paint, prefer a CSS breakpoint.
 */
export function useMediaQuery(query: string) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** One pane at a time: the width below which the workspaces and the site header use their phone layout (Tailwind's `md`). */
export const NARROW_QUERY = "(max-width: 767px)";
