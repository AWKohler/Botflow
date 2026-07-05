"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Anthropic } from "@/components/icons/anthropic";
import { OpenAI } from "@/components/icons/openai";

/**
 * FeatureBento — Apple-Intelligence-style bento grid summarizing Botflow's
 * feature set. Typography-led tiles (eyebrow → title → optional body) around a
 * gradient serif brand tile; imagery lives in /public/bento (device composite,
 * Apple's Dynamic Island shot, gpt-image-2 frosted-glass pieces).
 *
 * Desktop is a 4-column grid: a 2-row iPhone tile anchors the left, the
 * Dynamic Island tile (always dark, matching its photo) spans two columns
 * top-right, and the brand tile sits dead center.
 */

const EASE_OUT = "cubic-bezier(0.43, 0.195, 0.02, 1)";

// ── Per-tile scroll reveal (staggered rise, same feel as the page Reveal) ───
function useInView() {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (!ref.current || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          obs.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    obs.observe(ref.current);
    return () => obs.disconnect();
  }, []);
  return { ref, inView };
}

// ── Tile chrome ─────────────────────────────────────────────────────────────

function Tile({
  children,
  className,
  delay = 0,
  dark = false,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  /** Forces the tile dark in BOTH color schemes (image tiles with black art). */
  dark?: boolean;
}) {
  const { ref, inView } = useInView();
  return (
    <div
      ref={ref}
      className={cn(
        "group relative overflow-hidden rounded-[28px] border",
        dark
          ? "border-black/40 bg-[#060608]"
          : "border-[var(--sand-border)] bg-[var(--sand-bg)]",
        "transition-[transform,box-shadow] duration-300 hover:-translate-y-0.5",
        className,
      )}
      style={{
        opacity: inView ? 1 : 0,
        transform: inView ? "translateY(0)" : "translateY(1.25rem)",
        transition: `transform 0.7s ${EASE_OUT} ${delay}ms, opacity 0.7s ${EASE_OUT} ${delay}ms`,
        boxShadow:
          "0 1px 2px rgba(31, 27, 22, 0.05), 0 16px 40px -18px rgba(31, 27, 22, 0.16)",
      }}
    >
      {children}
    </div>
  );
}

function Eyebrow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--sand-accent)]",
        className,
      )}
    >
      {children}
    </p>
  );
}

function Title({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h3
      className={cn(
        "mt-1.5 text-[19px] font-semibold leading-snug tracking-[-0.01em] text-[var(--sand-text)]",
        className,
      )}
    >
      {children}
    </h3>
  );
}

function Body({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "mt-1.5 text-[13px] leading-relaxed text-[var(--sand-text-muted)]",
        className,
      )}
    >
      {children}
    </p>
  );
}

// ── Sign-in pills (vector, so they stay crisp and theme correctly) ──────────

function ProviderPills() {
  return (
    <div className="relative mt-6 flex flex-col items-center gap-3">
      <div
        className="flex w-fit items-center gap-2.5 rounded-full border border-transparent bg-[#1f1e1d] px-5 py-3 -rotate-2 dark:border-white/15"
        style={{
          boxShadow:
            "0 14px 28px -10px rgba(0,0,0,0.45), 0 2px 6px rgba(0,0,0,0.2)",
        }}
      >
        <Anthropic className="h-4 w-4 shrink-0 text-[#d97757]" />
        <span className="whitespace-nowrap text-[13.5px] font-medium text-white">
          Continue with Claude
        </span>
      </div>
      <div
        className="ml-6 flex w-fit items-center gap-2.5 rounded-full border border-[var(--sand-border)] bg-white px-5 py-3 rotate-1"
        style={{
          boxShadow:
            "0 14px 28px -12px rgba(0,0,0,0.28), 0 2px 6px rgba(0,0,0,0.08)",
        }}
      >
        <OpenAI className="h-4 w-4 shrink-0 text-black" />
        <span className="whitespace-nowrap text-[13.5px] font-medium text-black">
          Continue with ChatGPT
        </span>
      </div>
    </div>
  );
}

// ── The grid ─────────────────────────────────────────────────────────────────

export function FeatureBento({
  serifClassName,
  className,
}: {
  serifClassName?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:auto-rows-[290px]",
        className,
      )}
    >
      {/* 1 — Swift authentication flow (tall) */}
      <Tile className="sm:row-span-2" delay={0}>
        <div className="flex h-full min-h-[600px] flex-col p-6 pb-0 sm:min-h-[480px]">
          <Title>
            Auth for your app.
            <br />
            Just ask Botflow.
          </Title>
          <Body>
            Sign-up, sign-in, sessions, and social providers — wired into your
            Swift app for you.
          </Body>
          <div className="relative mt-5 flex-1">
            <Image
              src="/bento/swift-app-auth.png"
              alt="An iPhone showing an authentication flow built by Botflow"
              width={700}
              height={1431}
              sizes="(min-width: 1024px) 25vw, (min-width: 640px) 50vw, 90vw"
              className="absolute left-1/2 top-0 w-[78%] max-w-[250px] -translate-x-1/2 transition-transform duration-500 group-hover:-translate-y-1.5"
              style={{ filter: "drop-shadow(0 24px 38px rgba(0,0,0,0.3))" }}
            />
          </div>
        </div>
      </Tile>

      {/* 2 — Bring your own AI */}
      <Tile delay={60}>
        <div className="flex h-full flex-col p-6">
          {/*<Eyebrow>Bring your own AI</Eyebrow>*/}
          <Title>Sign in with Claude or&nbsp;ChatGPT.</Title>
          <Body>Your existing Max or Pro plan powers the agent.</Body>
          <div className="flex flex-1 items-center justify-center pb-2">
            <ProviderPills />
          </div>
        </div>
      </Tile>

      {/* 3 — Dynamic Island (always dark, matches the photo) */}
      <Tile className="sm:col-span-2" delay={120} dark>
        <div className="relative flex h-full min-h-[290px] flex-col p-6">
          <div className="relative z-10 sm:max-w-[48%]">
            {/*<Eyebrow className="text-[#f46a13]">Only possible native</Eyebrow>*/}
            <Title className="text-white">
              Live in the Dynamic&nbsp;Island, only with Botflow.
            </Title>
            <Body className="text-white/60">
              Live Activities, widgets, push — the iOS surfaces a wrapped web
              app can never reach.
            </Body>
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 top-[52%] sm:left-auto sm:right-4 sm:top-[8%] sm:w-[50%]">
            <Image
              src="/bento/dynamic-island.webp"
              alt="iPhones showing Live Activities in the Dynamic Island"
              fill
              sizes="(min-width: 1024px) 25vw, 100vw"
              className="object-contain object-bottom transition-transform duration-500 group-hover:scale-[1.015] sm:object-right-bottom"
            />
          </div>
        </div>
      </Tile>

      {/* 4 — Brand center */}
      <Tile className="sm:col-span-2" delay={180}>
        <div className="flex h-full min-h-[240px] flex-col items-center justify-center p-6 text-center">
          {/*<img src={"/botflow_black.svg"} />*/}

          <div
            style={{
              position: "relative",
              width: "95%",
              height: "100px",
              margin: "0 auto",
            }}
          >
            <Image
              src="/botflow_black.svg"
              alt="Botflow"
              fill
              style={{ objectFit: "contain" }}
              priority
              className="block dark:hidden"
            />

            <Image
              src="/botflow_white.svg"
              alt="Botflow"
              fill
              style={{ objectFit: "contain" }}
              priority
              className="hidden dark:block"
            />
          </div>

          {/*<span
            className={cn(
              serifClassName,
              "text-6xl tracking-tight sm:text-8xl",
            )}
            style={{
              backgroundImage:
                "linear-gradient(100deg, #1d52f1 0%, #7b4be8 42%, #d8826a 72%, #f46a13 100%)",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
            }}
          >
            Botflow
          </span>*/}
          <p className="mt-3 text-[13px] font-medium uppercase tracking-[0.18em] text-[var(--sand-text-muted)]">
            There is no moat
          </p>
        </div>
      </Tile>

      {/* 5 — Swift toolchain */}
      <Tile delay={240}>
        <div className="flex h-full flex-col p-6">
          <div className="relative flex flex-1 items-center justify-center">
            <div
              className="pointer-events-none absolute h-40 w-40 rounded-full"
              style={{
                background:
                  "radial-gradient(closest-side, color-mix(in oklab, #f46a13 16%, transparent), transparent 70%)",
              }}
            />
            <Image
              src="/bento/swift-logo.webp"
              alt="Swift"
              width={500}
              height={313}
              className="relative w-[72%] max-w-[190px] dark:hidden"
            />
            <Image
              src="/bento/swift-logo-dark.webp"
              alt="Swift"
              width={500}
              height={313}
              className="relative hidden w-[72%] max-w-[190px] dark:block"
            />
          </div>
          <div className="pt-4">
            <Eyebrow className="text-[#f46a13]">Under the hood</Eyebrow>
            <Title className="text-[17px]">
              SwiftUI, compiled for&nbsp;real.
            </Title>
          </div>
        </div>
      </Tile>

      {/* 6 — Webcam → Simulator */}
      <Tile delay={0}>
        <div className="flex h-full flex-col p-6">
          {/*<Eyebrow>Simulator superpowers</Eyebrow>*/}
          <Title className="text-[17px]">
            iPhone simulator, piped into your&nbsp;Browser.
          </Title>
          <div className="relative flex flex-1 items-center justify-center py-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {/*<img
              src="/bento/art-webcam.webp"
              alt=""
              className="h-full max-h-[150px] w-auto transition-transform duration-500 group-hover:-translate-y-1"
              style={{ filter: "drop-shadow(0 16px 26px rgba(31,27,22,0.28))" }}
            />*/}

            <div
              aria-hidden
              className="pointer-events-none absolute left-6 right-0 top-[15px] bottom-0"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/bento/sim-light.png"
                alt=""
                className="absolute left-0 top-0 w-[110%] max-w-none rounded-md border border-border block dark:hidden"
                style={{
                  WebkitMaskImage:
                    "linear-gradient(to bottom right, #000 26%, transparent 74%)",
                  maskImage:
                    "linear-gradient(to bottom right, #000 26%, transparent 74%)",
                }}
              />

              <img
                src="/bento/sim-dark.png"
                alt=""
                className="absolute left-0 top-0 w-[110%] max-w-none rounded-tl-md border border-border hidden dark:block"
                style={{
                  WebkitMaskImage:
                    "linear-gradient(to bottom right, #000 26%, transparent 74%)",
                  maskImage:
                    "linear-gradient(to bottom right, #000 26%, transparent 74%)",
                }}
              />
            </div>
          </div>
        </div>
      </Tile>

      {/* 7 — Ship to the App Store */}
      <Tile delay={60}>
        <div className="flex h-full flex-col p-6">
          {/*<Eyebrow>Ship it</Eyebrow>*/}
          <Title className="text-[17px]">
            One click to TestFlight and the App&nbsp;Store.
          </Title>
          <div className="relative flex flex-1 items-center justify-center py-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/bento/art-ship-plane.webp"
              alt=""
              className="h-full max-h-[150px] w-auto transition-transform duration-500 group-hover:-translate-y-1 group-hover:translate-x-1"
              style={{ filter: "drop-shadow(0 16px 26px rgba(31,27,22,0.28))" }}
            />
          </div>
        </div>
      </Tile>

      {/* 8 — In-app purchases */}
      <Tile delay={120}>
        <div className="flex h-full flex-col p-6">
          {/*<Eyebrow>Revenue, day one</Eyebrow>*/}
          <Title className="text-[17px]">
            Subscriptions wired with&nbsp;RevenueCat.
          </Title>
          <div className="relative flex flex-1 items-center justify-center py-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/bento/art-iap-coins.webp"
              alt=""
              className="h-full max-h-[150px] w-auto transition-transform duration-500 group-hover:-translate-y-1"
              style={{ filter: "drop-shadow(0 16px 26px rgba(31,27,22,0.28))" }}
            />
          </div>
        </div>
      </Tile>

      {/* 9 — Web too: the Convex dashboard bleeds off the clipped bottom-right
          corner, focus held on the sidebar in the top-left, opacity fading out
          toward the bottom-right (a diagonal mask). */}
      <Tile delay={180} className="min-h-[300px] lg:min-h-0">
        <div
          aria-hidden
          className="pointer-events-none absolute left-6 right-0 top-[100px] bottom-0"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/bento/convex-dash-light.png"
            alt=""
            className="absolute left-0 top-0 w-[128%] max-w-none rounded-tl-md border border-white/10 block dark:hidden"
            style={{
              WebkitMaskImage:
                "linear-gradient(to bottom right, #000 26%, transparent 74%)",
              maskImage:
                "linear-gradient(to bottom right, #000 26%, transparent 74%)",
            }}
          />

          <img
            src="/bento/convex-dash-dark.png"
            alt=""
            className="absolute left-0 top-0 w-[128%] max-w-none rounded-tl-md border border-white/10 hidden dark:block"
            style={{
              WebkitMaskImage:
                "linear-gradient(to bottom right, #000 26%, transparent 74%)",
              maskImage:
                "linear-gradient(to bottom right, #000 26%, transparent 74%)",
            }}
          />
        </div>
        <div className="relative z-10 p-6">
          {/*<Eyebrow>Not just iOS</Eyebrow>*/}
          <Title className="text-[17px]">Full-stack, Backend included.</Title>
        </div>
      </Tile>
    </div>
  );
}
