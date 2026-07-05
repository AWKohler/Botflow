'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CardSpotlight } from '@/components/landing/CardSpotlight';
import {
  EASE_SNAP,
  LineDivider,
  MarginBg,
  MarginHatch,
  Reveal,
  SectionLabel,
  StaggerButton,
  serif,
} from '@/components/landing/shared';
import type {
  AltProfile,
  CompareGroup,
  DeepDive,
  Faq,
  Strength,
} from '@/lib/marketing/competitors';

// ============================================================================
// Hero — "Botflow vs X" / "X alternatives"
// ============================================================================

export function CompareHero({
  label,
  titlePre,
  titleEm,
  titlePost,
  intro,
  updated,
}: {
  label: string;
  titlePre?: string;
  titleEm: string;
  titlePost?: string;
  intro: string;
  updated: string;
}) {
  return (
    <section className="relative overflow-hidden hero-grid">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 pt-16 sm:pt-24 pb-12 sm:pb-16">
        <div className="max-w-3xl mx-auto text-center">
          <Reveal>
            <SectionLabel>{label}</SectionLabel>
          </Reveal>

          <Reveal delay={80}>
            <h1
              className={cn(
                serif.className,
                'text-5xl sm:text-6xl md:text-7xl tracking-tight leading-[1.05]',
              )}
            >
              {titlePre ? <>{titlePre} </> : null}
              <em className={serif.className} style={{ color: 'var(--sand-accent)' }}>
                {titleEm}
              </em>
              {titlePost ? <> {titlePost}</> : null}
            </h1>
          </Reveal>

          <Reveal delay={180}>
            <p className="mt-6 text-lg sm:text-xl text-[var(--sand-text-muted)] max-w-2xl mx-auto leading-relaxed">
              {intro}
            </p>
          </Reveal>

          <Reveal delay={240}>
            <p className="mt-6 text-xs font-medium uppercase tracking-[0.18em] text-[var(--sand-text-muted)]/70">
              Last updated {updated} · Written by the Botflow team
            </p>
          </Reveal>

          <Reveal delay={300}>
            <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
              <StaggerButton text="Try Botflow free" href="/sign-up" />
              <Link
                href="/compare"
                className="inline-flex items-center gap-2 rounded-xl border border-[var(--sand-border)] bg-[var(--sand-elevated)] px-6 py-3 text-base font-medium shadow-sm hover:bg-[var(--sand-surface)] transition"
              >
                All comparisons
              </Link>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

// ============================================================================
// Honesty note — the trust marker under the hero
// ============================================================================

export function HonestyNote({ name }: { name: string }) {
  return (
    <section className="relative">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 pb-4">
        <Reveal>
          <div className="rounded-2xl border border-[var(--sand-border)] bg-[var(--sand-surface)] px-6 py-5 text-sm text-[var(--sand-text-muted)] leading-relaxed">
            <span className="font-semibold text-[var(--sand-text)]">
              How we wrote this:
            </span>{' '}
            this page is maintained by the Botflow team, so read it knowing where we
            stand. We&apos;ve kept it factual and current, and where {name} is genuinely
            the better fit, we say so — an honest page is more useful to you and,
            frankly, to us.
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// ============================================================================
// At-a-glance — two product cards
// ============================================================================

export function GlanceCards({
  usBlurb,
  usBestFor,
  themName,
  themBlurb,
  themBestFor,
}: {
  usBlurb: string;
  usBestFor: string;
  themName: string;
  themBlurb: string;
  themBestFor: string;
}) {
  return (
    <section className="relative">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-16 sm:py-20">
        <Reveal>
          <div className="text-center max-w-2xl mx-auto mb-12">
            <SectionLabel>At a glance</SectionLabel>
            <h2 className={cn(serif.className, 'text-4xl sm:text-5xl tracking-tight')}>
              Two tools, <em className={serif.className}>two bets</em>
            </h2>
          </div>
        </Reveal>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-0 rounded-2xl border border-[var(--sand-border)] overflow-hidden bg-[var(--sand-surface)]/50">
          <Reveal>
            <div className="group relative h-full p-7 sm:p-9 lg:border-r border-[var(--sand-border)] max-lg:border-b transition-colors duration-300 hover:bg-[var(--sand-surface)]">
              <CardSpotlight />
              <div className="relative z-10">
                <span className={cn(serif.className, 'text-2xl sm:text-3xl tracking-tight')}>
                  {themName}
                </span>
                <p className="mt-4 text-[var(--sand-text-muted)] leading-relaxed">{themBlurb}</p>
                <p className="mt-5 text-sm">
                  <span className="font-semibold uppercase tracking-[0.14em] text-[11px] text-[var(--sand-text-muted)]">
                    Best for
                  </span>
                  <span className="block mt-1 text-[var(--sand-text)]">{themBestFor}</span>
                </p>
              </div>
            </div>
          </Reveal>

          <Reveal delay={100}>
            <div className="group relative h-full p-7 sm:p-9 transition-colors duration-300 hover:bg-[var(--sand-surface)]">
              <CardSpotlight />
              <div
                className="absolute top-0 left-0 right-0 h-[2px]"
                style={{ background: 'var(--sand-accent)' }}
              />
              <div className="relative z-10">
                <span className="flex items-center gap-2.5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/brand/botflow-glyph.svg" alt="" className="h-6 w-6" />
                  <span className={cn(serif.className, 'text-2xl sm:text-3xl tracking-tight')}>
                    Botflow
                  </span>
                </span>
                <p className="mt-4 text-[var(--sand-text-muted)] leading-relaxed">{usBlurb}</p>
                <p className="mt-5 text-sm">
                  <span className="font-semibold uppercase tracking-[0.14em] text-[11px] text-[var(--sand-text-muted)]">
                    Best for
                  </span>
                  <span className="block mt-1 text-[var(--sand-text)]">{usBestFor}</span>
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

// ============================================================================
// Feature-by-feature table
// ============================================================================

function CompareCell({ value, highlight }: { value: boolean | string; highlight?: boolean }) {
  if (value === true) {
    return (
      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[var(--sand-accent)]/10 text-[var(--sand-accent)]">
        <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
      </span>
    );
  }
  if (value === false) {
    return <span className="text-[var(--sand-text-muted)]/40">—</span>;
  }
  return (
    <span
      className={cn(
        'text-sm leading-snug',
        highlight ? 'text-[var(--sand-text)] font-medium' : 'text-[var(--sand-text-muted)]',
      )}
    >
      {value}
    </span>
  );
}

export function CompareTable({ themName, groups }: { themName: string; groups: CompareGroup[] }) {
  return (
    <section className="relative">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 py-16 sm:py-20">
        <Reveal>
          <div className="text-center max-w-2xl mx-auto mb-12">
            <SectionLabel>Feature by feature</SectionLabel>
            <h2 className={cn(serif.className, 'text-4xl sm:text-5xl tracking-tight')}>
              Botflow vs {themName}, <em className={serif.className}>in detail</em>
            </h2>
          </div>
        </Reveal>

        <Reveal delay={120}>
          <div className="rounded-2xl border border-[var(--sand-border)] bg-[var(--sand-bg)] overflow-hidden">
            <div className="grid grid-cols-[1.3fr_1fr_1fr] sm:grid-cols-[1.6fr_1fr_1fr] border-b border-[var(--sand-border)]">
              <div className="px-4 sm:px-7 py-5 text-xs font-medium uppercase tracking-[0.18em] text-[var(--sand-text-muted)]">
                Feature
              </div>
              <div className="px-2 sm:px-4 py-5 text-center">
                <span className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.18em] text-[var(--sand-text)]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/brand/botflow-glyph.svg" alt="" className="h-4 w-4" />
                  Botflow
                </span>
              </div>
              <div className="px-2 sm:px-4 py-5 text-center text-xs font-medium uppercase tracking-[0.18em] text-[var(--sand-text-muted)]">
                {themName}
              </div>
            </div>

            {groups.map((group, gi) => (
              <div key={group.label}>
                <div className="border-b border-[var(--sand-border)] bg-[var(--sand-elevated)]/40">
                  <div
                    className={cn(
                      serif.className,
                      'px-4 sm:px-7 py-3 text-base italic text-[var(--sand-text-muted)]',
                    )}
                  >
                    {group.label}
                  </div>
                </div>
                {group.rows.map((row, ri) => (
                  <div
                    key={row.feature}
                    className={cn(
                      'grid grid-cols-[1.3fr_1fr_1fr] sm:grid-cols-[1.6fr_1fr_1fr] items-center',
                      (gi !== groups.length - 1 || ri !== group.rows.length - 1) &&
                        'border-b border-[var(--sand-border)]',
                    )}
                  >
                    <div className="px-4 sm:px-7 py-4 text-sm text-[var(--sand-text)]">
                      {row.feature}
                    </div>
                    <div className="px-2 sm:px-4 py-4 text-center bg-[var(--sand-accent)]/[0.03]">
                      <CompareCell value={row.us} highlight />
                    </div>
                    <div className="px-2 sm:px-4 py-4 text-center">
                      <CompareCell value={row.them} />
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// ============================================================================
// Where each shines — the honest split
// ============================================================================

function StrengthList({ items }: { items: Strength[] }) {
  return (
    <ul className="space-y-7">
      {items.map((s, i) => (
        <Reveal key={s.title} delay={i * 80}>
          <li>
            <h3 className={cn(serif.className, 'text-xl sm:text-2xl tracking-tight mb-2')}>
              {s.title}
            </h3>
            <p className="text-sm sm:text-base text-[var(--sand-text-muted)] leading-relaxed">
              {s.body}
            </p>
          </li>
        </Reveal>
      ))}
    </ul>
  );
}

export function StrengthsSplit({
  themName,
  theirStrengths,
  ourStrengths,
}: {
  themName: string;
  theirStrengths: Strength[];
  ourStrengths: Strength[];
}) {
  return (
    <section className="relative bg-[var(--sand-surface)]">
      <MarginBg />
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-20 sm:py-28">
        <Reveal>
          <div className="text-center max-w-2xl mx-auto mb-14 sm:mb-16">
            <SectionLabel>Credit where due</SectionLabel>
            <h2 className={cn(serif.className, 'text-4xl sm:text-5xl md:text-6xl tracking-tight')}>
              Where each one <em className={serif.className}>shines</em>
            </h2>
          </div>
        </Reveal>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-14 lg:gap-10">
          <div className="lg:pr-8 lg:border-r lg:border-[var(--sand-border)]">
            <Reveal>
              <p className="mb-7 text-[11px] font-medium uppercase tracking-[0.2em] text-[var(--sand-text-muted)]">
                Where {themName} shines
              </p>
            </Reveal>
            <StrengthList items={theirStrengths} />
          </div>
          <div className="lg:pl-2">
            <Reveal>
              <p className="mb-7 text-[11px] font-medium uppercase tracking-[0.2em] text-[var(--sand-accent)]">
                Where Botflow shines
              </p>
            </Reveal>
            <StrengthList items={ourStrengths} />
          </div>
        </div>
      </div>
    </section>
  );
}

// ============================================================================
// Deep dives — numbered editorial essays
// ============================================================================

export function DeepDives({ dives }: { dives: DeepDive[] }) {
  return (
    <section className="relative">
      <MarginHatch />
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-20 sm:py-28">
        <Reveal>
          <div className="text-center max-w-2xl mx-auto mb-14 sm:mb-20">
            <SectionLabel>The differences that matter</SectionLabel>
            <h2 className={cn(serif.className, 'text-4xl sm:text-5xl md:text-6xl tracking-tight')}>
              Beyond the <em className={serif.className}>checkboxes</em>
            </h2>
          </div>
        </Reveal>

        <div className="space-y-16 sm:space-y-20">
          {dives.map((dive, i) => (
            <Reveal key={dive.title} delay={60}>
              <div className="grid grid-cols-1 md:grid-cols-[auto_1fr] gap-6 md:gap-12 items-start max-w-4xl mx-auto">
                <span
                  className={cn(
                    serif.className,
                    'block text-7xl sm:text-8xl font-normal leading-none select-none',
                  )}
                  style={{ color: 'var(--sand-accent)', opacity: 0.32 }}
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div>
                  <h3 className={cn(serif.className, 'text-3xl sm:text-4xl tracking-tight mb-5')}>
                    {dive.title}{' '}
                    <em className={serif.className} style={{ color: 'var(--sand-accent)' }}>
                      {dive.em}
                    </em>
                  </h3>
                  <div className="space-y-4">
                    {dive.paragraphs.map((p, pi) => (
                      <p
                        key={pi}
                        className="text-base sm:text-lg text-[var(--sand-text-muted)] leading-relaxed"
                      >
                        {p}
                      </p>
                    ))}
                  </div>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

// ============================================================================
// Verdict — choose them / choose us
// ============================================================================

export function VerdictCards({
  themName,
  chooseThem,
  chooseUs,
}: {
  themName: string;
  chooseThem: string[];
  chooseUs: string[];
}) {
  return (
    <section className="relative">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-16 sm:py-24">
        <Reveal>
          <div className="text-center max-w-2xl mx-auto mb-12 sm:mb-16">
            <SectionLabel>The verdict</SectionLabel>
            <h2 className={cn(serif.className, 'text-4xl sm:text-5xl md:text-6xl tracking-tight')}>
              So, which <em className={serif.className}>one?</em>
            </h2>
          </div>
        </Reveal>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <Reveal>
            <div className="h-full rounded-2xl border border-[var(--sand-border)] bg-[var(--sand-surface)]/60 p-7 sm:p-9">
              <h3 className={cn(serif.className, 'text-2xl sm:text-3xl tracking-tight mb-6')}>
                Choose {themName} if…
              </h3>
              <ul className="space-y-3.5">
                {chooseThem.map((item) => (
                  <li
                    key={item}
                    className="flex items-start gap-3 text-sm sm:text-base text-[var(--sand-text-muted)] leading-relaxed"
                  >
                    <span
                      className="mt-2 h-1.5 w-1.5 rounded-full shrink-0"
                      style={{ background: 'var(--sand-text-muted)' }}
                    />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>

          <Reveal delay={100}>
            <div className="relative h-full rounded-2xl border border-[var(--sand-accent)]/30 bg-[var(--sand-accent)]/[0.04] p-7 sm:p-9 overflow-hidden">
              <div
                className="absolute top-0 left-0 right-0 h-[2px]"
                style={{ background: 'var(--sand-accent)' }}
              />
              <h3 className={cn(serif.className, 'text-2xl sm:text-3xl tracking-tight mb-6')}>
                Choose{' '}
                <em className={serif.className} style={{ color: 'var(--sand-accent)' }}>
                  Botflow
                </em>{' '}
                if…
              </h3>
              <ul className="space-y-3.5">
                {chooseUs.map((item) => (
                  <li
                    key={item}
                    className="flex items-start gap-3 text-sm sm:text-base text-[var(--sand-text-muted)] leading-relaxed"
                  >
                    <span className="mt-1 inline-flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full bg-[var(--sand-accent)]/15 text-[var(--sand-accent)]">
                      <Check className="h-3 w-3" strokeWidth={3} />
                    </span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

// ============================================================================
// FAQ accordion (matches the pricing page pattern)
// ============================================================================

function FaqItem({ q, a, index }: { q: string; a: string; index: number }) {
  const [open, setOpen] = useState(index === 0);
  return (
    <Reveal delay={index * 60}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'group w-full text-left transition-colors',
          'border-b border-[var(--sand-border)] last:border-b-0',
          'py-6 hover:bg-[var(--sand-surface)]/50',
        )}
      >
        <div className="flex items-start justify-between gap-6 px-1">
          <span className="text-base sm:text-lg font-medium text-[var(--sand-text)] leading-snug">
            {q}
          </span>
          <span
            aria-hidden
            className="mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--sand-border)] bg-[var(--sand-elevated)] text-[var(--sand-text-muted)] transition-transform duration-300"
            style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
          >
            {open ? <Minus className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
          </span>
        </div>
        <div
          className="grid overflow-hidden transition-[grid-template-rows] duration-300 ease-out px-1"
          style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
        >
          <div className="min-h-0 overflow-hidden">
            <p className="mt-3 max-w-3xl text-sm sm:text-base text-[var(--sand-text-muted)] leading-relaxed">
              {a}
            </p>
          </div>
        </div>
      </button>
    </Reveal>
  );
}

export function FaqSection({ faqs }: { faqs: Faq[] }) {
  return (
    <section className="relative">
      <div className="mx-auto max-w-4xl px-4 sm:px-6 py-16 sm:py-24">
        <Reveal>
          <div className="text-center max-w-2xl mx-auto mb-12 sm:mb-16">
            <SectionLabel>FAQ</SectionLabel>
            <h2 className={cn(serif.className, 'text-4xl sm:text-5xl md:text-6xl tracking-tight')}>
              Questions, <em className={serif.className}>answered</em>
            </h2>
          </div>
        </Reveal>

        <div className="border-t border-[var(--sand-border)]">
          {faqs.map((f, i) => (
            <FaqItem key={f.q} q={f.q} a={f.a} index={i} />
          ))}
        </div>
      </div>
    </section>
  );
}

// ============================================================================
// Related pages strip
// ============================================================================

export function RelatedStrip({
  links,
}: {
  links: { href: string; label: string }[];
}) {
  return (
    <section className="relative bg-[var(--sand-surface)]">
      <MarginBg />
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-14 sm:py-16">
        <Reveal>
          <p className="mb-6 text-center text-[11px] font-medium uppercase tracking-[0.2em] text-[var(--sand-text-muted)]">
            Keep comparing
          </p>
        </Reveal>
        <Reveal delay={80}>
          <div className="flex flex-wrap items-center justify-center gap-3">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--sand-border)] bg-[var(--sand-bg)] px-4 py-2.5 text-sm font-medium shadow-sm hover:bg-[var(--sand-elevated)] hover:text-[var(--sand-accent)] transition"
              >
                {l.label}
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// ============================================================================
// Closing CTA
// ============================================================================

export function ClosingCta({ heading, em, sub }: { heading: string; em: string; sub: string }) {
  return (
    <section className="relative">
      <MarginHatch />
      <div className="pointer-events-none absolute inset-0 -z-10 landing-gradient opacity-60" />
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-24 sm:py-32">
        <Reveal>
          <div className="text-center max-w-2xl mx-auto">
            <h2 className={cn(serif.className, 'text-4xl sm:text-5xl md:text-6xl tracking-tight')}>
              {heading}{' '}
              <em className={serif.className} style={{ color: 'var(--sand-accent)' }}>
                {em}
              </em>
            </h2>
            <p className="mt-4 text-lg text-[var(--sand-text-muted)]">{sub}</p>
            <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
              <StaggerButton text="Start building free" href="/sign-up" />
              <Link
                href="/pricing"
                className="inline-flex items-center gap-2 rounded-xl border border-[var(--sand-border)] bg-[var(--sand-elevated)] px-6 py-3 text-base font-medium shadow-sm hover:bg-[var(--sand-surface)] transition"
              >
                View pricing
              </Link>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// ============================================================================
// Alternatives page — why-people-switch cards
// ============================================================================

export function WhySwitchCards({ name, items }: { name: string; items: Strength[] }) {
  return (
    <section className="relative">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-16 sm:py-20">
        <Reveal>
          <div className="text-center max-w-2xl mx-auto mb-12">
            <SectionLabel>Why people look</SectionLabel>
            <h2 className={cn(serif.className, 'text-4xl sm:text-5xl tracking-tight')}>
              Why builders outgrow <em className={serif.className}>{name}</em>
            </h2>
          </div>
        </Reveal>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-0 rounded-2xl border border-[var(--sand-border)] overflow-hidden bg-[var(--sand-surface)]/50">
          {items.map((item, i) => (
            <Reveal key={item.title} delay={i * 80}>
              <div
                className={cn(
                  'group relative h-full p-6 sm:p-8 transition-colors duration-300 hover:bg-[var(--sand-surface)]',
                  i < items.length - 1 && 'md:border-r md:border-[var(--sand-border)]',
                  i < items.length - 1 && 'max-md:border-b max-md:border-[var(--sand-border)]',
                )}
              >
                <CardSpotlight />
                <div
                  className="absolute top-0 left-6 right-6 h-px origin-center scale-x-0 group-hover:scale-x-100 transition-transform duration-500 z-10"
                  style={{ background: 'var(--sand-accent)', transitionTimingFunction: EASE_SNAP }}
                />
                <h3 className="relative z-10 text-lg font-semibold mb-2">{item.title}</h3>
                <p className="relative z-10 text-sm text-[var(--sand-text-muted)] leading-relaxed">
                  {item.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

// ============================================================================
// Alternatives page — the ranked list
// ============================================================================

export function AlternativesList({ profiles }: { profiles: AltProfile[] }) {
  return (
    <section className="relative bg-[var(--sand-surface)]">
      <MarginBg />
      <div className="mx-auto max-w-5xl px-4 sm:px-6 py-20 sm:py-28">
        <Reveal>
          <div className="text-center max-w-2xl mx-auto mb-14 sm:mb-20">
            <SectionLabel>The alternatives</SectionLabel>
            <h2 className={cn(serif.className, 'text-4xl sm:text-5xl md:text-6xl tracking-tight')}>
              Ranked, with <em className={serif.className}>reasons</em>
            </h2>
          </div>
        </Reveal>

        <div className="space-y-8">
          {profiles.map((p, i) => (
            <Reveal key={p.key} delay={60}>
              <article
                className={cn(
                  'relative rounded-2xl border bg-[var(--sand-bg)] p-6 sm:p-10 overflow-hidden',
                  p.isBotflow ? 'border-[var(--sand-accent)]/30' : 'border-[var(--sand-border)]',
                )}
              >
                {p.isBotflow && (
                  <div
                    className="absolute top-0 left-0 right-0 h-[2px]"
                    style={{ background: 'var(--sand-accent)' }}
                  />
                )}

                <div className="grid grid-cols-[auto_1fr] gap-5 sm:gap-8 items-start">
                  <span
                    className={cn(
                      serif.className,
                      'block text-6xl sm:text-8xl font-normal leading-none select-none -mt-1',
                    )}
                    style={{ color: 'var(--sand-accent)', opacity: 0.32 }}
                  >
                    {i + 1}
                  </span>

                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-3">
                      <h3 className={cn(serif.className, 'text-3xl sm:text-4xl tracking-tight')}>
                        {p.name}
                      </h3>
                      {p.isBotflow && (
                        <span className="inline-flex items-center rounded-full bg-[var(--sand-accent)] px-3 py-1 text-xs font-semibold text-[var(--sand-accent-contrast)]">
                          Our pick — and our product
                        </span>
                      )}
                    </div>

                    <p className="mt-3 text-base sm:text-lg text-[var(--sand-text-muted)] leading-relaxed">
                      {p.oneLiner}
                    </p>

                    <p className="mt-4 text-sm">
                      <span className="font-semibold uppercase tracking-[0.14em] text-[11px] text-[var(--sand-text-muted)]">
                        Best for
                      </span>
                      <span className="block mt-1 text-[var(--sand-text)]">{p.bestFor}</span>
                    </p>

                    <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div>
                        <p className="mb-2.5 text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--sand-text-muted)]">
                          Strengths
                        </p>
                        <ul className="space-y-2.5">
                          {p.strengths.map((s) => (
                            <li
                              key={s}
                              className="flex items-start gap-2.5 text-sm text-[var(--sand-text-muted)] leading-relaxed"
                            >
                              <span className="mt-0.5 inline-flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full bg-[var(--sand-accent)]/12 text-[var(--sand-accent)]">
                                <Check className="h-2.5 w-2.5" strokeWidth={3} />
                              </span>
                              {s}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <p className="mb-2.5 text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--sand-text-muted)]">
                          Keep in mind
                        </p>
                        <ul className="space-y-2.5">
                          {p.tradeoffs.map((t) => (
                            <li
                              key={t}
                              className="flex items-start gap-2.5 text-sm text-[var(--sand-text-muted)] leading-relaxed"
                            >
                              <span className="mt-0.5 inline-flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border border-[var(--sand-border)] bg-[var(--sand-elevated)] text-[var(--sand-text-muted)]">
                                <Minus className="h-2.5 w-2.5" strokeWidth={3} />
                              </span>
                              {t}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>

                    <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border-t border-[var(--sand-border)] pt-5">
                      <p className="text-xs text-[var(--sand-text-muted)]">{p.pricingNote}</p>
                      <div className="flex items-center gap-3">
                        {p.compareSlug && !p.isBotflow && (
                          <Link
                            href={`/compare/botflow-vs-${p.compareSlug}`}
                            className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--sand-accent)] hover:opacity-80 transition"
                          >
                            Full comparison
                            <ArrowRight className="h-3.5 w-3.5" />
                          </Link>
                        )}
                        {p.isBotflow ? (
                          <Link
                            href="/sign-up"
                            className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--sand-accent)] px-4 py-2 text-sm font-medium text-[var(--sand-accent-contrast)] shadow-sm hover:opacity-90 transition"
                          >
                            Try it free
                            <ArrowRight className="h-3.5 w-3.5" />
                          </Link>
                        ) : (
                          p.url && (
                            <a
                              href={p.url}
                              target="_blank"
                              rel="noopener"
                              className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--sand-text-muted)] hover:text-[var(--sand-text)] transition"
                            >
                              Visit site
                              <ArrowUpRight className="h-3.5 w-3.5" />
                            </a>
                          )
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

// ============================================================================
// Alternatives page — quick facts table
// ============================================================================

export function AltQuickTable({ profiles }: { profiles: AltProfile[] }) {
  const cols: { key: keyof AltProfile['facts']; label: string }[] = [
    { key: 'platforms', label: 'Platforms' },
    { key: 'backend', label: 'Backend' },
    { key: 'code', label: 'Your code' },
    { key: 'native', label: 'App Store publish' },
  ];
  return (
    <section className="relative">
      <div className="mx-auto max-w-5xl px-4 sm:px-6 py-16 sm:py-20">
        <Reveal>
          <div className="text-center max-w-2xl mx-auto mb-12">
            <SectionLabel>Quick reference</SectionLabel>
            <h2 className={cn(serif.className, 'text-4xl sm:text-5xl tracking-tight')}>
              The facts, <em className={serif.className}>side by side</em>
            </h2>
          </div>
        </Reveal>

        <Reveal delay={100}>
          <div className="rounded-2xl border border-[var(--sand-border)] bg-[var(--sand-bg)] overflow-hidden overflow-x-auto modern-scrollbar">
            <table className="w-full min-w-[640px] border-collapse text-left">
              <thead>
                <tr className="border-b border-[var(--sand-border)]">
                  <th className="px-5 sm:px-7 py-4 text-xs font-medium uppercase tracking-[0.18em] text-[var(--sand-text-muted)]">
                    Product
                  </th>
                  {cols.map((c) => (
                    <th
                      key={c.key}
                      className="px-4 py-4 text-xs font-medium uppercase tracking-[0.18em] text-[var(--sand-text-muted)]"
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {profiles.map((p, i) => (
                  <tr
                    key={p.key}
                    className={cn(
                      i !== profiles.length - 1 && 'border-b border-[var(--sand-border)]',
                      p.isBotflow && 'bg-[var(--sand-accent)]/[0.04]',
                    )}
                  >
                    <td className="px-5 sm:px-7 py-4 text-sm font-medium text-[var(--sand-text)] whitespace-nowrap">
                      <span className="inline-flex items-center gap-2">
                        {p.isBotflow && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src="/brand/botflow-glyph.svg" alt="" className="h-4 w-4" />
                        )}
                        {p.name}
                      </span>
                    </td>
                    {cols.map((c) => (
                      <td
                        key={c.key}
                        className="px-4 py-4 text-sm text-[var(--sand-text-muted)] leading-snug"
                      >
                        {p.facts[c.key]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

// ============================================================================
// Shared page chrome — divider re-export for the server pages
// ============================================================================

export { LineDivider };
