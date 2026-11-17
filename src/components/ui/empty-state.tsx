import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Centered empty / error placeholder: icon tile, one-line title, one sentence
 * of help, and at most one action.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  tone = "neutral",
  className,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "danger";
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-16 text-center", className)}>
      {Icon && (
        <div
          className={cn(
            "mb-4 flex h-11 w-11 items-center justify-center rounded-xl border",
            tone === "danger"
              ? "border-danger-border bg-danger-soft text-danger"
              : "border-border bg-elevated text-muted",
          )}
        >
          <Icon className="h-5 w-5" strokeWidth={1.75} />
        </div>
      )}
      <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
      {description && <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted">{description}</p>}
      {action && <div className="mt-5 flex items-center gap-2">{action}</div>}
    </div>
  );
}
