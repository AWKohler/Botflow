'use client';

import Link from 'next/link';
import {
  Database,
  Zap,
  LayoutDashboard,
  Code2,
  Clock,
  FileStack,
  Webhook,
  Lock,
  ArrowRight,
  ArrowUpRight,
  Sparkles,
  Server,
  Gauge,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { WorkspaceMockup } from '@/components/landing/WorkspaceMockup';
import { CardSpotlight } from '@/components/landing/CardSpotlight';
import {
  EditorialGrid,
  LandingFooter,
  LandingNav,
  LineDivider,
  Reveal,
  SectionLabel,
  StaggerButton,
  serif,
} from '@/components/landing/shared';
import { isManagedConvexEnabled } from '@/lib/project-platform';

// Managed-Convex kill switch (NEXT_PUBLIC_DISABLE_MANAGED_CONVEX) — when off,
// Bring Your Own Convex is the only option, so the copy stops promising a
// platform-hosted deployment.
const MANAGED_CONVEX = isManagedConvexEnabled();

// ============================================================================
// Pillars — three benefit cards
// ============================================================================

const pillars = [
  {
    icon: Code2,
    title: 'Defined in TypeScript',
    description:
      'Your schema, queries, and mutations are just TypeScript files. The AI reads them like any other code — no dashboards to crawl, no REST to guess at.',
  },
  {
    icon: Zap,
    title: 'Real-time by default',
    description:
      "Data changes stream to your UI the moment they happen. No polling, no cache invalidation, no websocket glue you have to wire up yourself.",
  },
  {
    icon: LayoutDashboard,
    title: 'Admin UI, built in',
    description:
      "The real Convex dashboard lives inside the Database tab. Browse tables, run functions, inspect logs — without leaving the workspace.",
  },
];

// ============================================================================
// Feature list — "What you get out of the box"
// ============================================================================

const capabilities = [
  {
    icon: Database,
    title: 'Typed database',
    description:
      'A document database where every table is validated by your schema.ts. No migrations to hand-write, no separate ORM to install.',
    href: 'https://docs.convex.dev/database',
  },
  {
    icon: Code2,
    title: 'Queries & mutations',
    description:
      'Reactive reads and transactional writes as TypeScript functions. Call them from React with useQuery and useMutation.',
    href: 'https://docs.convex.dev/functions/query-functions',
  },
  {
    icon: Webhook,
    title: 'Actions & HTTP endpoints',
    description:
      'Talk to external APIs or expose your own HTTP routes. Perfect for payments, AI calls, and inbound webhooks.',
    href: 'https://docs.convex.dev/functions/actions',
  },
  {
    icon: Clock,
    title: 'Scheduled jobs & cron',
    description:
      "Schedule work for later or on a recurring cadence, all in code. Replace a job queue and a cron service in one file.",
    href: 'https://docs.convex.dev/scheduling',
  },
  {
    icon: FileStack,
    title: 'File storage',
    description:
      "Store and serve user uploads with signed URLs, directly from your Convex deployment — no S3 bucket to provision.",
    href: 'https://docs.convex.dev/file-storage',
  },
  {
    icon: Lock,
    title: 'Per-function auth',
    description:
      "Every function has access to the caller's identity. Enforce rules at the edge, next to the data they protect.",
    href: 'https://docs.convex.dev/auth',
  },
];

// ============================================================================
// Code block — minimal syntax-colored display (no highlighter dep)
// ============================================================================

function CodeBlock({
  filename,
  lines,
}: {
  filename: string;
  lines: { tokens: { text: string; color?: string }[] }[];
}) {
  return (
    <div className="rounded-xl border border-[var(--sand-border)] bg-[var(--sand-elevated)]/80 overflow-hidden shadow-sm">
      <div className="flex items-center gap-2 border-b border-[var(--sand-border)] bg-[var(--sand-surface)]/60 px-4 py-2">
        <span className="h-2.5 w-2.5 rounded-full bg-[#e24a4a]/60" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#e2b44a]/60" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#4ae27a]/60" />
        <span className="ml-2 font-mono text-[11px] text-[var(--sand-text-muted)]">
          {filename}
        </span>
      </div>
      <pre className="overflow-auto modern-scrollbar p-4 font-mono text-[12.5px] leading-[1.6]">
        {lines.map((line, i) => (
          <div key={i} className="flex">
            <span className="w-6 shrink-0 select-none pr-3 text-right text-[var(--sand-text-muted)] opacity-50">
              {i + 1}
            </span>
            <span className="whitespace-pre">
              {line.tokens.length === 0 ? '\u00A0' : line.tokens.map((t, ti) => (
                <span key={ti} style={t.color ? { color: t.color } : undefined}>
                  {t.text}
                </span>
              ))}
            </span>
          </div>
        ))}
      </pre>
    </div>
  );
}

// Color tokens for the code examples — warm editor-ish palette that matches sand theme
const C = {
  kw: '#d86a4e',     // keyword (import, export, const, default)
  fn: '#1d52f1',     // function name / call
  str: '#5a8a3b',    // string literal
  id: 'var(--sand-text)', // identifier
  type: '#b4783e',   // type / class
  prop: '#7a5ab1',   // property
  muted: 'var(--sand-text-muted)', // comment
  punct: 'var(--sand-text-muted)', // punctuation
};

const schemaExample = [
  {
    tokens: [
      { text: 'import', color: C.kw },
      { text: ' { ' },
      { text: 'defineSchema', color: C.fn },
      { text: ', ' },
      { text: 'defineTable', color: C.fn },
      { text: ' } ' },
      { text: 'from', color: C.kw },
      { text: ' ' },
      { text: '"convex/server"', color: C.str },
      { text: ';' },
    ],
  },
  {
    tokens: [
      { text: 'import', color: C.kw },
      { text: ' { ' },
      { text: 'v', color: C.fn },
      { text: ' } ' },
      { text: 'from', color: C.kw },
      { text: ' ' },
      { text: '"convex/values"', color: C.str },
      { text: ';' },
    ],
  },
  { tokens: [] },
  {
    tokens: [
      { text: 'export', color: C.kw },
      { text: ' ' },
      { text: 'default', color: C.kw },
      { text: ' ' },
      { text: 'defineSchema', color: C.fn },
      { text: '({' },
    ],
  },
  {
    tokens: [
      { text: '  tasks', color: C.prop },
      { text: ': ' },
      { text: 'defineTable', color: C.fn },
      { text: '({' },
    ],
  },
  {
    tokens: [
      { text: '    text', color: C.prop },
      { text: ': ' },
      { text: 'v', color: C.fn },
      { text: '.' },
      { text: 'string', color: C.fn },
      { text: '(),' },
    ],
  },
  {
    tokens: [
      { text: '    done', color: C.prop },
      { text: ': ' },
      { text: 'v', color: C.fn },
      { text: '.' },
      { text: 'boolean', color: C.fn },
      { text: '(),' },
    ],
  },
  {
    tokens: [
      { text: '    userId', color: C.prop },
      { text: ': ' },
      { text: 'v', color: C.fn },
      { text: '.' },
      { text: 'id', color: C.fn },
      { text: '(' },
      { text: '"users"', color: C.str },
      { text: '),' },
    ],
  },
  {
    tokens: [
      { text: '  }).' },
      { text: 'index', color: C.fn },
      { text: '(' },
      { text: '"by_user"', color: C.str },
      { text: ', [' },
      { text: '"userId"', color: C.str },
      { text: ']),' },
    ],
  },
  { tokens: [{ text: '});' }] },
];

const mutationExample = [
  {
    tokens: [
      { text: 'export', color: C.kw },
      { text: ' ' },
      { text: 'const', color: C.kw },
      { text: ' add = ' },
      { text: 'mutation', color: C.fn },
      { text: '({' },
    ],
  },
  {
    tokens: [
      { text: '  args', color: C.prop },
      { text: ': { ' },
      { text: 'text', color: C.prop },
      { text: ': ' },
      { text: 'v', color: C.fn },
      { text: '.' },
      { text: 'string', color: C.fn },
      { text: '() },' },
    ],
  },
  {
    tokens: [
      { text: '  handler', color: C.prop },
      { text: ': ' },
      { text: 'async', color: C.kw },
      { text: ' (ctx, { text }) => {' },
    ],
  },
  {
    tokens: [
      { text: '    ' },
      { text: 'const', color: C.kw },
      { text: ' user = ' },
      { text: 'await', color: C.kw },
      { text: ' ' },
      { text: 'getAuthedUser', color: C.fn },
      { text: '(ctx);' },
    ],
  },
  {
    tokens: [
      { text: '    ' },
      { text: 'return', color: C.kw },
      { text: ' ' },
      { text: 'await', color: C.kw },
      { text: ' ctx.db.' },
      { text: 'insert', color: C.fn },
      { text: '(' },
      { text: '"tasks"', color: C.str },
      { text: ', {' },
    ],
  },
  {
    tokens: [
      { text: '      text' },
      { text: ', ' },
      { text: 'done', color: C.prop },
      { text: ': ' },
      { text: 'false', color: C.kw },
      { text: ', ' },
      { text: 'userId', color: C.prop },
      { text: ': user._id,' },
    ],
  },
  { tokens: [{ text: '    });' }] },
  { tokens: [{ text: '  },' }] },
  { tokens: [{ text: '});' }] },
];

// ============================================================================
// Main Page
// ============================================================================

export default function ConvexPage() {
  // Smooth scroll to #showcase when "See it in action" is clicked
  const scrollToShowcase = () => {
    document.getElementById('showcase')?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="antialiased text-[var(--sand-text)] bg-[var(--sand-bg)] min-h-screen overflow-x-hidden">
      <EditorialGrid />
      <LandingNav />

      {/* ================================================================ */}
      {/* HERO                                                             */}
      {/* ================================================================ */}
      <section className="relative overflow-hidden">
        <div className="mx-auto max-w-7xl px-6 sm:px-6 pt-16 sm:pt-24 pb-12 sm:pb-16">
          <div className="max-w-3xl mx-auto text-center">

            <Reveal delay={80}>
              <h1
                className={cn(
                  serif.className,
                  'text-5xl sm:text-6xl md:text-7xl lg:text-8xl tracking-tight leading-[1.02]',
                )}
              >
                Your backend.{' '}
                <em className={serif.className} style={{ color: 'var(--sand-accent)' }}>
                  Already there.
                </em>
              </h1>
            </Reveal>

            <Reveal delay={180}>
              <p className="mt-6 text-lg sm:text-xl text-[var(--sand-text-muted)] max-w-2xl mx-auto leading-relaxed">
                {MANAGED_CONVEX
                  ? 'Every Botflow project ships with Convex — a typed database, serverless functions, real-time sync, and a built-in admin dashboard. No accounts to create. No glue code to write.'
                  : 'Every Botflow project ships with Convex — a typed database, serverless functions, real-time sync, and a built-in admin dashboard. Connect your free Convex account once. No glue code to write.'}
              </p>
            </Reveal>

            <Reveal delay={280}>
              <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-3">
                <StaggerButton text="Start building" href="/sign-up" />
                <button
                  type="button"
                  onClick={scrollToShowcase}
                  className="inline-flex items-center gap-2 rounded-xl border border-[var(--sand-border)] bg-[var(--sand-elevated)] px-6 py-3 text-base font-medium shadow-sm hover:bg-[var(--sand-surface)] transition"
                >
                  See it in action
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ================================================================ */}
      {/* PILLARS                                                          */}
      {/* ================================================================ */}
      <LineDivider />
      <section className="relative">
        <div className="mx-auto max-w-7xl px-6 sm:px-6 py-20 sm:py-28">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-0">
            {pillars.map((p, i) => (
              <Reveal key={p.title} delay={i * 80}>
                <div
                  className={cn(
                    'group relative p-6 sm:p-10 transition-colors duration-300 hover:bg-[var(--sand-surface)]',
                    i < 2 && 'md:border-r md:border-[var(--sand-border)]',
                    i < pillars.length - 1 &&
                      'max-md:border-b max-md:border-[var(--sand-border)]',
                  )}
                >
                  <CardSpotlight />
                  <p.icon
                    aria-hidden
                    className="relative z-10 mb-6 h-8 w-8 text-[var(--sand-accent)]"
                    strokeWidth={1.5}
                  />
                  <h3 className="relative z-10 text-xl font-semibold mb-2">
                    {p.title}
                  </h3>
                  <p className="relative z-10 text-[0.95rem] text-[var(--sand-text-muted)] leading-relaxed">
                    {p.description}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ================================================================ */}
      {/* SHOWCASE — database tab mockup                                   */}
      {/* ================================================================ */}
      <LineDivider />
      <section id="showcase" className="relative">
        <div className="mx-auto max-w-7xl px-6 sm:px-6 lg:px-10 xl:px-14 py-24 sm:py-32">
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-12 lg:gap-14 items-center">
            {/* Mockup — agent panel hidden, database view front-and-center. Hidden on mobile (too cramped to fit). */}
            <Reveal delay={150} className="hidden lg:block lg:col-span-3 lg:order-1">
              <div className="relative">
                {/* Ambient accent glow behind the mockup */}
                <div
                  aria-hidden
                  className="pointer-events-none absolute -inset-10 -z-10"
                  style={{
                    background:
                      'radial-gradient(55% 55% at 35% 50%, color-mix(in oklab, var(--sand-accent) 14%, transparent), transparent 70%)',
                  }}
                />

                <WorkspaceMockup
                  messages={[]}
                  hideAgentPanel
                  defaultView="database"
                  className="shadow-[0_20px_60px_-20px_rgba(0,0,0,0.25)]"
                />
              </div>
            </Reveal>

            {/* Copy — now on the right */}
            <Reveal className="lg:col-span-2 lg:order-2">
              <div>
                <SectionLabel>The Database tab</SectionLabel>
                <h2
                  className={cn(
                    serif.className,
                    'text-4xl sm:text-5xl tracking-tight leading-tight',
                  )}
                >
                  The admin UI,{' '}
                  <em className={serif.className}>right here</em>
                </h2>
                <p className="mt-6 text-lg text-[var(--sand-text-muted)] leading-relaxed">
                  Open the <span className="font-medium text-[var(--sand-text)]">Database</span> tab and you&apos;re looking at the real Convex dashboard, authenticated against your project&apos;s deployment — embedded seamlessly into your workspace.
                </p>
                <ul className="mt-8 space-y-3">
                  {[
                    'Browse tables and inspect every document',
                    'Run queries and mutations with live arguments',
                    'Watch function logs stream in real time',
                    'Edit schema indexes without leaving the IDE',
                  ].map((item) => (
                    <li
                      key={item}
                      className="flex items-start gap-3 text-[0.95rem] text-[var(--sand-text-muted)]"
                    >
                      <span
                        className="mt-2 h-1.5 w-1.5 rounded-full shrink-0"
                        style={{ background: 'var(--sand-accent)' }}
                      />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ================================================================ */}
      {/* TYPESCRIPT FIRST — AI development                                */}
      {/* ================================================================ */}
      <LineDivider />
      <section className="relative">
        <div className="mx-auto max-w-7xl px-6 sm:px-6 lg:px-10 xl:px-14 py-24 sm:py-32">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-start">
            <Reveal>
              <SectionLabel>Built for AI-first development</SectionLabel>
              <h2
                className={cn(
                  serif.className,
                  'text-4xl sm:text-5xl md:text-6xl tracking-tight leading-[1.05]',
                )}
              >
                A backend the AI actually{' '}
                <em className={serif.className}>understands</em>
              </h2>
              <div className="mt-8 space-y-5 text-[1.02rem] text-[var(--sand-text-muted)] leading-relaxed">
                <p>
                  Most backend services were designed for humans. Convex happens to be perfect for AI.
                </p>
                <p>
                  The schema is a file. Queries are functions. Mutations are functions. Validators are imports. There&apos;s no proprietary dashboard for the agent to crawl, no SQL migration format to translate, no REST contract to infer.
                </p>
                <p>
                  The agent reads the same <code className="rounded bg-[var(--sand-elevated)] px-1.5 py-0.5 text-[0.9em] font-mono">convex/</code> folder you do — and writes the same patterns it uses everywhere else in your codebase.
                </p>
              </div>
            </Reveal>

            <Reveal delay={150}>
              <div className="flex flex-col gap-4">
                <CodeBlock filename="convex/schema.ts" lines={schemaExample} />
                <CodeBlock filename="convex/tasks.ts" lines={mutationExample} />
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ================================================================ */}
      {/* CAPABILITIES — what you get out of the box                       */}
      {/* ================================================================ */}
      <LineDivider />
      <section className="relative bg-[var(--sand-surface)]">
        <div className="mx-auto max-w-7xl px-6 sm:px-6 py-24 sm:py-32">
          <Reveal>
            <div className="text-center max-w-2xl mx-auto mb-16 sm:mb-20">
              <SectionLabel>In the box</SectionLabel>
              <h2
                className={cn(
                  serif.className,
                  'text-4xl sm:text-5xl md:text-6xl tracking-tight',
                )}
              >
                Everything a modern app needs,{' '}
                <em className={serif.className}>from day one</em>
              </h2>
              <p className="mt-4 text-lg text-[var(--sand-text-muted)] leading-relaxed">
                One platform, one language, one deploy. Here&apos;s what ships with every project.
              </p>
            </div>
          </Reveal>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-0">
            {capabilities.map((c, i) => (
              <Reveal key={c.title} delay={i * 60}>
                <a
                  href={c.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    'group relative block p-6 sm:p-8 transition-colors duration-300 hover:bg-[var(--sand-elevated)] focus:outline-none focus-visible:bg-[var(--sand-elevated)]',
                    i % 3 !== 2 && 'lg:border-r lg:border-[var(--sand-border)]',
                    i % 2 === 0 && 'md:max-lg:border-r md:max-lg:border-[var(--sand-border)]',
                    i < 3 && 'lg:border-b lg:border-[var(--sand-border)]',
                    i < 4 && 'md:max-lg:border-b md:max-lg:border-[var(--sand-border)]',
                    i < capabilities.length - 1 &&
                      'max-md:border-b max-md:border-[var(--sand-border)]',
                  )}
                >
                  <CardSpotlight />
                  <div className="relative z-10 mb-4 flex items-start justify-between gap-3">
                    <div className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--sand-bg)] border border-[var(--sand-border)] text-[var(--sand-text-muted)] group-hover:text-[var(--sand-accent)] group-hover:border-[var(--sand-accent)]/30 transition-colors duration-300">
                      <c.icon className="h-5 w-5" strokeWidth={1.6} />
                    </div>
                    <ArrowUpRight
                      className="h-4 w-4 text-[var(--sand-text-muted)] opacity-0 -translate-x-1 translate-y-1 group-hover:opacity-100 group-hover:translate-x-0 group-hover:translate-y-0 group-hover:text-[var(--sand-accent)] transition-all duration-300"
                      aria-hidden
                    />
                  </div>
                  <h3 className="relative z-10 text-lg font-semibold mb-2">{c.title}</h3>
                  <p className="relative z-10 text-sm text-[var(--sand-text-muted)] leading-relaxed">
                    {c.description}
                  </p>
                  <span className="sr-only">
                    Read the Convex documentation for {c.title}
                  </span>
                </a>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ================================================================ */}
      {/* NO GLUE CODE — comparison callout                                */}
      {/* ================================================================ */}
      <LineDivider />
      <section className="relative">
        <div className="mx-auto max-w-7xl px-6 sm:px-6 lg:px-10 xl:px-14 py-24 sm:py-32">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center">
            <Reveal>
              <SectionLabel>Less to pay for, less to debug</SectionLabel>
              <h2
                className={cn(
                  serif.className,
                  'text-4xl sm:text-5xl tracking-tight leading-tight',
                )}
              >
                One platform,{' '}
                <em className={serif.className}>not five</em>
              </h2>
              <p className="mt-6 text-lg text-[var(--sand-text-muted)] leading-relaxed">
                A typical modern app stitches together a database provider, an auth service, a file store, a job runner, and a pile of glue code. Convex bundles the first four — so you and the agent have fewer services to wire up, fewer bills to reconcile, and fewer integrations to debug.
              </p>
              <p className="mt-4 text-[var(--sand-text-muted)] leading-relaxed">
                That&apos;s not just a developer-experience win. It&apos;s a measurably cheaper stack.
              </p>
            </Reveal>

            <Reveal delay={150}>
              <div className="relative rounded-2xl border border-[var(--sand-border)] bg-[var(--sand-elevated)] p-8 sm:p-10 overflow-hidden">
                <div
                  aria-hidden
                  className="absolute inset-0 opacity-60"
                  style={{
                    background:
                      'radial-gradient(ellipse 80% 60% at 100% 0%, color-mix(in oklab, var(--sand-accent) 10%, transparent), transparent 65%)',
                  }}
                />
                <div className="relative">
                  <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--sand-text-muted)] mb-6">
                    Without Convex
                  </p>
                  <ul className="space-y-2 text-[0.95rem] text-[var(--sand-text-muted)]">
                    {['Database service', 'Auth provider', 'File/object storage', 'Job queue + scheduler', 'HTTP/webhook gateway', 'The glue code that stitches them together'].map((s) => (
                      <li key={s} className="flex items-center gap-2">
                        <span className="h-px w-4 bg-[var(--sand-border)]" />
                        <span className="line-through decoration-[var(--sand-accent)]/40">{s}</span>
                      </li>
                    ))}
                  </ul>

                  <div className="my-6 h-px bg-[var(--sand-border)]" />

                  <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--sand-text-muted)] mb-4">
                    With Botflow + Convex
                  </p>
                  <div className="flex items-center gap-3">
                    <div
                      className="flex h-12 w-12 items-center justify-center rounded-xl border border-[var(--sand-accent)]/30 bg-[var(--sand-bg)] text-[var(--sand-accent)]"
                      style={{
                        boxShadow:
                          '0 6px 24px -10px color-mix(in oklab, var(--sand-accent) 40%, transparent)',
                      }}
                    >
                      <Server className="h-6 w-6" strokeWidth={1.5} />
                    </div>
                    <div>
                      <p className="font-semibold">One TypeScript project.</p>
                      <p className="text-sm text-[var(--sand-text-muted)]">
                        Deployed by the agent, inspected from the Database tab.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ================================================================ */}
      {/* BYOC                                                             */}
      {/* ================================================================ */}
      <LineDivider />
      <section className="relative bg-[var(--sand-surface)]">
        <div className="mx-auto max-w-7xl px-6 sm:px-6 py-24 sm:py-32">
          <Reveal>
            <div className="max-w-3xl mx-auto text-center">
              <SectionLabel>{MANAGED_CONVEX ? 'Power-user option' : 'Your Convex account'}</SectionLabel>
              <h2
                className={cn(
                  serif.className,
                  'text-4xl sm:text-5xl md:text-6xl tracking-tight leading-[1.05]',
                )}
              >
                {MANAGED_CONVEX ? 'Already a Convex user?' : 'Your backend,'}{' '}
                <em className={serif.className}>{MANAGED_CONVEX ? 'Bring your own.' : 'your account.'}</em>
              </h2>
              <p className="mt-6 text-lg text-[var(--sand-text-muted)] leading-relaxed">
                {MANAGED_CONVEX
                  ? <>Connect your Convex account via OAuth and Botflow will deploy to your team&apos;s deployment instead of the platform&apos;s. You keep full billing control, observability, and team access. Botflow just drives.</>
                  : <>Connect your Convex account via OAuth and Botflow provisions and deploys each project&apos;s backend in your team. You keep full billing control, observability, and team access. Botflow just drives.</>}
              </p>

              <div className="mt-10 grid grid-cols-1 sm:grid-cols-3 gap-4 text-left">
                {[
                  {
                    icon: Lock,
                    title: 'Your credentials',
                    desc: 'OAuth links your Convex account — keys never leave their vault.',
                  },
                  {
                    icon: Gauge,
                    title: 'Your billing',
                    desc: 'Usage stays on your Convex invoice, not ours.',
                  },
                  {
                    icon: Server,
                    title: 'Your team',
                    desc: 'Invite collaborators with Convex team permissions you already use.',
                  },
                ].map((b) => (
                  <div
                    key={b.title}
                    className="relative rounded-xl border border-[var(--sand-border)] bg-[var(--sand-bg)] p-5"
                  >
                    <b.icon
                      className="mb-3 h-5 w-5 text-[var(--sand-accent)]"
                      strokeWidth={1.6}
                    />
                    <p className="font-semibold text-[0.95rem] mb-1">{b.title}</p>
                    <p className="text-sm text-[var(--sand-text-muted)] leading-relaxed">
                      {b.desc}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ================================================================ */}
      {/* CTA                                                              */}
      {/* ================================================================ */}
      <LineDivider />
      <section className="relative">
        <div className="pointer-events-none absolute inset-0 -z-10 landing-gradient opacity-60" />
        <div className="mx-auto max-w-7xl px-6 sm:px-6 py-24 sm:py-32">
          <Reveal>
            <div className="text-center max-w-2xl mx-auto">
              <h2
                className={cn(
                  serif.className,
                  'text-4xl sm:text-5xl md:text-6xl tracking-tight',
                )}
              >
                Build with a{' '}
                <span style={{ color: 'var(--sand-accent)' }}>real backend</span>
              </h2>
              <p className="mt-4 text-lg text-[var(--sand-text-muted)]">
                Start a new project and your Convex deployment is waiting.
              </p>
              <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
                <StaggerButton text="Start for free" href="/sign-up" />
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

      <LineDivider />
      <LandingFooter />
    </div>
  );
}
