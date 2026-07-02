// 'use client';

// import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
// import Link from 'next/link';
// import { useRouter } from 'next/navigation';
// import { SignedIn, SignedOut, UserButton } from '@clerk/nextjs';
// import {
//   ArrowUp,
//   ArrowRight,
//   Eye,
//   Database,
//   Github,
//   Globe,
//   Bot,
//   Layers,
//   Plus,
//   Monitor,
// } from 'lucide-react';
// import { cn } from '@/lib/utils';
// import { WorkspaceMockup } from '@/components/landing/WorkspaceMockup';
// import { Convex } from '@/components/icons/convex';
// import { Anthropic } from '@/components/icons/anthropic';
// import { OpenAI } from '@/components/icons/openai';
// import { Instrument_Serif } from 'next/font/google';

// // ============================================================================
// // Font
// // ============================================================================

// const serif = Instrument_Serif({
//   weight: '400',
//   style: ['normal', 'italic'],
//   subsets: ['latin'],
//   display: 'swap',
// });

// // ============================================================================
// // Premium easing (from reference)
// // ============================================================================

// const EASE_OUT = 'cubic-bezier(0.43, 0.195, 0.02, 1)';
// const EASE_SNAP = 'cubic-bezier(0.5, 0, 0, 1)';

// // ============================================================================
// // Scroll reveal
// // ============================================================================

// function useInView(opts?: IntersectionObserverInit) {
//   const ref = useRef<HTMLDivElement>(null);
//   const [inView, setInView] = useState(false);
//   useEffect(() => {
//     if (!ref.current || typeof IntersectionObserver === 'undefined') return;
//     const obs = new IntersectionObserver(
//       ([entry]) => {
//         if (entry.isIntersecting) {
//           setInView(true);
//           obs.disconnect();
//         }
//       },
//       { threshold: 0.08, ...opts },
//     );
//     obs.observe(ref.current);
//     return () => obs.disconnect();
//     // eslint-disable-next-line react-hooks/exhaustive-deps
//   }, []);
//   return { ref, inView };
// }

// function Reveal({
//   children,
//   className,
//   delay = 0,
// }: {
//   children: ReactNode;
//   className?: string;
//   delay?: number;
// }) {
//   const { ref, inView } = useInView();
//   return (
//     <div
//       ref={ref}
//       className={cn(className)}
//       style={{
//         transform: inView ? 'translateY(0)' : 'translateY(2rem)',
//         opacity: inView ? 1 : 0,
//         transition: `transform 0.8s ${EASE_OUT} ${delay}ms, opacity 0.8s ${EASE_OUT} ${delay}ms`,
//       }}
//     >
//       {children}
//     </div>
//   );
// }

// // ============================================================================
// // Animated line divider — grows from center on scroll
// // ============================================================================

// function LineDivider({ className }: { className?: string }) {
//   const { ref, inView } = useInView();
//   return (
//     <div ref={ref} className={cn('relative w-full overflow-hidden', className)}>
//       <div
//         className="h-px w-full origin-center"
//         style={{
//           background: 'var(--sand-border)',
//           transform: inView ? 'scaleX(1)' : 'scaleX(0)',
//           transition: `transform 1s ${EASE_SNAP}`,
//         }}
//       />
//     </div>
//   );
// }

// // ============================================================================
// // Section label — uppercase, tracked, muted
// // ============================================================================

// function SectionLabel({ children }: { children: ReactNode }) {
//   return (
//     <span
//       className="inline-block text-[11px] font-medium uppercase tracking-[0.2em] text-[var(--sand-text-muted)] mb-5"
//       style={{ letterSpacing: '0.2em' }}
//     >
//       {children}
//     </span>
//   );
// }

// // ============================================================================
// // Character-stagger button — text slides up on hover, shadow reveals copy
// // ============================================================================

// function StaggerButton({
//   text,
//   href,
//   className,
// }: {
//   text: string;
//   href: string;
//   className?: string;
// }) {
//   return (
//     <Link
//       href={href}
//       className={cn(
//         'group relative inline-flex items-center gap-2 overflow-hidden rounded-xl bg-[var(--sand-accent)] px-6 py-3 text-base font-medium shadow-lg',
//         className,
//       )}
//     >
//       <span className="relative flex overflow-hidden">
//         {text.split('').map((char, i) => (
//           <span
//             key={i}
//             className="inline-block transition-transform duration-300 group-hover:-translate-y-[1.5em]"
//             style={{
//               transitionDelay: `${i * 12}ms`,
//               transitionTimingFunction: 'ease',
//               textShadow: '0 1.5em 0 currentColor',
//               color: 'var(--sand-accent-contrast)',
//             }}
//           >
//             {char === ' ' ? '\u00A0' : char}
//           </span>
//         ))}
//       </span>
//       <ArrowRight
//         className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5"
//         style={{ color: 'var(--sand-accent-contrast)' }}
//       />
//     </Link>
//   );
// }

// // ============================================================================
// // Drop-in badge
// // ============================================================================

// function DropBadge({ children }: { children: ReactNode }) {
//   const [visible, setVisible] = useState(false);
//   useEffect(() => {
//     const t = setTimeout(() => setVisible(true), 600);
//     return () => clearTimeout(t);
//   }, []);
//   return (
//     <span
//       className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium"
//       style={{
//         background: 'color-mix(in oklab, var(--sand-accent) 8%, transparent)',
//         color: 'var(--sand-accent)',
//         transform: visible ? 'translateY(0)' : 'translateY(-100%)',
//         opacity: visible ? 1 : 0,
//         transition: `transform 0.4s ${EASE_OUT}, opacity 0.3s ${EASE_OUT}`,
//       }}
//     >
//       <span
//         className="h-1.5 w-1.5 rounded-full"
//         style={{ background: 'var(--sand-accent)' }}
//       />
//       {children}
//     </span>
//   );
// }

// // ============================================================================
// // Feature data
// // ============================================================================

// const features = [
//   {
//     icon: Bot,
//     title: 'AI agent that builds',
//     description:
//       'Describe your app in plain English. The agent writes code, creates database schemas, installs packages, and starts the dev server — autonomously.',
//   },
//   {
//     icon: Eye,
//     title: 'Live preview',
//     description:
//       'Watch your app update in real-time as the agent works. Switch between desktop, tablet, and mobile views instantly.',
//   },
//   {
//     icon: Database,
//     title: 'Real-time database',
//     description:
//       'Every project includes a Convex backend — real-time sync, serverless functions, and automatic scaling. Zero config.',
//   },
//   {
//     icon: Globe,
//     title: 'Deploy in one click',
//     description:
//       'Hit Publish and your app goes live on Cloudflare\'s global edge network. Shareable URL, instant.',
//   },
//   {
//     icon: Github,
//     title: 'GitHub built in',
//     description:
//       'Push to GitHub without leaving your workspace. Commit, push, pull — version control from the start.',
//   },
//   {
//     icon: Layers,
//     title: 'Your choice of AI',
//     description:
//       'Pick from GPT-5.3 Codex, Claude Opus, Claude Sonnet, and more. Use platform credits or bring your own keys.',
//   },
// ];

// // ============================================================================
// // Steps data
// // ============================================================================

// const steps = [
//   {
//     num: '01',
//     title: 'Describe what you want',
//     description:
//       'Type a prompt describing your app. Attach screenshots or mockups for reference. The more detail you provide, the better the result.',
//   },
//   {
//     num: '02',
//     title: 'Watch the agent build',
//     description:
//       'The AI agent writes code, deploys your backend, and starts a live preview. Follow along in real-time — or grab a coffee.',
//   },
//   {
//     num: '03',
//     title: 'Ship it',
//     description:
//       'Review the result, request changes via chat, and publish with one click. Your app is live on the web.',
//   },
// ];

// // ============================================================================
// // Main Page
// // ============================================================================

// export default function LandingV2() {
//   const router = useRouter();
//   const [prompt, setPrompt] = useState('');
//   const textareaRef = useRef<HTMLTextAreaElement>(null);

//   const handlePromptChange = useCallback(
//     (e: React.ChangeEvent<HTMLTextAreaElement>) => {
//       setPrompt(e.target.value);
//       const el = e.target;
//       el.style.height = 'auto';
//       el.style.height = Math.min(el.scrollHeight, 300) + 'px';
//     },
//     [],
//   );

//   const handleSend = useCallback(() => {
//     if (!prompt.trim()) return;
//     const params = new URLSearchParams({ prompt: prompt.trim() });
//     router.push(`/?${params.toString()}`);
//   }, [prompt, router]);

//   return (
//     <div className="antialiased text-[var(--sand-text)] bg-[var(--sand-bg)] min-h-screen">
//       {/* ================================================================ */}
//       {/* NAV                                                              */}
//       {/* ================================================================ */}
//       <header className="sticky top-0 z-50 backdrop-blur-lg bg-[var(--sand-bg)]/80">
//         <div className="mx-auto max-w-7xl px-4 sm:px-6 py-3">
//           <div className="flex items-center justify-between md:grid md:grid-cols-3">
//             <Link className="flex items-center gap-2.5" href="/">
//               {/* eslint-disable-next-line @next/next/no-img-element */}
//               <img src="/brand/botflow-glyph.svg" alt="" className="h-8 w-8" />
//               {/* eslint-disable-next-line @next/next/no-img-element */}
//               <img
//                 src="/brand/botflow-wordmark.svg"
//                 alt="Botflow"
//                 className="h-5 w-auto botflow-wordmark-invert"
//               />
//             </Link>

//             <nav className="hidden md:flex items-center justify-center gap-8 text-sm">
//               <SignedIn>
//                 <a href="/projects" className="font-medium hover:text-[var(--sand-accent)] transition">
//                   My Projects
//                 </a>
//               </SignedIn>
//               <a href="/pricing" className="font-medium hover:text-[var(--sand-accent)] transition">
//                 Pricing
//               </a>
//             </nav>

//             <div className="flex items-center justify-end gap-2">
//               <SignedOut>
//                 <Link
//                   href="/sign-in"
//                   className="hidden sm:inline-flex items-center rounded-xl border border-[var(--sand-border)] bg-[var(--sand-elevated)] px-3.5 py-2 text-sm font-medium shadow-sm hover:bg-[var(--sand-surface)] transition"
//                 >
//                   Log in
//                 </Link>
//                 <Link
//                   href="/sign-up"
//                   className="inline-flex items-center rounded-xl bg-[var(--sand-text)] text-[var(--sand-bg)] px-4 py-2 text-sm font-medium shadow-md hover:opacity-90 transition"
//                 >
//                   Get started
//                 </Link>
//               </SignedOut>
//               <SignedIn>
//                 <Link
//                   href="/projects"
//                   className="hidden sm:inline-flex items-center rounded-xl border border-[var(--sand-border)] bg-[var(--sand-elevated)] px-3.5 py-2 text-sm font-medium shadow-sm hover:bg-[var(--sand-surface)] transition"
//                 >
//                   Dashboard
//                 </Link>
//                 <UserButton afterSignOutUrl="/" />
//               </SignedIn>
//             </div>
//           </div>
//         </div>
//         {/* Animated nav bottom border */}
//         <div
//           className="h-px w-full origin-center"
//           style={{
//             background: 'var(--sand-border)',
//             animation: `lineGrowX 0.6s ${EASE_SNAP} forwards`,
//             opacity: 0.5,
//           }}
//         />
//         <style>{`@keyframes lineGrowX { from { transform: scaleX(0); } to { transform: scaleX(1); } }`}</style>
//       </header>

//       {/* ================================================================ */}
//       {/* HERO                                                             */}
//       {/* ================================================================ */}
//       <section className="relative overflow-hidden hero-grid">

//         <div className="mx-auto max-w-7xl px-4 sm:px-6 pt-16 sm:pt-24 pb-8 sm:pb-12">
//           <div className="max-w-3xl mx-auto text-center">
//             {/* Drop-in badge */}
//             <div className="mb-6 flex justify-center">
//               <DropBadge>AI-Powered Development</DropBadge>
//             </div>

//             {/* Headline */}
//             <Reveal>
//               <h1
//                 className={cn(
//                   serif.className,
//                   'text-5xl sm:text-6xl md:text-7xl lg:text-8xl tracking-tight leading-[1.05]',
//                 )}
//               >
//                 From idea to{' '}
//                 <span className="relative inline-block">
//                   <span style={{ color: 'var(--sand-accent)' }}>production</span>
//                   <span
//                     className="absolute -bottom-1 left-0 right-0 h-[3px] rounded-full origin-center"
//                     style={{
//                       background: 'var(--sand-accent)',
//                       opacity: 0.5,
//                       animation: `lineGrowX 0.8s ${EASE_SNAP} 0.5s both`,
//                     }}
//                     aria-hidden
//                   />
//                 </span>
//                 <br />
//                 in one conversation
//               </h1>
//             </Reveal>

//             {/* Subheading */}
//             <Reveal delay={150}>
//               <p className="mt-6 text-lg sm:text-xl text-[var(--sand-text-muted)] max-w-2xl mx-auto leading-relaxed">
//                 Botflow is an AI workspace that builds full-stack web apps from natural language.
//                 Describe what you want, watch the agent code it, and deploy — all without leaving your browser.
//               </p>
//             </Reveal>

//             {/* Prompt box */}
//             <Reveal delay={250}>
//               <div className="w-full mt-8">
//                 <div className="flex flex-col rounded-2xl sm:rounded-3xl border border-[var(--sand-border)] bg-[var(--sand-elevated)] backdrop-blur-sm shadow-[0_2px_0_rgba(0,0,0,0.02),0_20px_60px_-20px_rgba(0,0,0,0.18)]">
//                   <textarea
//                     ref={textareaRef}
//                     placeholder="Ask Botflow to create a web app that..."
//                     className="w-full bg-transparent px-4 sm:px-5 pt-3 sm:pt-4 pb-2 text-sm sm:text-lg text-[var(--sand-text)] placeholder-[var(--sand-text-muted)] outline-none resize-none overflow-y-auto modern-scrollbar"
//                     aria-label="Generation prompt"
//                     style={{ minHeight: 96, maxHeight: 300 }}
//                     maxLength={30000}
//                     value={prompt}
//                     onChange={handlePromptChange}
//                     onKeyDown={(e) => {
//                       if (e.key === 'Enter' && !e.shiftKey) {
//                         e.preventDefault();
//                         handleSend();
//                       }
//                     }}
//                   />
//                   <div className="flex items-center justify-between gap-2 px-2.5 sm:px-3 pb-2.5 sm:pb-3 pt-1">
//                     <div className="flex items-center gap-1.5 sm:gap-2">
//                       <button
//                         type="button"
//                         className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[var(--sand-border)] bg-[var(--sand-elevated)] shadow-sm hover:bg-[var(--sand-accent)]/10 transition"
//                         aria-label="Attach"
//                       >
//                         <Plus className="h-4 w-4" />
//                       </button>
//                       <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--sand-border)] bg-[var(--sand-elevated)] px-2.5 py-1.5 text-xs sm:text-sm font-medium shadow-sm">
//                         <Monitor className="h-3.5 w-3.5" />
//                         <span className="hidden sm:inline">Web</span>
//                       </span>
//                     </div>
//                     <SignedIn>
//                       <button
//                         onClick={handleSend}
//                         disabled={!prompt.trim()}
//                         className={cn(
//                           'shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--sand-text)] text-[var(--sand-bg)] shadow-md transition',
//                           !prompt.trim() ? 'opacity-40 cursor-not-allowed' : 'hover:opacity-80',
//                         )}
//                       >
//                         <ArrowUp className="h-5 w-5" />
//                       </button>
//                     </SignedIn>
//                     <SignedOut>
//                       <Link
//                         href="/sign-up"
//                         className="shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--sand-text)] text-[var(--sand-bg)] shadow-md hover:opacity-80 transition"
//                       >
//                         <ArrowUp className="h-5 w-5" />
//                       </Link>
//                     </SignedOut>
//                   </div>
//                 </div>
//               </div>
//             </Reveal>

//             {/* Provider pills */}
//             <Reveal delay={350}>
//               <div className="mt-4 flex flex-col items-center gap-3">
//                 <div className="flex items-center justify-center gap-2">
//                   <SignedOut>
//                     <Link
//                       href="/sign-up"
//                       className="inline-flex items-center gap-2 rounded-full border border-[var(--sand-border)] bg-[var(--sand-elevated)] px-3.5 py-1.5 text-sm font-medium shadow-sm hover:bg-[var(--sand-surface)] transition"
//                     >
//                       <Anthropic className="h-4 w-4 shrink-0" />
//                       Sign in with Claude
//                     </Link>
//                     <Link
//                       href="/sign-up"
//                       className="inline-flex items-center gap-2 rounded-full border border-[var(--sand-border)] bg-[var(--sand-elevated)] px-3.5 py-1.5 text-sm font-medium shadow-sm hover:bg-[var(--sand-surface)] transition"
//                     >
//                       <OpenAI className="h-4 w-4 shrink-0" />
//                       Sign in with ChatGPT
//                     </Link>
//                   </SignedOut>
//                   <SignedIn>
//                     <Link
//                       href="/projects"
//                       className="inline-flex items-center gap-2 rounded-full border border-[var(--sand-border)] bg-[var(--sand-elevated)] px-3.5 py-1.5 text-sm font-medium shadow-sm hover:bg-[var(--sand-surface)] transition"
//                     >
//                       Go to dashboard
//                       <ArrowRight className="h-3.5 w-3.5" />
//                     </Link>
//                   </SignedIn>
//                 </div>
//                 <p className="text-[var(--sand-text-muted)] text-sm leading-none flex items-center gap-0">
//                   Backend by
//                   <span className="inline-flex items-center align-middle -ml-3" style={{ height: '2.4em' }}>
//                     <Convex className="h-full w-auto opacity-60" />
//                   </span>
//                 </p>
//               </div>
//             </Reveal>
//           </div>
//         </div>

//         {/* HERO MOCKUP */}
//         <Reveal delay={450}>
//           <div className="mx-auto max-w-7xl px-4 sm:px-6 pb-16 sm:pb-24">
//             <WorkspaceMockup
//               messages={[
//                 {
//                   role: 'user',
//                   content:
//                     'Build me an event discovery app with a map, event cards, and category filters',
//                 },
//                 {
//                   role: 'assistant',
//                   content:
//                     "I'll create a modern event discovery app with interactive map, filterable cards, and location-based search.",
//                   toolCalls: [
//                     { name: 'writeFile', done: true },
//                     { name: 'writeFile', done: true },
//                     { name: 'writeFile', done: true },
//                     { name: 'writeFile', done: true },
//                     { name: 'convexDeploy', done: true },
//                     { name: 'startDevServer', done: true },
//                   ],
//                 },
//                 {
//                   role: 'assistant',
//                   content:
//                     'Your event discovery app is live! Browse events on the map or scroll through cards. Use the category filters to narrow results.',
//                 },
//                 {
//                   role: 'user',
//                   content: 'Add a favorites system so users can save events',
//                 },
//                 {
//                   role: 'assistant',
//                   content: 'Adding a favorites feature with heart toggle and a saved events tab.',
//                   toolCalls: [
//                     { name: 'readFile', done: true },
//                     { name: 'writeFile', done: true },
//                     { name: 'writeFile', done: false },
//                   ],
//                 },
//               ]}
//               previewSrc="/health.html"
//               creditPct={47}
//               agentWorking={true}
//               defaultView="preview"
//               className="shadow-[0_8px_60px_-12px_rgba(0,0,0,0.25)]"
//             />
//           </div>
//         </Reveal>
//       </section>

//       {/* ================================================================ */}
//       {/* FEATURES                                                         */}
//       {/* ================================================================ */}
//       <LineDivider />
//       <section className="relative">
//         <div className="mx-auto max-w-7xl px-4 sm:px-6 py-24 sm:py-32">
//           <Reveal>
//             <div className="text-center max-w-2xl mx-auto mb-16 sm:mb-20">
//               <SectionLabel>Features</SectionLabel>
//               <h2
//                 className={cn(
//                   serif.className,
//                   'text-4xl sm:text-5xl md:text-6xl tracking-tight',
//                 )}
//               >
//                 Everything you need{' '}
//                 <em className={serif.className}>to build</em>
//               </h2>
//               <p className="mt-4 text-lg text-[var(--sand-text-muted)] leading-relaxed">
//                 A complete development environment powered by AI. No setup, no config, no context-switching.
//               </p>
//             </div>
//           </Reveal>

//           {/* Feature grid with vertical dividers */}
//           <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-0">
//             {features.map((f, i) => (
//               <Reveal key={f.title} delay={i * 80}>
//                 <div
//                   className={cn(
//                     'group relative p-6 sm:p-8 transition-colors duration-300 hover:bg-[var(--sand-surface)]',
//                     // Right border for first two columns on lg
//                     i % 3 !== 2 && 'lg:border-r lg:border-[var(--sand-border)]',
//                     // Right border for first column on md (2-col)
//                     i % 2 === 0 && 'md:max-lg:border-r md:max-lg:border-[var(--sand-border)]',
//                     // Bottom border for all except last row
//                     i < 3 && 'lg:border-b lg:border-[var(--sand-border)]',
//                     i < 4 && 'md:max-lg:border-b md:max-lg:border-[var(--sand-border)]',
//                     'max-md:border-b max-md:border-[var(--sand-border)]',
//                     i === features.length - 1 && 'max-md:border-b-0',
//                   )}
//                 >
//                   {/* Accent top line on hover */}
//                   <div
//                     className="absolute top-0 left-6 right-6 h-px origin-center scale-x-0 group-hover:scale-x-100 transition-transform duration-500"
//                     style={{
//                       background: 'var(--sand-accent)',
//                       transitionTimingFunction: EASE_SNAP,
//                     }}
//                   />
//                   <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--sand-elevated)] border border-[var(--sand-border)] text-[var(--sand-text-muted)] group-hover:text-[var(--sand-accent)] group-hover:border-[var(--sand-accent)]/30 transition-colors duration-300">
//                     <f.icon className="h-5 w-5" />
//                   </div>
//                   <h3 className="text-lg font-semibold mb-2">{f.title}</h3>
//                   <p className="text-sm text-[var(--sand-text-muted)] leading-relaxed">
//                     {f.description}
//                   </p>
//                 </div>
//               </Reveal>
//             ))}
//           </div>
//         </div>
//       </section>

//       {/* ================================================================ */}
//       {/* HOW IT WORKS                                                     */}
//       {/* ================================================================ */}
//       <LineDivider />
//       <section className="relative bg-[var(--sand-surface)]">
//         <div className="mx-auto max-w-7xl px-4 sm:px-6 py-24 sm:py-32">
//           <Reveal>
//             <div className="text-center max-w-2xl mx-auto mb-16 sm:mb-20">
//               <SectionLabel>How it works</SectionLabel>
//               <h2
//                 className={cn(
//                   serif.className,
//                   'text-4xl sm:text-5xl md:text-6xl tracking-tight',
//                 )}
//               >
//                 Three steps.{' '}
//                 <em className={serif.className}>That&apos;s it.</em>
//               </h2>
//             </div>
//           </Reveal>

//           {/* Steps with vertical dividers */}
//           <div className="grid grid-cols-1 md:grid-cols-3 gap-0">
//             {steps.map((s, i) => (
//               <Reveal key={s.num} delay={i * 120}>
//                 <div
//                   className={cn(
//                     'relative px-6 sm:px-10 py-8 md:py-0',
//                     i < 2 && 'md:border-r md:border-[var(--sand-border)]',
//                     i < 2 && 'max-md:border-b max-md:border-[var(--sand-border)]',
//                   )}
//                 >
//                   <span
//                     className={cn(
//                       serif.className,
//                       'text-7xl sm:text-8xl font-normal leading-none select-none',
//                     )}
//                     style={{ color: 'var(--sand-accent)', opacity: 0.2 }}
//                   >
//                     {s.num}
//                   </span>
//                   <h3 className="text-xl font-semibold mt-2 mb-3">{s.title}</h3>
//                   <p className="text-[var(--sand-text-muted)] leading-relaxed">{s.description}</p>
//                 </div>
//               </Reveal>
//             ))}
//           </div>
//         </div>
//       </section>

//       {/* ================================================================ */}
//       {/* CODE VIEW SHOWCASE                                               */}
//       {/* ================================================================ */}
//       <LineDivider />
//       <section className="relative">
//         <div className="mx-auto max-w-7xl px-4 sm:px-6 py-24 sm:py-32">
//           <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center">
//             <Reveal>
//               <div>
//                 <SectionLabel>Development</SectionLabel>
//                 <h2
//                   className={cn(
//                     serif.className,
//                     'text-4xl sm:text-5xl tracking-tight',
//                   )}
//                 >
//                   A real IDE,
//                   <br />
//                   <em className={serif.className}>not a toy</em>
//                 </h2>
//                 <p className="mt-6 text-lg text-[var(--sand-text-muted)] leading-relaxed">
//                   Full file tree, Monaco code editor, integrated terminal, environment variables — everything you&apos;d expect from a professional development environment. The AI builds here, and so can you.
//                 </p>
//                 <ul className="mt-8 space-y-3">
//                   {[
//                     'Monaco editor with syntax highlighting',
//                     'Multi-tab terminal with shell access',
//                     'File search and environment variable management',
//                     'Download your project as a ZIP anytime',
//                   ].map((item) => (
//                     <li
//                       key={item}
//                       className="flex items-start gap-3 text-sm text-[var(--sand-text-muted)]"
//                     >
//                       <span
//                         className="mt-1.5 h-1.5 w-1.5 rounded-full shrink-0"
//                         style={{ background: 'var(--sand-accent)' }}
//                       />
//                       {item}
//                     </li>
//                   ))}
//                 </ul>
//               </div>
//             </Reveal>
//             <Reveal delay={150}>
//               <WorkspaceMockup
//                 messages={[
//                   {
//                     role: 'user',
//                     content: 'Add a dark mode toggle to the navigation',
//                   },
//                   {
//                     role: 'assistant',
//                     content:
//                       'Done! Added a theme toggle with smooth transitions and system preference detection.',
//                     toolCalls: [
//                       { name: 'readFile', done: true },
//                       { name: 'writeFile', done: true },
//                       { name: 'writeFile', done: true },
//                     ],
//                   },
//                 ]}
//                 creditPct={22}
//                 defaultView="code"
//                 agentWorking={false}
//                 modelName="Claude Sonnet 4.6"
//                 className="shadow-[0_8px_40px_-12px_rgba(0,0,0,0.2)]"
//               />
//             </Reveal>
//           </div>
//         </div>
//       </section>

//       {/* ================================================================ */}
//       {/* INTEGRATIONS                                                     */}
//       {/* ================================================================ */}
//       <LineDivider />
//       <section className="relative bg-[var(--sand-surface)]">
//         <div className="mx-auto max-w-7xl px-4 sm:px-6 py-24 sm:py-32">
//           <Reveal>
//             <div className="text-center max-w-2xl mx-auto mb-16 sm:mb-20">
//               <SectionLabel>Infrastructure</SectionLabel>
//               <h2
//                 className={cn(
//                   serif.className,
//                   'text-4xl sm:text-5xl md:text-6xl tracking-tight',
//                 )}
//               >
//                 Built on tools{' '}
//                 <em className={serif.className}>you trust</em>
//               </h2>
//               <p className="mt-4 text-lg text-[var(--sand-text-muted)] leading-relaxed">
//                 We didn&apos;t reinvent the wheel. Botflow integrates with best-in-class services so you own your code, your data, and your deployments.
//               </p>
//             </div>
//           </Reveal>

//           {/* Integration cards with dividers */}
//           <div className="grid grid-cols-1 md:grid-cols-3 gap-0 border border-[var(--sand-border)] rounded-2xl overflow-hidden">
//             {[
//               {
//                 logo: <Convex className="h-8 w-auto" />,
//                 name: 'Convex',
//                 desc: 'Real-time backend as a service. Serverless functions, document database, and automatic scaling.',
//               },
//               {
//                 logo: <Github className="h-8 w-8 text-[var(--sand-text)]" />,
//                 name: 'GitHub',
//                 desc: 'Version control and collaboration. Connect a repo, push commits, and pull updates from the workspace.',
//               },
//               {
//                 logo: (
//                   <div className="h-8 w-8 rounded-lg bg-[var(--sand-elevated)] border border-[var(--sand-border)] flex items-center justify-center">
//                     <Globe className="h-5 w-5 text-[var(--sand-accent)]" />
//                   </div>
//                 ),
//                 name: 'Cloudflare',
//                 desc: 'Global edge deployment. One-click publish via Cloudflare Pages — fast, reliable, and free to start.',
//               },
//             ].map((item, i) => (
//               <Reveal key={item.name} delay={i * 80}>
//                 <div
//                   className={cn(
//                     'p-8 text-center bg-[var(--sand-bg)]',
//                     i < 2 && 'md:border-r md:border-[var(--sand-border)]',
//                     i < 2 && 'max-md:border-b max-md:border-[var(--sand-border)]',
//                   )}
//                 >
//                   <div className="flex items-center justify-center h-10 mb-5">
//                     {item.logo}
//                   </div>
//                   <h3 className="text-lg font-semibold mb-2">{item.name}</h3>
//                   <p className="text-sm text-[var(--sand-text-muted)] leading-relaxed">
//                     {item.desc}
//                   </p>
//                 </div>
//               </Reveal>
//             ))}
//           </div>
//         </div>
//       </section>

//       {/* ================================================================ */}
//       {/* MODELS                                                           */}
//       {/* ================================================================ */}
//       <LineDivider />
//       <section className="relative">
//         <div className="mx-auto max-w-7xl px-4 sm:px-6 py-24 sm:py-32">
//           <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center">
//             <Reveal>
//               <div>
//                 <SectionLabel>AI Models</SectionLabel>
//                 <h2
//                   className={cn(
//                     serif.className,
//                     'text-4xl sm:text-5xl tracking-tight',
//                   )}
//                 >
//                   Pick your{' '}
//                   <span style={{ color: 'var(--sand-accent)' }}>engine</span>
//                 </h2>
//                 <p className="mt-6 text-lg text-[var(--sand-text-muted)] leading-relaxed">
//                   Different tasks, different models. Use a lightweight model for quick iterations, or bring in the heavyweights for complex features. Switch models mid-conversation — no restart needed.
//                 </p>
//               </div>
//             </Reveal>

//             <Reveal delay={100}>
//               <div className="space-y-2">
//                 {[
//                   { name: 'GPT-5.3 Codex', provider: 'OpenAI', badge: 'Popular', cost: 'x4' },
//                   { name: 'Claude Opus 4.6', provider: 'Anthropic', badge: 'Most capable', cost: 'x10' },
//                   { name: 'Claude Sonnet 4.6', provider: 'Anthropic', badge: '', cost: 'x5' },
//                   { name: 'GPT-5.4', provider: 'OpenAI', badge: '', cost: 'x6' },
//                   { name: 'MiniMax M2P5', provider: 'Fireworks', badge: 'Free tier', cost: 'x1' },
//                   { name: 'GLM-5', provider: 'Fireworks', badge: 'Free tier', cost: 'x2' },
//                 ].map((m) => (
//                   <div
//                     key={m.name}
//                     className="group flex items-center gap-4 rounded-xl border border-[var(--sand-border)] bg-[var(--sand-surface)] px-5 py-3.5 transition-all duration-300 hover:border-[var(--sand-accent)]/30 hover:bg-[var(--sand-elevated)]"
//                   >
//                     <div className="flex-1 min-w-0">
//                       <div className="flex items-center gap-2">
//                         <span className="font-medium text-sm">{m.name}</span>
//                         {m.badge && (
//                           <span
//                             className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded"
//                             style={{
//                               background: 'color-mix(in oklab, var(--sand-accent) 10%, transparent)',
//                               color: 'var(--sand-accent)',
//                             }}
//                           >
//                             {m.badge}
//                           </span>
//                         )}
//                       </div>
//                       <span className="text-xs text-[var(--sand-text-muted)]">{m.provider}</span>
//                     </div>
//                     <span className="text-xs font-mono text-[var(--sand-text-muted)] tabular-nums">
//                       {m.cost}
//                     </span>
//                   </div>
//                 ))}
//               </div>
//             </Reveal>
//           </div>
//         </div>
//       </section>

//       {/* ================================================================ */}
//       {/* SOCIAL PROOF / PLACEHOLDER                                       */}
//       {/* ================================================================ */}
//       <LineDivider />
//       <section className="relative bg-[var(--sand-surface)]">
//         <div className="mx-auto max-w-7xl px-4 sm:px-6 py-24 sm:py-32">
//           <Reveal>
//             <div className="text-center max-w-3xl mx-auto">
//               <SectionLabel>Showcase</SectionLabel>
//               <h2
//                 className={cn(
//                   serif.className,
//                   'text-3xl sm:text-4xl tracking-tight mb-10',
//                 )}
//               >
//                 What people are building
//               </h2>
//               <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
//                 {[1, 2, 3].map((n) => (
//                   <div
//                     key={n}
//                     className="aspect-[4/3] rounded-2xl border border-[var(--sand-border)] bg-[var(--sand-elevated)] flex items-center justify-center text-[var(--sand-text-muted)] text-sm"
//                   >
//                     {/* IMAGE PLACEHOLDER — Replace with project screenshot */}
//                     Project screenshot {n}
//                   </div>
//                 ))}
//               </div>
//             </div>
//           </Reveal>
//         </div>
//       </section>

//       {/* ================================================================ */}
//       {/* CTA                                                              */}
//       {/* ================================================================ */}
//       <LineDivider />
//       <section className="relative">
//         <div className="pointer-events-none absolute inset-0 -z-10 landing-gradient opacity-60" />
//         <div className="mx-auto max-w-7xl px-4 sm:px-6 py-28 sm:py-36">
//           <Reveal>
//             <div className="text-center max-w-2xl mx-auto">
//               <h2
//                 className={cn(
//                   serif.className,
//                   'text-4xl sm:text-5xl md:text-6xl tracking-tight',
//                 )}
//               >
//                 Ready to build{' '}
//                 <span style={{ color: 'var(--sand-accent)' }}>something</span>?
//               </h2>
//               <p className="mt-4 text-lg text-[var(--sand-text-muted)]">
//                 Start for free. No credit card required.
//               </p>
//               <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
//                 <StaggerButton text="Get started free" href="/sign-up" />
//                 <Link
//                   href="/pricing"
//                   className="inline-flex items-center gap-2 rounded-xl border border-[var(--sand-border)] bg-[var(--sand-elevated)] px-6 py-3 text-base font-medium shadow-sm hover:bg-[var(--sand-surface)] transition"
//                 >
//                   View pricing
//                 </Link>
//               </div>
//             </div>
//           </Reveal>
//         </div>
//       </section>

//       {/* ================================================================ */}
//       {/* FOOTER                                                           */}
//       {/* ================================================================ */}
//       <LineDivider />
//       <footer>
//         <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8">
//           <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
//             <div className="flex items-center gap-2.5">
//               {/* eslint-disable-next-line @next/next/no-img-element */}
//               <img src="/brand/botflow-glyph.svg" alt="" className="h-6 w-6" />
//               <span className="text-sm text-[var(--sand-text-muted)]">
//                 &copy; 2026 Botflow
//               </span>
//             </div>
//             <div className="flex items-center gap-6 text-sm text-[var(--sand-text-muted)]">
//               <a href="#" className="hover:text-[var(--sand-text)] transition">
//                 Privacy
//               </a>
//               <a href="#" className="hover:text-[var(--sand-text)] transition">
//                 Terms
//               </a>
//               <a href="#" className="hover:text-[var(--sand-text)] transition">
//                 Contact
//               </a>
//             </div>
//           </div>
//         </div>
//       </footer>
//     </div>
//   );
// }

'use client';

import { Input } from "@/components/ui/input";
import { useState, useEffect, useMemo, useRef, useCallback, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SignedIn, SignedOut, SignInButton, useUser } from '@clerk/nextjs';
import {
  ArrowUp,
  ArrowRight,
  Eye,
  Database,
  Github,
  Globe,
  Bot,
  Layers,
  Plus,
  Lock,
  ImagePlus,
  X as IconX,
  KeyRound,
  ChevronDown,
  Check,
  Slash,
} from 'lucide-react';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { useToast } from '@/components/ui/toast';
import { ModelSelector } from '@/components/ui/ModelSelector';
import { modelSupportsImages, resolveModelId, type ModelId } from '@/lib/agent/models';
import { processImageForUpload } from '@/lib/image-processing';
import { checkDeviceSupport } from '@/lib/device';
import { cn } from '@/lib/utils';
import { WorkspaceMockup } from '@/components/landing/WorkspaceMockup';
import { CardSpotlight } from '@/components/landing/CardSpotlight';
import { ModelCloud } from '@/components/landing/ModelCloud';
import { MobileFeatureGrid } from '@/components/landing/MobileFeatureGrid';
import { LandingFooter, LandingNav, MarginHatch, MarginBg } from '@/components/landing/shared';
import { LandingShowcase } from '@/components/showcase/LandingShowcase';
import { Convex } from '@/components/icons/convex';
import { Anthropic } from '@/components/icons/anthropic';
import { OpenAI } from '@/components/icons/openai';
import { Swift } from '@/components/icons/swift';
import { Instrument_Serif } from 'next/font/google';
import {
  isSwiftPlatformEnabled,
  normalizeProjectPlatform,
  type ProjectPlatform,
} from '@/lib/project-platform';

// ============================================================================
// Font
// ============================================================================

const serif = Instrument_Serif({
  weight: '400',
  style: ['normal', 'italic'],
  subsets: ['latin'],
  display: 'swap',
});

// ============================================================================
// Premium easing (from reference)
// ============================================================================

const EASE_OUT = 'cubic-bezier(0.43, 0.195, 0.02, 1)';
const EASE_SNAP = 'cubic-bezier(0.5, 0, 0, 1)';

// ============================================================================
// Scroll reveal
// ============================================================================

function useInView(opts?: IntersectionObserverInit) {
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

function Reveal({
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
// Animated line divider — grows from center on scroll
// ============================================================================

function LineDivider({ className }: { className?: string }) {
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
// Section label — uppercase, tracked, muted
// ============================================================================

function SectionLabel({ children }: { children: ReactNode }) {
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
// Character-stagger button — text slides up on hover, shadow reveals copy
// ============================================================================

function StaggerButton({
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
// Drop-in badge
// ============================================================================

function DropBadge({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 600);
    return () => clearTimeout(t);
  }, []);
  return (
    <span
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium"
      style={{
        background: 'color-mix(in oklab, var(--sand-accent) 8%, transparent)',
        color: 'var(--sand-accent)',
        transform: visible ? 'translateY(0)' : 'translateY(-100%)',
        opacity: visible ? 1 : 0,
        transition: `transform 0.4s ${EASE_OUT}, opacity 0.3s ${EASE_OUT}`,
      }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: 'var(--sand-accent)' }}
      />
      {children}
    </span>
  );
}

// ============================================================================
// Feature data
// ============================================================================

const features = [
  {
    icon: Bot,
    title: 'AI agent that builds',
    shortTitle: 'AI Agent',
    description:
      'Describe your app in plain English. The agent writes code, creates database schemas, installs packages, and starts the dev server — autonomously.',
  },
  {
    icon: Eye,
    title: 'Live preview',
    shortTitle: 'Preview',
    description:
      'Watch your app update in real-time as the agent works. Switch between desktop, tablet, and mobile views instantly.',
  },
  {
    icon: Database,
    title: 'Real-time database',
    shortTitle: 'Database',
    description:
      'Every project includes a Convex backend — real-time sync, serverless functions, and automatic scaling. Zero config.',
  },
  {
    icon: Globe,
    title: 'Deploy in one click',
    shortTitle: 'Deploy',
    description:
      'Hit Publish and your app goes live on Cloudflare\'s global edge network. Shareable URL, instant.',
  },
  {
    icon: Github,
    title: 'GitHub built in',
    shortTitle: 'GitHub',
    description:
      'Push to GitHub without leaving your workspace. Commit, push, pull — version control from the start.',
  },
  {
    icon: Layers,
    title: 'Your choice of AI',
    shortTitle: 'Models',
    description:
      'Pick from GPT-5.3 Codex, Claude Opus, Claude Sonnet, and more. Use platform credits or bring your own keys.',
  },
];

// ============================================================================
// Steps data
// ============================================================================

const steps = [
  {
    num: '01',
    title: 'Describe what you want',
    description:
      'Type a prompt describing your app. Attach screenshots or mockups for reference. The more detail you provide, the better the result.',
  },
  {
    num: '02',
    title: 'Watch the agent build',
    description:
      'The AI agent writes code, deploys your backend, and starts a live preview. Follow along in real-time — or grab a coffee.',
  },
  {
    num: '03',
    title: 'Ship it',
    description:
      'Review the result, request changes via chat, and publish with one click. Your app is live on the web.',
  },
];

// ============================================================================
// Editorial column grid — decorative structural lines (ported from component.gallery)
// Fixed overlay: 12-column grid, border-color lines at 1px gaps, fades top/bottom
// ============================================================================

// Fixed overlay drawing the two continuous margin boundary lines that run the
// full height of the page (left + right content edges), faded at top/bottom.
function EditorialGrid() {
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
        {/* Just the two margin boundary lines — left and right edges of the content area */}
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
// Main Page
// ============================================================================

interface LandingPendingImage {
  id: string;
  file: File;
  localUrl: string;
}

export default function LandingV2() {
  const router = useRouter();
  const { isSignedIn, user } = useUser();
  // Beta flag lives in Clerk publicMetadata, which already rides along on the
  // client user object — no extra fetch. Gates the Swift platform toggle below;
  // the projects API enforces the same rule server-side.
  const isBetaUser = (user?.publicMetadata as { isBeta?: boolean } | undefined)?.isBeta === true;
  const SWIFT_ORANGE = '#f46a13';
  const hasSwiftAccess = isSwiftPlatformEnabled() && isBetaUser;
  const [prompt, setPrompt] = useState('');
  const [platform, setPlatform] = useState<ProjectPlatform>('sandboxed-web');
  // Accent that frames the prompt box for the selected platform: neutral sand
  // for Web (1px), Swift orange and thicker (2px) when Swift is selected.
  const promptFrameColor = platform === 'swift' ? SWIFT_ORANGE : 'var(--sand-border)';
  const promptFrameWidth = platform === 'swift' ? 2 : 1;
  const [model, setModel] = useState<ModelId>('fireworks-kimi-k2p7');
  const { toast } = useToast();
  const [hasOpenAIKey, setHasOpenAIKey] = useState<boolean | null>(null);
  const [hasAnthropicKey, setHasAnthropicKey] = useState<boolean | null>(null);
  const [hasClaudeOAuth, setHasClaudeOAuth] = useState<boolean | null>(null);
  const [, setHasMoonshotKey] = useState<boolean | null>(null);
  const [hasCodexOAuth, setHasCodexOAuth] = useState<boolean | null>(null);
  const [hasFireworksKey, setHasFireworksKey] = useState<boolean | null>(null);
  const [userTier, setUserTier] = useState<'free' | 'pro' | 'max'>('free');
  const [hasConvexOAuth, setHasConvexOAuth] = useState<boolean | null>(null);
  const [convexBackendType, setConvexBackendType] = useState<'platform' | 'user' | 'none'>('platform');
  const [showConvexSelector, setShowConvexSelector] = useState(false);
  const [convexConnecting, setConvexConnecting] = useState(false);
  const convexSelectorRef = useRef<HTMLDivElement>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsDefaultTab, setSettingsDefaultTab] = useState<'usage' | 'connections' | 'subscription'>('usage');
  // Provider sign-in pills: signed-in users jump to the Connections settings tab
  // (to link Claude/ChatGPT); signed-out users are sent to login first.
  const handleProviderAuthClick = useCallback(() => {
    if (isSignedIn) {
      setSettingsDefaultTab('connections');
      setShowSettings(true);
    } else {
      router.push('/sign-in');
    }
  }, [isSignedIn, router]);
  const [showAuthDialog, setShowAuthDialog] = useState(false);
  const [projectStep, setProjectStep] = useState<null | 'convex' | 'name'>(null);
  const [projectQuotaLeft, setProjectQuotaLeft] = useState<number | null>(null);
  const [pendingImages, setPendingImages] = useState<LandingPendingImage[]>([]);
  const [showPlusPopover, setShowPlusPopover] = useState(false);
  const plusButtonRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [projectName, setProjectName] = useState('');
  const [pendingParams, setPendingParams] = useState<URLSearchParams | null>(null);
  const PENDING_PARAMS_KEY = 'huggable_pending_start_params';
  const PENDING_NAME_KEY = 'huggable_pending_project_name';
  const serverKeyModels = useMemo(() => new Set([
    'fireworks-minimax-m3', 'fireworks-glm-5p2', 'fireworks-kimi-k2p7',
    'gpt-5.3-codex', 'gpt-5.4', 'gpt-5.5', 'claude-sonnet-5', 'claude-sonnet-4.6', 'claude-opus-4.7', 'claude-opus-4-8',
  ]), []);
  const landingSignInModalAppearance = {
    elements: {
      modalContent: '!max-h-[90vh] !overflow-hidden',
      cardBox: '!max-h-[90vh] !overflow-y-auto !rounded-2xl !border !border-[var(--sand-border)] !bg-[var(--color-surface)] !shadow-xl',
      card: '!h-auto !max-h-none !overflow-visible !bg-transparent !border-0 !shadow-none !pb-4',
      footer: '!mt-2 !pt-2 !bg-transparent',
    },
  } as const;

  const canSend = useMemo(
    () => prompt.trim().length > 0 || pendingImages.length > 0,
    [prompt, pendingImages.length],
  );

  const providerAccess = useMemo(() => ({
    openai: hasCodexOAuth || hasOpenAIKey || null,
    anthropic: hasClaudeOAuth || hasAnthropicKey || null,
    fireworks: hasFireworksKey === true ? true : null,
  }), [hasCodexOAuth, hasOpenAIKey, hasClaudeOAuth, hasAnthropicKey, hasFireworksKey]);

  // Free users can't provision a Botflow-managed Convex backend unless the
  // global override flag is set. The /start route enforces the same rule
  // server-side; this flag is only used to gray out the option in the UI
  // and route the user to the upgrade tab on click.
  const managedBackendLocked =
    userTier === 'free' &&
    process.env.NEXT_PUBLIC_ALLOW_CLOUD_CONVEX_FOR_ALL !== 'true';

  const handlePromptChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setPrompt(e.target.value);
      const el = e.target;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 160) + 'px';
    },
    [],
  );

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    const newImages = await Promise.all(files.map(async (file) => {
      const processed = await processImageForUpload(file);
      return { id: crypto.randomUUID(), file: processed, localUrl: URL.createObjectURL(processed) };
    }));
    setPendingImages(prev => [...prev, ...newImages]);
  }, []);

  const handleRemoveImage = useCallback((id: string) => {
    setPendingImages(prev => {
      const img = prev.find(i => i.id === id);
      if (img) URL.revokeObjectURL(img.localUrl);
      return prev.filter(i => i.id !== id);
    });
  }, []);

  useEffect(() => {
    if (!showPlusPopover) return;
    const handler = (e: MouseEvent) => {
      if (plusButtonRef.current && !plusButtonRef.current.contains(e.target as Node)) {
        setShowPlusPopover(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPlusPopover]);

  const ensureModelKeyPresent = () => {
    if (serverKeyModels.has(model)) return true;
    const hasOpenAICreds = hasCodexOAuth || hasOpenAIKey;
    const keyChecks: Record<string, { hasKey: boolean | null; provider: string }> = {
      'gpt-5.3-codex': { hasKey: hasOpenAICreds, provider: 'OpenAI' },
    };
    const check = keyChecks[model];
    if (check?.hasKey === false) {
      toast({ title: 'Missing API key', description: `Please add your ${check.provider} API key in Settings.` });
      return false;
    }
    return true;
  };

  const start = (authed: boolean) => {
    const device = checkDeviceSupport();
    if (!device.supported) {
      toast({
        title: 'Device not supported',
        description: device.reason ?? 'Botflow is a desktop-only platform. Please use a desktop browser.',
      });
      return;
    }
    const params = new URLSearchParams();
    if (prompt.trim()) params.set('prompt', prompt.trim());
    params.set('visibility', 'public');
    params.set('platform', platform);
    params.set('model', model);
    const defaultName = prompt.trim() ? prompt.trim().slice(0, 48) : 'New Project';
    params.set('name', defaultName);
    setPendingParams(params);
    setProjectName(defaultName);
    if (typeof window !== 'undefined') {
      localStorage.setItem(PENDING_PARAMS_KEY, params.toString());
      localStorage.setItem(PENDING_NAME_KEY, defaultName);
    }
    if (!authed) {
      setShowAuthDialog(true);
      return;
    }
    const cloudForAll = process.env.NEXT_PUBLIC_ALLOW_CLOUD_CONVEX_FOR_ALL === 'true';
    // No-backend projects don't need Convex at all — skip the OAuth gate entirely.
    const needsConvexStep = convexBackendType !== 'none'
      && ((!cloudForAll && userTier === 'free') || convexBackendType === 'user')
      && !hasConvexOAuth;
    setProjectStep(needsConvexStep ? 'convex' : 'name');
  };

  const handleSend = useCallback(() => {
    start(Boolean(isSignedIn));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn, prompt, platform, model, userTier, convexBackendType, hasConvexOAuth, pendingImages.length]);

  const handleCreateProject = async () => {
    if (!pendingParams) return;
    if (!ensureModelKeyPresent()) return;
    const params = new URLSearchParams(pendingParams);
    const chosenName = projectName.trim() ? projectName.trim().slice(0, 48) : 'New Project';
    params.set('name', chosenName);
    setProjectStep(null);
    setPendingParams(null);
    if (typeof window !== 'undefined') {
      localStorage.removeItem(PENDING_PARAMS_KEY);
      localStorage.removeItem(PENDING_NAME_KEY);
    }
    if (convexBackendType === 'none' || params.get('backendType') === 'none') {
      params.set('backendType', 'none');
    } else if (convexBackendType === 'user' || params.get('backendType') === 'user') {
      params.set('backendType', 'user');
    }
    if (pendingImages.length > 0) {
      try {
        const imageParts = await Promise.all(
          pendingImages.map((img) =>
            new Promise<{ type: 'file'; mediaType: string; url: string; filename: string }>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve({
                type: 'file',
                mediaType: img.file.type || 'image/jpeg',
                url: reader.result as string,
                filename: img.file.name,
              });
              reader.onerror = reject;
              reader.readAsDataURL(img.file);
            })
          )
        );
        sessionStorage.setItem('botflow_pending_images', JSON.stringify(imageParts));
      } catch (err) {
        console.error('Failed to serialize images for workspace:', err);
      }
      pendingImages.forEach(img => URL.revokeObjectURL(img.localUrl));
      setPendingImages([]);
    }
    router.push(`/start?${params.toString()}`);
  };

  const closeAuthDialog = () => {
    setShowAuthDialog(false);
    setPendingParams(null);
    if (typeof window !== 'undefined') {
      localStorage.removeItem(PENDING_PARAMS_KEY);
      localStorage.removeItem(PENDING_NAME_KEY);
    }
  };

  const closeProjectModal = () => {
    setProjectStep(null);
    setPendingParams(null);
    if (typeof window !== 'undefined') {
      localStorage.removeItem(PENDING_PARAMS_KEY);
      localStorage.removeItem(PENDING_NAME_KEY);
    }
  };

  const saveBackendPreference = useCallback(async (pref: 'platform' | 'user' | 'none') => {
    // Defense in depth: ignore an attempt to pick the locked option.
    // The selector UI also gates this, but a stale render could slip through.
    if (
      pref === 'platform' &&
      userTier === 'free' &&
      process.env.NEXT_PUBLIC_ALLOW_CLOUD_CONVEX_FOR_ALL !== 'true'
    ) {
      return;
    }
    setConvexBackendType(pref);
    try {
      await fetch('/api/user-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ convexBackendPreference: pref }),
      });
    } catch {}
  }, [userTier]);

  const fetchUserSettings = useCallback(async () => {
    try {
      const [settingsRes, budgetRes] = await Promise.all([
        fetch('/api/user-settings'),
        fetch('/api/usage/budget'),
      ]);
      // Resolve tier first (it lives on the budget response) so the backend
      // selector below can downgrade 'platform' → 'none' for locked free users.
      let resolvedTier: 'free' | 'pro' | 'max' = 'free';
      let budgetData: { tier?: string; convexProjectsLeft?: number } | null = null;
      if (budgetRes.ok) {
        budgetData = await budgetRes.json();
        if (budgetData?.tier === 'pro' || budgetData?.tier === 'max') {
          resolvedTier = budgetData.tier;
        }
      }
      const cloudForAll = process.env.NEXT_PUBLIC_ALLOW_CLOUD_CONVEX_FOR_ALL === 'true';
      const platformLocked = resolvedTier === 'free' && !cloudForAll;
      if (settingsRes.ok) {
        const data = await settingsRes.json();
        setHasOpenAIKey(Boolean(data?.hasOpenAIKey));
        setHasAnthropicKey(Boolean(data?.hasAnthropicKey));
        setHasClaudeOAuth(Boolean(data?.hasClaudeOAuth));
        setHasCodexOAuth(Boolean(data?.hasCodexOAuth));
        setHasMoonshotKey(Boolean(data?.hasMoonshotKey));
        setHasFireworksKey(Boolean(data?.hasFireworksKey));
        setHasConvexOAuth(Boolean(data?.hasConvexOAuth));
        const pref = data?.convexBackendPreference as 'platform' | 'user' | 'none' | undefined;
        if (pref === 'none') {
          setConvexBackendType('none');
        } else if (pref === 'user' && data?.hasConvexOAuth) {
          setConvexBackendType('user');
        } else if (pref === 'platform' && !platformLocked) {
          setConvexBackendType('platform');
        } else if (platformLocked) {
          // Free user without flag: 'platform' is unavailable. Default to
          // 'none' (the path that always works). They can opt into BYOC by
          // connecting Convex from the selector.
          setConvexBackendType('none');
        } else if (!data?.hasConvexOAuth) {
          setConvexBackendType('platform');
        }
      }
      // Apply the tier we resolved up-front (we already consumed budgetRes
      // above to gate the backend-selector default).
      if (resolvedTier === 'pro' || resolvedTier === 'max') {
        setUserTier(resolvedTier);
      }
      if (budgetData && typeof budgetData.convexProjectsLeft === 'number') {
        setProjectQuotaLeft(budgetData.convexProjectsLeft);
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (!isSignedIn) {
      setHasOpenAIKey(null);
      setHasAnthropicKey(null);
      setHasMoonshotKey(null);
      setHasFireworksKey(null);
      setHasConvexOAuth(null);
      return;
    }
    void fetchUserSettings();
  }, [isSignedIn, fetchUserSettings]);

  useEffect(() => {
    const handler = () => { if (isSignedIn) void fetchUserSettings(); };
    window.addEventListener('settings-closed', handler);
    return () => window.removeEventListener('settings-closed', handler);
  }, [isSignedIn, fetchUserSettings]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const errorParam = params.get('error');
    if (errorParam) {
      params.delete('error');
      const newSearch = params.toString();
      window.history.replaceState({}, '', newSearch ? `/?${newSearch}` : '/');
      const errorMessages: Record<string, { title: string; description: string }> = {
        convex_not_connected: { title: 'Convex not connected', description: 'Please connect your Convex account before creating a BYOC project.' },
        convex_provision_failed: { title: 'Convex provisioning failed', description: 'Failed to create a Convex backend in your account. Please try again or check your Convex dashboard.' },
        convex_quota: { title: 'Convex project limit reached', description: 'Your Convex account has reached its project quota. Delete unused projects at dashboard.convex.dev or upgrade your Convex plan.' },
      };
      const errMsg = errorMessages[errorParam] ?? { title: 'Error', description: 'Something went wrong creating your project.' };
      toast(errMsg);
    }
    if (params.get('convex_connected') === '1') {
      setHasConvexOAuth(true);
      params.delete('convex_connected');
      const newSearch = params.toString();
      window.history.replaceState({}, '', newSearch ? `/?${newSearch}` : '/');
      void saveBackendPreference('user');
      const stored = localStorage.getItem(PENDING_PARAMS_KEY);
      if (stored) {
        const restoredParams = new URLSearchParams(stored);
        restoredParams.set('backendType', 'user');
        localStorage.setItem(PENDING_PARAMS_KEY, restoredParams.toString());
        const storedName = localStorage.getItem(PENDING_NAME_KEY) ?? 'New Project';
        setPendingParams(restoredParams);
        setProjectName(storedName);
        setProjectStep('name');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 'No Backend' is supported by platforms with a convex-less template variant:
  // web + sandboxed-web (plain Vite) and swift (plain swift vs. swift-convex).
  // Mobile/multiplatform have no such variant. If the user picked 'none' and
  // then switched to one of those, fall back to 'platform' to avoid creating a
  // project with a Convex template but `backendType: 'none'` (inconsistent).
  useEffect(() => {
    const supportsNoBackend =
      platform === 'web' || platform === 'sandboxed-web' || platform === 'swift';
    if (!supportsNoBackend && convexBackendType === 'none') {
      setConvexBackendType('platform');
    }
  }, [platform, convexBackendType]);

  useEffect(() => {
    if (!showConvexSelector) return;
    const handler = (e: MouseEvent) => {
      if (convexSelectorRef.current && !convexSelectorRef.current.contains(e.target as Node)) {
        setShowConvexSelector(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showConvexSelector]);

  const handleConnectConvex = async () => {
    setConvexConnecting(true);
    try {
      const res = await fetch('/api/oauth/convex/start?return_to=/');
      const data = await res.json();
      if (data.authUrl) {
        window.location.href = data.authUrl;
      }
    } catch {
      toast({ title: 'Error', description: 'Failed to start Convex authentication.' });
    } finally {
      setConvexConnecting(false);
    }
  };

  useEffect(() => {
    if (!pendingParams && typeof window !== 'undefined') {
      const storedParams = localStorage.getItem(PENDING_PARAMS_KEY);
      const storedName = localStorage.getItem(PENDING_NAME_KEY);
      if (storedParams) {
        setPendingParams(new URLSearchParams(storedParams));
        const storedParamsObj = new URLSearchParams(storedParams);
        const storedModel = storedParamsObj.get('model');
        const storedPlatform = storedParamsObj.get('platform');
        if (storedModel) {
          setModel(resolveModelId(storedModel));
        }
        if (storedPlatform) {
          // normalizeProjectPlatform coerces deprecated/unknown values to the
          // default sandbox platform and respects the Swift flag.
          setPlatform(normalizeProjectPlatform(storedPlatform));
        }
        if (storedName) setProjectName(storedName);
      }
    }
    if (isSignedIn && pendingParams) {
      setShowAuthDialog(false);
      const cloudForAll = process.env.NEXT_PUBLIC_ALLOW_CLOUD_CONVEX_FOR_ALL === 'true';
      const needsConvex = convexBackendType !== 'none'
        && ((!cloudForAll && userTier === 'free') || convexBackendType === 'user')
        && !hasConvexOAuth;
      setProjectStep(needsConvex ? 'convex' : 'name');
    }
  }, [isSignedIn, pendingParams, userTier, convexBackendType, hasConvexOAuth]);

  const orgJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Botflow',
    url: 'https://botflow.io',
    logo: 'https://botflow.io/brand/botflow-glyph.svg',
    description:
      'Botflow is an AI app builder that turns a chat prompt into a deployed full-stack web app.',
    // Add your social/profile URLs here so Google can disambiguate the Botflow
    // entity from other "Botflow" brands and tie them to this site (knowledge panel).
    sameAs: [],
  };

  const websiteJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Botflow',
    url: 'https://botflow.io',
    description:
      'Create full-stack web apps by chatting with AI. Botflow runs a real Node.js environment in your browser.',
  };

  const softwareAppJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Botflow',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Web',
    url: 'https://botflow.io',
    description:
      "Describe what you want and Botflow's AI writes the code, provisions the backend, and deploys it — a real full-stack web app, from one conversation.",
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
    },
    publisher: {
      '@type': 'Organization',
      name: 'Botflow',
      url: 'https://botflow.io',
    },
  };

  return (
    <>
    {/* JSON-LD rendered as plain <script> so it ships in the initial server HTML
        (next/script + afterInteractive only injected it client-side). */}
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(orgJsonLd) }}
    />
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd) }}
    />
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareAppJsonLd) }}
    />
    <div className="antialiased text-[var(--sand-text)] bg-[var(--sand-bg)] min-h-screen">
      <EditorialGrid />
      <LandingNav />

      {/* ================================================================ */}
      {/* HERO                                                             */}
      {/* ================================================================ */}
      <section
        className="relative overflow-hidden"
        /* hero-grid — ornamental background grid commented out */
      >

        <div className="mx-auto max-w-7xl px-4 sm:px-6 pt-16 sm:pt-24 pb-8 sm:pb-12">
          <div className="max-w-3xl mx-auto text-center">
            {/* Drop-in badge */}
            {/* <div className="mb-6 flex justify-center">
              <DropBadge>AI-Powered Development</DropBadge>
            </div> */}

            {/* Headline */}
            <Reveal>
              <h1
                className={cn(
                  serif.className,
                  'text-4xl sm:text-6xl md:text-7xl lg:text-8xl tracking-tight leading-[1.05]',
                )}
              >
                Build{' '}
                <span className="relative inline-block">
                  <span>full-stack apps</span>
                  <span
                    className="absolute bottom-2 left-0 right-0 h-[3px] rounded-full origin-center scale-x-95 ml-5"
                    style={{
                      background: 'var(--sand-font)',
                      opacity: 0.5,
                      animation: `lineGrowX 0.8s ${EASE_SNAP} 0.5s both`,
                    }}
                    aria-hidden
                  />
                </span>
                <br />
                by chatting with AI
              </h1>
            </Reveal>

            {/* Subheading */}
            <Reveal delay={150}>
              <p className="mt-6 text-lg sm:text-xl text-[var(--sand-text-muted)] max-w-3xl mx-auto leading-relaxed">
                From idea to production in one conversation — no setup, no deploys, just ship.
              </p>
            </Reveal>

            {/* Prompt box */}
            <Reveal delay={250} className="relative z-40">
              <div className="w-full mt-8">
                {/* Platform tabs — sit on top of the prompt box; the selected
                    tab's accent color frames the box. Web is the default; Swift
                    is gated to beta users (shows a lock until unlocked, then
                    lights up in Swift orange #f46a13). */}
                <div
                  className="flex items-end gap-1 pl-4 sm:pl-6 relative z-10"
                  style={{ marginBottom: -promptFrameWidth }}
                >
                  <button
                    type="button"
                    onClick={() => setPlatform('sandboxed-web')}
                    title="Build a web app"
                    className={cn(
                      'relative inline-flex items-center gap-1.5 rounded-t-xl px-3 sm:px-4 py-1.5 text-xs sm:text-sm font-medium transition',
                      platform !== 'swift'
                        ? 'bg-[var(--sand-elevated)] text-[var(--sand-text)]'
                        : 'bg-[var(--sand-surface)] text-[var(--sand-text-muted)] hover:text-[var(--sand-text)]',
                    )}
                    style={
                      platform !== 'swift'
                        ? {
                            borderColor: promptFrameColor,
                            borderTopWidth: promptFrameWidth,
                            borderLeftWidth: promptFrameWidth,
                            borderRightWidth: promptFrameWidth,
                            borderBottomWidth: 0,
                          }
                        : { borderColor: promptFrameColor, borderBottomWidth: promptFrameWidth }
                    }
                  >
                    <Globe className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                    Web
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (hasSwiftAccess) {
                        setPlatform('swift');
                      } else {
                        toast({
                          title: 'Swift is in private beta',
                          description:
                            'Native Swift apps are rolling out to beta users — access is coming soon.',
                        });
                      }
                    }}
                    aria-disabled={!hasSwiftAccess}
                    title={hasSwiftAccess ? 'Build a native Swift app' : 'Swift is in private beta'}
                    className={cn(
                      'relative inline-flex items-center gap-1.5 rounded-t-xl px-3 sm:px-4 py-1.5 text-xs sm:text-sm font-medium transition',
                      platform === 'swift'
                        ? 'bg-[var(--sand-elevated)]'
                        : 'bg-[var(--sand-surface)]',
                      platform !== 'swift' && !hasSwiftAccess && 'text-[var(--sand-text-muted)]',
                    )}
                    style={
                      platform === 'swift'
                        ? {
                            borderColor: SWIFT_ORANGE,
                            borderTopWidth: promptFrameWidth,
                            borderLeftWidth: promptFrameWidth,
                            borderRightWidth: promptFrameWidth,
                            borderBottomWidth: 0,
                            color: SWIFT_ORANGE,
                          }
                        : {
                            borderColor: promptFrameColor,
                            borderBottomWidth: promptFrameWidth,
                            ...(hasSwiftAccess ? { color: SWIFT_ORANGE } : {}),
                          }
                    }
                  >
                    <Swift className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                    Swift
                    {!hasSwiftAccess && (
                      <Lock className="h-3 w-3 sm:h-3.5 sm:w-3.5 opacity-90" />
                    )}
                  </button>
                </div>
                <div
                  className="flex flex-col rounded-2xl sm:rounded-3xl border bg-[var(--sand-elevated)] shadow-[0_2px_0_rgba(0,0,0,0.02),0_20px_60px_-20px_rgba(0,0,0,0.18)]"
                  style={{ borderColor: promptFrameColor, borderWidth: promptFrameWidth }}
                >
                  <textarea
                    ref={textareaRef}
                    placeholder="Ask Botflow to create a web app that..."
                    className="w-full bg-transparent px-4 sm:px-5 pt-3 sm:pt-4 pb-2 text-sm sm:text-lg text-[var(--sand-text)] placeholder-[var(--sand-text-muted)] outline-none resize-none overflow-y-auto modern-scrollbar text-left"
                    aria-label="Generation prompt"
                    style={{ minHeight: 96, maxHeight: 160 }}
                    maxLength={30000}
                    value={prompt}
                    onChange={handlePromptChange}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSend();
                      }
                    }}
                  />
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,.jpg,.jpeg,image/png,.png,image/webp,.webp"
                    multiple
                    className="hidden"
                    onChange={handleFileSelect}
                  />
                  <div className="flex flex-col gap-1 px-2.5 sm:px-3 pb-2.5 sm:pb-3 pt-1">
                    {pendingImages.length > 0 && (
                      <div className="flex gap-2 overflow-x-auto modern-scrollbar pb-1">
                        {pendingImages.map(img => (
                          <div key={img.id} className="relative group shrink-0">
                            <div className="w-10 h-10 rounded-lg border border-[var(--sand-border)] overflow-hidden">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={img.localUrl} alt={img.file.name} className="w-full h-full object-cover" />
                            </div>
                            <button
                              type="button"
                              onClick={() => handleRemoveImage(img.id)}
                              className="absolute -top-1.5 -right-1.5 flex items-center justify-center size-4 rounded-full bg-[var(--sand-elevated)] border border-[var(--sand-border)] text-[var(--sand-text-muted)] hover:text-[var(--sand-text)] opacity-0 group-hover:opacity-100 transition-opacity"
                              aria-label="Remove image"
                            >
                              <IconX size={10} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-1.5 sm:gap-2">
                      <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                        <div ref={plusButtonRef} className="relative shrink-0">
                          <button
                            type="button"
                            onClick={() => setShowPlusPopover(v => !v)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[var(--sand-border)] bg-[var(--sand-elevated)] shadow-sm hover:border-transparent hover:bg-[var(--sand-accent)]/15 transition"
                            aria-label="Attach"
                          >
                            <Plus className="h-4 w-4 text-[var(--sand-text)]" />
                          </button>
                          {showPlusPopover && (
                            <div className="absolute bottom-full mb-2 left-0 w-44 rounded-xl border border-[var(--sand-border)] bg-[var(--sand-surface)] shadow-lg overflow-hidden z-20">
                              <button
                                type="button"
                                onClick={() => { setShowPlusPopover(false); fileInputRef.current?.click(); }}
                                disabled={!modelSupportsImages(model)}
                                className={cn(
                                  'flex w-full items-center gap-2.5 px-3 py-2 text-sm transition',
                                  modelSupportsImages(model)
                                    ? 'text-[var(--sand-text)] hover:bg-[var(--sand-elevated)] cursor-pointer'
                                    : 'text-[var(--sand-text-muted)] cursor-not-allowed',
                                )}
                              >
                                <ImagePlus size={15} className="shrink-0" />
                                <span>Attach image</span>
                              </button>
                            </div>
                          )}
                        </div>
                        <ModelSelector
                          value={model}
                          onChange={setModel}
                          providerAccess={providerAccess}
                          userTier={userTier}
                          size="md"
                          openDirection="up"
                          onTierLocked={() => {
                            toast({
                              title: 'Plan required',
                              description: 'This model requires a Pro or Max plan. Upgrade or add your own API key in Settings.',
                            });
                          }}
                        />
                        {/* The backend selector is meaningful for platforms with a
                            no-backend template variant: web + sandboxed-web (plain Vite)
                            and swift (plain swift vs. swift-convex). Mobile/multiplatform
                            always include Convex, so the selector stays hidden there. */}
                        {isSignedIn && (platform === 'web' || platform === 'sandboxed-web' || platform === 'swift') && (
                          <div ref={convexSelectorRef} className="relative shrink-0">
                            <button
                              type="button"
                              onClick={() => setShowConvexSelector(v => !v)}
                              className="shrink-0 inline-flex items-center gap-1.5 sm:gap-2 rounded-full border border-[var(--sand-border)] bg-[var(--sand-elevated)] px-2.5 sm:px-3 py-1.5 text-xs sm:text-sm font-medium text-[var(--sand-text)] shadow-sm hover:border-transparent hover:bg-[var(--sand-accent)]/15 transition"
                              title="Backend type"
                            >
                              {convexBackendType === 'platform' ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src="/convex-color.svg" className="h-3.5 w-3.5" alt="" />
                              ) : convexBackendType === 'user' ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src="/convex-white.svg" className="h-3.5 w-3.5" alt="" />
                              ) : (
                                <Slash className="h-3.5 w-3.5" />
                              )}
                              <span className="hidden sm:inline">
                                {convexBackendType === 'platform'
                                  ? 'Managed'
                                  : convexBackendType === 'user'
                                  ? 'Your Convex'
                                  : 'No Backend'}
                              </span>
                              <ChevronDown className="h-3 w-3 opacity-60" />
                            </button>
                            {showConvexSelector && (
                              <div className="absolute bottom-full mb-2 left-0 w-60 rounded-xl border border-[var(--sand-border)] bg-[var(--sand-surface)] shadow-lg overflow-hidden z-20">
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (managedBackendLocked) {
                                      toast({
                                        title: 'Pro plan required',
                                        description: 'Botflow-managed Convex is included on Pro and Max. Free projects can use Bring Your Own Convex or No Backend.',
                                      });
                                      setSettingsDefaultTab('subscription');
                                      setShowSettings(true);
                                      setShowConvexSelector(false);
                                      return;
                                    }
                                    void saveBackendPreference('platform');
                                    setShowConvexSelector(false);
                                  }}
                                  className={cn(
                                    'flex w-full items-start gap-2.5 px-3 py-2.5 text-sm transition text-left',
                                    convexBackendType === 'platform' ? 'bg-[var(--sand-elevated)]' : 'hover:bg-[var(--sand-elevated)]',
                                    managedBackendLocked && 'opacity-60',
                                  )}
                                >
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src="/convex-color.svg" className={cn('h-4 w-4 mt-0.5 shrink-0', managedBackendLocked && 'grayscale')} alt="" />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1.5 font-medium text-[var(--sand-text)]">
                                      <span>Botflow Managed</span>
                                      {managedBackendLocked && (
                                        <span className="inline-flex items-center rounded-full bg-[var(--sand-accent)]/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--sand-text)]">
                                          Pro
                                        </span>
                                      )}
                                    </div>
                                    <div className="text-xs text-[var(--sand-text-muted)] mt-0.5">
                                      {managedBackendLocked
                                        ? 'Upgrade to Pro for managed Convex'
                                        : 'We handle infrastructure & scaling'}
                                    </div>
                                  </div>
                                  {convexBackendType === 'platform' && !managedBackendLocked && (
                                    <Check className="h-4 w-4 text-[var(--sand-text)] ml-auto mt-0.5 shrink-0" />
                                  )}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => { void saveBackendPreference('user'); setShowConvexSelector(false); }}
                                  className={cn(
                                    'flex w-full items-start gap-2.5 px-3 py-2.5 text-sm transition text-left border-t border-[var(--sand-border)]',
                                    convexBackendType === 'user' ? 'bg-[var(--sand-elevated)]' : 'hover:bg-[var(--sand-elevated)]',
                                  )}
                                >
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src="/convex-white.svg" className="h-4 w-4 mt-0.5 shrink-0" alt="" />
                                  <div>
                                    <div className="font-medium text-[var(--sand-text)]">Bring Your Own Convex</div>
                                    <div className="text-xs text-[var(--sand-text-muted)] mt-0.5">Will require authentication</div>
                                  </div>
                                  {convexBackendType === 'user' && <Check className="h-4 w-4 text-[var(--sand-text)] ml-auto mt-0.5 shrink-0" />}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => { void saveBackendPreference('none'); setShowConvexSelector(false); }}
                                  className={cn(
                                    'flex w-full items-start gap-2.5 px-3 py-2.5 text-sm transition text-left border-t border-[var(--sand-border)]',
                                    convexBackendType === 'none' ? 'bg-[var(--sand-elevated)]' : 'hover:bg-[var(--sand-elevated)]',
                                  )}
                                >
                                  <Slash className="h-4 w-4 mt-0.5 shrink-0 text-[var(--sand-text)]" />
                                  <div>
                                    <div className="font-medium text-[var(--sand-text)]">No Backend</div>
                                    <div className="text-xs text-[var(--sand-text-muted)] mt-0.5">Frontend only — no database, no functions</div>
                                  </div>
                                  {convexBackendType === 'none' && <Check className="h-4 w-4 text-[var(--sand-text)] ml-auto mt-0.5 shrink-0" />}
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      <SignedIn>
                        <button
                          onClick={() => start(true)}
                          disabled={!canSend}
                          className={cn(
                            'shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--sand-text)] text-[var(--sand-bg)] shadow-md transition',
                            !canSend ? 'opacity-40 cursor-not-allowed' : 'hover:opacity-80',
                          )}
                        >
                          <ArrowUp className="h-5 w-5" />
                        </button>
                      </SignedIn>
                      <SignedOut>
                        <button
                          onClick={() => start(false)}
                          className="shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--sand-text)] text-[var(--sand-bg)] shadow-md hover:opacity-80 transition"
                        >
                          <ArrowUp className="h-5 w-5" />
                        </button>
                      </SignedOut>
                    </div>
                  </div>
                </div>
              </div>
            </Reveal>

            {/* Provider pills */}
            <Reveal delay={350}>
              <div className="mt-4 flex flex-col items-center gap-3">
                <div className="flex flex-col min-[390px]:flex-row items-center justify-center gap-2">
                  {process.env.NEXT_PUBLIC_ANTHROPIC_OAUTH_ENABLED === 'true' && (
                    <button
                      type="button"
                      onClick={handleProviderAuthClick}
                      className="inline-flex cursor-pointer items-center gap-1.5 sm:gap-2 whitespace-nowrap rounded-full border border-[var(--sand-border)] bg-[var(--sand-elevated)] px-3 sm:px-3.5 py-1.5 text-[13px] sm:text-sm font-medium shadow-sm hover:bg-[var(--sand-surface)] transition"
                    >
                      <Anthropic className="h-4 w-4 shrink-0" />
                      Sign in with Claude
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleProviderAuthClick}
                    className="inline-flex cursor-pointer items-center gap-1.5 sm:gap-2 whitespace-nowrap rounded-full border border-[var(--sand-border)] bg-[var(--sand-elevated)] px-3 sm:px-3.5 py-1.5 text-[13px] sm:text-sm font-medium shadow-sm hover:bg-[var(--sand-surface)] transition"
                  >
                    <OpenAI className="h-4 w-4 shrink-0" />
                    Sign in with ChatGPT
                  </button>
                </div>


                {/* <p className="text-[var(--sand-text-muted)] text-sm leading-none flex items-center gap-0">
                  Backend by
                  <span className="inline-flex items-center align-middle -ml-3" style={{ height: '2.4em' }}>
                    <Convex className="h-full w-auto opacity-60" />
                  </span>
                </p> */}
                
                <p className="text-center text-[var(--sand-text)] text-sm sm:text-lg leading-none mt-2 opacity-75">
                Backend by{" "}
                  <span className="inline-flex items-center align-middle -ml-3" style={{ height: "2.8em" }}>
                    <Convex className="h-full w-auto opacity-75" />
                  </span>
                </p>


              </div>
            </Reveal>
          </div>
        </div>

        {/* HERO MOCKUP — hidden on mobile, not enough room to render well */}
        <Reveal delay={450} className="hidden md:block">
          <div className="mx-auto max-w-7xl px-6 sm:px-8 pb-16 sm:pb-24">
            <WorkspaceMockup
              messages={[
                {
                  role: 'user',
                  content:
                    'Build me Flowsync — a finance dashboard SaaS landing page. Dark, premium feel with a 3D hero visual, multi-currency account cards, a recent transactions feed, and a smart forecasting section.',
                },
                {
                  role: 'assistant',
                  content:
                    "I'll build the Flowsync landing page: a Three.js hero, USD/EUR account cards, a live transactions feed, and an AI forecasting panel.",
                  toolCalls: [
                    { name: 'writeFile', done: true },
                    { name: 'writeFile', done: true },
                    { name: 'writeFile', done: true },
                    { name: 'writeFile', done: true },
                    { name: 'convexDeploy', done: true },
                    { name: 'startDevServer', done: true },
                  ],
                },
                {
                  role: 'assistant',
                  content:
                    'Flowsync is live — the 3D hero animates on load, and the dashboard shows account balances with a recent activity log.',
                },
                {
                  role: 'user',
                  content: "Add a testimonials section with finance leaders, and a ‘Book a Free Demo’ CTA.",
                },
                {
                  role: 'assistant',
                  content: "Adding a ‘Loved by finance teams’ testimonials grid and a Book a Free Demo call-to-action.",
                  toolCalls: [
                    { name: 'readFile', done: true },
                    { name: 'writeFile', done: true },
                    { name: 'writeFile', done: false },
                  ],
                },
              ]}
              previewSrc="https://bf-28ba0c04.pages.dev"
              creditPct={47}
              agentWorking={true}
              defaultView="preview"
              modelName="Claude Opus 4.8"
              className="shadow-[0_8px_60px_-12px_rgba(0,0,0,0.25)]"
            />
          </div>
        </Reveal>
      </section>

      {/* ================================================================ */}
      {/* FEATURES                                                         */}
      {/* ================================================================ */}
      <LineDivider />
      <section className="relative">
        <MarginHatch />
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-24 sm:py-32">
          <Reveal>
            <div className="text-center max-w-2xl mx-auto mb-16 sm:mb-20">
              <SectionLabel>Features</SectionLabel>
              <h2
                className={cn(
                  serif.className,
                  'text-4xl sm:text-5xl md:text-6xl tracking-tight',
                )}
              >
                Everything you need{' '}
                <em className={serif.className}>to build</em>
              </h2>
              <p className="mt-4 text-lg text-[var(--sand-text-muted)] leading-relaxed">
                A complete development environment powered by AI. No setup, no config, no context-switching.
              </p>
            </div>
          </Reveal>

          {/* Mobile: interactive 2x3 glyph grid */}
          <div className="md:hidden">
            <Reveal>
              <MobileFeatureGrid features={features} />
            </Reveal>
          </div>

          {/* Desktop/tablet: full feature grid with vertical dividers */}
          <div className="hidden md:grid md:grid-cols-2 lg:grid-cols-3 gap-0">
            {features.map((f, i) => (
              <Reveal key={f.title} delay={i * 80}>
                <div
                  className={cn(
                    'group relative p-6 sm:p-8 transition-colors duration-300 hover:bg-[var(--sand-surface)]',
                    // Right border for first two columns on lg
                    i % 3 !== 2 && 'lg:border-r lg:border-[var(--sand-border)]',
                    // Right border for first column on md (2-col)
                    i % 2 === 0 && 'md:max-lg:border-r md:max-lg:border-[var(--sand-border)]',
                    // Bottom border for all except last row
                    i < 3 && 'lg:border-b lg:border-[var(--sand-border)]',
                    i < 4 && 'md:max-lg:border-b md:max-lg:border-[var(--sand-border)]',
                  )}
                >
                  <CardSpotlight />
                  {/* Accent top line on hover */}
                  <div
                    className="absolute top-0 left-6 right-6 h-px origin-center scale-x-0 group-hover:scale-x-100 transition-transform duration-500 z-10"
                    style={{
                      background: 'var(--sand-accent)',
                      transitionTimingFunction: EASE_SNAP,
                    }}
                  />
                  <div className="relative z-10 mb-4 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--sand-elevated)] border border-[var(--sand-border)] text-[var(--sand-text-muted)] group-hover:text-[var(--sand-accent)] group-hover:border-[var(--sand-accent)]/30 transition-colors duration-300">
                    <f.icon className="h-5 w-5" />
                  </div>
                  <h3 className="relative z-10 text-lg font-semibold mb-2">{f.title}</h3>
                  <p className="relative z-10 text-sm text-[var(--sand-text-muted)] leading-relaxed">
                    {f.description}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ================================================================ */}
      {/* HOW IT WORKS                                                     */}
      {/* ================================================================ */}
      <LineDivider />
      <section className="relative bg-[var(--sand-surface)]">
        <MarginBg />
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-24 sm:py-32">
          <Reveal>
            <div className="text-center max-w-2xl mx-auto mb-16 sm:mb-20">
              <SectionLabel>How it works</SectionLabel>
              <h2
                className={cn(
                  serif.className,
                  'text-4xl sm:text-5xl md:text-6xl tracking-tight',
                )}
              >
                Three steps.{' '}
                <em className={serif.className}>That&apos;s it.</em>
              </h2>
            </div>
          </Reveal>

          {/* Steps with vertical dividers */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-0">
            {steps.map((s, i) => (
              <Reveal key={s.num} delay={i * 120}>
                <div
                  className={cn(
                    'group relative px-6 sm:px-10 py-8 md:py-10 transition-colors duration-300 hover:bg-[var(--sand-surface)]',
                    i < 2 && 'md:border-r md:border-[var(--sand-border)]',
                    i < 2 && 'max-md:border-b max-md:border-[var(--sand-border)]',
                  )}
                >
                  <CardSpotlight />
                  <span
                    className={cn(
                      serif.className,
                      'relative z-10 block text-7xl sm:text-8xl font-normal leading-none select-none',
                    )}
                    style={{ color: 'var(--sand-accent)', opacity: 0.32 }}
                  >
                    {s.num}
                  </span>
                  <h3 className="relative z-10 text-xl font-semibold mt-2 mb-3">{s.title}</h3>
                  <p className="relative z-10 text-[var(--sand-text-muted)] leading-relaxed">{s.description}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ================================================================ */}
      {/* CODE VIEW SHOWCASE                                               */}
      {/* ================================================================ */}
      {/* <LineDivider />
      <section className="relative">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-24 sm:py-32">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center">
            <Reveal>
              <div>
                <SectionLabel>Development</SectionLabel>
                <h2
                  className={cn(
                    serif.className,
                    'text-4xl sm:text-5xl tracking-tight',
                  )}
                >
                  A real IDE,
                  <br />
                  <em className={serif.className}>not a toy</em>
                </h2>
                <p className="mt-6 text-lg text-[var(--sand-text-muted)] leading-relaxed">
                  Full file tree, Monaco code editor, integrated terminal, environment variables — everything you&apos;d expect from a professional development environment. The AI builds here, and so can you.
                </p>
                <ul className="mt-8 space-y-3">
                  {[
                    'Monaco editor with syntax highlighting',
                    'Multi-tab terminal with shell access',
                    'File search and environment variable management',
                    'Download your project as a ZIP anytime',
                  ].map((item) => (
                    <li
                      key={item}
                      className="flex items-start gap-3 text-sm text-[var(--sand-text-muted)]"
                    >
                      <span
                        className="mt-1.5 h-1.5 w-1.5 rounded-full shrink-0"
                        style={{ background: 'var(--sand-accent)' }}
                      />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
            <Reveal delay={150}>
              <WorkspaceMockup
                messages={[
                  {
                    role: 'user',
                    content: 'Add a dark mode toggle to the navigation',
                  },
                  {
                    role: 'assistant',
                    content:
                      'Done! Added a theme toggle with smooth transitions and system preference detection.',
                    toolCalls: [
                      { name: 'readFile', done: true },
                      { name: 'writeFile', done: true },
                      { name: 'writeFile', done: true },
                    ],
                  },
                ]}
                creditPct={22}
                defaultView="code"
                agentWorking={false}
                modelName="Claude Sonnet 5"
                className="shadow-[0_8px_40px_-12px_rgba(0,0,0,0.2)]"
              />
            </Reveal>
          </div>
        </div>
      </section> */}

      {/* ================================================================ */}
      {/* INTEGRATIONS                                                     */}
      {/* ================================================================ */}
      <LineDivider />
      {/* <section className="relative bg-[var(--sand-surface)]">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-24 sm:py-32">
          <Reveal>
            <div className="text-center max-w-2xl mx-auto mb-16 sm:mb-20">
              <SectionLabel>Infrastructure</SectionLabel>
              <h2
                className={cn(
                  serif.className,
                  'text-4xl sm:text-5xl md:text-6xl tracking-tight',
                )}
              >
                Built on tools{' '}
                <em className={serif.className}>you trust</em>
              </h2>
              <p className="mt-4 text-lg text-[var(--sand-text-muted)] leading-relaxed">
                We didn&apos;t reinvent the wheel. Botflow integrates with best-in-class services so you own your code, your data, and your deployments.
              </p>
            </div>
          </Reveal>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-0 border border-[var(--sand-border)] rounded-2xl overflow-hidden">
            {[
              {
                logo: <Convex className="h-16 w-auto" />,
                name: 'Convex',
                desc: 'Real-time backend as a service. Serverless functions, document database, and automatic scaling.',
              },
              {
                logo: <Github className="h-8 w-8 text-[var(--sand-text)]" />,
                name: 'GitHub',
                desc: 'Version control and collaboration. Connect a repo, push commits, and pull updates from the workspace.',
              },
              {
                logo: (
                  <div className="h-8 w-8 rounded-lg bg-[var(--sand-elevated)] border border-[var(--sand-border)] flex items-center justify-center">
                    <Globe className="h-5 w-5 text-[var(--sand-accent)]" />
                  </div>
                ),
                name: 'Cloudflare',
                desc: 'Global edge deployment. One-click publish via Cloudflare Pages — fast, reliable, and free to start.',
              },
            ].map((item, i) => (
              <Reveal key={item.name} delay={i * 80}>
                <div
                  className={cn(
                    'p-8 text-center bg-[var(--sand-bg)]',
                    i < 2 && 'md:border-r md:border-[var(--sand-border)]',
                    i < 2 && 'max-md:border-b max-md:border-[var(--sand-border)]',
                  )}
                >
                  <div className="flex items-center justify-center h-10 mb-5">
                    {item.logo}
                  </div>
                  <h3 className="text-lg font-semibold mb-2">{item.name}</h3>
                  <p className="text-sm text-[var(--sand-text-muted)] leading-relaxed">
                    {item.desc}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section> */}

      {/* ================================================================ */}
      {/* MODELS                                                           */}
      {/* ================================================================ */}
      <LineDivider />
      <section className="relative">
        <MarginHatch />
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-24 sm:py-32">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center">
            {/* <Reveal className='max-md:px-4'> */}
            <Reveal className='px-4'>
              <div>
                <SectionLabel>AI Models</SectionLabel>
                <h2
                  className={cn(
                    serif.className,
                    'text-4xl sm:text-5xl tracking-tight',
                  )}
                >
                  Pick your{' '}
                  <span style={{ color: 'var(--sand-accent)' }}>engine</span>
                </h2>
                <p className="mt-6 text-lg text-[var(--sand-text-muted)] leading-relaxed">
                  Different tasks, different models. Use a lightweight model for quick iterations, or bring in the heavyweights for complex features. Switch models mid-conversation — no restart needed.
                </p>
              </div>
            </Reveal>

            <Reveal delay={100}>
              <ModelCloud />
            </Reveal>
          </div>
        </div>
      </section>

      {/* ================================================================ */}
      {/* SOCIAL PROOF / PLACEHOLDER                                       */}
      {/* ================================================================ */}
      {process.env.NEXT_PUBLIC_HIDE_EXPLORE !== 'true' && (
        <>
          <LineDivider />
          <section className="relative bg-[var(--sand-surface)]">
            <MarginBg />
            <div className="mx-auto max-w-7xl px-4 sm:px-6 py-24 sm:py-32">
              <Reveal>
                <div className="text-center max-w-4xl mx-auto">
                  <SectionLabel>Showcase</SectionLabel>
                  <h2
                    className={cn(
                      serif.className,
                      'text-3xl sm:text-4xl tracking-tight mb-10',
                    )}
                  >
                    What people are building
                  </h2>
                  <LandingShowcase />
                </div>
              </Reveal>
            </div>
          </section>
        </>
      )}

      {/* ================================================================ */}
      {/* CTA                                                              */}
      {/* ================================================================ */}
      <LineDivider />
      <section className="relative">
        <MarginHatch />
        <div className="pointer-events-none absolute inset-0 -z-10 landing-gradient opacity-60" />
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-28 sm:py-36">
          <Reveal>
            <div className="text-center max-w-2xl mx-auto">
              <h2
                className={cn(
                  serif.className,
                  'text-4xl sm:text-5xl md:text-6xl tracking-tight',
                )}
              >
                Ready to build?
              </h2>
              <p className="mt-4 text-lg text-[var(--sand-text-muted)]">
                Start for free. No credit card required.
              </p>
              <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
                <StaggerButton text="Get started free" href="/sign-up" />
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

      {/* ================================================================ */}
      {/* FOOTER                                                           */}
      {/* ================================================================ */}
      <LandingFooter />
    </div>

    <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} defaultTab={settingsDefaultTab} />

    {showAuthDialog && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
        <div className="w-full max-w-md rounded-2xl border border-border bg-bg p-6 shadow-xl">
          <h2 className="text-xl font-semibold text-foreground">Sign in to start building</h2>
          <p className="mt-2 text-sm text-muted">
            Sign in or sign up to create your project workspace. You&apos;ll be able to name it on the next step.
          </p>
          <div className="mt-6 flex flex-col sm:flex-row gap-3">
            <SignInButton mode="modal" appearance={landingSignInModalAppearance}>
              <button className="inline-flex flex-1 items-center justify-center rounded-xl bg-foreground px-4 py-2.5 text-sm font-medium text-bg shadow hover:opacity-90 transition">
                Sign in / Sign up
              </button>
            </SignInButton>
            <button
              onClick={closeAuthDialog}
              className="inline-flex flex-1 items-center justify-center rounded-xl border border-border bg-elevated px-4 py-2.5 text-sm font-medium text-muted shadow-sm hover:bg-surface transition"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    )}

    {projectStep !== null && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
        <div className="w-full max-w-md rounded-2xl border border-border bg-bg shadow-xl overflow-hidden">
          {projectStep === 'convex' && (() => {
            const cloudForAll = process.env.NEXT_PUBLIC_ALLOW_CLOUD_CONVEX_FOR_ALL === 'true';
            const isPaid = userTier === 'pro' || userTier === 'max' || cloudForAll;
            const managedQuotaHit = isPaid && projectQuotaLeft !== null && projectQuotaLeft <= 0;
            return (
              <>
                <div className="px-6 pt-6 pb-3">
                  <h2 className="text-xl font-semibold text-foreground">Connect your backend</h2>
                  <p className="mt-1.5 text-sm text-muted">
                    {isPaid
                      ? 'Choose how to host the Convex backend for this project.'
                      : 'Botflow uses Convex for your backend. Connect your free Convex account to continue.'}
                  </p>
                </div>
                <div className="px-6 pb-6 space-y-3">
                  <div className={cn(
                    'relative rounded-xl border-2 p-4 transition-all',
                    hasConvexOAuth ? 'border-green-500/60 bg-green-500/5' : 'border-foreground/20 bg-soft',
                  )}>
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground">
                        <KeyRound className="h-4 w-4 text-bg" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-foreground">Your Convex Account</span>
                          {hasConvexOAuth && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-700 border border-green-500/30">
                              <Check className="h-3 w-3" /> Connected
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-muted">
                          Connect your free Convex account — projects live in your dashboard, no lock-in.
                        </p>
                        {!hasConvexOAuth && (
                          <a
                            href="https://dashboard.convex.dev"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground mt-1"
                          >
                            Don&apos;t have an account? Sign up free at convex.dev
                            <ArrowRight className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                    </div>
                    {!hasConvexOAuth && (
                      <button
                        onClick={handleConnectConvex}
                        disabled={convexConnecting}
                        className="mt-3 w-full inline-flex items-center justify-center gap-2 rounded-lg bg-foreground px-4 py-2.5 text-sm font-medium text-bg shadow hover:opacity-90 disabled:opacity-60 transition"
                      >
                        {convexConnecting ? (
                          <><div className="h-4 w-4 animate-spin rounded-full border-2 border-bg/30 border-t-bg" /> Connecting&hellip;</>
                        ) : (
                          'Sign in with Convex'
                        )}
                      </button>
                    )}
                  </div>
                  {isPaid ? (
                    <button
                      type="button"
                      disabled={managedQuotaHit}
                      onClick={() => {
                        void saveBackendPreference('platform');
                        setProjectStep('name');
                      }}
                      className={cn(
                        'relative w-full rounded-xl border p-4 text-left transition-all',
                        managedQuotaHit
                          ? 'border-border bg-soft opacity-50 cursor-not-allowed'
                          : 'border-border bg-soft hover:border-foreground/30 hover:bg-elevated cursor-pointer',
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-elevated">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src="/convex-color.svg" className="h-4 w-4" alt="" />
                        </div>
                        <div>
                          <span className="text-sm font-semibold text-foreground">Botflow Managed</span>
                          <span className="ml-1.5 text-xs text-muted font-normal">(Recommended)</span>
                          <p className="mt-0.5 text-xs text-muted">
                            We handle the infrastructure, backups, and scaling. Instant setup.
                          </p>
                          {managedQuotaHit && (
                            <p className="mt-1 text-xs text-amber-600 font-medium">
                              You&apos;ve reached your managed project limit. Delete a project or upgrade your plan.
                            </p>
                          )}
                        </div>
                      </div>
                    </button>
                  ) : (
                    <div className="relative rounded-xl border border-border bg-soft p-4 opacity-50 cursor-not-allowed">
                      <div className="absolute -top-2.5 right-3">
                        <span className="inline-flex items-center rounded-full bg-foreground px-2.5 py-0.5 text-xs font-semibold text-bg">
                          Upgrade to Pro
                        </span>
                      </div>
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-elevated">
                          <Database className="h-4 w-4 text-muted" />
                        </div>
                        <div>
                          <span className="text-sm font-semibold text-muted">Botflow Managed (Recommended)</span>
                          <p className="mt-0.5 text-xs text-muted">
                            We handle the infrastructure, backups, and scaling. Instant setup.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="flex gap-3 pt-1">
                    {hasConvexOAuth && (
                      <button
                        onClick={() => {
                          void saveBackendPreference('user');
                          setProjectStep('name');
                        }}
                        className="flex-1 inline-flex items-center justify-center rounded-xl bg-foreground px-4 py-2.5 text-sm font-medium text-bg shadow hover:opacity-90 transition"
                      >
                        Continue
                        <ArrowRight className="ml-1.5 h-4 w-4" />
                      </button>
                    )}
                    <button
                      onClick={closeProjectModal}
                      className={cn(
                        'inline-flex items-center justify-center rounded-xl border border-border bg-elevated px-4 py-2.5 text-sm font-medium text-muted shadow-sm hover:bg-surface transition',
                        hasConvexOAuth ? '' : 'flex-1',
                      )}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </>
            );
          })()}
          {projectStep === 'name' && (
            <div className="p-6">
              <h2 className="text-xl font-semibold text-foreground">Name your project</h2>
              <p className="mt-2 text-sm text-muted">
                Give your project a short name so it&apos;s easy to find later.
              </p>
              <div className="mt-4">
                <Input
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreateProject();
                  }}
                  placeholder="My new project"
                  className="w-full rounded-xl border border-border bg-bg px-3.5 py-2.5 text-sm text-foreground shadow-sm outline-none focus:ring-2 focus:ring-foreground/10"
                  autoFocus
                />
              </div>
              <div className="mt-6 flex gap-3">
                <button
                  onClick={handleCreateProject}
                  className="flex-1 inline-flex items-center justify-center rounded-xl bg-foreground px-4 py-2.5 text-sm font-medium text-bg shadow hover:opacity-90 transition"
                >
                  Continue to workspace
                </button>
                <button
                  onClick={closeProjectModal}
                  className="inline-flex items-center justify-center rounded-xl border border-border bg-elevated px-4 py-2.5 text-sm font-medium text-muted shadow-sm hover:bg-surface transition"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    )}
    </>
  );
}
