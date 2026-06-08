'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SignedIn, SignedOut, UserButton } from '@clerk/nextjs';
import { ArrowRight, Cog } from 'lucide-react';
import { Instrument_Serif } from 'next/font/google';
import { cn } from '@/lib/utils';
import { SettingsModal } from '@/components/settings/SettingsModal';

// ============================================================================
// Typography + easing tokens shared across landing / subpages
// ============================================================================

export const serif = Instrument_Serif({
  weight: '400',
  style: ['normal', 'italic'],
  subsets: ['latin'],
  display: 'swap',
});

export const EASE_OUT = 'cubic-bezier(0.43, 0.195, 0.02, 1)';
export const EASE_SNAP = 'cubic-bezier(0.5, 0, 0, 1)';

// ============================================================================
// Scroll reveal
// ============================================================================

export function useInView(opts?: IntersectionObserverInit) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (!ref.current || typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          obs.disconnect();
        }
      },
      { threshold: 0.08, ...opts },
    );
    obs.observe(ref.current);
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { ref, inView };
}

export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const { ref, inView } = useInView();
  return (
    <div
      ref={ref}
      className={cn(className)}
      style={{
        transform: inView ? 'translateY(0)' : 'translateY(2rem)',
        opacity: inView ? 1 : 0,
        transition: `transform 0.8s ${EASE_OUT} ${delay}ms, opacity 0.8s ${EASE_OUT} ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}

// ============================================================================
// Animated line divider — grows from scaleX(0) when in view
// ============================================================================

export function LineDivider({ className }: { className?: string }) {
  const { ref, inView } = useInView();
  return (
    <div ref={ref} className={cn('relative w-full overflow-hidden', className)}>
      <div
        className="h-px w-full origin-center"
        style={{
          background: 'var(--sand-border)',
          transform: inView ? 'scaleX(1)' : 'scaleX(0)',
          transition: `transform 1s ${EASE_SNAP}`,
        }}
      />
    </div>
  );
}

// ============================================================================
// Small uppercase section label
// ============================================================================

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span
      className="inline-block text-[11px] font-medium uppercase tracking-[0.2em] text-[var(--sand-text-muted)] mb-5"
      style={{ letterSpacing: '0.2em' }}
    >
      {children}
    </span>
  );
}

// ============================================================================
// Primary CTA — character stagger on hover
// ============================================================================

export function StaggerButton({
  text,
  href,
  className,
}: {
  text: string;
  href: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'group relative inline-flex items-center gap-2 overflow-hidden rounded-xl bg-[var(--sand-accent)] px-6 py-3 text-base font-medium shadow-lg',
        className,
      )}
    >
      <span className="relative flex overflow-hidden">
        {text.split('').map((char, i) => (
          <span
            key={i}
            className="inline-block transition-transform duration-300 group-hover:-translate-y-[1.5em]"
            style={{
              transitionDelay: `${i * 12}ms`,
              transitionTimingFunction: 'ease',
              textShadow: '0 1.5em 0 currentColor',
              color: 'var(--sand-accent-contrast)',
            }}
          >
            {char === ' ' ? '\u00A0' : char}
          </span>
        ))}
      </span>
      <ArrowRight
        className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5"
        style={{ color: 'var(--sand-accent-contrast)' }}
      />
    </Link>
  );
}

// ============================================================================
// Editorial grid — two vertical lines framing the content area
// ============================================================================

export function EditorialGrid() {
  return (
    <div
      aria-hidden="true"
      className="fixed inset-0 pointer-events-none select-none overflow-hidden"
      style={{ zIndex: 1 }}
    >
      <div
        className="h-full mx-auto max-w-8xl px-4 sm:px-6"
        style={{
          maskImage:
            'linear-gradient(to bottom, transparent 0px, black 72px, black calc(100% - 80px), transparent 100%)',
          WebkitMaskImage:
            'linear-gradient(to bottom, transparent 0px, black 72px, black calc(100% - 80px), transparent 100%)',
        }}
      >
        <div
          className="h-full"
          style={{
            borderLeft: '1px solid var(--sand-border)',
            borderRight: '1px solid var(--sand-border)',
            opacity: 0.5,
          }}
        />
      </div>
    </div>
  );
}

// ============================================================================
// Shared nav (matches landing-v2)
// ============================================================================

export function LandingNav() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'usage' | 'connections' | 'subscription'>('usage');

  return (
    <>
      <header className="sticky top-0 z-50 backdrop-blur-lg bg-[var(--sand-bg)]/80">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-3">
          <div className="flex items-center justify-between md:grid md:grid-cols-3">
            <Link className="flex items-center gap-2.5" href="/">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/botflow-glyph.svg" alt="" className="h-8 w-8" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/brand/botflow-wordmark.svg"
                alt="Botflow"
                className="h-5 w-auto botflow-wordmark-invert"
              />
            </Link>

            <nav className="hidden md:flex items-center justify-center gap-6 text-sm">
              <SignedIn>
                <a href="/projects" className="font-medium hover:text-[var(--sand-accent)] transition whitespace-nowrap">
                  My Projects
                </a>
              </SignedIn>
              {process.env.NEXT_PUBLIC_HIDE_EXPLORE !== 'true' && (
                <Link href="/explore" className="font-medium hover:text-[var(--sand-accent)] transition">
                  Explore
                </Link>
              )}
              <Link href="/convex" className="font-medium hover:text-[var(--sand-accent)] transition">
                Convex
              </Link>
              <Link href="/blog" className="font-medium hover:text-[var(--sand-accent)] transition">
                Blog
              </Link>
              <Link href="/pricing" className="font-medium hover:text-[var(--sand-accent)] transition">
                Pricing
              </Link>
              <Link href="/docs" className="font-medium hover:text-[var(--sand-accent)] transition">
                Docs
              </Link>
            </nav>

            <div className="flex items-center justify-end gap-2">
              <SignedOut>
                <Link
                  href="/sign-in"
                  className="hidden sm:inline-flex items-center rounded-xl border border-[var(--sand-border)] bg-[var(--sand-elevated)] px-3.5 py-2 text-sm font-medium shadow-sm hover:bg-[var(--sand-surface)] transition"
                >
                  Log in
                </Link>
                <Link
                  href="/sign-up"
                  className="inline-flex items-center rounded-xl bg-[var(--sand-text)] text-[var(--sand-bg)] px-4 py-2 text-sm font-medium shadow-md hover:opacity-90 transition"
                >
                  Get started
                </Link>
              </SignedOut>
              <SignedIn>
                <Link
                  href="/projects"
                  className="hidden sm:inline-flex h-9 items-center rounded-xl border border-[var(--sand-border)] bg-[var(--sand-elevated)] px-3.5 text-sm font-medium shadow-sm hover:bg-[var(--sand-surface)] transition"
                >
                  Dashboard
                </Link>
                <button
                  type="button"
                  onClick={() => { setSettingsTab('usage'); setSettingsOpen(true); }}
                  className="relative z-10 inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-[var(--sand-border)] bg-[var(--sand-elevated)] text-sm shadow-sm hover:bg-[var(--sand-surface)] transition"
                  title="Settings"
                  aria-label="Settings"
                >
                  <Cog className="pointer-events-none h-4 w-4" />
                </button>
                <UserButton />
              </SignedIn>
            </div>
          </div>
        </div>
        <div
          className="h-px w-full origin-center"
          style={{
            background: 'var(--sand-border)',
            animation: `lineGrowX 0.6s ${EASE_SNAP} forwards`,
            opacity: 0.5,
          }}
        />
        <style>{`@keyframes lineGrowX { from { transform: scaleX(0); } to { transform: scaleX(1); } }`}</style>
      </header>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        defaultTab={settingsTab}
      />
    </>
  );
}

// ============================================================================
// Shared footer
// ============================================================================

export function LandingFooter() {
  return (
    <footer>
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/botflow-glyph.svg" alt="" className="h-6 w-6" />
            <span className="text-sm text-[var(--sand-text-muted)]">
              &copy; 2026 Botflow
            </span>
          </div>
          <div className="flex items-center gap-6 text-sm text-[var(--sand-text-muted)]">
            <a href="/privacy" className="hover:text-[var(--sand-text)] transition">
              Privacy
            </a>
            <a href="/terms" className="hover:text-[var(--sand-text)] transition">
              Terms
            </a>
            <a href="mailto:awkohler@botflow.io" className="hover:text-[var(--sand-text)] transition">
              Contact
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
