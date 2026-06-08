/**
 * Shared auth + lookup for the platform's RevenueCat proxy endpoints.
 *
 * The Convex actions scaffolded into user projects call back to the platform
 * with the project's per-project HMAC secret in the X-Botflow-Project-Secret
 * header. The user's RevenueCat secret key never enters the sandbox; the proxy
 * is the only place that can act against the user's RevenueCat project.
 *
 * Mirrors src/lib/stripe-proxy-auth.ts. On failure, returns
 * { ok: false, status, body } so the caller can NextResponse.json(body, { status }).
 */
import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { projects, userRevenueCatIdentity } from '@/db/schema';
import { decryptSecret } from '@/lib/secrets';

export interface RevenueCatProxyAuthSuccess {
  ok: true;
  project: typeof projects.$inferSelect;
  /** Decrypted RevenueCat secret key (sk_…). */
  secretKey: string;
  /** RevenueCat project id (proj…). */
  rcProjectId: string;
  userId: string;
}

export interface RevenueCatProxyAuthFailure {
  ok: false;
  status: number;
  body: { ok: false; error: string };
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function authRevenueCatProjectSecret(opts: {
  projectId: string;
  headerSecret: string | null;
}): Promise<RevenueCatProxyAuthSuccess | RevenueCatProxyAuthFailure> {
  const { projectId, headerSecret } = opts;
  if (!headerSecret) {
    return {
      ok: false,
      status: 401,
      body: { ok: false, error: 'Missing X-Botflow-Project-Secret header' },
    };
  }
  const db = getDb();
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) {
    return { ok: false, status: 404, body: { ok: false, error: 'Project not found' } };
  }
  if (!project.revenuecatWebhookSecret) {
    return {
      ok: false,
      status: 412,
      body: { ok: false, error: 'Project is not RevenueCat-enabled' },
    };
  }
  if (!constantTimeEqual(headerSecret, project.revenuecatWebhookSecret)) {
    return { ok: false, status: 403, body: { ok: false, error: 'Bad project secret' } };
  }
  const [identity] = await db
    .select()
    .from(userRevenueCatIdentity)
    .where(eq(userRevenueCatIdentity.userId, project.userId))
    .limit(1);
  const secretKey = decryptSecret(identity?.rcSecretKey);
  const rcProjectId = identity?.rcProjectId ?? project.revenuecatProjectId;
  if (!identity || !secretKey || !rcProjectId) {
    return {
      ok: false,
      status: 412,
      body: { ok: false, error: 'User has not linked a RevenueCat account' },
    };
  }
  return { ok: true, project, secretKey, rcProjectId, userId: project.userId };
}
