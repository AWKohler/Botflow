'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { UserButton } from '@clerk/nextjs';
import { cn } from '@/lib/utils';
import { Activity, Boxes, Gauge, Users } from 'lucide-react';

const TABS = [
  { href: '/panel', label: 'Overview', icon: Gauge },
  { href: '/panel/users', label: 'Users', icon: Users },
  { href: '/panel/infra', label: 'Infrastructure', icon: Boxes },
  { href: '/panel/providers', label: 'Providers', icon: Activity },
];

export function PanelNav() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-bg/90 backdrop-blur">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 flex items-center gap-6 h-14">
        <Link href="/projects" className="text-sm font-semibold text-fg shrink-0">
          Botflow <span className="text-muted font-normal">Admin</span>
        </Link>
        <nav className="flex items-center gap-1 flex-1 overflow-x-auto">
          {TABS.map((t) => {
            const active =
              t.href === '/panel' ? pathname === '/panel' : pathname.startsWith(t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm whitespace-nowrap transition-colors',
                  active
                    ? 'bg-elevated text-fg font-medium'
                    : 'text-muted hover:text-fg hover:bg-surface',
                )}
              >
                <t.icon className="w-3.5 h-3.5" />
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
