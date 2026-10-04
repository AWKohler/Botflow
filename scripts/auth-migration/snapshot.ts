import { migrationArtifactPath } from "./artifacts";
/** Read-only Clerk export. Secrets are written only inside an AES-GCM envelope. */
import { config } from "dotenv";
config({
  path: process.env.AUTH_MIGRATION_ENV_FILE || ".env.local",
  quiet: true,
});
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import {
  encryptPrivateData,
  decryptPrivateData,
} from "../../src/lib/auth/crypto";
import { createHash } from "node:crypto";

async function clerk(path: string): Promise<unknown> {
  const secret = process.env.CLERK_MIGRATION_SECRET_KEY;
  if (!secret) throw new Error("CLERK_MIGRATION_SECRET_KEY is required");
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(`https://api.clerk.com/v1${path}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (response.status === 429 || response.status >= 500) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(30000, 1000 * 2 ** attempt)),
      );
      continue;
    }
    if (!response.ok)
      throw new Error(
        `Clerk request ${path.split("/")[1]} failed: ${response.status}`,
      );
    return response.json();
  }
  throw new Error("Clerk export retries exhausted");
}
export interface ClerkUser {
  id: string;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  image_url: string;
  primary_email_address_id: string;
  email_addresses: {
    id: string;
    email_address: string;
    verification?: { status: string };
  }[];
  public_metadata: Record<string, unknown>;
  private_metadata: Record<string, unknown>;
  unsafe_metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
  last_sign_in_at: number | null;
  password_enabled: boolean;
  password_last_updated_at?: number | null;
  banned: boolean;
  locked: boolean;
  two_factor_enabled: boolean;
  passkeys?: unknown[];
  external_accounts: {
    id: string;
    provider: string;
    provider_user_id: string;
    approved_scopes: string;
  }[];
}
export interface Snapshot {
  version: 1;
  exportedAt: string;
  instanceId: string;
  users: ClerkUser[];
  passwords: Record<
    string,
    { password_digest: string; password_hasher: string }
  >;
  tokens: Record<string, unknown>;
  subscriptions: Record<
    string,
    { id: string; subscription_items: SubscriptionItem[] }
  >;
  plans: unknown;
  digest: string;
}
export interface SubscriptionItem {
  id: string;
  status: string;
  plan_period: string;
  period_start: number;
  period_end: number;
  canceled_at: number | null;
  plan: {
    slug: string;
    fee: { amount: number; currency: string };
    annual_fee: { amount: number; currency: string };
  };
}
async function main() {
  const users: ClerkUser[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = (await clerk(
      `/users?limit=100&offset=${offset}`,
    )) as ClerkUser[];
    users.push(...page);
    if (page.length < 100) break;
  }
  const count = (await clerk("/users/count")) as { total_count: number };
  if (
    count.total_count !== users.length ||
    new Set(users.map((u) => u.id)).size !== users.length
  )
    throw new Error("User count changed during export; rerun snapshot");
  const passwords: Snapshot["passwords"] = {};
  const csvPath = process.argv
    .find((arg) => arg.startsWith("--passwords="))
    ?.slice("--passwords=".length);
  const reusePath = process.argv
    .find((arg) => arg.startsWith("--reuse-passwords-from="))
    ?.slice("--reuse-passwords-from=".length);
  if (csvPath && reusePath)
    throw new Error(
      "Select either a fresh CSV or verified prior password hashes",
    );
  let reusedInstance: string | undefined;
  if (reusePath) {
    const prior = decryptPrivateData<Snapshot>(
      await readFile(reusePath, "utf8"),
      "clerk-migration-snapshot",
    );
    reusedInstance = prior.instanceId;
    const previous = new Map(prior.users.map((user) => [user.id, user]));
    for (const user of users.filter((user) => user.password_enabled)) {
      const old = previous.get(user.id);
      if (
        !user.password_last_updated_at ||
        !old?.password_enabled ||
        old.password_last_updated_at !== user.password_last_updated_at ||
        !prior.passwords[user.id]?.password_digest
      )
        throw new Error(
          "A password changed or lacks a verified timestamp; a fresh Clerk CSV export is required",
        );
      passwords[user.id] = prior.passwords[user.id];
    }
  }
  if (csvPath) {
    const rows = parse(await readFile(csvPath, "utf8"), {
      columns: true,
      bom: true,
      skip_empty_lines: true,
    }) as Record<string, string>[];
    const csvIds = rows.map((row) => row.id);
    if (
      csvIds.length !== users.length ||
      new Set(csvIds).size !== users.length ||
      users.some((user) => !csvIds.includes(user.id))
    )
      throw new Error(
        "CSV user set differs from the current Clerk directory; export again",
      );
    for (const row of rows)
      if (row.password_digest)
        passwords[row.id] = {
          password_digest: row.password_digest,
          password_hasher: row.password_hasher,
        };
  }
  const subscriptions: Snapshot["subscriptions"] = {};
  const tokens: Snapshot["tokens"] = {};
  let instanceId = "";
  let unavailableTokens = 0;
  for (const user of users) {
    const subscription = (await clerk(
      `/users/${encodeURIComponent(user.id)}/billing/subscription`,
    )) as Snapshot["subscriptions"][string] & { instance_id: string };
    subscriptions[user.id] = subscription;
    if (instanceId && instanceId !== subscription.instance_id)
      throw new Error("Mixed Clerk instances");
    instanceId = subscription.instance_id;
    for (const provider of new Set(
      user.external_accounts.map((a) => a.provider),
    )) {
      try {
        tokens[`${user.id}:${provider}`] = await clerk(
          `/users/${encodeURIComponent(user.id)}/oauth_access_tokens/${encodeURIComponent(provider)}`,
        );
      } catch {
        unavailableTokens++;
        tokens[`${user.id}:${provider}`] = { unavailable: true };
      }
    }
  }
  if (reusedInstance && reusedInstance !== instanceId)
    throw new Error("Prior password export belongs to another Clerk instance");
  const payload = {
    version: 1 as const,
    exportedAt: new Date().toISOString(),
    instanceId,
    users,
    passwords,
    tokens,
    subscriptions,
    plans: await clerk("/billing/plans?limit=100"),
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
  await mkdir(migrationArtifactPath(), { recursive: true, mode: 0o700 });
  await writeFile(
    migrationArtifactPath("clerk-snapshot.enc"),
    encryptPrivateData({ ...payload, digest }, "clerk-migration-snapshot"),
    { mode: 0o600 },
  );
  const report = {
    instanceId,
    users: users.length,
    passwordAccounts: users.filter((u) => u.password_enabled).length,
    importedPasswordHashes: Object.keys(passwords).length,
    providerLinks: users.reduce((n, u) => n + u.external_accounts.length, 0),
    unavailableProviderTokens: unavailableTokens,
    digest,
  };
  await writeFile(
    migrationArtifactPath("snapshot-report.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report, null, 2));
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Snapshot failed");
  process.exitCode = 1;
});
