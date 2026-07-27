// Server-side HTTP client for the Mac simulator controller.
// Used by the swift-preview API routes to provision sessions and ship build
// tarballs across the Tailscale Funnel / Cloudflare Tunnel boundary.

export type SimDeviceModel = "iPhone-16-Pro" | "iPad-Pro";
export type SimOrientation = "portrait" | "landscape";

export interface CreateSessionInput {
  deviceModel?: SimDeviceModel;
  orientation?: SimOrientation;
  awaitBuild?: boolean;
}

export interface CreateSessionResult {
  sessionId: string;
  state: string;
  deviceModel: string;
  orientation?: SimOrientation;
  queuePosition: number | null;
  createdAt: number;
  hostId: string | null;
  // Per-session capability secret for the browser stream WS. Returned only by
  // the controller's create endpoint; must be appended to the WS URL.
  streamToken?: string;
}

export interface UploadBuildInput {
  scheme?: string;
  bundleId?: string;
}

export interface DeviceBuildLogLine {
  line: string;
  stream: "stdout" | "stderr";
  at: number;
}

export interface DeviceBuildSummary {
  buildId: string;
  state: "queued" | "building" | "succeeded" | "failed";
  createdAt: number;
  updatedAt: number;
  hostId: string | null;
  scheme?: string;
  bundleId?: string;
  durationMs?: number;
  unsigned?: boolean;
  diagnostics: Array<{
    severity: "error" | "warning";
    file: string | null;
    line: number | null;
    column: number | null;
    message: string;
    snippet: string[] | null;
  }>;
  logs: DeviceBuildLogLine[];
  error?: string;
  ipaUrl: string | null;
}

function controllerBase(): { http: string; ws: string } {
  const http = process.env.SIM_CONTROLLER_URL;
  if (!http) {
    throw new Error("SIM_CONTROLLER_URL is not set");
  }
  const trimmedHttp = http.replace(/\/$/, "");
  // The browser-visible WS URL — same host, switched scheme. Configurable so a
  // future split (proxy WS through different ingress) is one-env-change away.
  const wsOverride = process.env.NEXT_PUBLIC_SIM_CONTROLLER_WS_URL;
  const ws = (wsOverride ?? trimmedHttp).replace(/^http/, "ws").replace(/\/$/, "");
  return { http: trimmedHttp, ws };
}

function platformToken(): string {
  const t = process.env.SIM_PLATFORM_TOKEN;
  if (!t) throw new Error("SIM_PLATFORM_TOKEN is not set");
  return t;
}

async function jsonOrText(res: Response): Promise<string> {
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    // Cap even JSON errors — they end up in user-facing toasts.
    return (body?.error ?? JSON.stringify(body)).slice(0, 300);
  }
  // Non-JSON body = the error came from infrastructure in front of the
  // controller (Cloudflare / a proxy), not from the controller itself. Its
  // HTML error pages are huge (break the toast UI) and leak infra details
  // (hostnames, ray IDs, tunnel config) — never surface them. Map the status
  // to a short human message instead.
  const infra: Record<number, string> = {
    502: "the simulator service is not responding",
    503: "the simulator service is unavailable",
    504: "the simulator service timed out",
    521: "the simulator service is down",
    522: "the connection to the simulator service timed out",
    523: "the simulator service is unreachable",
    530: "the simulator service is offline",
  };
  return `${infra[res.status] ?? "the simulator service returned an unexpected response"} — please try again in a moment`;
}

export async function createSession(
  input: CreateSessionInput = {},
): Promise<CreateSessionResult> {
  const { http } = controllerBase();
  const res = await fetch(`${http}/api/sessions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-platform-token": platformToken(),
    },
    body: JSON.stringify({
      deviceModel: input.deviceModel ?? "iPhone-16-Pro",
      ...(input.orientation ? { orientation: input.orientation } : {}),
      awaitBuild: input.awaitBuild ?? true,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `createSession failed (${res.status}): ${await jsonOrText(res)}`,
    );
  }
  return (await res.json()) as CreateSessionResult;
}

export async function uploadBuild(
  sessionId: string,
  tarball: Buffer,
  input: UploadBuildInput = {},
): Promise<void> {
  const { http } = controllerBase();
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "content-length": String(tarball.length),
    "x-platform-token": platformToken(),
  };
  if (input.scheme) headers["x-build-scheme"] = input.scheme;
  if (input.bundleId) headers["x-build-bundle-id"] = input.bundleId;

  // Buffer is a Uint8Array subclass; node:fetch accepts it but TS types are
  // narrower than reality. Cast to BodyInit explicitly.
  const res = await fetch(`${http}/api/sessions/${sessionId}/build`, {
    method: "POST",
    headers,
    body: tarball as unknown as BodyInit,
  });
  if (!res.ok) {
    throw new Error(
      `uploadBuild failed (${res.status}): ${await jsonOrText(res)}`,
    );
  }
}

export async function releaseSession(sessionId: string): Promise<void> {
  const { http } = controllerBase();
  const res = await fetch(`${http}/api/sessions/${sessionId}`, {
    method: "DELETE",
    headers: { "x-platform-token": platformToken() },
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(
      `releaseSession failed (${res.status}): ${await jsonOrText(res)}`,
    );
  }
}

export async function createDeviceBuild(
  tarball: Buffer,
  input: UploadBuildInput = {},
): Promise<DeviceBuildSummary> {
  const { http } = controllerBase();
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "content-length": String(tarball.length),
    "x-platform-token": platformToken(),
  };
  if (input.scheme) headers["x-build-scheme"] = input.scheme;
  if (input.bundleId) headers["x-build-bundle-id"] = input.bundleId;

  const res = await fetch(`${http}/api/device-builds`, {
    method: "POST",
    headers,
    body: tarball as unknown as BodyInit,
  });
  if (!res.ok) {
    throw new Error(
      `createDeviceBuild failed (${res.status}): ${await jsonOrText(res)}`,
    );
  }
  return (await res.json()) as DeviceBuildSummary;
}

export async function getDeviceBuild(buildId: string): Promise<DeviceBuildSummary> {
  const { http } = controllerBase();
  const res = await fetch(`${http}/api/device-builds/${buildId}`, {
    headers: { "x-platform-token": platformToken() },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(
      `getDeviceBuild failed (${res.status}): ${await jsonOrText(res)}`,
    );
  }
  return (await res.json()) as DeviceBuildSummary;
}

export async function downloadDeviceBuildIpa(buildId: string): Promise<{
  bytes: ArrayBuffer;
  contentType: string;
  contentDisposition: string | null;
}> {
  const { http } = controllerBase();
  const res = await fetch(`${http}/api/device-builds/${buildId}/ipa`, {
    headers: { "x-platform-token": platformToken() },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(
      `downloadDeviceBuildIpa failed (${res.status}): ${await jsonOrText(res)}`,
    );
  }
  return {
    bytes: await res.arrayBuffer(),
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
    contentDisposition: res.headers.get("content-disposition"),
  };
}

// --- App Store / TestFlight publish builds ---------------------------------

export type AppStoreBuildState =
  | "queued"
  | "building"
  | "exporting"
  | "uploading"
  | "succeeded"
  | "failed";

export interface AppStoreBuildSummary {
  buildId: string;
  // 'succeeded' means Apple accepted the upload — it may still be PROCESSING
  // server-side at Apple; the publish status route enriches with that.
  state: AppStoreBuildState;
  createdAt: number;
  updatedAt: number;
  hostId: string | null;
  scheme?: string;
  bundleId?: string;
  marketingVersion?: string;
  buildNumber?: string;
  durationMs?: number;
  diagnostics: Array<{
    severity: "error" | "warning";
    file: string | null;
    line: number | null;
    column: number | null;
    message: string;
    snippet: string[] | null;
  }>;
  logs: DeviceBuildLogLine[];
  error?: string;
}

export interface SubmitAppStoreBuildParams {
  teamId: string;
  keyId: string;
  issuerId: string;
  /** Base64 of the .p8 PEM (header-safe transport encoding). */
  p8Base64: string;
  /** ASC `apps` resource id for the existing app record. */
  ascAppId: string;
  bundleId: string;
  marketingVersion: string;
  buildNumber: string;
  scheme?: string;
}

export async function submitAppStoreBuild(
  tarball: Buffer,
  params: SubmitAppStoreBuildParams,
): Promise<AppStoreBuildSummary> {
  const { http } = controllerBase();
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "content-length": String(tarball.length),
    "x-platform-token": platformToken(),
    "x-team-id": params.teamId,
    "x-asc-key-id": params.keyId,
    "x-asc-issuer-id": params.issuerId,
    "x-asc-p8": params.p8Base64,
    "x-asc-app-id": params.ascAppId,
    "x-bundle-id": params.bundleId,
    "x-marketing-version": params.marketingVersion,
    "x-build-number": params.buildNumber,
  };
  if (params.scheme) headers["x-build-scheme"] = params.scheme;

  const res = await fetch(`${http}/api/app-store-builds`, {
    method: "POST",
    headers,
    body: tarball as unknown as BodyInit,
  });
  if (!res.ok) {
    throw new Error(
      `submitAppStoreBuild failed (${res.status}): ${await jsonOrText(res)}`,
    );
  }
  return (await res.json()) as AppStoreBuildSummary;
}

export async function getAppStoreBuildStatus(
  buildId: string,
): Promise<AppStoreBuildSummary> {
  const { http } = controllerBase();
  const res = await fetch(`${http}/api/app-store-builds/${buildId}`, {
    headers: { "x-platform-token": platformToken() },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(
      `getAppStoreBuildStatus failed (${res.status}): ${await jsonOrText(res)}`,
    );
  }
  return (await res.json()) as AppStoreBuildSummary;
}

/**
 * Build the browser-facing WSS URL for a given session. Used by the
 * swift-preview/start route to hand the client a URL it can hit directly.
 *
 * The per-session `streamToken` (from createSession) is appended as a query
 * param: in secured mode the controller rejects session WS upgrades whose token
 * doesn't match, so a leaked/guessed sessionId alone can't open a stream.
 */
export function sessionWsUrl(sessionId: string, streamToken?: string): string {
  const { ws } = controllerBase();
  const base = `${ws}/ws/session/${sessionId}`;
  return streamToken ? `${base}?token=${encodeURIComponent(streamToken)}` : base;
}
