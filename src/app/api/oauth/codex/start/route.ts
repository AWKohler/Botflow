import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { enforce, identifierFor } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const blocked = await enforce(identifierFor(userId, req), 'oauthStart');
    if (blocked) return blocked;

    const res = await fetch('https://auth.openai.com/api/accounts/deviceauth/usercode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('Codex device auth start failed:', res.status, text);
      return NextResponse.json({ error: 'Failed to start device auth' }, { status: 502 });
    }

    const data = await res.json() as {
      user_code: string;
      verification_url?: string;
      device_auth_id: string;
      interval: number;
    };

    return NextResponse.json({
      user_code: data.user_code,
      verification_url: data.verification_url || 'https://auth.openai.com/codex/device',
      device_auth_id: data.device_auth_id,
      interval: data.interval,
    });
  } catch (e) {
    console.error('Codex OAuth start error:', e);
    return NextResponse.json({ error: 'Failed to start device auth' }, { status: 500 });
  }
}
