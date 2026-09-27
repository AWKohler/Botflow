import { NextResponse } from 'next/server';
import { Webhook } from 'svix';
export async function POST(request: Request) {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: 'Legacy webhook disabled' }, { status: 410 });
  try {
    new Webhook(secret).verify(await request.text(), {
      'svix-id': request.headers.get('svix-id') ?? '',
      'svix-timestamp': request.headers.get('svix-timestamp') ?? '',
      'svix-signature': request.headers.get('svix-signature') ?? '',
    });
  } catch { return NextResponse.json({ error: 'Invalid signature' }, { status: 401 }); }
  return NextResponse.json({ received: true, ignored: 'Identity migration owns local user and subscription state' });
}
