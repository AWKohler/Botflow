import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUp, Check } from "lucide-react";
import { serif } from "@/components/landing/fonts";
import { BrandMark } from "@/components/site/SiteHeader";

const POINTS = ["Real code you own", "A backend included", "Live in one click"];

/**
 * Split layout shared by /sign-in and /sign-up: the form on the left under
 * the brand mark, and a quiet on-palette panel on the right that shows what
 * the product does (a prompt in, an app out) instead of unrelated artwork.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-bg text-fg">
      <div className="flex w-full flex-col md:w-1/2">
        <div className="px-6 py-5 sm:px-10">
          <Link href="/" aria-label="Botflow home" className="inline-flex items-center rounded-md">
            <BrandMark />
          </Link>
        </div>
        <div className="flex flex-1 items-center justify-center px-2 pb-16">
          <div className="w-full max-w-md">{children}</div>
        </div>
      </div>

      <div className="hidden p-3 md:flex md:w-1/2">
        <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-2xl border border-border bg-surface px-10">
          {/* Faint editorial grid, fading out toward the edges. */}
          <div
            aria-hidden="true"
            className="absolute inset-0"
            style={{
              backgroundImage:
                "linear-gradient(var(--sand-border) 1px, transparent 1px), linear-gradient(to right, var(--sand-border) 1px, transparent 1px)",
              backgroundSize: "40px 40px",
              maskImage: "radial-gradient(ellipse at center, black 30%, transparent 78%)",
              WebkitMaskImage: "radial-gradient(ellipse at center, black 30%, transparent 78%)",
              opacity: 0.7,
            }}
          />
          <div className="relative w-full max-w-[440px]">
            <p className={`${serif.className} text-[2.75rem] leading-[1.05] tracking-tight`}>
              Describe it. <em>Botflow builds it.</em>
            </p>
            <div className="mt-8 rounded-2xl border border-border bg-bg p-4 shadow-lg">
              <p className="min-h-[3.25rem] text-[15px] leading-relaxed text-fg">
                A booking page for my studio, with payments and a calendar
              </p>
              <div className="mt-2 flex items-center justify-between">
                <span className="rounded-full border border-border bg-elevated px-2.5 py-1 text-xs font-medium text-muted">
                  Web app
                </span>
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-fg text-bg">
                  <ArrowUp className="h-4 w-4" strokeWidth={2.25} />
                </span>
              </div>
            </div>
            <ul className="mt-7 space-y-2 text-sm text-muted">
              {POINTS.map((point) => (
                <li key={point} className="flex items-center gap-2">
                  <Check className="h-3.5 w-3.5 text-subtle" />
                  {point}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
