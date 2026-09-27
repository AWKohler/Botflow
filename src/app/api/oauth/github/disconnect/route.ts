import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/server';
import { clearUserCredentials } from '@/lib/user-credentials';
import { getDb } from '@/db';
import { userSettings } from '@/db/schema';
import { eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Clear from Clerk privateMetadata
    await clearUserCredentials(userId, [
      'githubAccessToken',
      'githubUsername',
      'githubAvatarUrl',
    ]);

    // Also clear display fields from Neon
    const db = getDb();
    await db
      .update(userSettings)
      .set({ githubUsername: null, githubAvatarUrl: null, updatedAt: new Date() })
      .where(eq(userSettings.userId, userId));

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('GitHub disconnect failed:', e);
    return NextResponse.json({ error: 'Failed to disconnect GitHub' }, { status: 500 });
  }
}
