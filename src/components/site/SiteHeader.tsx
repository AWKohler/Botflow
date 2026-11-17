'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { SignedIn, SignedOut, UserButton, useUser } from '@/components/auth';
import { buttonClass } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const EXPLORE_ENABLED = process.env.NEXT_PUBLIC_HIDE_EXPLORE !== 'true';

type NavLink = { href: string; label: string };

// Signed-out visitors see the product story; signed-in users see their
// workspace destinations. Both end with Pricing and Docs so the header keeps
// the same shape either way.
const VISITOR_LINKS: NavLink[] = [
  ...(EXPLORE_ENABLED ? [{ href: '/explore', label: 'Explore' }] : []),
  { href: '/convex', label: 'Convex' },
  { href: '/blog', label: 'Blog' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/docs', label: 'Docs' },
];

const MEMBER_LINKS: NavLink[] = [
  { href: '/projects', label: 'Projects' },
  ...(EXPLORE_ENABLED ? [{ href: '/explore', label: 'Explore' }] : []),
  { href: '/domains', label: 'Domains' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/docs', label: 'Docs' },
];

// 6×6 diagonal stripe tile (public/stripe.svg) used as a mask so the hatch
// takes the themed --margin-stripe color. Matches MarginHatch in the landing
// components; kept local so the header has no dependency on them.
const HATCH_STYLE = {
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

export function BrandMark({ className }: { className?: string }) {
  return (
    <>
      {/* Botflow.io lockup — black on light, white on dark. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/botflow_logo_black.png" alt="Botflow" className={cn('block h-6 w-auto dark:hidden', className)} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/botflow_logo_white.png" alt="Botflow" className={cn('hidden h-6 w-auto dark:block', className)} />
    </>
  );
}

/**
 * The one header for every page outside the workspace: marketing, legal and
 * the signed-in app pages all share this bar so navigation never changes
 * shape from page to page.
 */
export function SiteHeader() {
  const pathname = usePathname() ?? '/';
  const { isSignedIn, isLoaded } = useUser();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => setMenuOpen(false), [pathname]);

  const links = isSignedIn ? MEMBER_LINKS : VISITOR_LINKS;
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <>
      <header className="sticky top-0 z-50 border-b border-border bg-bg/85 backdrop-blur-lg">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 select-none overflow-hidden">
          <div className="absolute inset-y-0 left-0 w-4 sm:w-6" style={HATCH_STYLE} />
          <div className="absolute inset-y-0 right-0 w-4 sm:w-6" style={HATCH_STYLE} />
        </div>

        <div className="relative mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-6 sm:px-10 md:grid md:grid-cols-[1fr_auto_1fr]">
          <Link href="/" className="flex items-center rounded-md" aria-label="Botflow home">
            <BrandMark />
          </Link>

          <nav
            aria-label="Main"
            className={cn(
              'hidden items-center gap-1 text-sm md:flex',
              // Hold the nav invisible until we know which link set applies, so
              // it never flashes the visitor links at a signed-in user.
              !isLoaded && 'invisible',
            )}
          >
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={isActive(link.href) ? 'page' : undefined}
                className={cn(
                  'rounded-md px-3 py-1.5 font-medium transition-colors',
                  isActive(link.href) ? 'text-fg' : 'text-muted hover:text-fg',
                )}
              >
                {link.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center justify-end gap-2">
            <SignedOut>
              <Link href="/sign-in" className={buttonClass({ variant: 'ghost', size: 'sm', className: 'hidden text-fg sm:inline-flex' })}>
                Log in
              </Link>
              <Link href="/sign-up" className={buttonClass({ variant: 'primary', size: 'sm' })}>
                Get started
              </Link>
            </SignedOut>
            <SignedIn>
              <UserButton />
            </SignedIn>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className={buttonClass({ variant: 'ghost', size: 'icon-sm', className: 'md:hidden' })}
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
            >
              {menuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {menuOpen && (
          <nav aria-label="Mobile" className="relative border-t border-border bg-bg px-6 py-3 md:hidden">
            <ul className="flex flex-col">
              {links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    aria-current={isActive(link.href) ? 'page' : undefined}
                    className={cn(
                      'block rounded-md px-2 py-2.5 text-[15px] font-medium',
                      isActive(link.href) ? 'text-fg' : 'text-muted',
                    )}
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
              <SignedOut>
                <li>
                  <Link href="/sign-in" className="block rounded-md px-2 py-2.5 text-[15px] font-medium text-muted">
                    Log in
                  </Link>
                </li>
              </SignedOut>
            </ul>
          </nav>
        )}
      </header>

    </>
  );
}
