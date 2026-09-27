import { auth } from '@/lib/auth/server';
import { redirect } from 'next/navigation';
import DomainsClient from './domains-client';

export const dynamic = 'force-dynamic';

export default async function DomainsPage() {
  const { userId } = await auth();
  if (!userId) redirect('/');
  return <DomainsClient />;
}
