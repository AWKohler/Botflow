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
  // A control that can't be pressed is flat: no shadow, no bevel, no lit wash.
  "disabled:pointer-events-none disabled:opacity-50 disabled:bg-none disabled:shadow-none disabled:inset-shadow-none";

// Raised variants carry a bevel: a hairline of light inside the top edge and
// of shade inside the bottom edge (see the --bevel-* tokens in globals.css).
// A faint wash of light over the top half rounds the surface under that edge.
const LIT = "bg-linear-to-b from-white/[0.09] to-white/0";
const INK = `bg-fg ${LIT} text-bg shadow-xs inset-shadow-bevel-ink hover:bg-fg/88 active:bg-fg/80`;

const variants: Record<ButtonVariant, string> = {
  default: INK,
  primary: INK,
  accent: `bg-accent ${LIT} text-accent-foreground shadow-xs inset-shadow-bevel-solid hover:bg-accent/90 active:bg-accent/85`,
  // A faint top-to-bottom shade plus the surface bevel; hover and press swap
  // the gradient stops, since a background colour would sit under it.
  secondary:
    "border border-border bg-linear-to-b from-bg to-surface text-fg shadow-xs inset-shadow-bevel disabled:bg-surface " +
    "hover:border-border-strong hover:from-surface hover:to-elevated active:from-elevated active:to-elevated " +
    "dark:from-elevated dark:to-surface dark:hover:from-soft dark:hover:to-elevated dark:active:from-elevated dark:active:to-elevated",
  outline: "border border-border bg-transparent text-fg hover:border-border-strong hover:bg-elevated",
  ghost: "text-muted hover:bg-elevated hover:text-fg",
  danger: `bg-danger-solid ${LIT} text-white shadow-xs inset-shadow-bevel-solid hover:bg-danger-solid/90 active:bg-danger-solid/85`,
  "danger-outline": "border border-danger-border bg-transparent text-danger hover:bg-danger-soft",
  success: `bg-success-solid ${LIT} text-white shadow-xs inset-shadow-bevel-solid hover:bg-success-solid/90 active:bg-success-solid/85`,
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
