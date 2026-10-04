import { resolve, sep } from "node:path";
/** Keep separate staging/production envelopes and checkpoints inside ignored storage. */
export function migrationArtifactPath(name = ""): string {
  const root = resolve(".migration");
  const directory = resolve(process.env.AUTH_MIGRATION_ARTIFACT_DIR || root);
  if (directory !== root && !directory.startsWith(root + sep))
    throw new Error(
      "Migration artifacts must stay inside ignored .migration storage",
    );
  return resolve(directory, name);
}
