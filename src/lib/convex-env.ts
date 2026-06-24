/**
 * Live backend (Convex) environment-variable access.
 *
 * The Convex *deployment* is the sole source of truth for backend env vars —
 * we store nothing in our DB. This makes the Convex dashboard and the Botflow
 * Env panel equal peers: a change in either place is immediately reflected in
 * the other. No sync, no split-brain.
 *
 * All calls go through the deployment's own HTTP admin API using the project's
 * deploy key — the same channel `convex-admin.ts` uses for queries/logs and the
 * same one the Convex CLI uses for `convex env list/set/rm`.
 */
import { runConvexFunction, resolveConvexCreds } from "@/lib/convex-admin";
import { isReservedEnvKey, isSecretReservedKey, MASKED_ENV_VALUE } from "@/lib/platform-env";

export interface ConvexEnvVar {
  key: string;
  value: string;
  /** True when the key is platform-managed (read-only in our UI). */
  reserved: boolean;
}

/**
 * List the deployment's environment variables.
 *
 * Uses the built-in `_system/cli/queryEnvironmentVariables` UDF (the one
 * `convex env list` calls). The exact response shape is verified against a
 * live deployment in the push→deploy→test loop; we defensively handle the two
 * shapes the CLI has used: `{ name, value }[]` directly, or `{ variables: [...] }`.
 */
export async function listConvexEnvVars(
  projectId: string,
): Promise<{ ok: true; vars: ConvexEnvVar[] } | { ok: false; error: string }> {
  const r = await runConvexFunction(projectId, {
    path: "_system/cli/queryEnvironmentVariables",
    args: {},
  });
  if (!r.ok) return r;

  const raw = r.value as
    | Array<{ name?: string; value?: string }>
    | { variables?: Array<{ name?: string; value?: string }> }
    | null;
  const list = Array.isArray(raw) ? raw : raw?.variables ?? [];

  const vars: ConvexEnvVar[] = list
    .filter((e): e is { name: string; value?: string } => Boolean(e?.name))
    .map((e) => ({
      key: e.name,
      // Redact managed bearer secrets (OAuth client secrets, signing keys) so a
      // plaintext value never round-trips to the client / Env panel.
      value: isSecretReservedKey(e.name) ? MASKED_ENV_VALUE : (e.value ?? ""),
      reserved: isReservedEnvKey(e.name),
    }));

  return { ok: true, vars };
}

/**
 * Low-level: PATCH a set of changes onto the deployment. A `value: null`
 * change deletes the variable (Convex semantics). Callers should pre-filter
 * reserved keys via the higher-level helpers below.
 */
async function applyEnvChanges(
  projectId: string,
  changes: Array<{ name: string; value: string | null }>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (changes.length === 0) return { ok: true };
  const resolved = await resolveConvexCreds(projectId);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { deployUrl, deployKey } = resolved.creds;

  let res: Response;
  try {
    res = await fetch(`${deployUrl}/api/update_environment_variables`, {
      method: "POST",
      headers: { Authorization: `Convex ${deployKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ changes }),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `Convex env update HTTP ${res.status}: ${text.slice(0, 300)}` };
  }
  return { ok: true };
}

/** Set (create or update) a single backend env var. Rejects reserved keys. */
export async function setConvexEnvVar(
  projectId: string,
  key: string,
  value: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const name = key.trim();
  if (!name) return { ok: false, error: "Variable name is required." };
  if (isReservedEnvKey(name)) {
    return { ok: false, error: `${name} is managed by Botflow and can't be edited here.` };
  }
  return applyEnvChanges(projectId, [{ name, value }]);
}

/** Delete a single backend env var. Rejects reserved keys. */
export async function deleteConvexEnvVar(
  projectId: string,
  key: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const name = key.trim();
  if (!name) return { ok: false, error: "Variable name is required." };
  if (isReservedEnvKey(name)) {
    return { ok: false, error: `${name} is managed by Botflow and can't be deleted here.` };
  }
  return applyEnvChanges(projectId, [{ name, value: null }]);
}
