import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { SiteHeader } from './SiteHeader';

/** Width presets shared by every signed-in page so content edges line up. */
const WIDTHS = {
  narrow: 'max-w-3xl',
  default: 'max-w-5xl',
  wide: 'max-w-7xl',
} as const;

/**
 * Page frame for the signed-in app pages: the shared header plus a centered
 * content column on the same gutters as the marketing pages.
 */
export function AppShell({
  children,
  width = 'wide',
  className,
}: {
  children: ReactNode;
  width?: keyof typeof WIDTHS;
  className?: string;
}) {
  return (
    <div className="min-h-screen bg-bg text-fg antialiased">
      <SiteHeader />
      <main className={cn('mx-auto px-6 pb-20 pt-10 sm:px-10', WIDTHS[width], className)}>{children}</main>
    </div>
  );
}
