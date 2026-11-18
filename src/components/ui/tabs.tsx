import { cn } from "@/lib/utils";

export type TabOption<T extends string> = {
  value: T;
  text: string;
};

interface TabsProps<T extends string> {
  options: TabOption<T>[];
  selected: T;
  onSelect: (value: T) => void;
  className?: string;
  stretch?: boolean;
  size?: "sm" | "default" | "lg";
}

/**
 * Segmented control. The selected segment is a raised neutral chip rather
 * than a filled accent block, so it reads as "where you are" without
 * competing with the primary action on the page.
 */
export function Tabs<T extends string>({ options, selected, onSelect, className, stretch, size = "default" }: TabsProps<T>) {
  const single = options.length === 1;
  const expand = single || stretch;
  return (
    <div
      role="tablist"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg border border-border bg-elevated p-0.5 inset-shadow-well dark:bg-bg",
        expand && "flex w-full",
        className,
      )}
    >
      {options.map((option) => {
        const active = selected === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(option.value)}
            className={cn(
              "tap-44 rounded-md font-medium transition-[background-color,color,box-shadow] duration-150",
              size === "sm" ? "h-6 px-2.5 text-xs" : size === "lg" ? "h-9 px-5 text-sm" : "h-7 px-3 text-[13px]",
              expand && "flex-1",
              active
                ? "bg-bg text-fg shadow-sm inset-shadow-bevel-top ring-1 ring-border-strong/50 dark:bg-soft dark:ring-border-strong"
                : "text-muted hover:text-fg",
            )}
          >
            {option.text}
          </button>
        );
      })}
    </div>
  );
}
