/** Close the legacy login path after native identity and billing are verified. */
import { config } from "dotenv";
config({
  path: process.env.AUTH_MIGRATION_ENV_FILE || ".env.local",
  quiet: true,
});
import { readFile, writeFile } from "node:fs/promises";
import { migrationArtifactPath } from "./artifacts";
import {
  decryptPrivateData,
  encryptPrivateData,
} from "../../src/lib/auth/crypto";
import { getIdentityDb } from "../../src/lib/auth/database";
interface Retirement {
  instanceId: string;
  users: { id: string; banned: boolean; locked: boolean }[];
  state: "prepared" | "retired";
  retiredAt?: string;
}
async function clerk(path: string, method = "GET") {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(`https://api.clerk.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.CLERK_MIGRATION_SECRET_KEY}`,
      },
    });
    if (response.status === 429 || response.status >= 500) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(30000, 1000 * 2 ** attempt)),
      );
      continue;
    }
    if (!response.ok)
      throw new Error(`Legacy retirement request failed (${response.status})`);
    return response.json();
  }
  throw new Error(
    "Legacy retirement retries exhausted; rerun the same checkpoint",
  );
}
async function main() {
  if (
    process.env.AUTH_MIGRATION_TARGET !== "production" ||
    process.env.BILLING_STRIPE_MODE !== "live"
  )
    throw new Error("Production/live configuration required");
  const instance = await clerk("/instance");
  if (
    instance.id !== process.env.CLERK_MIGRATION_INSTANCE_ID ||
    instance.environment_type !== "production"
  )
    throw new Error("Source instance mismatch");
  const freeze = decryptPrivateData<{
    instanceId: string;
    state: string;
    originalUsers: Retirement["users"];
  }>(
    await readFile(migrationArtifactPath("source-freeze.enc"), "utf8"),
    "clerk-source-freeze",
  );
  const billing = JSON.parse(
    await readFile(
      migrationArtifactPath("billing-cutover-checkpoint.json"),
      "utf8",
    ),
  );
  const delivery = JSON.parse(
    await readFile(migrationArtifactPath("live-webhook-verified.json"), "utf8"),
  );
  if (
    freeze.instanceId !== instance.id ||
    freeze.state !== "frozen" ||
    billing.step !== "verified-complete" ||
    !delivery.realStripeDeliveryProcessed
  )
    throw new Error("Verified native identity and billing cutover required");
  const settings = await fetch("https://clerk.botflow.io/v1/environment").then(
    (response) => {
      if (!response.ok)
        throw new Error("Cannot verify source sign-up restriction");
      return response.json();
    },
  );
  if (!settings.user_settings.restrictions.allowlist.enabled)
    throw new Error("Legacy sign-up must remain closed");
  const allowed = await clerk("/allowlist_identifiers?limit=1");
  if ((Array.isArray(allowed) ? allowed : allowed.data).length)
    throw new Error("Legacy allowlist must remain empty");
  const users: { id: string; banned: boolean }[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = (await clerk(
      `/users?limit=100&offset=${offset}`,
    )) as typeof users;
    users.push(...page);
    if (page.length < 100) break;
  }
  if (
    users.length !== freeze.originalUsers.length ||
    users.some(
      (user) =>
        !freeze.originalUsers.find((original) => original.id === user.id),
    )
  )
    throw new Error(
      "Legacy user inventory changed; reconcile before retirement",
    );
  const db = getIdentityDb();
  const native = await db.query(
    "SELECT id,banned FROM identity_user WHERE id=ANY($1)",
    [users.map((user) => user.id)],
  );
  if (
    native.rowCount !== users.length ||
    native.rows.some(
      (user) =>
        user.banned !==
        Boolean(
          freeze.originalUsers.find((original) => original.id === user.id)
            ?.banned ||
            freeze.originalUsers.find((original) => original.id === user.id)
              ?.locked,
        ),
    )
  )
    throw new Error("Native identity flags differ from the verified import");
  await db.end();
  console.log(
    JSON.stringify({
      ready: true,
      legacyAccounts: users.length,
      apply: process.argv.includes("--apply"),
    }),
  );
  if (!process.argv.includes("--apply")) return;
  if (!process.argv.includes("--retire-legacy-auth"))
    throw new Error("Explicit legacy retirement guard required");
  const health = await fetch("https://botflow.io/api/auth/get-session");
  if (health.status !== 200)
    throw new Error("Native production authentication must be healthy");
  const path = migrationArtifactPath("source-retirement.enc");
  const checkpoint: Retirement = {
    instanceId: instance.id,
    users: freeze.originalUsers,
    state: "prepared",
  };
  await writeFile(
    path,
    encryptPrivateData(checkpoint, "clerk-source-retirement"),
    { mode: 0o600 },
  );
  for (const user of users)
    if (!user.banned) {
      const disabled = await clerk(
        `/users/${encodeURIComponent(user.id)}/ban`,
        "POST",
      );
      if (!disabled.banned) throw new Error("Legacy login closure failed");
    }
  let verified = 0;
  for (let offset = 0; ; offset += 100) {
    const page = (await clerk(
      `/users?limit=100&offset=${offset}`,
    )) as typeof users;
    if (page.some((user) => !user.banned))
      throw new Error("An active legacy account remains");
    verified += page.length;
    if (page.length < 100) break;
  }
  if (verified !== users.length)
    throw new Error("Source inventory changed during retirement");
  checkpoint.state = "retired";
  checkpoint.retiredAt = new Date().toISOString();
  await writeFile(
    path,
    encryptPrivateData(checkpoint, "clerk-source-retirement"),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      legacyAccountsDisabled: verified,
      nativeAccountsUnchanged: true,
      recoverableSourceRecordsRetained: true,
    }),
  );
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Legacy retirement failed",
  );
  process.exitCode = 1;
});
