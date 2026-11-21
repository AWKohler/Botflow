"use client";

import { useEffect, useRef, useState } from "react";

/**
 * For a row that scrolls sideways when it does not fit (a tab row on a phone):
 * keeps the current item in view, and reports which edges have more to scroll
 * to, so the row can fade there. `current` is anything that changes when the
 * selection does; the current item is the one marked `aria-selected="true"` or
 * `aria-current="page"`.
 */
export function useScrollRow<T extends HTMLElement>(current: unknown) {
  const ref = useRef<T>(null);
  const [more, setMore] = useState({ left: false, right: false });

  useEffect(() => {
    const row = ref.current;
    if (!row) return;
    const update = () => {
      const left = row.scrollLeft > 1;
      const right = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
      setMore((m) => (m.left === left && m.right === right ? m : { left, right }));
    };
    update();
    row.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(row);
    return () => {
      row.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const row = ref.current;
    const item = row?.querySelector<HTMLElement>('[aria-selected="true"], [aria-current="page"]');
    if (!row || !item || row.scrollWidth <= row.clientWidth) return;
    const rowBox = row.getBoundingClientRect();
    const box = item.getBoundingClientRect();
    if (box.left < rowBox.left + 8) row.scrollBy({ left: box.left - rowBox.left - 16 });
    else if (box.right > rowBox.right - 8) row.scrollBy({ left: box.right - rowBox.right + 16 });
  }, [current]);

  return { ref, more };
}

/** A fade at whichever edge of a scrolling row has more to show. */
export function scrollRowFade(more: { left: boolean; right: boolean }) {
  if (more.left && more.right)
    return "[mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)]";
  if (more.right) return "[mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]";
  if (more.left) return "[mask-image:linear-gradient(to_right,transparent,black_1.5rem)]";
  return "";
}
