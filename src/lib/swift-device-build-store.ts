import { randomBytes, timingSafeEqual } from "node:crypto";

interface DeviceBuildOwnership {
  userId: string;
  projectId: string;
  downloadToken: string;
  createdAt: number;
}

const store = new Map<string, DeviceBuildOwnership>();

const TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

let sweeper: NodeJS.Timeout | null = null;
function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [buildId, ownership] of store) {
      if (now - ownership.createdAt > TTL_MS) store.delete(buildId);
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();
}

export function recordSwiftDeviceBuild(
  buildId: string,
  userId: string,
  projectId: string,
): string {
  ensureSweeper();
  const downloadToken = randomBytes(32).toString("base64url");
  store.set(buildId, {
    userId,
    projectId,
    downloadToken,
    createdAt: Date.now(),
  });
  return downloadToken;
}

export function ownsSwiftDeviceBuild(
  buildId: string,
  userId: string,
  projectId: string,
): boolean {
  const ownership = store.get(buildId);
  if (!ownership) return false;
  return ownership.userId === userId && ownership.projectId === projectId;
}

export function verifySwiftDeviceBuildDownloadToken(
  buildId: string,
  projectId: string,
  token: string | null,
): boolean {
  const ownership = store.get(buildId);
  if (!ownership || ownership.projectId !== projectId || !token) return false;
  const expected = Buffer.from(ownership.downloadToken);
  const provided = Buffer.from(token);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export function swiftDeviceBuildDownloadToken(buildId: string): string | null {
  return store.get(buildId)?.downloadToken ?? null;
}
