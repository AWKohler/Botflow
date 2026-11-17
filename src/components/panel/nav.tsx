'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { UserButton } from '@/components/auth';
import { cn } from '@/lib/utils';
import { BrandMark } from '@/components/site/SiteHeader';
import { Badge } from '@/components/ui/badge';
import { Activity, Boxes, Gauge, UserCog, Users } from 'lucide-react';

const TABS = [
  { href: '/panel/accounts', label: 'Accounts', icon: UserCog },
  { href: '/panel', label: 'Overview', icon: Gauge },
  { href: '/panel/users', label: 'Users', icon: Users },
  { href: '/panel/infra', label: 'Infrastructure', icon: Boxes },
  { href: '/panel/providers', label: 'Providers', icon: Activity },
];

/** `activePath` lets a preview or test render the nav for a given tab; it defaults to the current route. */
export function PanelNav({ activePath }: { activePath?: string } = {}) {
  const current = usePathname();
  const pathname = activePath ?? current;
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-bg/85 backdrop-blur-lg">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-6 sm:px-10">
        <Link href="/projects" aria-label="Back to Botflow" className="flex shrink-0 items-center gap-2.5 rounded-md">
          <BrandMark />
          <Badge>Admin</Badge>
        </Link>
        <nav aria-label="Admin" className="flex flex-1 items-center gap-1 overflow-x-auto">
          {TABS.map((t) => {
            const active =
              t.href === '/panel' ? pathname === '/panel' : pathname.startsWith(t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
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
