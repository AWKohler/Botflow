'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { UserButton } from '@/components/auth';
import { cn } from '@/lib/utils';
import { BrandMark } from '@/components/site/SiteHeader';
import { Badge } from '@/components/ui/badge';
import { Activity, Boxes, Gauge, UserCog, Users } from 'lucide-react';

const TABS = [
  { href: '/panel', label: 'Overview', icon: Gauge },
  { href: '/panel/users', label: 'Users', icon: Users },
  { href: '/panel/accounts', label: 'Accounts', icon: UserCog },
  { href: '/panel/infra', label: 'Infrastructure', icon: Boxes },
  { href: '/panel/providers', label: 'Providers', icon: Activity },
];

/** `activePath` lets a preview or test render the nav for a given tab; it defaults to the current route. */
export function PanelNav({ activePath }: { activePath?: string } = {}) {
  const current = usePathname();
  const pathname = activePath ?? current;
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-bg/85 backdrop-blur-lg">
      {/* Phone: two rows — brand and account, then the tabs across the full
          width (beside the brand they had room for about one letter). */}
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-6 px-6 sm:px-10 md:h-14 md:flex-nowrap md:justify-start">
        <Link href="/projects" aria-label="Back to Botflow" className="flex h-14 shrink-0 items-center gap-2.5 rounded-md">
          <BrandMark />
          <Badge>Admin</Badge>
        </Link>
        <nav
          aria-label="Admin"
          className={cn(
            'flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:flex-1',
            'max-md:order-last max-md:-mx-6 max-md:w-[calc(100%+3rem)] max-md:border-t max-md:border-border max-md:px-5 max-md:py-1.5',
            // Faded at the right edge, where the row runs on.
            'max-md:[mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)]',
          )}
        >
          {TABS.map((t) => {
            const active =
              t.href === '/panel' ? pathname === '/panel' : pathname.startsWith(t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors pointer-coarse:py-2.5',
                  active ? 'bg-elevated text-fg' : 'text-muted hover:text-fg',
                )}
              >
                <t.icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                {t.label}
              </Link>
            );
          })}
        </nav>
        <UserButton afterSignOutUrl="/" />
      </div>
    </header>
  );
}
