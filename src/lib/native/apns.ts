/**
 * Apple Push Notification service client for the Botflow iOS app: alerts
 * ("your agent finished") and Live Activity updates (the agent's current step
 * in the Dynamic Island).
 *
 * Token-based auth (a .p8 key, ES256). Off unless all of APNS_KEY_ID,
 * APNS_TEAM_ID and APNS_PRIVATE_KEY are set, so environments without an Apple
 * key behave exactly as before.
 */
import { createSign } from "node:crypto";
import http2 from "node:http2";
import type { ApnsEnvironment } from "./devices";

const HOSTS: Record<ApnsEnvironment, string> = {
  production: "https://api.push.apple.com",
  development: "https://api.sandbox.push.apple.com",
};

export const DEFAULT_BUNDLE_ID = "io.botflow.app";

interface ApnsConfig {
  keyId: string;
  teamId: string;
  privateKey: string;
}

export function apnsConfig(): ApnsConfig | null {
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const privateKey = process.env.APNS_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!keyId || !teamId || !privateKey) return null;
  return { keyId, teamId, privateKey };
}

export function isApnsConfigured(): boolean {
  return apnsConfig() !== null;
}

// Apple rejects provider tokens older than an hour and throttles ones minted
// more often than every 20 minutes, so one token is reused for 40 minutes.
let cachedToken: { value: string; mintedAt: number; keyId: string } | null = null;
const TOKEN_LIFETIME_MS = 40 * 60 * 1000;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function providerToken(config: ApnsConfig, now = Date.now()): string {
  if (cachedToken && cachedToken.keyId === config.keyId && now - cachedToken.mintedAt < TOKEN_LIFETIME_MS) {
    return cachedToken.value;
  }
  const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(now / 1000) }));
  const signer = createSign("SHA256");
  signer.update(`${header}.${claims}`);
  const signature = signer.sign({ key: config.privateKey, dsaEncoding: "ieee-p1363" });
  const value = `${header}.${claims}.${base64url(signature)}`;
  cachedToken = { value, mintedAt: now, keyId: config.keyId };
  return value;
}

export interface ApnsRequest {
  deviceToken: string;
  environment: ApnsEnvironment;
  /** The bundle id for alerts; `<bundle id>.push-type.liveactivity` for Live Activities. */
  topic: string;
  pushType: "alert" | "liveactivity" | "background";
  priority?: 5 | 10;
  collapseId?: string;
  expiresAt?: number;
  payload: unknown;
}

export interface ApnsResult {
  ok: boolean;
  status: number;
  /** Apple's reason string on failure, e.g. "BadDeviceToken", "Unregistered". */
  reason?: string;
}

/** Tokens Apple says will never work again; callers drop them. */
export function isDeadToken(result: ApnsResult): boolean {
  return result.status === 410 || result.reason === "BadDeviceToken" || result.reason === "Unregistered";
}

export type ApnsTransport = (request: ApnsRequest, authorization: string) => Promise<ApnsResult>;

const http2Transport: ApnsTransport = (request, authorization) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (result: ApnsResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const client = http2.connect(HOSTS[request.environment]);
    client.on("error", () => finish({ ok: false, status: 0, reason: "ConnectionError" }));
    const timer = setTimeout(() => {
      finish({ ok: false, status: 0, reason: "Timeout" });
      client.destroy();
    }, 8000);

    const headers: http2.OutgoingHttpHeaders = {
      ":method": "POST",
      ":path": `/3/device/${request.deviceToken}`,
      authorization,
      "apns-topic": request.topic,
      "apns-push-type": request.pushType,
      "apns-priority": String(request.priority ?? 10),
      "content-type": "application/json",
    };
    if (request.collapseId) headers["apns-collapse-id"] = request.collapseId.slice(0, 64);
    if (request.expiresAt) headers["apns-expiration"] = String(Math.floor(request.expiresAt / 1000));

    const stream = client.request(headers);
    let status = 0;
    let body = "";
    stream.setEncoding("utf8");
    stream.on("response", (responseHeaders) => {
      status = Number(responseHeaders[":status"] ?? 0);
    });
    stream.on("data", (chunk: string) => {
      body += chunk;
    });
    stream.on("error", () => finish({ ok: false, status: 0, reason: "StreamError" }));
    stream.on("end", () => {
      clearTimeout(timer);
      client.close();
      let reason: string | undefined;
      try {
        reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined;
      } catch {
        reason = undefined;
      }
      finish({ ok: status === 200, status, reason });
    });
    stream.end(JSON.stringify(request.payload));
  });

let transport: ApnsTransport = http2Transport;

/** Tests swap the network out; returns a function that restores it. */
export function setApnsTransportForTests(replacement: ApnsTransport): () => void {
  const previous = transport;
  transport = replacement;
  return () => {
    transport = previous;
  };
}

export async function sendApns(request: ApnsRequest): Promise<ApnsResult> {
  const config = apnsConfig();
  if (!config) return { ok: false, status: 0, reason: "NotConfigured" };
  try {
    return await transport(request, `bearer ${providerToken(config)}`);
  } catch {
    return { ok: false, status: 0, reason: "SendFailed" };
  }
}
