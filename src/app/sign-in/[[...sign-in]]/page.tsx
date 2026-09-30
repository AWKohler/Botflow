import Image from "next/image";
import { SignIn } from "@/components/auth";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string }>;
}) {
  const resolvedParams = await searchParams;
  const redirectUrl = resolvedParams?.redirect_url ?? "/";

  return (
    <div className="min-h-screen flex">
      <div className="w-full md:w-1/2 flex items-center justify-center p-6 bg-surface text-neutral-900">
        {/* <div className="w-full max-w-md mx-auto scale-120 mt-20 ml-25"> */}
        <div className="w-full max-w-md mx-auto mt-20">
          <SignIn
            forceRedirectUrl={redirectUrl}
            routing="hash"
            appearance={{
              elements: {
                socialButtons: {
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.75rem",
                  alignItems: "stretch",
                },
              },
            }}
          />
        </div>
      </div>

      <div className="hidden md:flex md:w-1/2 items-center justify-center p-4 bg-surface">
        <div className="relative w-full h-full rounded-xl overflow-hidden">
          {/* Light mode image */}
          <Image
            src="/light-login-background.webp"
            alt="Login Banner"
            fill
            priority
            className="object-cover pointer-events-none select-none rounded-lg dark:hidden"
          />
          {/* Dark mode image */}
          <Image
            src="/dark-login-background.webp"
            alt="Login Banner"
            fill
            priority
            className="object-cover pointer-events-none select-none rounded-lg hidden dark:block"
          />

          {/* Centered overlay card on top of the image */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-auto">
            <div className="flex w-[450px] items-center gap-4 rounded-2xl bg-[#FCFBF8D9]/85 px-4 py-4 shadow-xl">
              <div className="flex-1">
                <p className="text-base text-black">
                  <span className="relative inline-block min-w-[80px] text-base">
                    {/* <span className="invisible">&ZeroWidthSpace;</span> */}
                    Ask Botflow to build your project
                    {/* <span
                      className="absolute top-1/2 ml-[2px] inline-block h-[1.4em] w-[2px] -translate-y-1/2 bg-[#1F68DB] opacity-100"
                      aria-hidden="true"
                    /> */}
                  </span>
                </p>
              </div>

              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-900">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-white"
                >
                  <path d="M12 19V5M5 12l7-7 7 7"></path>
                </svg>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
