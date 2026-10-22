/**
 * Does the pinned OpenCode binary's bundled model catalog know every model we
 * route to OpenCode?
 *
 * Why it matters: the bridge declares each model with an EMPTY override, so
 * OpenCode takes the model's capabilities from its bundled catalog —
 * `reasoning` (which picks /v1/responses vs /v1/chat/completions and the
 * request shape), `attachment` (images), and `limit` (auto-compaction). A
 * model missing from the catalog runs with all of those off/unknown.
 *
 * Run whenever a model is added to src/lib/agent/models.ts or the pin moves:
 *   node --import tsx scripts/check-opencode-catalog.ts [version]
 * Downloads the linux-x64 binary (what sandboxes run) into a temp dir.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MODEL_CONFIGS } from "../src/lib/agent/models";
import { hasCatalogGapDeclaration, resolveOpenCodeModel } from "../src/lib/agent/opencode/models";

const setupSrc = readFileSync(path.join(__dirname, "../src/lib/agent/opencode/setup.ts"), "utf8");
const pinned = /BOTFLOW_OPENCODE_VERSION \|\| "([^"]+)"/.exec(setupSrc)?.[1];
const version = process.argv[2] ?? pinned;
if (!version) throw new Error("Could not read the pinned OpenCode version from setup.ts");

const dir = mkdtempSync(path.join(tmpdir(), "opencode-catalog-"));
console.log(`Downloading opencode-linux-x64@${version}…`);
execFileSync("npm", ["pack", "--silent", `opencode-linux-x64@${version}`], { cwd: dir, stdio: "ignore" });
const tgz = readdirSync(dir).find((f) => f.endsWith(".tgz"))!;
execFileSync("tar", ["-xzf", tgz], { cwd: dir });
const binary = readFileSync(path.join(dir, "package/bin/opencode")).toString("latin1");

let missing = 0;
for (const config of Object.values(MODEL_CONFIGS)) {
  const ref = resolveOpenCodeModel(config.id, { useTogetherKimi: false });
  const inCatalog = binary.includes(`"${ref.modelID}":{id:"${ref.modelID}"`);
  const declared = hasCatalogGapDeclaration(ref);
  if (!inCatalog && !declared) missing++;
  const label = inCatalog ? (declared ? "ok (catalog + declared)" : "ok") : declared ? "ok (declared)" : "MISSING";
  console.log(`${label.padEnd(24)} ${ref.providerID}/${ref.modelID}`);
}
console.log(
  missing === 0
    ? `\nAll models are covered (catalog or explicit declaration) in opencode ${version}.`
    : `\n${missing} model(s) missing from opencode ${version}'s catalog — bump BOTFLOW_OPENCODE_VERSION, or add a declaration to CATALOG_GAP_DECLARATIONS (src/lib/agent/opencode/models.ts).`,
);
process.exit(missing === 0 ? 0 : 1);
