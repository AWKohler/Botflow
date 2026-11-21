import Link from "next/link";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/site/SiteHeader";
import { AuthArt } from "./auth-art";

/**
 * Split layout shared by /sign-in and /sign-up: the form on the left under
 * the brand mark, and a painted canvas on the right in the brand's colours.
 * Phones get the form alone: the painting only shows from the md breakpoint.
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
        <div className="flex flex-1 items-start justify-center px-2 pb-12 pt-4 md:items-center md:pb-16 md:pt-0">
          <div className="w-full max-w-md">{children}</div>
        </div>
      </div>

      <div className="hidden p-3 md:flex md:w-1/2">
        <AuthArt />
      </div>
    </div>
  );
}
