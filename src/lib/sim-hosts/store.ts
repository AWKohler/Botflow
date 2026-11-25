// Server-side access to the simulator host registry (sim_hosts).

import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { simHosts, type SimHostRow } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import { deriveStreamBase, type SimTarget } from "@/lib/sim-platform";
import type { SimHost, SimHostInput, SimHostRuntime, SimHostScope, SimHostTestResult } from "./model";

export async function listSimHostRows(): Promise<SimHostRow[]> {
  return getDb().select().from(simHosts).orderBy(asc(simHosts.priority), asc(simHosts.createdAt));
}

export async function getSimHostRow(id: string): Promise<SimHostRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await getDb().select().from(simHosts).where(eq(simHosts.id, id)).limit(1);
  return row ?? null;
}

export function toSimHost(row: SimHostRow): SimHost {
  return {
    id: row.id,
    name: row.name,
    controllerUrl: row.controllerUrl,
    streamUrl: row.streamUrl,
    agentHostId: row.agentHostId,
    hasOwnToken: Boolean(row.platformTokenEnc),
    runtime: row.runtime as SimHostRuntime,
    macosVersion: row.macosVersion,
    hardwareModel: row.hardwareModel,
    chip: row.chip,
    ramGb: row.ramGb,
    vmCapUnlocked: row.vmCapUnlocked,
    maxSessions: row.maxSessions,
    serving: row.serving,
    scope: row.scope as SimHostScope,
    priority: row.priority,
    notes: row.notes,
    lastTest: (row.lastTest as SimHostTestResult | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The controller target for a host. A host without its own token uses the
 * deployment's SIM_PLATFORM_TOKEN.
 */
export function toSimTarget(row: SimHostRow): SimTarget {
  let token: string | null;
  if (row.platformTokenEnc) {
    token = decryptSecret(row.platformTokenEnc);
    if (!token) {
      throw new Error(`The platform token saved for simulator host “${row.name}” can't be read here. Re-enter it in the admin panel.`);
    }
  } else {
    token = process.env.SIM_PLATFORM_TOKEN ?? null;
    if (!token) throw new Error("SIM_PLATFORM_TOKEN is not set");
  }
  const http = row.controllerUrl.replace(/\/$/, "");
  return {
    hostId: row.id,
    http,
    ws: (row.streamUrl ?? deriveStreamBase(http)).replace(/\/$/, ""),
    token,
  };
}

function columns(input: SimHostInput) {
  return {
    name: input.name.trim(),
    controllerUrl: input.controllerUrl.trim().replace(/\/$/, ""),
    streamUrl: input.streamUrl?.trim().replace(/\/$/, "") || null,
    agentHostId: input.agentHostId?.trim() || null,
    runtime: input.runtime,
    macosVersion: input.macosVersion.trim(),
    hardwareModel: input.hardwareModel?.trim() || null,
    chip: input.chip?.trim() || null,
    ramGb: input.ramGb,
    // Only meaningful for hosts that run VMs.
    vmCapUnlocked: input.runtime !== "unsecure" ? input.vmCapUnlocked : false,
    maxSessions: input.maxSessions,
    scope: input.scope,
    priority: input.priority,
    notes: input.notes?.trim() || null,
  };
}

export async function createSimHost(
  input: SimHostInput,
  opts: { platformToken: string | null; serving: boolean },
): Promise<SimHostRow> {
  const [row] = await getDb()
    .insert(simHosts)
    .values({
      ...columns(input),
      platformTokenEnc: opts.platformToken ? encryptSecret(opts.platformToken) : null,
      serving: opts.serving,
    })
    .returning();
  return row;
}

export async function updateSimHost(
  id: string,
  patch: {
    input?: SimHostInput;
    /** undefined = keep, null = clear (use SIM_PLATFORM_TOKEN), string = replace. */
    platformToken?: string | null;
    serving?: boolean;
    lastTest?: SimHostTestResult;
  },
): Promise<SimHostRow | null> {
  const values: Partial<typeof simHosts.$inferInsert> = { updatedAt: new Date() };
  if (patch.input) Object.assign(values, columns(patch.input));
  if (patch.platformToken !== undefined) {
    values.platformTokenEnc = patch.platformToken ? encryptSecret(patch.platformToken) : null;
  }
  if (patch.serving !== undefined) values.serving = patch.serving;
  if (patch.lastTest !== undefined) values.lastTest = patch.lastTest;
  const [row] = await getDb().update(simHosts).set(values).where(eq(simHosts.id, id)).returning();
  return row ?? null;
}

export async function deleteSimHost(id: string): Promise<boolean> {
  const rows = await getDb().delete(simHosts).where(eq(simHosts.id, id)).returning({ id: simHosts.id });
  return rows.length > 0;
}

/** The form fields of a stored host, for re-validation when only some change. */
export function inputFromRow(row: SimHostRow): SimHostInput {
  const h = toSimHost(row);
  return {
    name: h.name,
    controllerUrl: h.controllerUrl,
    streamUrl: h.streamUrl,
    agentHostId: h.agentHostId,
    runtime: h.runtime,
    macosVersion: h.macosVersion,
    hardwareModel: h.hardwareModel,
    chip: h.chip,
    ramGb: h.ramGb,
    vmCapUnlocked: h.vmCapUnlocked,
    maxSessions: h.maxSessions,
    scope: h.scope,
    priority: h.priority,
    notes: h.notes,
  };
}
