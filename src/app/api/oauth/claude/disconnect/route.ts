import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/server';
import { clearUserCredentials } from '@/lib/user-credentials';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    await clearUserCredentials(userId, [
      'claudeOAuthAccessToken',
      'claudeOAuthRefreshToken',
      'claudeOAuthExpiresAt',
    ]);

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('OAuth disconnect failed:', e);
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 });
  }
}
