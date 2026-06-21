/**
 * Push App Store text metadata via the App Store Connect REST API.
 *
 * Name + subtitle live on appInfoLocalizations (the app's editable App Info);
 * description + keywords live on appStoreVersionLocalizations (per app-store
 * version). We create the editable version on first submission if none exists.
 * Each group is best-effort: we push what we can and report what we couldn't.
 *
 * NOTE: the 1024 marketing icon is pulled by Apple FROM the uploaded build's
 * asset catalog (no separate upload). Screenshot upload (appScreenshots chunked
 * reservation/commit per display type) is a deliberate follow-up — not here.
 */

import { ascFetch, mintAscToken } from "@/lib/asc-jwt";
import type { AscAuth } from "@/lib/asc-publish";

const DEFAULT_LOCALE = "en-US";

interface AscResource {
  id: string;
  attributes?: Record<string, unknown>;
}
interface AscListResponse {
  data?: AscResource[];
}

function token(auth: AscAuth): string {
  return mintAscToken({ issuerId: auth.issuerId, keyId: auth.keyId, p8: auth.p8 });
}

async function getList(auth: AscAuth, path: string): Promise<AscListResponse> {
  const res = await ascFetch(token(auth), path);
  if (!res.ok) {
    throw new Error(`GET ${path} → ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  }
  return (await res.json()) as AscListResponse;
}

async function patchResource(
  auth: AscAuth,
  path: string,
  type: string,
  id: string,
  attributes: Record<string, unknown>,
): Promise<void> {
  const res = await ascFetch(token(auth), path, {
    method: "PATCH",
    body: JSON.stringify({ data: { type, id, attributes } }),
  });
  if (!res.ok) {
    throw new Error(`PATCH ${path} → ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  }
}

async function postResource(auth: AscAuth, path: string, body: unknown): Promise<AscResource> {
  const res = await ascFetch(token(auth), path, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) {
    throw new Error(`POST ${path} → ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  }
  const j = (await res.json()) as { data?: AscResource };
  if (!j.data) throw new Error(`POST ${path}: response had no data`);
  return j.data;
}

// The app's primary App Store language — the localization our default listing
// edits should target. Falls back to en-US if it can't be read, so a missing
// permission never blocks the push.
async function primaryLocale(auth: AscAuth, ascAppId: string): Promise<string> {
  try {
    const res = await ascFetch(token(auth), `/v1/apps/${ascAppId}?fields[apps]=primaryLocale`);
    if (res.ok) {
      const j = (await res.json()) as { data?: { attributes?: { primaryLocale?: string } } };
      return j.data?.attributes?.primaryLocale || DEFAULT_LOCALE;
    }
  } catch {
    /* fall back to default */
  }
  return DEFAULT_LOCALE;
}

function appStoreState(r: AscResource): string {
  return String(r.attributes?.appStoreState ?? r.attributes?.state ?? "");
}

const LIVE_STATES = new Set(["READY_FOR_SALE", "READY_FOR_DISTRIBUTION"]);
// App-store version states that are still editable (not live / not in review).
const EDITABLE_VERSION_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
]);

export interface MetadataPush {
  name?: string;
  subtitle?: string;
  description?: string;
  keywords?: string;
}

export interface PushResult {
  pushed: string[];
  warnings: string[];
}

export async function pushAppStoreMetadata(
  auth: AscAuth,
  ascAppId: string,
  meta: MetadataPush,
  marketingVersion: string,
): Promise<PushResult> {
  const pushed: string[] = [];
  const warnings: string[] = [];
  const locale = await primaryLocale(auth, ascAppId);

  // ── 1. Name + subtitle → appInfoLocalizations ────────────────────────────
  if (meta.name || meta.subtitle) {
    try {
      const infos = await getList(auth, `/v1/apps/${ascAppId}/appInfos?limit=10`);
      const editable =
        infos.data?.find((i) => !LIVE_STATES.has(appStoreState(i))) ?? infos.data?.[0];
      if (!editable) throw new Error("no editable App Info found");

      const locs = await getList(auth, `/v1/appInfos/${editable.id}/appInfoLocalizations?limit=50`);
      const loc = locs.data?.find((l) => l.attributes?.locale === locale);
      const attrs: Record<string, unknown> = {};
      if (meta.name) attrs.name = meta.name;
      if (meta.subtitle) attrs.subtitle = meta.subtitle;

      if (loc) {
        await patchResource(auth, `/v1/appInfoLocalizations/${loc.id}`, "appInfoLocalizations", loc.id, attrs);
      } else {
        await postResource(auth, `/v1/appInfoLocalizations`, {
          data: {
            type: "appInfoLocalizations",
            attributes: { locale, ...attrs },
            relationships: { appInfo: { data: { type: "appInfos", id: editable.id } } },
          },
        });
      }
      if (meta.name) pushed.push("name");
      if (meta.subtitle) pushed.push("subtitle");
    } catch (e) {
      warnings.push(`Couldn't set name/subtitle (${(e as Error).message}).`);
    }
  }

  // ── 2. Description + keywords → appStoreVersionLocalizations ──────────────
  if (meta.description || meta.keywords) {
    try {
      const versions = await getList(
        auth,
        `/v1/apps/${ascAppId}/appStoreVersions?filter[platform]=IOS&limit=50`,
      );
      // iOS-only (filtered above); never touch a live version.
      const nonLive = (versions.data ?? []).filter((v) => !LIVE_STATES.has(appStoreState(v)));
      // Prefer the exact marketing version we're publishing, then any known
      // editable state, then any remaining non-live iOS version; create only
      // when that exact version doesn't exist yet.
      let version =
        nonLive.find((v) => v.attributes?.versionString === marketingVersion) ??
        nonLive.find((v) => EDITABLE_VERSION_STATES.has(appStoreState(v))) ??
        nonLive[0];
      if (!version) {
        // First submission and no editable iOS version yet — create one.
        version = await postResource(auth, `/v1/appStoreVersions`, {
          data: {
            type: "appStoreVersions",
            attributes: { platform: "IOS", versionString: marketingVersion },
            relationships: { app: { data: { type: "apps", id: ascAppId } } },
          },
        });
      }

      const locs = await getList(
        auth,
        `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=50`,
      );
      const loc = locs.data?.find((l) => l.attributes?.locale === locale);
      const attrs: Record<string, unknown> = {};
      if (meta.description) attrs.description = meta.description;
      if (meta.keywords) attrs.keywords = meta.keywords;

      if (loc) {
        await patchResource(
          auth,
          `/v1/appStoreVersionLocalizations/${loc.id}`,
          "appStoreVersionLocalizations",
          loc.id,
          attrs,
        );
      } else {
        await postResource(auth, `/v1/appStoreVersionLocalizations`, {
          data: {
            type: "appStoreVersionLocalizations",
            attributes: { locale, ...attrs },
            relationships: {
              appStoreVersion: { data: { type: "appStoreVersions", id: version.id } },
            },
          },
        });
      }
      if (meta.description) pushed.push("description");
      if (meta.keywords) pushed.push("keywords");
    } catch (e) {
      warnings.push(`Couldn't set description/keywords (${(e as Error).message}).`);
    }
  }

  return { pushed, warnings };
}
