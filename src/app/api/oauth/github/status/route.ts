import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth/server';
import { getUserCredentials } from '@/lib/user-credentials';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const creds = await getUserCredentials(userId);

    return NextResponse.json({
      connected: Boolean(creds.githubAccessToken),
      username: creds.githubUsername ?? null,
      avatarUrl: creds.githubAvatarUrl ?? null,
    });
  } catch (e) {
    console.error('GitHub status check failed:', e);
    return NextResponse.json({ error: 'Failed to check GitHub status' }, { status: 500 });
  }
}
