import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import { ToastProvider } from "@/components/ui/toast";
import { shadcn } from "@clerk/themes";
import { enUS } from "@clerk/localizations";
import { Analytics } from "@vercel/analytics/next";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const SITE_URL = "https://botflow.io";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Botflow — Build Full-Stack Apps with AI",
    template: "%s — Botflow",
  },
  description:
    "Create full-stack web apps by chatting with AI. Botflow runs a real Node.js environment in your browser — no setup, no deploys, just ship.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "Botflow — Build Full-Stack Apps with AI",
    description:
      "Create full-stack web apps by chatting with AI. Botflow runs a real Node.js environment in your browser — no setup, no deploys, just ship.",
    type: "website",
    siteName: "Botflow",
    url: SITE_URL,
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "Botflow" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Botflow — Build Full-Stack Apps with AI",
    description:
      "Create full-stack web apps by chatting with AI. Botflow runs a real Node.js environment in your browser — no setup, no deploys, just ship.",
    images: ["/og-image.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      signInFallbackRedirectUrl="/"
      signUpFallbackRedirectUrl="/"
      localization={{
        ...enUS,
        socialButtonsBlockButtonManyInView: "Continue with {{provider}}",
      }}
      appearance={{
        elements: {
          dividerLine: "!bg-[var(--sand-border)]",
          buttonArrowIcon: "!hidden",
          header: "!text-[var(--sand-text)]",
          button: "!bg-[var(--color-elevated)]",
          socialButtonsBlockButtonText: "!text-[var(--sand-text)]",
          socialButtonsBlockButton: "!gap-0",
          footerActionLink: "!text-[var(--sand-text)] !underline",
          cardBox:
            "!border-none !border-transparent !shadow-none !shadow-transparent",
          card: "!border-none !border-transparent !shadow-none !shadow-transparent !mb-0 !pb-0",
          formButtonPrimary: "!text-[var(--sand-bg)] !bg-[var(--sand-text)]",
          // formField__username: "!bg-[var(--color-elevated)] !font-bold",
          userPreview: "!text-[var(--sand-text)]",
          userPreviewMainIdentifierText: "!text-[var(--sand-text)]",
          // rootBox: "!text-[var(--sand-text)]",
          navbar: "!text-[var(--sand-text)] !bg-surface",
          footer: "!pt-0 !mt-0",
          headerTitle: "!text-[var(--sand-text)]",
          profileSection: "!border-[var(--sand-border)]",
          profilePage: "!text-[var(--sand-text)]",
          internal: "!text-[var(--sand-text)]",
          title: "!text-[var(--sand-text)]",
          // text: "!text-[var(--sand-text)]",
          badge: "!text-[var(--sand-text)]",

          switchIndicator: "bg-accent",
          pricingTableCard: "!shadow-none border",


          pricingTableCardFooterButton: "!text-[var(--sand-bg)] !bg-[var(--sand-text)]",

          input: "!bg-[var(--color-elevated)] !text-[var(--sand-text)]",
          formFieldInput: "!bg-[var(--color-elevated)] !text-[var(--sand-text)]",


          alertText: "text-accent",
          alertIcon: "!text-accent",
        },

        baseTheme: shadcn,
        variables: {
          // use CSS variables so Clerk follows light/dark modes
          colorBackground: "var(--color-surface)",
          colorText: "var(--sand-text)",
          colorTextSecondary: "var(--sand-text-muted)",
          colorInputBackground: "var(--sand-elevated)",
          colorInputText: "var(--sand-text)",
          colorNeutral: "var(--sand-text)",
        },
      }}
    >
      <html lang="en">
        <body
          className={`${geistSans.variable} ${geistMono.variable} antialiased`}
        >
          <ToastProvider>{children}</ToastProvider>
          <Analytics />
        </body>
      </html>
    </ClerkProvider>
  );
}
