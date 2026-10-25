/**
 * Test identities. Only the SESSION is faked (who `auth()` says is calling);
 * users, emails, metadata and subscriptions are real rows in the test DB, read
 * by the real identity directory, tier and billing code.
 *
 *   await createUser({ id: 'u1', plan: 'pro', privateMetadata: { anthropicApiKey: 'sk-…' } })
 *   await signInAs('u1')        // creates a bare user if missing
 *   signOut()
 */
import { encryptPrivateData } from '@/lib/auth/crypto';
import { currentIdentityPool } from './db';

type Plan = 'pro' | 'max';

const session = { userId: null as string | null, impersonatedBy: null as string | null };

export function resetSession() {
  session.userId = null;
  session.impersonatedBy = null;
}

export function currentSessionUserId() {
  return session.userId;
}

export function currentSession() {
  return session.userId
    ? { user: { id: session.userId }, session: { id: `sess_${session.userId}`, impersonatedBy: session.impersonatedBy } }
    : null;
}

export async function createUser(u: {
  id: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  plan?: Plan;
  publicMetadata?: Record<string, unknown>;
  privateMetadata?: Record<string, unknown>;
}) {
  const pool = currentIdentityPool();
  const email = (u.email ?? `${u.id}@example.test`).toLowerCase();
  await pool.query(
    `INSERT INTO identity_user (id, name, email, "emailVerified") VALUES ($1, $2, $3, $4)`,
    [u.id, u.name ?? u.id, email, u.emailVerified ?? true],
  );
  await pool.query(
    `INSERT INTO identity_profile (user_id, public_metadata, private_metadata_encrypted) VALUES ($1, $2::jsonb, $3)`,
    [u.id, JSON.stringify(u.publicMetadata ?? {}), encryptPrivateData(u.privateMetadata ?? {}, `profile:${u.id}`)],
  );
  if (u.plan) await setPlan(u.id, u.plan);
  return { id: u.id, email };
}

/** Give a user an active paid subscription (direct Stripe billing). */
export async function setPlan(userId: string, plan: Plan | 'free') {
  await currentIdentityPool().query(
    `INSERT INTO botflow_subscription (user_id, source, plan, status, period_end)
     VALUES ($1, 'stripe', $2, 'active', now() + interval '30 days')
     ON CONFLICT (user_id) DO UPDATE SET plan = EXCLUDED.plan, status = 'active'`,
    [userId, plan],
  );
}

/** Add a secondary email address (alias) to a user. */
export async function addEmail(userId: string, email: string, verified = true) {
  await currentIdentityPool().query(
    `INSERT INTO identity_email (email, user_id, verified) VALUES (lower($1), $2, $3)`,
    [email, userId, verified],
  );
}

async function userExists(id: string) {
  const { rows } = await currentIdentityPool().query('SELECT 1 FROM identity_user WHERE id = $1', [id]);
  return rows.length > 0;
}

export async function signInAs(userId: string, opts: { plan?: Plan } = {}) {
  if (!(await userExists(userId))) await createUser({ id: userId, plan: opts.plan });
  else if (opts.plan) await setPlan(userId, opts.plan);
  session.userId = userId;
}

export function signOut() {
  session.userId = null;
}
