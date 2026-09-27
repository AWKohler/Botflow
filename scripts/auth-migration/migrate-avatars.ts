import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { getIdentityDb } from "../../src/lib/auth/database";
import { decryptPrivateData } from "../../src/lib/auth/crypto";
import type { Snapshot } from "./snapshot";
async function main() {
  if (
    process.env.AUTH_MIGRATION_TARGET !== "staging" &&
    !process.argv.includes("--production-reviewed")
  )
    throw new Error("Explicit production migration review required");
  const db = getIdentityDb();
  await db.query(
    await readFile("scripts/auth-migration/001-identity.sql", "utf8"),
  );
  const snapshot = decryptPrivateData<Snapshot>(
    await readFile(".migration/clerk-snapshot.enc", "utf8"),
    "clerk-migration-snapshot",
  );
  let completed = 0,
    failed = 0;
  for (const user of snapshot.users) {
    if (!user.image_url) continue;
    const url = new URL(user.image_url);
    if (
      url.protocol !== "https:" ||
      !["img.clerk.com", "images.clerk.dev"].includes(url.hostname)
    )
      throw new Error("Unrecognized avatar host");
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error("Avatar download failed");
      const data = await sharp(Buffer.from(await response.arrayBuffer()), {
        limitInputPixels: 16000000,
      })
        .resize(256, 256, { fit: "cover" })
        .webp({ quality: 85 })
        .toBuffer();
      const digest = createHash("sha256").update(data).digest("hex");
      await db.query(
        "INSERT INTO identity_avatar(user_id,data,digest)VALUES($1,$2,$3)ON CONFLICT(user_id)DO NOTHING",
        [user.id, data, digest],
      );
      await db.query(
        "UPDATE identity_user SET image=$2 WHERE id=$1 AND image=$3",
        [
          user.id,
          `/api/identity/avatar/${user.id}?v=${digest.slice(0, 12)}`,
          user.image_url,
        ],
      );
      completed++;
    } catch {
      failed++;
    }
  }
  await db.end();
  console.log(JSON.stringify({ avatarsMigrated: completed, failed }));
  if (failed) process.exitCode = 1;
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
