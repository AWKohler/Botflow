'use client';

import { AppShell } from '@/components/site/AppShell';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { PageHeader } from '@/components/ui/card';

/**
 * Full-page view of the same settings the dialog shows (usage, connections
 * and keys, subscription) — one implementation, two entry points.
 */
export default function SettingsPage() {
  return (
    <AppShell>
      <PageHeader title="Settings" description="Usage, connected accounts and API keys, and your plan." />
      <div className="mt-8 max-w-3xl">
        <SettingsModal variant="page" open onClose={() => {}} defaultTab="connections" />
      </div>
    </AppShell>
  );
}
