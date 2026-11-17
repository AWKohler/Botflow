import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const tones: Record<BadgeTone, string> = {
  neutral: "border-border bg-elevated text-muted",
  accent: "border-accent/25 bg-accent-soft text-accent",
  success: "border-success-border bg-success-soft text-success",
  warning: "border-warning-border bg-warning-soft text-warning",
  danger: "border-danger-border bg-danger-soft text-danger",
  info: "border-info-border bg-info-soft text-info",
};

/** Small status / metadata pill. */
export function Badge({
  tone = "neutral",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

/** A tinted inline message block (callout) in one of the status tones. */
export function Notice({
  tone = "neutral",
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { tone?: BadgeTone }) {
  return (
    <div
      className={cn("rounded-lg border px-3 py-2.5 text-[13px] leading-relaxed", tones[tone], className)}
      {...props}
    />
  );
}
