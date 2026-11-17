'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BrandMark, SiteHeader } from '@/components/site/SiteHeader';
import { serif } from './fonts';

// ============================================================================
// Typography + easing tokens shared across landing / subpages
// ============================================================================

// Re-exported for client components; server components must import from
// ./fonts directly (see the note there).
export { serif };

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
// Margin hatch — diagonal stripe ornament for the page/section/nav margins
// ============================================================================

// 6×6 diagonal stripe tile (public/stripe.svg) used as a MASK, repeated at 6px,
// then filled with the themed --margin-stripe color. The mask keeps the exact
// tile shape from the reference design while letting the color vary per theme:
// warm/faint #23201A on dark (the reference tone), soft on-palette gray on light.
const MARGIN_TILE_STYLE = {
  backgroundColor: 'var(--margin-stripe)',
  maskImage: 'url(/stripe.svg)',
  maskRepeat: 'repeat',
  maskPosition: 'left top',
  maskSize: '6px auto',
  WebkitMaskImage: 'url(/stripe.svg)',
  WebkitMaskRepeat: 'repeat',
  WebkitMaskPosition: 'left top',
  WebkitMaskSize: '6px auto',
};

// Fills the nearest position:relative ancestor's left/right margin gutters (the
// px-4/sm:px-6 page margin, matched exactly by w-4 / sm:w-6) with the stripe
// tile, aligned to the EditorialGrid boundary lines. Drop into a relative
// section/header to turn the hatch on for that band. pointer-events-none and
// confined to the empty gutter, so it never overlaps the centered content.
export function MarginHatch() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none select-none absolute inset-0 overflow-hidden"
    >
      <div className="absolute inset-y-0 left-0 w-4 sm:w-6" style={MARGIN_TILE_STYLE} />
      <div className="absolute inset-y-0 right-0 w-4 sm:w-6" style={MARGIN_TILE_STYLE} />
    </div>
  );
}

// Paints the left/right margin gutters with the base --sand-bg. Drop into a
// relative section that has a sand-surface background so its margins stay
// sand-bg — the surface color then reads as an inset panel framed by the
// editorial gutters, matching the sand-bg gutters of the other sections. Same
// geometry as MarginHatch (w-4 / sm:w-6 = the px-4/sm:px-6 page gutter).
export function MarginBg() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none select-none absolute inset-0 overflow-hidden"
    >
      <div className="absolute inset-y-0 left-0 w-4 sm:w-6 bg-[var(--sand-bg)]" />
      <div className="absolute inset-y-0 right-0 w-4 sm:w-6 bg-[var(--sand-bg)]" />
    </div>
  );
}

// ============================================================================
// Shared nav — the site-wide header (see components/site/SiteHeader)
// ============================================================================

export function LandingNav() {
  return <SiteHeader />;
}

// ============================================================================
// Shared footer — editorial multi-column with a clipped serif wordmark
// ============================================================================

// Curated here (rather than imported from the marketing data file) so the
// footer bundle stays light on every page that renders it.
const FOOTER_COMPARE_LINKS = [
  { href: '/compare/botflow-vs-lovable', label: 'vs Lovable' },
  { href: '/compare/botflow-vs-rork', label: 'vs Rork' },
  { href: '/compare/botflow-vs-vibecode', label: 'vs Vibecode' },
  { href: '/compare/botflow-vs-bloom', label: 'vs Bloom' },
  { href: '/compare/botflow-vs-base44', label: 'vs Base44' },
  { href: '/compare', label: 'All comparisons' },
];

const FOOTER_ALTERNATIVES_LINKS = [
  { href: '/alternatives/lovable', label: 'Lovable alternatives' },
  { href: '/alternatives/rork', label: 'Rork alternatives' },
  { href: '/alternatives/vibecode', label: 'Vibecode alternatives' },
  { href: '/alternatives/bloom', label: 'Bloom alternatives' },
  { href: '/alternatives/base44', label: 'Base44 alternatives' },
];

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: { href: string; label: string; external?: boolean }[];
}) {
  return (
    <div>
      <p className="mb-4 text-[11px] font-medium uppercase tracking-[0.2em] text-[var(--sand-text-muted)]">
        {title}
      </p>
      <ul className="space-y-2.5">
        {links.map((l) => (
          <li key={l.href}>
            {l.external ? (
              <a
                href={l.href}
                className="text-sm text-[var(--sand-text-muted)] hover:text-[var(--sand-accent)] transition"
              >
                {l.label}
              </a>
            ) : (
              <Link
                href={l.href}
                className="text-sm text-[var(--sand-text-muted)] hover:text-[var(--sand-accent)] transition"
              >
                {l.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LandingFooter() {
  const productLinks = [
    ...(process.env.NEXT_PUBLIC_HIDE_EXPLORE !== 'true'
      ? [{ href: '/explore', label: 'Explore' }]
      : []),
    { href: '/convex', label: 'Convex' },
    { href: '/pricing', label: 'Pricing' },
    { href: '/docs', label: 'Docs' },
    { href: '/blog', label: 'Blog' },
  ];

  const companyLinks = [
    { href: '/privacy', label: 'Privacy' },
    { href: '/terms', label: 'Terms' },
    { href: 'mailto:awkohler@botflow.io', label: 'Contact', external: true },
  ];

  return (
    <footer className="relative overflow-hidden">
      <LineDivider />
      <MarginHatch />

      <div className="relative mx-auto max-w-7xl px-6 sm:px-10 pt-14 sm:pt-16 pb-8">
        <div className="grid grid-cols-2 gap-x-6 gap-y-10 md:grid-cols-[1.7fr_1fr_1fr_1fr_0.8fr]">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1 md:pr-8">
            <Link href="/" aria-label="Botflow home" className="inline-flex items-center rounded-md">
              <BrandMark />
            </Link>
            <p className="mt-4 max-w-xs text-sm text-[var(--sand-text-muted)] leading-relaxed">
              Describe it, and Botflow builds it — a real full-stack web app or a
              native iOS app, with a backend included and code you own.
            </p>
            <a
              href="mailto:awkohler@botflow.io"
              className="mt-4 inline-block text-sm text-[var(--sand-text-muted)] hover:text-[var(--sand-accent)] transition"
            >
              awkohler@botflow.io
            </a>
          </div>

          <FooterColumn title="Product" links={productLinks} />
          <FooterColumn title="Compare" links={FOOTER_COMPARE_LINKS} />
          <FooterColumn title="Alternatives" links={FOOTER_ALTERNATIVES_LINKS} />
          <FooterColumn title="Company" links={companyLinks} />
        </div>

        {/* Bottom bar */}
        <div className="mt-12 flex flex-col sm:flex-row items-center justify-between gap-3 border-t border-[var(--sand-border)] pt-6">
          <span className="text-sm text-[var(--sand-text-muted)]">
            &copy; {new Date().getFullYear()} Botflow
          </span>
          <span className={cn(serif.className, 'text-sm italic text-[var(--sand-text-muted)]')}>
            Real apps. Real code. Yours.
          </span>
        </div>
      </div>

      {/* Giant clipped wordmark */}
      <div
        aria-hidden="true"
        className="pointer-events-none select-none relative h-[17vw] sm:h-[13vw] md:h-[11vw]"
        style={{
          maskImage: 'linear-gradient(to bottom, black 0%, transparent 92%)',
          WebkitMaskImage: 'linear-gradient(to bottom, black 0%, transparent 92%)',
        }}
      >
        <span
          className={cn(
            serif.className,
            'absolute left-1/2 -translate-x-1/2 top-0 text-[26vw] sm:text-[20vw] md:text-[17vw] leading-[0.78] tracking-tight whitespace-nowrap',
          )}
          style={{ color: 'var(--sand-text)', opacity: 0.05 }}
        >
          Botflow
        </span>
      </div>
    </footer>
  );
}
