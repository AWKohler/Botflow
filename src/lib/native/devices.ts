/**
 * Where to reach a person's Botflow iOS app: their devices' push tokens and
 * the Live Activity tokens of agents they are following. Kept in Redis with a
 * rolling expiry; a token that stops being refreshed (app deleted, signed
 * out) simply ages out.
 */
import { redis } from "@/lib/redis";

export type ApnsEnvironment = "development" | "production";

export interface NativeDevice {
  token: string;
  environment: ApnsEnvironment;
  bundleId: string;
  at: number;
}

export interface LiveActivityTarget {
  token: string;
  environment: ApnsEnvironment;
  projectId: string;
  at: number;
}

const DEVICE_TTL_SECONDS = 60 * 24 * 60 * 60;
const ACTIVITY_TTL_SECONDS = 8 * 60 * 60;
const MAX_DEVICES = 10;

export const APNS_TOKEN_PATTERN = /^[0-9a-f]{64,400}$/;

const devicesKey = (userId: string) => `native:devices:${userId}`;
const activityKey = (threadId: string, userId: string) => `native:activity:${threadId}:${userId}`;

function parse<T>(value: unknown): T | null {
  if (!value) return null;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/** One JSON list per person: small, and plain get/set keeps it portable. */
async function writeDevices(userId: string, devices: NativeDevice[]): Promise<void> {
  if (devices.length === 0) {
    await redis.del(devicesKey(userId));
    return;
  }
  await redis.setex(devicesKey(userId), DEVICE_TTL_SECONDS, JSON.stringify(devices));
}

export async function registerDevice(userId: string, device: Omit<NativeDevice, "at">): Promise<void> {
  const others = (await listDevices(userId)).filter((d) => d.token !== device.token);
  // Newest first; a person reinstalling many times should not grow this without bound.
  await writeDevices(userId, [{ ...device, at: Date.now() }, ...others].slice(0, MAX_DEVICES));
}

export async function listDevices(userId: string): Promise<NativeDevice[]> {
  try {
    const list = parse<NativeDevice[]>(await redis.get(devicesKey(userId)));
    return Array.isArray(list) ? list.filter((d) => Boolean(d?.token)) : [];
  } catch {
    return [];
  }
}

export async function hasDevices(userId: string): Promise<boolean> {
  return (await listDevices(userId)).length > 0;
}

export async function removeDevice(userId: string, token: string): Promise<void> {
  await writeDevices(userId, (await listDevices(userId)).filter((d) => d.token !== token));
}

export async function removeAllDevices(userId: string): Promise<void> {
  await redis.del(devicesKey(userId));
}

export async function registerLiveActivity(
  userId: string,
  threadId: string,
  target: Omit<LiveActivityTarget, "at">,
): Promise<void> {
  await redis.setex(activityKey(threadId, userId), ACTIVITY_TTL_SECONDS, JSON.stringify({ ...target, at: Date.now() }));
}

export async function getLiveActivity(userId: string, threadId: string): Promise<LiveActivityTarget | null> {
  try {
    return parse<LiveActivityTarget>(await redis.get(activityKey(threadId, userId)));
  } catch {
    return null;
  }
}

export async function clearLiveActivity(userId: string, threadId: string): Promise<void> {
  await redis.del(activityKey(threadId, userId));
}
