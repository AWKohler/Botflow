"use client";

import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { buttonClass } from "./button";

const SIZES = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
} as const;

export const overlayClass =
  "fixed inset-0 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]";
export const dialogPanelClass =
  "relative w-full rounded-2xl border border-border bg-bg text-fg shadow-2xl";

/**
 * Standard modal: dimmed backdrop, one panel style, a title row with a close
 * button, a scrollable body and an optional right-aligned footer for actions.
 * Closes on Escape and on backdrop click.
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
  useEffect(() => {
    if (!open || !dismissable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, dismissable, onClose]);

  if (!open) return null;

  return (
    <div
      className={overlayClass}
      style={{ zIndex }}
      onMouseDown={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={cn(dialogPanelClass, "flex max-h-[calc(100vh-2rem)] flex-col", SIZES[size], className)}
      >
        {(title || dismissable) && (
          <div className="flex items-start justify-between gap-4 px-6 pb-1 pt-5">
            <div className="min-w-0">
              {title && <h2 className="text-base font-semibold leading-6 text-fg">{title}</h2>}
              {description && <p className="mt-1 text-[13px] leading-relaxed text-muted">{description}</p>}
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
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-3.5">{footer}</div>
        )}
      </div>
    </div>
  );
}
