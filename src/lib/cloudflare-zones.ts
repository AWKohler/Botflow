/**
 * Cloudflare Zones API helpers — used by the managed-domains feature.
 *
 * Requires CLOUDFLARE_API_TOKEN to have Zone:Edit + Zone:Read + DNS:Edit
 * scopes (in addition to the Pages scopes the publish flow needs).
 */

const CF_BASE = 'https://api.cloudflare.com/client/v4';

export interface CfResult<T> {
  result: T;
  result_info?: unknown;
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  messages?: Array<{ code: number; message: string }>;
}

function getCfConfig() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set');
  }
  return { accountId, apiToken };
}

async function cfFetch<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<CfResult<T>> {
  const { apiToken } = getCfConfig();
  const headers: Record<string, string> = { Authorization: `Bearer ${apiToken}` };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(CF_BASE + path, {
    method: opts.method ?? (body ? 'POST' : 'GET'),
    headers,
    body,
  });
  return (await res.json()) as CfResult<T>;
}

export type ZoneStatus = 'initializing' | 'pending' | 'active' | 'moved' | 'deactivated' | 'read only';

export interface CfZone {
  id: string;
  name: string;
  status: ZoneStatus;
  name_servers: string[];
  original_name_servers?: string[];
  paused: boolean;
  type: string;
}

export interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  priority?: number;
  proxied: boolean;
  zone_id: string;
}

export interface CreateDnsRecordInput {
  type: string;
  name: string;
  content: string;
  ttl?: number;     // 1 = auto
  priority?: number; // MX only
  proxied?: boolean;
  comment?: string;
}

export type UpdateDnsRecordInput = Partial<CreateDnsRecordInput>;

// ─── Zones ────────────────────────────────────────────────────────────────

/** Look up a zone by exact apex name. Returns null if not found. */
export async function findZoneByName(apexDomain: string): Promise<CfZone | null> {
  const res = await cfFetch<CfZone[]>(`/zones?name=${encodeURIComponent(apexDomain)}`);
  if (!res.success) return null;
  return res.result?.[0] ?? null;
}

/**
 * Create a new zone, or adopt an existing one already under the account.
 * Idempotent — if the zone already exists (CF error 1061) we look it up and return it.
 * After adoption, we kick activation_check so the zone's status reflects whether
 * NS records at the registrar still point at CF (otherwise it can sit "active"
 * indefinitely even though the world has moved on).
 */
export async function createZone(apexDomain: string): Promise<CfZone> {
  const { accountId } = getCfConfig();
  const res = await cfFetch<CfZone>('/zones', {
    body: {
      name: apexDomain,
      account: { id: accountId },
      type: 'full',
    },
  });
  if (res.success) return res.result;

  // 1061 = zone already exists in this CF account → adopt it
  const isAlreadyExists = res.errors?.some(e => e.code === 1061 || /already exists/i.test(e.message ?? ''));
  if (isAlreadyExists) {
    const existing = await findZoneByName(apexDomain);
    if (existing) {
      // Re-validate NS so we don't trust a stale "active" status.
      await activationCheck(existing.id).catch(() => {});
      const refreshed = await getZone(existing.id).catch(() => null);
      return refreshed ?? existing;
    }
  }
  throw new Error(`CF createZone failed: ${JSON.stringify(res.errors)}`);
}

export async function getZone(zoneId: string): Promise<CfZone> {
  const res = await cfFetch<CfZone>(`/zones/${zoneId}`);
  if (!res.success) throw new Error(`CF getZone failed: ${JSON.stringify(res.errors)}`);
  return res.result;
}

export async function deleteZone(zoneId: string): Promise<void> {
  const res = await cfFetch(`/zones/${zoneId}`, { method: 'DELETE' });
  if (!res.success) {
    // ignore 81044 (zone not found / already deleted)
    const onlyMissing = res.errors?.every(e => e.code === 81044 || e.code === 7003);
    if (!onlyMissing) throw new Error(`CF deleteZone failed: ${JSON.stringify(res.errors)}`);
  }
}

/** Ask CF to re-check the registrar's NS records and activate the zone. */
export async function activationCheck(zoneId: string): Promise<void> {
  await cfFetch(`/zones/${zoneId}/activation_check`, { method: 'PUT' });
  // Best-effort — ignore failures; status will still update on next getZone.
}

// ─── DNS records ──────────────────────────────────────────────────────────

export async function listDnsRecords(zoneId: string): Promise<CfDnsRecord[]> {
  // CF paginates by default at 100 — plenty for our use case.
  const res = await cfFetch<CfDnsRecord[]>(`/zones/${zoneId}/dns_records?per_page=100`);
  if (!res.success) throw new Error(`CF listDnsRecords failed: ${JSON.stringify(res.errors)}`);
  return res.result;
}

export async function createDnsRecord(zoneId: string, input: CreateDnsRecordInput): Promise<CfDnsRecord> {
  const res = await cfFetch<CfDnsRecord>(`/zones/${zoneId}/dns_records`, { body: input });
  if (!res.success) throw new Error(`CF createDnsRecord failed: ${JSON.stringify(res.errors)}`);
  return res.result;
}

export async function updateDnsRecord(
  zoneId: string,
  recordId: string,
  input: UpdateDnsRecordInput,
): Promise<CfDnsRecord> {
  const res = await cfFetch<CfDnsRecord>(`/zones/${zoneId}/dns_records/${recordId}`, {
    method: 'PATCH',
    body: input,
  });
  if (!res.success) throw new Error(`CF updateDnsRecord failed: ${JSON.stringify(res.errors)}`);
  return res.result;
}

export async function deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
  const res = await cfFetch(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
  if (!res.success) {
    const onlyMissing = res.errors?.every(e => e.code === 81044 || e.code === 81012);
    if (!onlyMissing) throw new Error(`CF deleteDnsRecord failed: ${JSON.stringify(res.errors)}`);
  }
}

/** Upsert: find a record matching {type,name}, update its content/ttl/proxied; create if missing. */
export async function upsertDnsRecord(zoneId: string, input: CreateDnsRecordInput): Promise<CfDnsRecord> {
  const all = await listDnsRecords(zoneId);
  const fullName = input.name.includes('.') ? input.name : input.name; // CF stores fully-qualified
  const match = all.find(r => r.type === input.type && (r.name === fullName || r.name.startsWith(input.name + '.')));
  if (match) return updateDnsRecord(zoneId, match.id, input);
  return createDnsRecord(zoneId, input);
}

// ─── Pages custom-domain attach ───────────────────────────────────────────
// Attach a managed hostname to a CF Pages project so the SSL cert + routing
// just work. This is the bit that hooks a user's managed domain to their
// deployed app.
export async function attachPagesCustomDomain(pagesProjectName: string, hostname: string): Promise<void> {
  const { accountId } = getCfConfig();
  const res = await cfFetch(`/accounts/${accountId}/pages/projects/${pagesProjectName}/domains`, {
    body: { name: hostname },
  });
  if (!res.success) {
    // 8000040 = "domain already attached" — treat as success
    const ok = res.errors?.some(e => e.code === 8000040 || e.message?.toLowerCase().includes('already'));
    if (!ok) throw new Error(`CF attachPagesCustomDomain failed: ${JSON.stringify(res.errors)}`);
  }
}

export async function detachPagesCustomDomain(pagesProjectName: string, hostname: string): Promise<void> {
  const { accountId } = getCfConfig();
  const res = await cfFetch(
    `/accounts/${accountId}/pages/projects/${pagesProjectName}/domains/${encodeURIComponent(hostname)}`,
    { method: 'DELETE' },
  );
  if (!res.success) {
    const ok = res.errors?.every(e => e.code === 8000007 || e.code === 8000040);
    if (!ok) {
      // Non-fatal — log only.
      console.warn(`CF detachPagesCustomDomain warn: ${JSON.stringify(res.errors)}`);
    }
  }
}

// ─── White-label branded deployment domain ─────────────────────────────────
// Every deployment is fronted by `<project>.<CLOUDFLARE_BRANDED_DOMAIN>` instead
// of the raw `<project>.pages.dev`. This is a plain white-label of Pages, not the
// user-supplied custom-domain perk — it applies to all tiers.

let brandedZoneIdCache: string | null | undefined;

/**
 * Zone id for the platform's white-label domain (CLOUDFLARE_BRANDED_DOMAIN).
 * Cached for the lifetime of the server process. Prefer CLOUDFLARE_BRANDED_ZONE_ID
 * when set to avoid a zone lookup; otherwise resolve it by name once.
 * Returns null when no branded domain is configured or no matching zone exists.
 */
export async function getBrandedZoneId(): Promise<string | null> {
  const branded = process.env.CLOUDFLARE_BRANDED_DOMAIN;
  if (!branded) return null;
  if (brandedZoneIdCache !== undefined) return brandedZoneIdCache;
  if (process.env.CLOUDFLARE_BRANDED_ZONE_ID) {
    brandedZoneIdCache = process.env.CLOUDFLARE_BRANDED_ZONE_ID;
    return brandedZoneIdCache;
  }
  const zone = await findZoneByName(branded);
  brandedZoneIdCache = zone?.id ?? null;
  return brandedZoneIdCache;
}

/**
 * Point a branded subdomain (e.g. `bf-xxxxxxxx.botflow-site.app`) at a Pages
 * project. Attaches the custom domain AND creates the proxied CNAME the hostname
 * needs to resolve. Cloudflare does NOT auto-create that DNS record when you attach
 * a Pages custom domain — without it the domain sits in "initializing" forever and
 * the cert never validates. Both steps are idempotent.
 */
export async function attachBrandedSubdomain(
  pagesProjectName: string,
  hostname: string,
  zoneId: string,
): Promise<void> {
  await attachPagesCustomDomain(pagesProjectName, hostname);
  await upsertDnsRecord(zoneId, {
    type: 'CNAME',
    name: hostname,
    content: `${pagesProjectName}.pages.dev`,
    proxied: true,
    comment: 'Botflow white-label deployment domain',
  });
}

/** Tear down a branded subdomain: detach the Pages custom domain and remove its CNAME. */
export async function removeBrandedSubdomain(
  pagesProjectName: string,
  hostname: string,
  zoneId: string,
): Promise<void> {
  await detachPagesCustomDomain(pagesProjectName, hostname).catch(() => {});
  const records = await listDnsRecords(zoneId).catch(() => [] as CfDnsRecord[]);
  const match = records.find(r => r.type === 'CNAME' && r.name === hostname);
  if (match) await deleteDnsRecord(zoneId, match.id).catch(() => {});
}
