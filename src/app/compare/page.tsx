import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CardSpotlight } from '@/components/landing/CardSpotlight';
import {
  EditorialGrid,
  LandingFooter,
  LandingNav,
  Reveal,
  SectionLabel,
} from '@/components/landing/shared';
import { serif } from '@/components/landing/fonts';
import { ClosingCta, LineDivider } from '@/components/landing/compare-ui';
import {
  COMPETITORS,
  COMPETITOR_SLUGS,
  LAST_UPDATED,
  alternativesHref,
  compareHref,
  type CompetitorSlug,
} from '@/lib/marketing/competitors';

export const metadata: Metadata = {
  title: { absolute: 'Compare — Botflow vs the alternatives' },
  description:
    'Honest, regularly updated comparisons of Botflow against Lovable, Rork, Vibecode, Bloom, and Base44 — plus alternatives guides for each. Where a rival is genuinely better, we say so.',
  alternates: { canonical: '/compare' },
  openGraph: {
    title: 'Compare — Botflow vs the alternatives',
    description:
      'Honest, regularly updated comparisons of Botflow against Lovable, Rork, Vibecode, Bloom, and Base44.',
    type: 'website',
    url: '/compare',
  },
};

const HUB_BLURBS: Record<CompetitorSlug, string> = {
  lovable: 'The web-builder giant — and the native iOS apps it can’t build.',
  rork: 'The direct rival on native iOS. The difference is the backend.',
  vibecode: 'Phone-first building vs browser-built native SwiftUI.',
  bloom: 'Same Convex backend, different finish line: demo link or App Store.',
  base44: 'All-in-one simplicity vs code and a backend you actually own.',
};

export default function CompareHubPage() {
  return (
    <div className="relative min-h-screen bg-[var(--sand-bg)] text-[var(--sand-text)] antialiased overflow-x-hidden">
      <EditorialGrid />
      <LandingNav />

      <main className="relative z-10">
        {/* ============================================================== */}
        {/* HERO                                                           */}
        {/* ============================================================== */}
        <section className="relative overflow-hidden hero-grid">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 pt-16 sm:pt-24 pb-12 sm:pb-16">
            <div className="max-w-3xl mx-auto text-center">
              <Reveal>
                <SectionLabel>Us vs them</SectionLabel>
              </Reveal>
              <Reveal delay={80}>
                <h1
                  className={cn(
                    serif.className,
                    'text-5xl sm:text-6xl md:text-7xl tracking-tight leading-[1.05]',
                  )}
                >
                  How Botflow{' '}
                  <em className={serif.className} style={{ color: 'var(--sand-accent)' }}>
                    stacks up
                  </em>
                </h1>
              </Reveal>
              <Reveal delay={180}>
                <p className="mt-6 text-lg sm:text-xl text-[var(--sand-text-muted)] max-w-2xl mx-auto leading-relaxed">
                  Honest comparisons against the tools you&apos;re probably also looking
                  at. We keep these factual and current — and where a rival is
                  genuinely the better fit, we say so. Picking the right tool matters
                  more to us than winning every row of a table.
                </p>
              </Reveal>
              <Reveal delay={240}>
                <p className="mt-6 text-xs font-medium uppercase tracking-[0.18em] text-[var(--sand-text-muted)]/70">
                  Last updated {LAST_UPDATED}
                </p>
              </Reveal>
            </div>
          </div>
        </section>

        {/* ============================================================== */}
        {/* HEAD-TO-HEADS                                                  */}
        {/* ============================================================== */}
        <section className="relative">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 py-16 sm:py-24">
            <Reveal>
              <div className="text-center max-w-2xl mx-auto mb-12 sm:mb-16">
                <SectionLabel>Head to head</SectionLabel>
                <h2 className={cn(serif.className, 'text-4xl sm:text-5xl tracking-tight')}>
                  The <em className={serif.className}>comparisons</em>
                </h2>
              </div>
            </Reveal>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-0 rounded-2xl border border-[var(--sand-border)] overflow-hidden bg-[var(--sand-surface)]/50">
              {COMPETITOR_SLUGS.map((slug, i) => (
                <Reveal key={slug} delay={i * 80}>
                  <Link
                    href={compareHref(slug)}
                    className={cn(
                      'group relative block h-full p-6 sm:p-8 transition-colors duration-300 hover:bg-[var(--sand-surface)]',
                      i % 3 !== 2 && 'lg:border-r lg:border-[var(--sand-border)]',
                      i % 2 === 0 && 'md:max-lg:border-r md:max-lg:border-[var(--sand-border)]',
                      i < 3 && 'lg:border-b lg:border-[var(--sand-border)]',
                      i < 4 && 'md:max-lg:border-b md:max-lg:border-[var(--sand-border)]',
                      'max-md:border-b max-md:border-[var(--sand-border)] max-md:last:border-b-0',
                    )}
                  >
                    <CardSpotlight />
                    <div
                      className="absolute top-0 left-6 right-6 h-px origin-center scale-x-0 group-hover:scale-x-100 transition-transform duration-500 z-10"
                      style={{
                        background: 'var(--sand-accent)',
                        transitionTimingFunction: 'cubic-bezier(0.5, 0, 0, 1)',
                      }}
                    />
                    <h3 className={cn(serif.className, 'relative z-10 text-2xl sm:text-3xl tracking-tight')}>
                      Botflow{' '}
                      <em className={serif.className} style={{ color: 'var(--sand-accent)' }}>
                        vs
                      </em>{' '}
                      {COMPETITORS[slug].name}
                    </h3>
                    <p className="relative z-10 mt-3 text-sm text-[var(--sand-text-muted)] leading-relaxed">
                      {HUB_BLURBS[slug]}
                    </p>
                    <span className="relative z-10 mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--sand-accent)]">
                      Read the comparison
                      <ArrowRight className="h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-0.5" />
                    </span>
                  </Link>
                </Reveal>
              ))}

              {/* Filler cell keeps the 3-col grid balanced at 6 items */}
              <Reveal delay={COMPETITOR_SLUGS.length * 80}>
                <div className="relative hidden lg:flex h-full items-center justify-center p-6 sm:p-8">
                  <p className={cn(serif.className, 'text-xl italic text-[var(--sand-text-muted)]/60 text-center')}>
                    More on the way —<br />
                    suggestions welcome.
                  </p>
                </div>
              </Reveal>
            </div>
          </div>
        </section>

        {/* ============================================================== */}
        {/* ALTERNATIVES GUIDES                                            */}
        {/* ============================================================== */}
        <LineDivider />
        <section className="relative bg-[var(--sand-surface)]">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 py-16 sm:py-24">
            <Reveal>
              <div className="text-center max-w-2xl mx-auto mb-12">
                <SectionLabel>Roundups</SectionLabel>
                <h2 className={cn(serif.className, 'text-4xl sm:text-5xl tracking-tight')}>
                  Alternatives, <em className={serif.className}>ranked honestly</em>
                </h2>
                <p className="mt-4 text-lg text-[var(--sand-text-muted)] leading-relaxed">
                  Full guides to the alternatives for each tool — including the ones
                  that aren&apos;t us.
                </p>
              </div>
            </Reveal>

            <Reveal delay={100}>
              <div className="flex flex-wrap items-center justify-center gap-3">
                {COMPETITOR_SLUGS.map((slug) => (
                  <Link
                    key={slug}
                    href={alternativesHref(slug)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--sand-border)] bg-[var(--sand-bg)] px-4 py-2.5 text-sm font-medium shadow-sm hover:bg-[var(--sand-elevated)] hover:text-[var(--sand-accent)] transition"
                  >
                    {COMPETITORS[slug].name} alternatives
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                ))}
              </div>
            </Reveal>
          </div>
        </section>

        <ClosingCta
          heading="Or skip the reading"
          em="and try it"
          sub="The free tier needs no credit card. Describe an app and watch it run."
        />
      </main>

      <LandingFooter />
    </div>
  );
}
