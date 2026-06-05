/**
 * Ownership + download-token store for physical-device (.ipa) builds.
 *
 * Backed by Redis (Upstash), NOT an in-memory Map: on Vercel each request can
 * hit a different serverless instance, so the POST that records ownership and
 * the later GET/IPA requests that check it run in separate processes. An
 * in-memory Map silently returns "not found" cross-instance — which is exactly
 * the bug this replaces.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { redis } from "./redis";

interface DeviceBuildOwnership {
  userId: string;
  projectId: string;
  downloadToken: string;
  createdAt: number;
}

const TTL_SECONDS = 30 * 60;
const keyFor = (buildId: string): string => `swiftdev:build:${buildId}`;

async function getOwnership(buildId: string): Promise<DeviceBuildOwnership | null> {
  return (await redis.get<DeviceBuildOwnership>(keyFor(buildId))) ?? null;
}

export async function recordSwiftDeviceBuild(
  buildId: string,
  userId: string,
  projectId: string,
): Promise<string> {
  const downloadToken = randomBytes(32).toString("base64url");
  const ownership: DeviceBuildOwnership = {
    userId,
    projectId,
    downloadToken,
    createdAt: Date.now(),
  };
  await redis.set(keyFor(buildId), ownership, { ex: TTL_SECONDS });
  return downloadToken;
}

export async function ownsSwiftDeviceBuild(
  buildId: string,
  userId: string,
  projectId: string,
): Promise<boolean> {
  const ownership = await getOwnership(buildId);
  if (!ownership) return false;
  return ownership.userId === userId && ownership.projectId === projectId;
}

export async function verifySwiftDeviceBuildDownloadToken(
  buildId: string,
  projectId: string,
  token: string | null,
): Promise<boolean> {
  const ownership = await getOwnership(buildId);
  if (!ownership || ownership.projectId !== projectId || !token) return false;
  const expected = Buffer.from(ownership.downloadToken);
  const provided = Buffer.from(token);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export async function swiftDeviceBuildDownloadToken(
  buildId: string,
): Promise<string | null> {
  return (await getOwnership(buildId))?.downloadToken ?? null;
}
