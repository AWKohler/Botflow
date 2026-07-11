'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { AtSign } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * AuthProviderArc — a scroll-driven "provider wheel" for the landing page.
 *
 * One tile for every sign-in method a generated app supports sits on the rim
 * of an invisible circle whose center is below the panel. GSAP ScrollTrigger
 * scrubs the wheel's rotation so each unique provider crosses the apex once.
 *
 * Providers listed here mirror src/lib/oauth-providers/registry.ts plus the
 * email+password scaffold every project ships with — keep them in sync.
 */

// ============================================================================
// Brand marks (inline so tiles need no network fetch and honor dark mode)
// ============================================================================

function GoogleLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1A6.6 6.6 0 0 1 5.49 12c0-.73.13-1.43.35-2.09V7.07H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.93l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A11 11 0 0 0 12 1 11 11 0 0 0 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
      />
    </svg>
  );
}

function GitHubLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

function MicrosoftLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path fill="#F25022" d="M1 1h10.4v10.4H1z" />
      <path fill="#7FBA00" d="M12.6 1H23v10.4H12.6z" />
      <path fill="#00A4EF" d="M1 12.6h10.4V23H1z" />
      <path fill="#FFB900" d="M12.6 12.6H23V23H12.6z" />
    </svg>
  );
}

function AppleLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.56-1.702" />
    </svg>
  );
}

function EmailLogo({ className }: { className?: string }) {
  return <AtSign className={className} style={{ color: 'var(--sand-accent)' }} aria-hidden />;
}

type ArcProvider = {
  key: string;
  name: string;
  buttonLabel: string;
  Logo: (props: { className?: string }) => React.ReactElement;
};

const PROVIDERS: ArcProvider[] = [
  { key: 'email', name: 'Email & password', buttonLabel: 'Continue with email', Logo: EmailLogo },
  { key: 'google', name: 'Google', buttonLabel: 'Sign in with Google', Logo: GoogleLogo },
  { key: 'github', name: 'GitHub', buttonLabel: 'Sign in with GitHub', Logo: GitHubLogo },
  { key: 'microsoft', name: 'Microsoft', buttonLabel: 'Sign in with Microsoft', Logo: MicrosoftLogo },
  { key: 'apple', name: 'Apple', buttonLabel: 'Sign in with Apple', Logo: AppleLogo },
];

// ============================================================================
// Wheel geometry — derived from the measured panel width so the arc reads the
// same from phones to wide desktops.
// ============================================================================

function wheelLayout(width: number) {
  const tile = width >= 560 ? 72 : width >= 400 ? 64 : 56;
  // Solve the rim radius from the panel width: the resting fan's outer tiles
  // (~±42° from apex) must clear a real side inset — 13% of the panel width,
  // not a sliver. Below the radius floor five tiles can't fit with margins,
  // so hold the floor and let the outer tiles bleed off the edges instead of
  // hovering just inside them.
  const inset = Math.max(24, width * 0.13);
  const reach = (tile / 2) * 1.45; // half-diagonal of a rotated tile
  const fit = (width / 2 - inset - reach) / Math.sin((42 * Math.PI) / 180);
  const radius = Math.min(Math.max(fit, 230), 340);
  const gap = Math.min(Math.max((tile * 1.45 * 180) / (Math.PI * radius), 18), 25);
  const count = PROVIDERS.length;
  const sweep = gap * (count - 1);
  const apexY = width >= 400 ? 76 : 66;
  return { tile, radius, gap, count, apexY, sweep };
}

export function AuthProviderArc({
  serifClassName,
  className,
}: {
  serifClassName?: string;
  className?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const wheelRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState(0);

  const layout = useMemo(() => wheelLayout(width || 1024), [width]);

  // Measure the panel (debounced) — geometry drives both render and the tween.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const measure = () => setWidth(panel.clientWidth);
    measure();
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(measure, 150);
    });
    ro.observe(panel);
    return () => {
      clearTimeout(t);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!width) return;
    gsap.registerPlugin(ScrollTrigger);
    const { gap, count, sweep } = layout;
    const mm = gsap.matchMedia();

    mm.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.fromTo(
        wheelRef.current,
        { rotation: -sweep / 2 },
        {
          rotation: sweep / 2,
          ease: 'none',
          scrollTrigger: {
            trigger: panelRef.current,
            start: 'top bottom',
            end: 'bottom top',
            scrub: 0.6,
            onUpdate: () => {
              const rot = Number(gsap.getProperty(wheelRef.current, 'rotation'));
              const idx = Math.round((sweep / 2 - rot) / gap);
              setActive(Math.min(Math.max(idx, 0), count - 1));
            },
          },
        },
      );
      // Content above this section can reflow after the trigger measures
      // (font swaps, hydrating widgets, images), leaving the cached start/end
      // stale and the scrub visibly offset — re-measure once things settle.
      const settle = window.setTimeout(() => ScrollTrigger.refresh(), 800);
      return () => window.clearTimeout(settle);
    });

    return () => mm.revert();
  }, [width, layout]);

  const { tile, radius, gap, apexY, sweep } = layout;
  const activeProvider = PROVIDERS[active];

  return (
    <div ref={panelRef} className={cn('relative', className)}>
      {/* Screen-reader fallback for the purely visual wheel */}
      <p className="sr-only">
        Supported sign-in methods: {PROVIDERS.map((p) => p.name).join(', ')}.
      </p>

      <div
        aria-hidden
        className="relative h-[310px] overflow-hidden rounded-[28px] border border-[var(--sand-border)] bg-[var(--sand-elevated)] sm:h-[360px]"
      >
        {/* Dot grid, fading out toward the caption */}
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              'radial-gradient(circle at 1px 1px, color-mix(in oklab, var(--sand-text-muted) 45%, transparent) 1px, transparent 0)',
            backgroundSize: '22px 22px',
            maskImage: 'linear-gradient(to bottom, black 0%, transparent 62%)',
            WebkitMaskImage: 'linear-gradient(to bottom, black 0%, transparent 62%)',
            opacity: 0.18,
          }}
        />
        {/* Soft glow behind the apex tile */}
        <div
          className="absolute left-1/2 -translate-x-1/2"
          style={{
            top: apexY - tile,
            width: tile * 4,
            height: tile * 4,
            background:
              'radial-gradient(closest-side, color-mix(in oklab, var(--sand-accent) 14%, transparent), transparent 70%)',
          }}
        />

        {/* The wheel — a zero-size pivot far below the panel; GSAP rotates it */}
        <div
          ref={wheelRef}
          className="absolute left-1/2"
          style={{ top: apexY + radius, width: 0, height: 0, willChange: 'transform' }}
        >
          {PROVIDERS.map((provider, i) => {
            const isActive = i === active;
            return (
              <div
                key={provider.key}
                className="absolute left-0 top-0"
                style={{
                  transform: `rotate(${i * gap - sweep / 2}deg) translateY(${-radius}px)`,
                }}
              >
                <div
                  className={cn(
                    'flex items-center justify-center rounded-[24%] border bg-[var(--sand-bg)] transition-[transform,border-color,box-shadow] duration-300',
                    isActive
                      ? 'scale-[1.08] border-[color-mix(in_oklab,var(--sand-accent)_45%,var(--sand-border))]'
                      : 'border-[var(--sand-border)]',
                  )}
                  style={{
                    width: tile,
                    height: tile,
                    marginLeft: -tile / 2,
                    marginTop: -tile / 2,
                    color: 'var(--sand-text)',
                    boxShadow: isActive
                      ? '0 12px 32px color-mix(in oklab, var(--sand-accent) 22%, transparent), 0 2px 6px rgba(0,0,0,0.10)'
                      : '0 8px 24px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.06)',
                  }}
                >
                  <provider.Logo className="h-[42%] w-[42%]" />
                </div>
              </div>
            );
          })}
        </div>

        {/* Apex indicator + generated sign-in button preview */}
        <div
          className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center gap-4"
          style={{ top: apexY + tile / 2 + 22 }}
        >
          <div
            className="h-0 w-0"
            style={{
              borderLeft: '7px solid transparent',
              borderRight: '7px solid transparent',
              borderBottom: '8px solid var(--sand-soft)',
            }}
          />
          <span
            key={activeProvider.key}
            className="flex min-h-[46px] min-w-[220px] items-center justify-center gap-3 whitespace-nowrap rounded-[10px] border border-[color-mix(in_oklab,var(--sand-text)_22%,var(--sand-border))] bg-[var(--sand-bg)] px-4 py-3 text-sm font-semibold text-[var(--sand-text)] shadow-[0_2px_4px_rgba(0,0,0,0.08),0_8px_24px_rgba(0,0,0,0.06)] sm:min-w-[240px]"
            style={{ animation: 'auth-button-in 0.35s cubic-bezier(0.43, 0.195, 0.02, 1)' }}
          >
            <activeProvider.Logo className="h-[18px] w-[18px] shrink-0" />
            {activeProvider.buttonLabel}
          </span>
        </div>

        {/* Caption — mirrors the tone of the section headlines */}
        <div className="absolute inset-x-0 bottom-7 px-6 text-center sm:bottom-8">
          <p className={cn(serifClassName, 'text-xl tracking-tight sm:text-2xl')}>
            All your users <em className={serifClassName}>welcome</em>
          </p>
        </div>

        <style>{`
          @keyframes auth-button-in {
            from { opacity: 0; transform: translateY(4px) scale(0.98); }
            to { opacity: 1; transform: translateY(0); }
          }
        `}</style>
      </div>
    </div>
  );
}
