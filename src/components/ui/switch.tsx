"use client";

import { cn } from "@/lib/utils";

/**
 * The one on/off switch. Off is a quiet fill with a control-border edge, so
 * the track stays visible on every surface in both themes; on is the accent.
 */
export function Switch({
  checked,
  onChange,
  disabled,
  "aria-label": ariaLabel,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        // tap-44: a 44px hit area on touch screens around the 20px track.
        "tap-44 relative inline-flex h-5 w-9 shrink-0 cursor-pointer appearance-none items-center rounded-full border p-0 transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-60",
        "inset-shadow-well",
        checked ? "border-accent bg-accent" : "border-control bg-soft",
        className,
      )}
    >
      <span
        className={cn(
          "inline-block h-3.5 w-3.5 rounded-full shadow-sm transition-transform",
          // Off: a white knob with a hairline edge on the pale, outlined track
          // (a soft grey knob in dark); on: white on the accent.
          checked
            ? "translate-x-[18px] bg-white"
            : "translate-x-[2px] bg-white ring-1 ring-control dark:bg-muted dark:ring-0",
        )}
      />
    </button>
  );
}
