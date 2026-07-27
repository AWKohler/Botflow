import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { isPanelAdmin } from '@/lib/panel/auth';
import { PanelNav } from '@/components/panel/nav';

/**
 * Admin panel shell. Middleware already requires a signed-in user for
 * /panel/**; this layout adds the operator-allowlist check (defense in depth —
 * every /api/panel route re-checks independently). Non-admins are bounced to
 * the projects page with no hint the panel exists.
 */
export default async function PanelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { userId } = await auth();
  if (!userId || !isPanelAdmin(userId)) redirect('/projects');

  return (
    <div className="min-h-screen bg-bg">
      <PanelNav />
      <main className="mx-auto max-w-7xl px-4 sm:px-6 py-6">{children}</main>
    </div>
  );
}
