/**
 * Ownership store for App Store / TestFlight publish builds.
 *
 * Backed by Redis (Upstash), NOT an in-memory Map: on Vercel each request can
 * hit a different serverless instance, so the POST that records ownership and
 * the later status polls run in separate processes (same rationale as
 * swift-device-build-store.ts). No download token here — publish builds have
 * no client-downloadable artifact; the .ipa goes straight to Apple.
 *
 * TTL is 2h: archive + signed export + upload + the wizard's "Apple is
 * processing" polling can comfortably outlast the device-build 30 min window.
 */

import { redis } from "./redis";

interface PublishBuildOwnership {
  userId: string;
  projectId: string;
  createdAt: number;
}

const TTL_SECONDS = 2 * 60 * 60;
const keyFor = (buildId: string): string => `swift-publish:${buildId}`;

export async function recordSwiftPublishBuild(
  buildId: string,
  userId: string,
  projectId: string,
): Promise<void> {
  const ownership: PublishBuildOwnership = {
    userId,
    projectId,
    createdAt: Date.now(),
  };
  await redis.set(keyFor(buildId), ownership, { ex: TTL_SECONDS });
}

export async function ownsSwiftPublishBuild(
  buildId: string,
  userId: string,
  projectId: string,
): Promise<boolean> {
  const key = keyFor(buildId);
  const ownership = (await redis.get<PublishBuildOwnership>(key)) ?? null;
  if (!ownership) return false;
  const owns = ownership.userId === userId && ownership.projectId === projectId;
  // Sliding TTL: while the owner keeps polling, refresh the window so a long
  // Apple-processing wait can't expire ownership and 404 an authorized poll.
  if (owns) {
    try {
      await redis.expire(key, TTL_SECONDS);
    } catch {
      /* non-fatal — the original fixed TTL still applies */
    }
  }
  return owns;
}
