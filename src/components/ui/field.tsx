import { cn } from "@/lib/utils";
import {
  forwardRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { ChevronDown } from "lucide-react";
import { Input } from "./input";

/**
 * Shared form-control look: one height, radius, border and focus ring for
 * every text input, select and textarea in the app.
 */
export const fieldClass =
  "w-full rounded-lg border border-control bg-bg px-3 text-sm text-fg inset-shadow-well outline-none " +
  "placeholder:text-subtle transition-[border-color,box-shadow] duration-150 " +
  "hover:border-subtle focus:border-accent focus:ring-3 focus:ring-accent/20 " +
  "disabled:cursor-not-allowed disabled:opacity-60";

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <Input ref={ref} className={cn(fieldClass, "h-9", className)} {...props} />
  ),
);
TextInput.displayName = "TextInput";

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(fieldClass, "min-h-20 py-2 leading-relaxed", className)} {...props} />
  ),
);
TextArea.displayName = "TextArea";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    // The browser's own arrow is replaced by the same thin chevron used everywhere else.
    <span className="relative block w-full">
      <select ref={ref} className={cn(fieldClass, "h-9 appearance-none pr-8", className)} {...props} />
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted"
        strokeWidth={1.75}
      />
    </span>
  ),
);
Select.displayName = "Select";

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("block text-[13px] font-medium text-fg", className)} {...props} />;
}

export function Hint({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-xs leading-relaxed text-muted", className)} {...props} />;
}

/** Label + control + optional hint/error, with consistent spacing. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  className,
  children,
}: {
  label?: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      {label && <Label htmlFor={htmlFor}>{label}</Label>}
      {children}
      {error ? <p className="text-xs text-danger">{error}</p> : hint ? <Hint>{hint}</Hint> : null}
    </div>
  );
}
