'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PricingTable } from '@/components/auth';
import {
  Bot,
  Check,
  Database,
  Globe,
  Layers,
  Plus,
  Sparkles,
  Minus,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  EditorialGrid,
  LandingFooter,
  LandingNav,
  LineDivider,
  Reveal,
  SectionLabel,
  serif,
} from '@/components/landing/shared';
import { isManagedConvexEnabled } from '@/lib/project-platform';

// Managed-Convex kill switch (NEXT_PUBLIC_DISABLE_MANAGED_CONVEX) — when off,
// every plan is Bring Your Own Convex and the copy below says so.
const MANAGED_CONVEX = isManagedConvexEnabled();

// ============================================================================
// Plan highlight pills shown above the pricing table
// ============================================================================

// const planHighlights = [
//   {
//     icon: Sparkles,
//     title: 'Bring your own keys',
//     description:
//       'Use OpenAI, Anthropic, Fireworks, or your existing Claude / Codex OAuth — no markup, ever.',
//   },
//   {
//     icon: Database,
//     title: 'Real backend included',
//     description:
//       'Convex is wired into every project from the first prompt. No setup, no extra bill.',
//   },
//   {
//     icon: Globe,
//     title: 'Deploys, not demos',
//     description:
//       'Ship to Cloudflare\'s global edge with one click. Custom domains and GitHub sync are built in.',
//   },
// ];

// ============================================================================
// Cross-plan feature comparison
// ============================================================================

type PlanKey = 'free' | 'pro' | 'max';
type CellValue = boolean | string;

const comparisonGroups: {
  label: string;
  rows: { feature: string; values: Record<PlanKey, CellValue> }[];
}[] = [
  {
    label: 'Building',
    rows: [
      {
        feature: 'Active projects',
        values: { free: '3', pro: '20', max: 'Unlimited' },
      },
      {
        feature: 'AI agent (Claude, GPT-6, Fireworks)',
        values: { free: true, pro: true, max: true },
      },
      {
        feature: 'Bring your own model keys',
        values: { free: true, pro: true, max: true },
      },
      {
        feature: 'Platform-managed model credits',
        values: { free: false, pro: 'Monthly allotment', max: 'Generous monthly allotment' },
      },
    ],
  },
  {
    label: 'Backend',
    rows: [
      {
        feature: 'Convex backend per project',
        values: MANAGED_CONVEX
          ? { free: 'Bring your own', pro: 'Platform-managed', max: 'Platform-managed' }
          : { free: 'Bring your own', pro: 'Bring your own', max: 'Bring your own' },
      },
      {
        feature: 'Real-time database & functions',
        values: { free: true, pro: true, max: true },
      },
      {
        feature: 'Scheduled jobs & cron',
        values: { free: true, pro: true, max: true },
      },
    ],
  },
  {
    label: 'Shipping',
    rows: [
      {
        feature: 'One-click deploy to Cloudflare',
        values: { free: true, pro: true, max: true },
      },
      {
        feature: 'GitHub sync & PRs',
        values: { free: true, pro: true, max: true },
      },
      {
        feature: 'Custom domains',
        values: { free: false, pro: true, max: true },
      },
      {
        feature: 'Priority support',
        values: { free: false, pro: false, max: true },
      },
    ],
  },
];

// ============================================================================
// FAQ
// ============================================================================

const faqs = [
  {
    q: 'Can I start without a credit card?',
    a: 'Yes. The Free plan lets you build, run, and ship real projects without entering any payment info. You can always upgrade later from inside the workspace.',
  },
  {
    q: 'Do I have to use Botflow\'s AI credits?',
    a: 'No. Every plan supports bringing your own keys for OpenAI, Anthropic, and Fireworks — or signing in with Claude / Codex OAuth. Use the platform credits when convenient and your own keys when you want zero markup.',
  },
  {
    q: 'What happens to my projects if I downgrade?',
    a: 'Your projects stay live. If you exceed the lower plan\'s active-project limit, the oldest projects move to read-only until you archive a few or upgrade again — nothing is deleted.',
  },
  {
    q: 'Is Convex really included?',
    a: MANAGED_CONVEX
      ? 'Yes. On Pro and Max, every project gets a platform-managed Convex backend with real-time sync, typed functions, and the full Convex dashboard inside the IDE. On Free, you connect your own Convex account and we wire it up automatically.'
      : 'Convex is built in on every plan: connect your own (free) Convex account once, and Botflow provisions a backend for each project and wires it up automatically — real-time sync, typed functions, and the full Convex dashboard inside the IDE. Usage stays on your Convex account.',
  },
  {
    q: 'Can I cancel anytime?',
    a: 'Yes. Cancel from the subscription tab in Settings — your plan stays active until the end of the current billing period, and you keep everything you\'ve built.',
  },
];

// ============================================================================
// Clerk PricingTable — typography only. We only restyle text elements
// (size, font-family, color) and palette tokens. We deliberately avoid
// touching `display`, `flex`, `grid`, `padding`, and `leading-none` on any
// container element — those break Clerk's internal layout, which previously
// caused the description to wrap one character per line.
// ============================================================================

const pricingTableAppearance = {
  variables: {
    colorPrimary: 'var(--sand-text)',
    colorBackground: 'var(--sand-surface)',
    colorText: 'var(--sand-text)',
    colorTextSecondary: 'var(--sand-text-muted)',
    colorNeutral: 'var(--sand-text)',
    colorInputBackground: 'var(--sand-elevated)',
    colorInputText: 'var(--sand-text)',
    borderRadius: '0.875rem',
  },
  elements: {
    // Card shell — safe: bg / border / radius / hover.
    pricingTableCard: cn(
      '!bg-[var(--sand-surface)] !border !border-[var(--sand-border)]',
      '!rounded-2xl !shadow-sm transition-colors',
      'hover:!border-[var(--sand-text-muted)]/40',
    ),
    // Plan name — serif, larger. NO leading-none (it broke alignment last time).
    pricingTableCardTitle: cn(
      serif.className,
      '!text-4xl sm:!text-5xl !font-normal !tracking-tight',
    ),
    // Tagline under the plan name — slightly bigger, more breathing room.
    pricingTableCardDescription:
      '!text-base !leading-relaxed !text-[var(--sand-text-muted)] !py-4',
    // The price itself — big serif, the focal point of each card.
    pricingTableCardFee: cn(
      serif.className,
      '!text-6xl sm:!text-7xl !font-normal !tracking-tight',
    ),
    // " / month" next to the price — readable, not cramped.
    pricingTableCardFeePeriod:
      '!text-base !font-normal !text-[var(--sand-text-muted)]',
    // "Always free" caption under the $0 price.
    pricingTableCardFeePeriodNotice:
      '!text-sm !text-[var(--sand-text-muted)]',
    // CTA — a little more presence than Clerk's default.
    pricingTableCardFooterButton: cn(
      '!bg-[var(--sand-text)] !text-[var(--sand-bg)]',
      '!text-base !font-medium hover:!opacity-90',
    ),
    // Active-plan pill.
    badge:
      '!bg-[var(--sand-accent)] !text-[var(--sand-accent-contrast)] !text-xs !font-semibold',
  },
} as const;

// ============================================================================
// FAQ accordion item
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

// ============================================================================
// Comparison cell renderer
// ============================================================================

function ComparisonCell({ value }: { value: CellValue }) {
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
    <span className="text-sm text-[var(--sand-text)] font-medium">{value}</span>
  );
}

// ============================================================================
// Main page
// ============================================================================

export default function PricingPage() {
  return (
    <div className="antialiased text-[var(--sand-text)] bg-[var(--sand-bg)] min-h-screen overflow-x-hidden">
      <EditorialGrid />
      <LandingNav />

      {/* ================================================================ */}
      {/* HERO                                                             */}
      {/* ================================================================ */}
      <section className="relative overflow-hidden hero-grid">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 pt-16 sm:pt-24 pb-12 sm:pb-16">
          <div className="max-w-3xl mx-auto text-center">
            <Reveal>
              <SectionLabel>Pricing</SectionLabel>
            </Reveal>

            <Reveal delay={80}>
              <h1
                className={cn(
                  serif.className,
                  'text-5xl sm:text-6xl md:text-7xl lg:text-8xl tracking-tight leading-[1.05]',
                )}
              >
                Build for free.{' '}
                <em
                  className={serif.className}
                  style={{ color: 'var(--sand-accent)' }}
                >
                  Pay when it&apos;s real.
                </em>
              </h1>
            </Reveal>

            <Reveal delay={180}>
              <p className="mt-6 text-lg sm:text-xl text-[var(--sand-text-muted)] max-w-2xl mx-auto leading-relaxed">
                Start with a generous free tier. Upgrade when you need more
                projects, more credits, or your apps go to production. Cancel
                anytime — no surprises.
              </p>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ================================================================ */}
      {/* PLAN HIGHLIGHTS                                                  */}
      {/* ================================================================ 
      <section className="relative">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 pb-2 sm:pb-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-0 border border-[var(--sand-border)] rounded-2xl overflow-hidden bg-[var(--sand-surface)]/50">
            {planHighlights.map((h, i) => (
              <Reveal key={h.title} delay={i * 80}>
                <div
                  className={cn(
                    'relative p-6 sm:p-7 h-full',
                    i < planHighlights.length - 1 &&
                      'md:border-r md:border-[var(--sand-border)]',
                    i < planHighlights.length - 1 &&
                      'max-md:border-b max-md:border-[var(--sand-border)]',
                  )}
                >
                  <h.icon
                    aria-hidden
                    className="mb-4 h-6 w-6 text-[var(--sand-accent)]"
                    strokeWidth={1.5}
                  />
                  <h3 className="text-base font-semibold mb-1.5">{h.title}</h3>
                  <p className="text-sm text-[var(--sand-text-muted)] leading-relaxed">
                    {h.description}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>
      */}

      {/* ================================================================ */}
      {/* PRICING TABLE                                                    */}
      {/* ================================================================ */}
      <section className="relative">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 pt-12 sm:pt-16 pb-20 sm:pb-28">
          <Reveal>
            <div className="pricing-clerk-wrapper">
              <PricingTable
                newSubscriptionRedirectUrl="/projects"
                ctaPosition="bottom"
                appearance={pricingTableAppearance}
              />
            </div>
          </Reveal>

          <Reveal delay={120}>
            <p className="mt-8 text-center text-xs text-[var(--sand-text-muted)]">
              All plans include unlimited collaborators, encrypted secrets, and
              the full IDE. Prices in USD.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ================================================================ */}
      {/* COMPARISON                                                       */}
      {/* ================================================================ */}
      <LineDivider />
      <section className="relative bg-[var(--sand-surface)]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-20 sm:py-28">
          <Reveal>
            <div className="text-center max-w-2xl mx-auto mb-12 sm:mb-16">
              <SectionLabel>Compare</SectionLabel>
              <h2
                className={cn(
                  serif.className,
                  'text-4xl sm:text-5xl md:text-6xl tracking-tight',
                )}
              >
                What&apos;s in{' '}
                <em className={serif.className}>each plan</em>
              </h2>
            </div>
          </Reveal>

          <Reveal delay={120}>
            <div className="rounded-2xl border border-[var(--sand-border)] bg-[var(--sand-bg)] overflow-hidden">
              {/* Table header */}
              <div className="grid grid-cols-[1.5fr_1fr_1fr_1fr] sm:grid-cols-[2fr_1fr_1fr_1fr] border-b border-[var(--sand-border)]">
                <div className="px-5 sm:px-7 py-5 text-xs font-medium uppercase tracking-[0.18em] text-[var(--sand-text-muted)]">
                  Feature
                </div>
                {(['free', 'pro', 'max'] as PlanKey[]).map((p) => (
                  <div
                    key={p}
                    className="px-3 sm:px-5 py-5 text-center text-xs font-medium uppercase tracking-[0.18em] text-[var(--sand-text-muted)]"
                  >
                    {p}
                  </div>
                ))}
              </div>

              {/* Groups */}
              {comparisonGroups.map((group, gi) => (
                <div key={group.label}>
                  <div className="grid grid-cols-[1.5fr_1fr_1fr_1fr] sm:grid-cols-[2fr_1fr_1fr_1fr] border-b border-[var(--sand-border)] bg-[var(--sand-elevated)]/40">
                    <div
                      className={cn(
                        serif.className,
                        'col-span-4 px-5 sm:px-7 py-3 text-base italic text-[var(--sand-text-muted)]',
                      )}
                    >
                      {group.label}
                    </div>
                  </div>
                  {group.rows.map((row, ri) => (
                    <div
                      key={row.feature}
                      className={cn(
                        'grid grid-cols-[1.5fr_1fr_1fr_1fr] sm:grid-cols-[2fr_1fr_1fr_1fr] items-center',
                        (gi !== comparisonGroups.length - 1 ||
                          ri !== group.rows.length - 1) &&
                          'border-b border-[var(--sand-border)]',
                      )}
                    >
                      <div className="px-5 sm:px-7 py-4 text-sm text-[var(--sand-text)]">
                        {row.feature}
                      </div>
                      {(['free', 'pro', 'max'] as PlanKey[]).map((p) => (
                        <div
                          key={p}
                          className="px-3 sm:px-5 py-4 text-center"
                        >
                          <ComparisonCell value={row.values[p]} />
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      {/* ================================================================ */}
      {/* FAQ                                                              */}
      {/* ================================================================ */}
      <LineDivider />
      <section className="relative">
        <div className="mx-auto max-w-4xl px-4 sm:px-6 py-20 sm:py-28">
          <Reveal>
            <div className="text-center max-w-2xl mx-auto mb-12 sm:mb-16">
              <SectionLabel>FAQ</SectionLabel>
              <h2
                className={cn(
                  serif.className,
                  'text-4xl sm:text-5xl md:text-6xl tracking-tight',
                )}
              >
                Questions,{' '}
                <em className={serif.className}>answered</em>
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

      {/* ================================================================ */}
      {/* CTA                                                              */}
      {/* ================================================================ */}
      <LineDivider />
      <section className="relative">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-24 sm:py-32 text-center">
          <Reveal>
            <Bot
              aria-hidden
              className="mx-auto mb-6 h-10 w-10 text-[var(--sand-accent)]"
              strokeWidth={1.5}
            />
            <h2
              className={cn(
                serif.className,
                'text-4xl sm:text-5xl md:text-6xl tracking-tight max-w-2xl mx-auto',
              )}
            >
              Start building.{' '}
              <em
                className={serif.className}
                style={{ color: 'var(--sand-accent)' }}
              >
                Upgrade later.
              </em>
            </h2>
            <p className="mt-5 text-lg text-[var(--sand-text-muted)] max-w-xl mx-auto leading-relaxed">
              No credit card. No setup. Describe an app and watch it run.
            </p>
            <div className="mt-9 flex items-center justify-center">
              <Link
                href="/sign-up"
                className="group inline-flex items-center gap-2 rounded-xl bg-[var(--sand-text)] text-[var(--sand-bg)] px-6 py-3 text-base font-medium shadow-md hover:opacity-90 transition"
              >
                <Layers className="h-4 w-4" />
                Create your first project
              </Link>
            </div>
          </Reveal>
        </div>
      </section>

      <LandingFooter />
    </div>
  );
}
