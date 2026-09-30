import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AuthProvider } from "@/components/auth";
import "./globals.css";
import { ToastProvider } from "@/components/ui/toast";
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
    <AuthProvider>
      <html lang="en">
        <body
          className={`${geistSans.variable} ${geistMono.variable} antialiased`}
        >
          <ToastProvider>{children}</ToastProvider>
          <Analytics />
        </body>
      </html>
    </AuthProvider>
  );
}
