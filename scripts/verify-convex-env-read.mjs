// Read-only verification of the Convex env-list UDF path used by convex-env.ts.
// Finds a project with a Convex deploy URL+key and probes the candidate UDFs.
import { neon } from "@neondatabase/serverless";
import { readFileSync } from "node:fs";

// Load DATABASE_URL from .env.local
const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const sql = neon(process.env.DATABASE_URL);

const rows = await sql`
  SELECT id, platform, backend_type,
         convex_deploy_url, convex_deploy_key,
         user_convex_url, user_convex_deploy_key
  FROM projects
  WHERE platform = 'sandboxed-web'
    AND backend_type <> 'none'
    AND (
      (convex_deploy_url IS NOT NULL AND convex_deploy_key IS NOT NULL)
      OR (user_convex_url IS NOT NULL AND user_convex_deploy_key IS NOT NULL)
    )
  ORDER BY updated_at DESC
  LIMIT 1
`;

if (rows.length === 0) {
  console.log("NO_PROJECT_WITH_CONVEX");
  process.exit(0);
}

const p = rows[0];
const deployUrl = p.backend_type === "user" ? p.user_convex_url : p.convex_deploy_url;
const deployKey = p.backend_type === "user" ? p.user_convex_deploy_key : p.convex_deploy_key;
console.log("project:", p.id, "backend:", p.backend_type, "url:", deployUrl);

const candidates = [
  "_system/cli/queryEnvironmentVariables",
  "_system/cli/environmentVariables",
  "_system/frontend/listEnvironmentVariables",
];

for (const path of candidates) {
  try {
    const res = await fetch(`${deployUrl}/api/query`, {
      method: "POST",
      headers: { Authorization: `Convex ${deployKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path, args: {}, format: "json" }),
    });
    const data = await res.json().catch(() => null);
    const status = data?.status;
    let shape = "";
    if (status === "success") {
      const v = data.value;
      if (Array.isArray(v)) shape = `array[${v.length}] sample=${JSON.stringify(v[0])}`;
      else if (v && typeof v === "object") shape = `object keys=${Object.keys(v).join(",")}`;
      else shape = `scalar ${JSON.stringify(v)}`;
    }
    console.log(`\n[${path}]`, "http", res.status, "udf", status,
      status === "success" ? "OK -> " + shape : (data?.errorMessage ?? "(no msg)"));
  } catch (e) {
    console.log(`\n[${path}] FETCH_ERR`, e.message);
  }
}
