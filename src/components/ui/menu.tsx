import { cn } from "@/lib/utils";
import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes } from "react";

/** Popover surface shared by every dropdown menu and floating panel. */
/** In dark mode shadows barely show, so the surface itself is one step lighter with a stronger edge. */
export const popoverClass =
  "rounded-xl border border-border bg-bg shadow-lg dark:border-border-strong dark:bg-elevated";

export const Menu = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} role="menu" className={cn(popoverClass, "p-1", className)} {...props} />
  ),
);
Menu.displayName = "Menu";

export const menuItemClass =
  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] text-fg transition-colors " +
  "hover:bg-elevated dark:hover:bg-soft disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent";

export const MenuItem = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "default" | "danger" }
>(({ className, tone = "default", type, ...props }, ref) => (
  <button
    ref={ref}
    type={type ?? "button"}
    role="menuitem"
    className={cn(menuItemClass, tone === "danger" && "text-danger hover:bg-danger-soft", className)}
    {...props}
  />
));
MenuItem.displayName = "MenuItem";

export function MenuSeparator({ className }: { className?: string }) {
  return <div role="separator" className={cn("my-1 h-px bg-border", className)} />;
}
