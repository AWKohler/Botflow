/**
 * App Store Connect helpers for the Swift "Publish to App Store" flow.
 *
 * Botflow does the ASC REST half of the hybrid split (decision #3 in
 * future/app-store-submission.md): app-record lookup, bundle-id registration,
 * next-build-number computation, and processing-state polling. The Mac
 * controller does only what's physically local (archive, sign, upload).
 *
 * App records can NOT be created via the API — the wizard guides the user to
 * create one manually on App Store Connect; `findAppByBundleId` is how we
 * detect that it exists.
 */

import { ascFetch, mintAscToken } from './asc-jwt';

export interface AscAuth {
  issuerId: string;
  keyId: string;
  p8: string;
}

interface AscResource {
  id: string;
  attributes?: Record<string, unknown>;
}

interface AscListResponse {
  data?: AscResource[];
}

/** Throw an informative Error including a snippet of Apple's response body. */
async function throwAscError(context: string, res: Response): Promise<never> {
  const body = await res.text().catch(() => '');
  const snippet = body.slice(0, 400);
  throw new Error(`${context} failed (${res.status})${snippet ? `: ${snippet}` : ''}`);
}

function token(auth: AscAuth): string {
  return mintAscToken({ issuerId: auth.issuerId, keyId: auth.keyId, p8: auth.p8 });
}

/**
 * Look up an existing App Store Connect app record by bundle id.
 * Returns null when no app record exists yet (the user must create it
 * manually — there is no create-app API endpoint).
 */
export async function findAppByBundleId(
  auth: AscAuth,
  bundleId: string,
): Promise<{ ascAppId: string; name: string } | null> {
  const res = await ascFetch(
    token(auth),
    `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`,
  );
  if (!res.ok) await throwAscError('App Store Connect app lookup', res);
  const body = (await res.json()) as AscListResponse;
  const app = body.data?.[0];
  if (!app) return null;
  return {
    ascAppId: app.id,
    name: typeof app.attributes?.name === 'string' ? app.attributes.name : '',
  };
}

/**
 * Compute the next CFBundleVersion for an app: latest uploaded build's
 * numeric version + 1, or '1' when the app has no builds yet.
 * Defensive on non-numeric versions: falls back to (parsed || 0) + 1.
 */
export async function nextBuildNumber(auth: AscAuth, ascAppId: string): Promise<string> {
  const res = await ascFetch(
    token(auth),
    `/v1/builds?filter[app]=${encodeURIComponent(ascAppId)}&sort=-uploadedDate&limit=1`,
  );
  if (!res.ok) await throwAscError('App Store Connect builds lookup', res);
  const body = (await res.json()) as AscListResponse;
  const latest = body.data?.[0];
  if (!latest) return '1';
  const raw =
    typeof latest.attributes?.version === 'string' ? latest.attributes.version.trim() : '';
  // CFBundleVersion is a plain integer for our own uploads. Take the leading
  // integer (covers legacy dotted versions uploaded elsewhere) and guard against
  // overflow. If a number ever collides, Apple rejects the duplicate at upload —
  // a clear, recoverable error rather than a silent reuse.
  const leading = raw.match(/^\d+/)?.[0];
  const n = leading ? parseInt(leading, 10) : 0;
  // Guard so the increment itself can't exceed MAX_SAFE_INTEGER.
  const base = Number.isSafeInteger(n) && n < Number.MAX_SAFE_INTEGER ? n : 0;
  return String(base + 1);
}

/**
 * Ensure the bundle id is registered with the Developer portal. Best-effort:
 * returns true if registered (already or just now), false on any failure —
 * non-fatal because `xcodebuild -allowProvisioningUpdates` can also register
 * it during the signed archive.
 */
export async function ensureBundleIdRegistered(
  auth: AscAuth,
  bundleId: string,
  name: string,
): Promise<boolean> {
  try {
    const t = token(auth);
    const lookup = await ascFetch(
      t,
      `/v1/bundleIds?filter[identifier]=${encodeURIComponent(bundleId)}`,
    );
    if (!lookup.ok) return false;
    const body = (await lookup.json()) as AscListResponse;
    const exists = (body.data ?? []).some(
      (b) => b.attributes?.identifier === bundleId,
    );
    if (exists) return true;

    const create = await ascFetch(t, '/v1/bundleIds', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'bundleIds',
          attributes: { identifier: bundleId, name, platform: 'IOS' },
        },
      }),
    });
    return create.ok;
  } catch {
    return false;
  }
}

/**
 * Check whether an uploaded build (identified by CFBundleVersion) has appeared
 * in App Store Connect and finished server-side processing. Used by the
 * wizard's final "Apple is processing" step.
 */
export async function getUploadProcessingState(
  auth: AscAuth,
  ascAppId: string,
  cfBundleVersion: string,
): Promise<{ processed: boolean; processingState?: string }> {
  const res = await ascFetch(
    token(auth),
    `/v1/builds?filter[app]=${encodeURIComponent(ascAppId)}&filter[version]=${encodeURIComponent(cfBundleVersion)}&limit=1`,
  );
  if (!res.ok) await throwAscError('App Store Connect processing-state lookup', res);
  const body = (await res.json()) as AscListResponse;
  const build = body.data?.[0];
  if (!build) return { processed: false };
  const state = build.attributes?.processingState;
  const processingState = typeof state === 'string' ? state : undefined;
  return {
    // "processed" means READY: Apple accepted the build into TestFlight (VALID).
    // INVALID/FAILED are NOT processed — the caller reads `processingState` to
    // surface a rejection. (A build past PROCESSING but not VALID was rejected.)
    processed: processingState === 'VALID',
    ...(processingState ? { processingState } : {}),
  };
}
