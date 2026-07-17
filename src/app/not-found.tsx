import Link from 'next/link';
import {
  EditorialGrid,
  LandingFooter,
  LandingNav,
  LineDivider,
  MarginHatch,
  Reveal,
  SectionLabel,
  StaggerButton,
} from '@/components/landing/shared';
import { serif } from '@/components/landing/fonts';
import { cn } from '@/lib/utils';

export const metadata = {
  title: 'Page not found',
  description:
    "There's no page at this address. Head back to Botflow or browse the rest of the site.",
};

const CONTENTS: { n: string; label: string; href: string }[] = [
  { n: '01', label: 'Home', href: '/' },
  ...(process.env.NEXT_PUBLIC_HIDE_EXPLORE !== 'true'
    ? [{ n: '02', label: 'Explore', href: '/explore' }]
    : []),
  { n: '03', label: 'Pricing', href: '/pricing' },
  { n: '04', label: 'Docs', href: '/docs' },
  { n: '05', label: 'Blog', href: '/blog' },
  { n: '06', label: 'Convex', href: '/convex' },
].map((entry, i) => ({ ...entry, n: String(i + 1).padStart(2, '0') }));

export default function NotFound() {
  return (
    <div className="antialiased text-[var(--sand-text)] bg-[var(--sand-bg)] min-h-screen flex flex-col">
      <EditorialGrid />
      <LandingNav />

      <section className="relative flex-1 overflow-hidden">
        <MarginHatch />

        <div className="relative mx-auto max-w-7xl px-6 sm:px-10 pt-10 sm:pt-14 pb-16 sm:pb-24">
          <div className="grid items-center gap-14 lg:grid-cols-[1.15fr_0.85fr] lg:gap-20">
            {/* ---------------------------------------------------------- */}
            {/* Left — the misprint                                        */}
            {/* ---------------------------------------------------------- */}
            <div>
              <Reveal>
                <SectionLabel>Error · Page not found</SectionLabel>
              </Reveal>

              <Reveal delay={100}>
                <h1
                  aria-label="404 — page not found"
                  className={cn(serif.className, 'select-none tracking-tight')}
                  // tailwind-merge drops leading-* next to an arbitrary
                  // text-[clamp(...)] size, so both live here instead
                  style={{
                    fontSize: 'clamp(7rem, 26vw, 15rem)',
                    lineHeight: 0.85,
                  }}
                >
                  <span aria-hidden>4</span>
                  <span
                    aria-hidden
                    style={{
                      WebkitTextStroke: '0.014em var(--sand-text)',
                      color: 'transparent',
                    }}
                  >
                    0
                  </span>
                  <span aria-hidden>4</span>
                </h1>
              </Reveal>

              <Reveal delay={200}>
                <h2
                  className={cn(
                    serif.className,
                    'mt-6 text-3xl sm:text-4xl tracking-tight leading-[1.1]',
                  )}
                >
                  There&apos;s no page at this address.
                </h2>
              </Reveal>

              <Reveal delay={280}>
                <p className="mt-4 max-w-md text-base sm:text-lg text-[var(--sand-text-muted)] leading-relaxed">
                  It may have moved, or the link was mistyped. Everything else
                  is where you left it.
                </p>
              </Reveal>

              <Reveal delay={360}>
                <div className="mt-8 flex flex-wrap items-center gap-5">
                  <StaggerButton text="Back to home" href="/" />
                  <Link
                    href="/projects"
                    className="text-sm font-medium text-[var(--sand-text-muted)] hover:text-[var(--sand-accent)] transition"
                  >
                    Go to my projects
                  </Link>
                </div>
              </Reveal>
            </div>

            {/* ---------------------------------------------------------- */}
            {/* Right — contents, with one entry missing                   */}
            {/* ---------------------------------------------------------- */}
            <Reveal delay={250}>
              <div className="rounded-xl border border-[var(--sand-border)] bg-[var(--sand-surface)] p-6 sm:p-8 shadow-sm">
                <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-[var(--sand-text-muted)]">
                  Contents
                </p>
                <div
                  className="mt-4 h-px w-full"
                  style={{ background: 'var(--sand-border)' }}
                />

                <nav aria-label="Site contents" className="mt-2">
                  <ul>
                    {CONTENTS.map((entry) => (
                      <li key={entry.href}>
                        <Link
                          href={entry.href}
                          className="group flex items-baseline gap-3 py-3 text-sm sm:text-base"
                        >
                          <span className="w-6 shrink-0 tabular-nums text-xs text-[var(--sand-text-muted)] opacity-70">
                            {entry.n}
                          </span>
                          <span className="font-medium transition group-hover:text-[var(--sand-accent)]">
                            {entry.label}
                          </span>
                          <span
                            aria-hidden
                            className="flex-1 -translate-y-1 border-b border-dotted border-[var(--sand-soft)] transition group-hover:border-[var(--sand-text-muted)]"
                          />
                          <span className="shrink-0 text-xs text-[var(--sand-text-muted)] opacity-70 transition group-hover:opacity-100">
                            {entry.href}
                          </span>
                        </Link>
                      </li>
                    ))}

                    {/* The entry that should have been here */}
                    <li
                      aria-hidden
                      className="flex items-baseline gap-3 py-3 text-sm sm:text-base text-[var(--sand-text-muted)]"
                    >
                      <span className="w-6 shrink-0 text-xs opacity-70">—</span>
                      <span className="line-through decoration-[var(--sand-accent)] decoration-2">
                        The page you asked for
                      </span>
                      <span
                        aria-hidden
                        className="flex-1 -translate-y-1 border-b border-dotted border-[var(--sand-soft)]"
                      />
                      <span className="shrink-0 text-xs italic opacity-70">
                        missing
                      </span>
                    </li>
                  </ul>
                </nav>
              </div>

              <p
                className={cn(
                  serif.className,
                  'mt-5 px-1 text-base italic text-[var(--sand-text-muted)] leading-relaxed',
                )}
              >
                Doesn&apos;t exist yet? That&apos;s the whole idea —{' '}
                <Link
                  href="/"
                  className="underline decoration-[var(--sand-accent)] decoration-2 underline-offset-4 hover:text-[var(--sand-accent)] transition"
                >
                  describe it, and Botflow builds it
                </Link>
                .
              </p>
            </Reveal>
          </div>
        </div>
      </section>

      <LineDivider />
      <LandingFooter />
    </div>
  );
}
