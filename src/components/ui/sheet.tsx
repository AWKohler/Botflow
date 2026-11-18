"use client";

import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import { useId, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { buttonClass } from "./button";
import { useModal } from "./use-modal";

const PHONE_QUERY = "(max-width: 639px)";

function subscribePhone(onChange: () => void) {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * True on a phone-width window (below Tailwind's `sm`). False on the server
 * and for the first client render, so use it for things that only appear
 * after an interaction (an open menu), never for the page's first paint.
 */
export function useIsPhone() {
  return useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );
}

/**
 * For a popover that is anchored to its button on larger screens (fixed, with
 * inline `top`/`right`): on a phone these classes turn the same element into a
 * bottom sheet instead, where a 420px panel hanging off a button would run off
 * the side of the screen. Put `phoneSheetBackdropClass` on its click-away layer.
 */
export const phoneSheetClass =
  "max-sm:inset-x-0 max-sm:bottom-0 max-sm:top-auto! max-sm:right-0! max-sm:w-full max-sm:max-w-none " +
  "max-sm:rounded-b-none max-sm:rounded-t-2xl max-sm:border-x-0 max-sm:border-b-0 " +
  "max-sm:pb-[env(safe-area-inset-bottom)] max-sm:motion-safe:animate-[sheet-up_0.24s_cubic-bezier(0.2,0.8,0.2,1)]";
export const phoneSheetBackdropClass =
  "max-sm:bg-black/40 max-sm:backdrop-blur-[2px] max-sm:motion-safe:animate-[sheet-fade_0.18s_ease-out]";
/** Title row and scrolling body of such a popover, sized for a phone. */
export const phoneSheetTitleClass = "max-sm:pl-5 max-sm:pr-2 max-sm:py-2 max-sm:[&_h3]:text-base";
export const phoneSheetCloseClass = "max-sm:flex max-sm:size-11 max-sm:items-center max-sm:justify-center max-sm:[&_svg]:size-5";
export const phoneSheetBodyClass = "max-sm:max-h-[calc(85dvh-3.75rem)] max-sm:overflow-y-auto max-sm:overscroll-contain";

/**
 * A panel that slides up from the bottom edge of a phone screen. On a phone a
 * long menu anchored to its button has nowhere to go: it runs under the header
 * or off the side. A sheet gives the same content the full width, a reachable
 * position and rows big enough to tap.
 *
 * It is a modal like `Dialog`: rendered at the end of <body>, focus is held
 * inside, the page behind is inert, and Escape, the close button or a tap on
 * the dimmed backdrop close it.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
  zIndex = 200,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  zIndex?: number;
}) {
  const panelRef = useModal<HTMLDivElement>(open, onClose);
  const titleId = useId();
  const descriptionId = useId();

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 flex items-end bg-black/40 backdrop-blur-[2px] motion-safe:animate-[sheet-fade_0.18s_ease-out]"
      style={{ zIndex }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          "flex max-h-[85dvh] w-full flex-col rounded-t-2xl border-t border-border bg-bg text-fg shadow-2xl outline-none",
          "inset-shadow-bevel-top dark:border-border-strong dark:bg-elevated",
          "pb-[env(safe-area-inset-bottom)] motion-safe:animate-[sheet-up_0.24s_cubic-bezier(0.2,0.8,0.2,1)]",
          className,
        )}
      >
        {/* Grabber: says "sheet" at a glance. Decorative; the close button does the work. */}
        <div aria-hidden="true" className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border-strong" />
        <div className="flex shrink-0 items-center justify-between gap-3 pb-1 pl-5 pr-2 pt-1">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold leading-6 text-fg">{title}</h2>
            {description && <p id={descriptionId} className="text-[13px] leading-relaxed text-muted">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={buttonClass({ variant: "ghost", size: "icon", className: "size-11 shrink-0" })}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="modern-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
        {footer && <div className="shrink-0 border-t border-border px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
