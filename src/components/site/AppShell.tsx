import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { SiteHeader } from './SiteHeader';

/**
 * Page frame for the signed-in app pages: the shared header plus one content
 * column on the same gutters as the header and the marketing pages, so the
 * page title starts at the same left edge on every page. Pages that want a
 * narrower measure constrain their own content inside this column.
 */
export function AppShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="min-h-screen bg-bg text-fg antialiased">
      <SiteHeader />
      <main className={cn('mx-auto max-w-7xl px-6 pb-20 pt-10 sm:px-10', className)}>{children}</main>
    </div>
  );
}
