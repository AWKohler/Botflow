import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/server';
import { getUserTier } from '@/lib/tier';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ tier: 'free' });

  const tier = await getUserTier(userId);
  return NextResponse.json({ tier });
}
