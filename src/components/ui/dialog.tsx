"use client";

import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import { useId, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { buttonClass } from "./button";
import { useModal } from "./use-modal";

const SIZES = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
} as const;

// On a phone a dialog sits toward the top, so the on-screen keyboard (which
// takes the lower half) does not cover its field or its actions, and its
// height stops above the keyboard (see KeyboardInset). The same three classes
// are used by the dialogs that build their own frame.
export const phoneOverlayClass = "max-sm:items-start max-sm:pt-[max(1rem,9dvh)]";
export const phonePanelClass =
  "max-sm:max-h-[calc(100dvh-1rem-max(1rem,9dvh)-var(--keyboard-inset,0px))] max-sm:overflow-y-auto";
/** For a native <dialog> centred with `m-auto`. */
export const phoneNativeDialogClass =
  "max-sm:mb-auto max-sm:mt-[max(1rem,9dvh)] max-sm:max-h-[calc(100dvh-1rem-max(1rem,9dvh)-var(--keyboard-inset,0px))]";
export const overlayClass =
  `fixed inset-0 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px] ${phoneOverlayClass}`;
export const dialogPanelClass =
  "relative w-full rounded-2xl border border-border bg-bg text-fg shadow-2xl inset-shadow-bevel-top dark:border-border-strong";

/**
 * Standard modal: dimmed backdrop, one panel style, a title row with a close
 * button, a scrollable body and an optional right-aligned footer for actions.
 * Rendered at the end of <body>. Focus moves in and stays in, the rest of the
 * page is inert, Escape and a backdrop click close it, and focus returns to
 * the control that opened it. The title and description name the dialog.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  className,
  zIndex = 200,
  dismissable = true,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: keyof typeof SIZES;
  className?: string;
  zIndex?: number;
  dismissable?: boolean;
}) {
  const panelRef = useModal<HTMLDivElement>(open, dismissable ? onClose : undefined);
  const titleId = useId();
  const descriptionId = useId();

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className={overlayClass}
      style={{ zIndex }}
      onMouseDown={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(dialogPanelClass, "flex max-h-[calc(100dvh-2rem)] flex-col outline-none max-sm:max-h-[calc(100dvh-1rem-max(1rem,9dvh)-var(--keyboard-inset,0px))]", SIZES[size], className)}
      >
        {(title || dismissable) && (
          <div className="flex items-start justify-between gap-4 px-6 pb-1 pt-5 max-sm:px-5">
            <div className="min-w-0">
              {title && <h2 id={titleId} className="text-base font-semibold leading-6 text-fg">{title}</h2>}
              {description && <p id={descriptionId} className="mt-1 text-[13px] leading-relaxed text-muted">{description}</p>}
            </div>
            {dismissable && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className={buttonClass({ variant: "ghost", size: "icon-sm", className: "-mr-2 -mt-1 shrink-0" })}
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 max-sm:px-5">{children}</div>
        {footer && (
          // Phone: the actions share the full width, so each is an easy target.
          <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-3.5 max-sm:px-5 max-sm:[&>*]:flex-1">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
