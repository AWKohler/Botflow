import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUp } from "lucide-react";
import { BrandMark } from "@/components/site/SiteHeader";

/**
 * Split layout shared by /sign-in and /sign-up: the form on the left under
 * the brand mark, the product artwork on the right.
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
        <div className="relative h-full w-full overflow-hidden rounded-2xl border border-border">
          <Image
            src="/light-login-background.webp"
            alt=""
            fill
            priority
            className="pointer-events-none select-none object-cover dark:hidden"
          />
          <Image
            src="/dark-login-background.webp"
            alt=""
            fill
            priority
            className="pointer-events-none hidden select-none object-cover dark:block"
          />
          <div className="absolute inset-0 flex items-center justify-center px-8">
            <div className="flex w-full max-w-[440px] items-center gap-4 rounded-2xl border border-white/40 bg-white/85 py-3 pl-5 pr-3 shadow-xl backdrop-blur-md">
              <p className="flex-1 text-[15px] text-[#27272a]">Ask Botflow to build your project</p>
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#27272a] text-white">
                <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
