import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import {
  getUserCredentials,
  setUserCredentials,
  clearUserCredentials,
} from '@/lib/user-credentials';
import { mintAscToken, ascFetch } from '@/lib/asc-jwt';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// 10-char alphanumeric — ASC Key IDs and Apple Developer Team IDs share this shape.
const KEY_ID_RE = /^[A-Z0-9]{10}$/i;
// Issuer IDs are UUIDs.
const ISSUER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const APPLE_REJECTED_MSG =
  'Apple rejected this key — check the Key ID, Issuer ID, and .p8 file match';

/** Last 4 chars only, e.g. "•••• AB12". */
function maskKeyId(keyId: string): string {
  return `•••• ${keyId.slice(-4).toUpperCase()}`;
}

/** First 8 chars + ellipsis, e.g. "69a6de7e…". */
function maskIssuerId(issuerId: string): string {
  return `${issuerId.slice(0, 8)}…`;
}

/**
 * GET /api/user/apple-credentials
 * Masked connection status. NEVER returns the .p8 or the full issuer/key ids.
 */
export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const creds = await getUserCredentials(userId);
    const connected = Boolean(creds.appleAscKeyId && creds.appleAscIssuerId && creds.appleAscKeyP8);

    return NextResponse.json({
      connected,
      keyId: connected && creds.appleAscKeyId ? maskKeyId(creds.appleAscKeyId) : null,
      issuerId: connected && creds.appleAscIssuerId ? maskIssuerId(creds.appleAscIssuerId) : null,
      teamId: connected ? creds.appleTeamId : null,
      teamName: connected ? creds.appleTeamName : null,
    });
  } catch (e) {
    console.error('GET /api/user/apple-credentials failed:', e);
    return NextResponse.json({ error: 'Failed to load Apple credentials' }, { status: 500 });
  }
}

/**
 * POST /api/user/apple-credentials
 * Body: { issuerId, keyId, p8, teamId? }
 * Validates the key against the ASC API (GET /v1/apps), resolves the team id
 * when possible, and saves to Clerk privateMetadata. Never echoes the .p8.
 */
export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    }
    // Coerce only real strings; anything else becomes '' and fails validation
    // below (rather than throwing on `.trim()` and 500-ing).
    const asStr = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
    const issuerId = asStr(body.issuerId);
    const keyId = asStr(body.keyId);
    const p8 = asStr(body.p8);
    const suppliedTeamId = asStr(body.teamId);

    // A .p8 is ~250 bytes (PEM-wrapped ~300). Reject oversized payloads before
    // running regex / key-parsing on attacker-controlled input.
    if (p8.length > 10_000) {
      return NextResponse.json({ error: 'The .p8 key is too large to be valid.' }, { status: 400 });
    }

    if (!KEY_ID_RE.test(keyId)) {
      return NextResponse.json(
        { error: 'Key ID should be the 10-character id shown next to the key in App Store Connect' },
        { status: 400 }
      );
    }
    if (!ISSUER_ID_RE.test(issuerId)) {
      return NextResponse.json(
        { error: 'Issuer ID should be the UUID shown at the top of the Integrations page' },
        { status: 400 }
      );
    }
    if (suppliedTeamId && !KEY_ID_RE.test(suppliedTeamId)) {
      return NextResponse.json(
        { error: 'Team ID should be the 10-character id from your Apple Developer membership' },
        { status: 400 }
      );
    }

    // Parse the .p8 + mint a token (throws a clear Error on malformed keys)
    let token: string;
    try {
      token = mintAscToken({ issuerId, keyId, p8 });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Invalid .p8 key' },
        { status: 400 }
      );
    }

    // Validate against Apple
    const appsRes = await ascFetch(token, '/v1/apps?limit=1');
    if (appsRes.status === 401 || appsRes.status === 403) {
      return NextResponse.json({ error: APPLE_REJECTED_MSG }, { status: 400 });
    }
    if (!appsRes.ok) {
      return NextResponse.json(
        { error: `App Store Connect returned an unexpected error (${appsRes.status}). Try again shortly.` },
        { status: 502 }
      );
    }

    // Resolve the team id: caller-supplied wins; otherwise try the seedId of any
    // registered bundle id (the seed id IS the team id for normal teams). If
    // neither works we still save — the publish flow will prompt for it later.
    let teamId: string | null = suppliedTeamId ? suppliedTeamId.toUpperCase() : null;
    if (!teamId) {
      try {
        const bundleRes = await ascFetch(token, '/v1/bundleIds?limit=1');
        if (bundleRes.ok) {
          const bundleData = (await bundleRes.json()) as {
            data?: Array<{ attributes?: { seedId?: string } }>;
          };
          const seedId = bundleData.data?.[0]?.attributes?.seedId;
          if (seedId && KEY_ID_RE.test(seedId)) teamId = seedId.toUpperCase();
        }
      } catch {
        // Non-fatal — teamId stays null
      }
    }

    await setUserCredentials(userId, {
      appleAscIssuerId: issuerId,
      appleAscKeyId: keyId.toUpperCase(),
      appleAscKeyP8: p8,
      appleTeamId: teamId,
      // No clean public-API endpoint for the team name; display falls back to
      // the (masked) issuer id.
      appleTeamName: null,
    });

    return NextResponse.json({
      connected: true,
      keyId: maskKeyId(keyId),
      teamId,
    });
  } catch (e) {
    console.error('POST /api/user/apple-credentials failed:', e);
    return NextResponse.json({ error: 'Failed to save Apple credentials' }, { status: 500 });
  }
}

/**
 * DELETE /api/user/apple-credentials
 * Disconnects: clears all Apple ASC fields.
 */
export async function DELETE() {
  try {
    const { userId } = await auth();
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    await clearUserCredentials(userId, [
      'appleAscIssuerId',
      'appleAscKeyId',
      'appleAscKeyP8',
      'appleTeamId',
      'appleTeamName',
    ]);

    return NextResponse.json({ connected: false });
  } catch (e) {
    console.error('DELETE /api/user/apple-credentials failed:', e);
    return NextResponse.json({ error: 'Failed to disconnect Apple credentials' }, { status: 500 });
  }
}
