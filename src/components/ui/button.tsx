import { cn } from "@/lib/utils";
import { ButtonHTMLAttributes, forwardRef } from "react";

export type ButtonVariant =
  | "default"
  | "primary"
  | "accent"
  | "secondary"
  | "outline"
  | "ghost"
  | "danger"
  | "danger-outline"
  | "success";

export type ButtonSize = "xs" | "sm" | "default" | "lg" | "icon" | "icon-sm";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/**
 * The one button style for the app. Pick the variant by intent:
 *   default        the main action of a view (ink). `primary` is an alias.
 *   accent         the brand accent fill. Not used for actions today — every
 *                  primary action is ink so buttons read the same everywhere;
 *                  the accent is kept for links, selection and focus.
 *   secondary      a peer action next to a primary one
 *   outline/ghost  low-emphasis and toolbar actions
 *   danger*        destructive actions
 *   success        a positive, completed/confirming action
 *
 * `buttonClass()` returns the same classes for links styled as buttons.
 */
const base =
  "inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium " +
  "transition-[background-color,border-color,color,box-shadow,opacity] duration-150 " +
  "disabled:pointer-events-none disabled:opacity-50";

const INK = "bg-fg text-bg shadow-xs hover:bg-fg/88 active:bg-fg/80";

const variants: Record<ButtonVariant, string> = {
  default: INK,
  primary: INK,
  accent: "bg-accent text-accent-foreground shadow-xs hover:bg-accent/90 active:bg-accent/85",
  secondary:
    "border border-border bg-bg text-fg shadow-xs hover:border-border-strong hover:bg-elevated active:bg-soft/70",
  outline: "border border-border bg-transparent text-fg hover:border-border-strong hover:bg-elevated",
  ghost: "text-muted hover:bg-elevated hover:text-fg",
  danger: "bg-danger-solid text-white shadow-xs hover:bg-danger-solid/90 active:bg-danger-solid/85",
  "danger-outline": "border border-danger-border bg-transparent text-danger hover:bg-danger-soft",
  success: "bg-success-solid text-white shadow-xs hover:bg-success-solid/90 active:bg-success-solid/85",
};

const sizes: Record<ButtonSize, string> = {
  xs: "h-7 px-2.5 text-xs",
  sm: "h-8 px-3 text-[13px]",
  default: "h-9 px-3.5 text-sm",
  lg: "h-11 px-5 text-[15px]",
  icon: "h-9 w-9",
  "icon-sm": "h-8 w-8",
};

export function buttonClass(
  opts: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {},
) {
  return cn(base, variants[opts.variant ?? "default"], sizes[opts.size ?? "default"], opts.className);
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", type, ...props }, ref) => {
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        className={buttonClass({ variant, size, className })}
        {...props}
      />
    );
  }
);

Button.displayName = "Button";

export { Button };
