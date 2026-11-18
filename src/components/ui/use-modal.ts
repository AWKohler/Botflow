"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), iframe';

/** Open modals, innermost last: only the top one answers the keyboard. */
const stack: HTMLElement[] = [];

/**
 * The last few focused elements, newest last. A field with `autoFocus` takes
 * focus before the modal's effect runs, so "what opened this" has to be read
 * from history rather than from `document.activeElement`.
 */
const focusHistory: HTMLElement[] = [];
if (typeof document !== "undefined") {
  document.addEventListener(
    "focusin",
    (e) => {
      if (!(e.target instanceof HTMLElement)) return;
      focusHistory.push(e.target);
      if (focusHistory.length > 8) focusHistory.shift();
    },
    true,
  );
}

/**
 * What makes a panel behave as a modal for keyboard and screen-reader users:
 *  - focus moves into the panel when it opens (to `[data-autofocus]`, else the
 *    panel itself, so nothing is activated by accident);
 *  - Tab and Shift+Tab stay inside it;
 *  - everything else on the page is made `inert` while it is open (siblings of
 *    the panel's root under <body>; portal the modal to <body> for full cover);
 *  - Escape closes it, when a close handler is given;
 *  - focus returns to whatever opened it.
 * Attach the returned ref to the panel and give the panel `tabIndex={-1}`.
 */
export function useModal<T extends HTMLElement>(open: boolean, onClose?: () => void) {
  const ref = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const panel = ref.current;
    if (!open || !panel) return;

    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const opener =
      active && !panel.contains(active)
        ? active
        : ([...focusHistory].reverse().find((el) => !panel.contains(el) && document.contains(el)) ?? null);
    stack.push(panel);

    const inerted: Element[] = [];
    for (const el of Array.from(document.body.children)) {
      if (el.contains(panel) || el.hasAttribute("inert") || el.hasAttribute("data-modal-keep")) continue;
      if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
      el.setAttribute("inert", "");
      inerted.push(el);
    }

    // Keep focus where an autofocused field already put it; otherwise move it in.
    if (!active || !panel.contains(active)) {
      (panel.querySelector<HTMLElement>("[data-autofocus]") ?? panel).focus({ preventScroll: true });
    }

    const visibleFocusables = () =>
      Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0 && !el.closest("[inert]"),
      );

    const onKeyDown = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== panel) return;
      if (e.key === "Escape" && onCloseRef.current) {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = visibleFocusables();
      if (items.length === 0) {
        e.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      const outside = !current || !panel.contains(current);
      if (e.shiftKey && (outside || current === first || current === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (outside || current === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const i = stack.lastIndexOf(panel);
      if (i >= 0) stack.splice(i, 1);
      for (const el of inerted) el.removeAttribute("inert");
      // On a touch screen, focusing a text field raises the keyboard; a sheet
      // that closes should not do that on its own.
      const raisesKeyboard =
        !!opener &&
        (opener.tagName === "TEXTAREA" || opener.tagName === "INPUT" || opener.isContentEditable) &&
        window.matchMedia("(pointer: coarse)").matches;
      if (opener && document.contains(opener) && !raisesKeyboard) opener.focus({ preventScroll: true });
    };
  }, [open]);

  return ref;
}
