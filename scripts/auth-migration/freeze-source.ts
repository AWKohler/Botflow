/** Briefly close legacy sign-in and revoke sessions before the final snapshot. */
import { config } from "dotenv";
config({
  path: process.env.AUTH_MIGRATION_ENV_FILE || ".env.local",
  quiet: true,
});
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { migrationArtifactPath } from "./artifacts";
import {
  decryptPrivateData,
  encryptPrivateData,
} from "../../src/lib/auth/crypto";
interface Freeze {
  instanceId: string;
  strategy?: "user-locks";
  originalUsers?: { id: string; locked: boolean; banned: boolean }[];
  lockedUsers?: string[];
  original: {
    allowlist: boolean;
    allowlist_blocklist_disabled_on_sign_in: boolean;
  };
  state: "prepared" | "closed" | "frozen" | "restored";
  users: string[];
  sessionsRevoked: number;
  startedAt: string;
  frozenAt?: string;
}
async function clerk(path: string, method = "GET", body?: unknown) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(`https://api.clerk.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.CLERK_MIGRATION_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // These writes set known restriction booleans or revoke a specific session.
    if (response.status === 429 || response.status >= 500) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(30000, 1000 * 2 ** attempt)),
      );
      continue;
    }
    if (!response.ok)
      throw new Error(
        `Legacy sign-in pause request failed (${response.status}); use --restore if cutover cannot continue`,
      );
    return response.json();
  }
  throw new Error(
    "Legacy sign-in pause retries exhausted; use --restore if cutover cannot continue",
  );
}
function rows<T>(value: T[] | { data: T[] }): T[] {
  return Array.isArray(value) ? value : value.data;
}
async function main() {
  if (process.env.AUTH_MIGRATION_TARGET !== "production")
    throw new Error(
      "Source pause requires the production migration configuration",
    );
  if (
    !process.env.CLERK_MIGRATION_SECRET_KEY ||
    !process.env.CLERK_MIGRATION_INSTANCE_ID
  )
    throw new Error("Source identity configuration is missing");
  const instance = await clerk("/instance");
  if (
    instance.id !== process.env.CLERK_MIGRATION_INSTANCE_ID ||
    instance.environment_type !== "production"
  )
    throw new Error("Source instance mismatch");
  const path = migrationArtifactPath("source-freeze.enc");
  async function save(value: Freeze) {
    await writeFile(path, encryptPrivateData(value, "clerk-source-freeze"), {
      mode: 0o600,
    });
  }
  let checkpoint: Freeze | undefined;
  try {
    checkpoint = decryptPrivateData<Freeze>(
      await readFile(path, "utf8"),
      "clerk-source-freeze",
    );
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
    )
      throw new Error("Unable to read source pause recovery checkpoint");
  }
  if (checkpoint && checkpoint.instanceId !== instance.id)
    throw new Error("Pause checkpoint belongs to another source");
  if (process.argv.includes("--restore")) {
    try {
      const retirement = decryptPrivateData<{ state: string }>(
        await readFile(migrationArtifactPath("source-retirement.enc"), "utf8"),
        "clerk-source-retirement",
      );
      if (retirement.state !== "restored")
        throw new Error(
          "Legacy source is retired; reconcile native identity and billing changes before restoring it",
        );
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      )
        throw error;
    }
    if (!checkpoint || !process.argv.includes("--apply"))
      throw new Error("Restore requires the saved checkpoint and --apply");
    for (const id of checkpoint.lockedUsers || []) {
      const unlocked = await clerk(
        `/users/${encodeURIComponent(id)}/unlock`,
        "POST",
      );
      if (unlocked.locked) throw new Error("Legacy account unlock failed");
    }
    const restored = await clerk("/instance/restrictions", "PATCH", {
      allowlist: checkpoint.original.allowlist,
    });
    if (restored.allowlist !== checkpoint.original.allowlist)
      throw new Error("Source settings restoration could not be verified");
    checkpoint.state = "restored";
    await save(checkpoint);
    console.log(
      JSON.stringify({
        legacySignInRestored: true,
        sessionsRequireSignInAgain: true,
      }),
    );
    return;
  }
  const allowlist = rows(await clerk("/allowlist_identifiers?limit=100"));
  const invitations = rows(
    await clerk("/invitations?status=pending&limit=100"),
  );
  if (allowlist.length || invitations.length)
    throw new Error(
      "A source pause requires an empty allowlist and no pending Clerk invitations",
    );
  const users: {
    id: string;
    locked: boolean;
    banned: boolean;
    lockout_expires_in_seconds: number | null;
  }[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = rows<(typeof users)[number]>(
      await clerk(`/users?limit=100&offset=${offset}`),
    );
    users.push(...page);
    if (page.length < 100) break;
  }
  const count = await clerk("/users/count");
  if (
    count.total_count !== users.length ||
    new Set(users.map((u) => u.id)).size !== users.length
  )
    throw new Error("User inventory changed; retry before pausing");
  const response = await fetch("https://clerk.botflow.io/v1/environment");
  if (!response.ok)
    throw new Error("Unable to verify source restriction settings");
  const restrictions = (await response.json()).user_settings.restrictions;
  if (
    !checkpoint ||
    checkpoint.state === "restored" ||
    (!checkpoint.strategy && checkpoint.state === "prepared")
  )
    checkpoint = {
      instanceId: instance.id,
      strategy: "user-locks",
      originalUsers: users.map(({ id, locked, banned }) => ({
        id,
        locked,
        banned,
      })),
      lockedUsers: [],
      original: {
        allowlist: restrictions.allowlist.enabled,
        allowlist_blocklist_disabled_on_sign_in:
          restrictions.allowlist_blocklist_disabled_on_sign_in.enabled,
      },
      state: "prepared",
      users: users.map((u) => u.id),
      sessionsRevoked: 0,
      startedAt: new Date().toISOString(),
    };
  if (
    checkpoint.strategy !== "user-locks" ||
    !checkpoint.originalUsers ||
    !checkpoint.lockedUsers
  )
    throw new Error("Unsupported pause checkpoint");
  if (!process.argv.includes("--apply")) {
    console.log(
      JSON.stringify({
        ready: true,
        users: users.length,
        action:
          "Close legacy sign-up, temporarily lock sign-in, and revoke old sessions",
        apply: false,
      }),
    );
    return;
  }
  if (!process.argv.includes("--brief-sign-in-pause"))
    throw new Error("Applying the source pause requires --brief-sign-in-pause");
  await mkdir(migrationArtifactPath(), { recursive: true, mode: 0o700 });
  await save(checkpoint);
  const closed = await clerk("/instance/restrictions", "PATCH", {
    allowlist: true,
  });
  if (!closed.allowlist)
    throw new Error("Legacy sign-in closure could not be verified");
  checkpoint.state = "closed";
  await save(checkpoint);
  for (const user of users) {
    const original = checkpoint.originalUsers.find(
      (source) => source.id === user.id,
    );
    if (!original) throw new Error("Source directory changed during pause");
    if (!original.locked && !original.banned) {
      // Record intent before the API write so a crash can still restore the account.
      if (!checkpoint.lockedUsers.includes(user.id)) {
        checkpoint.lockedUsers.push(user.id);
        await save(checkpoint);
      }
      const locked = await clerk(
        `/users/${encodeURIComponent(user.id)}/lock`,
        "POST",
      );
      if (
        !locked.locked ||
        (locked.lockout_expires_in_seconds !== null &&
          locked.lockout_expires_in_seconds < 1800)
      )
        throw new Error(
          "Sign-in lock is too short for a safe migration; restore and review lockout policy",
        );
    }
    const sessions: { id: string }[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = rows<{ id: string }>(
        await clerk(
          `/sessions?user_id=${encodeURIComponent(user.id)}&status=active&limit=100&offset=${offset}`,
        ),
      );
      sessions.push(...page);
      if (page.length < 100) break;
    }
    for (const session of sessions) {
      await clerk(`/sessions/${encodeURIComponent(session.id)}/revoke`, "POST");
      checkpoint.sessionsRevoked++;
      await save(checkpoint);
    }
  }
  // Recheck the complete directory and session lists after revocation.
  const finalCount = await clerk("/users/count");
  if (finalCount.total_count !== users.length)
    throw new Error("Source directory changed during pause");
  for (const user of users)
    if (
      rows(
        await clerk(
          `/sessions?user_id=${encodeURIComponent(user.id)}&status=active&limit=1`,
        ),
      ).length
    )
      throw new Error("An active legacy session remains; do not import yet");
  for (let offset = 0; ; offset += 100) {
    const page = rows<(typeof users)[number]>(
      await clerk(`/users?limit=100&offset=${offset}`),
    );
    for (const user of page) {
      const original = checkpoint.originalUsers.find(
        (source) => source.id === user.id,
      );
      if (
        !original ||
        original.banned !== user.banned ||
        (!user.banned &&
          (!user.locked ||
            (user.lockout_expires_in_seconds !== null &&
              user.lockout_expires_in_seconds < 1800)))
      )
        throw new Error("Legacy sign-in lock could not be verified");
    }
    if (page.length < 100) break;
  }
  checkpoint.state = "frozen";
  checkpoint.frozenAt = new Date().toISOString();
  await save(checkpoint);
  console.log(
    JSON.stringify({
      legacySignInPaused: true,
      temporarySourceLocks: checkpoint.lockedUsers.length,
      originalAccountFlagsPreservedInSnapshot: true,
      users: users.length,
      sessionsRevoked: checkpoint.sessionsRevoked,
      waitForExistingJwtExpiryBeforeSnapshot: true,
      recoveryCommand: "freeze-source.ts --restore --apply",
    }),
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
