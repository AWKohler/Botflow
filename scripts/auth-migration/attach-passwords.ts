import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { readFile, writeFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { createHash } from "node:crypto";
import {
  decryptPrivateData,
  encryptPrivateData,
} from "../../src/lib/auth/crypto";
import type { Snapshot } from "./snapshot";
async function main() {
  const snapshot = decryptPrivateData<Snapshot>(
    await readFile(".migration/clerk-snapshot.enc", "utf8"),
    "clerk-migration-snapshot",
  );
  const rows = parse(
    await readFile(process.argv[2] || ".migration/clerk-passwords.csv"),
    { columns: true, bom: true, skip_empty_lines: true },
  ) as Record<string, string>[];
  const ids = new Set(snapshot.users.map((u) => u.id));
  if (rows.some((r) => !ids.has(r.id)) || rows.length !== ids.size)
    throw new Error("CSV does not match the snapshot user set");
  snapshot.passwords = Object.fromEntries(
    rows
      .filter((r) => r.password_digest)
      .map((r) => [
        r.id,
        {
          password_digest: r.password_digest,
          password_hasher: r.password_hasher,
        },
      ]),
  );
  const { digest: _old, ...payload } = snapshot;
  void _old;
  const digest = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
  await writeFile(
    ".migration/clerk-snapshot.enc",
    encryptPrivateData({ ...payload, digest }, "clerk-migration-snapshot"),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      users: rows.length,
      passwordHashes: Object.keys(snapshot.passwords).length,
      digest,
    }),
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
