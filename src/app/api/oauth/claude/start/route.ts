import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import crypto from 'crypto';
import { enforce, identifierFor } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const SCOPES = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Key by userId, falling back to IP so unauthed probes are still bounded.
    const blocked = await enforce(identifierFor(userId, req), 'oauthStart');
    if (blocked) return blocked;

    // Generate PKCE verifier (32 random bytes → base64url)
    const verifier = base64url(crypto.randomBytes(32));

    // Generate PKCE challenge (SHA256 of verifier → base64url)
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());

    // Build authorization URL
    const params = new URLSearchParams({
      code: 'true',
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: verifier,
      access_type: 'offline',
      prompt: 'consent',
    });

    const authUrl = `https://claude.ai/oauth/authorize?${params.toString()}`;

    // Return the verifier to the client — it stores it in component state and
    // sends it back with the exchange request (PKCE verifier is a client-side secret)
    return NextResponse.json({ authUrl, verifier });
  } catch (e) {
    console.error('OAuth start failed:', e);
    return NextResponse.json({ error: 'Failed to start OAuth flow' }, { status: 500 });
  }
}
