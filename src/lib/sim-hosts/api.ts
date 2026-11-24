// Request parsing and guards shared by the /api/panel/sim-hosts routes.

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSameOrigin } from "@/lib/auth/policy";
import { requirePanelAdmin } from "@/lib/panel/auth";
import { SIM_HOST_RUNTIMES, SIM_HOST_SCOPES, validateSimHostInput, type SimHostInput } from "./model";

const nullableText = z
  .string()
  .max(2000)
  .nullish()
  .transform((v) => (v && v.trim() ? v.trim() : null));

export const simHostInputSchema = z.object({
  name: z.string().max(200),
  controllerUrl: z.string().max(500),
  streamUrl: nullableText,
  agentHostId: nullableText,
  runtime: z.enum(SIM_HOST_RUNTIMES),
  macosVersion: z.string().max(20),
  hardwareModel: nullableText,
  chip: nullableText,
  ramGb: z.number().int().nullable(),
  vmCapUnlocked: z.boolean(),
  maxSessions: z.number().int(),
  scope: z.enum(SIM_HOST_SCOPES),
  priority: z.number().int(),
  notes: nullableText,
});

export const testResultSchema = z.object({
  ok: z.boolean(),
  startupMs: z.number().int().min(0).max(3_600_000).nullable(),
  provisionMs: z.number().int().min(0).max(3_600_000).nullable(),
  buildMs: z.number().int().min(0).max(3_600_000).nullable(),
  avgFps: z.number().min(0).max(240).nullable(),
  minFps: z.number().min(0).max(240).nullable(),
  targetFps: z.number().min(0).max(240).nullable(),
  resolution: z.string().max(40).nullable(),
  error: z.string().max(500).nullable(),
});

/** 404 for non-admins (the panel's existence isn't advertised); 403 for a cross-site write. */
export async function guardPanel(request: Request, opts: { write: boolean }): Promise<NextResponse | null> {
  if (opts.write && !requireSameOrigin(request)) {
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  }
  if (!(await requirePanelAdmin())) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return null;
}

export function invalidInput(errors: Record<string, string>): NextResponse {
  return NextResponse.json({ error: "Check the highlighted fields.", fields: errors }, { status: 400 });
}

/** Parse + validate a SimHostInput; returns the input or a 400 response. */
export function parseSimHostInput(raw: unknown): SimHostInput | NextResponse {
  const parsed = simHostInputSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid host details." }, { status: 400 });
  }
  const input = parsed.data as SimHostInput;
  const errors = validateSimHostInput(input);
  return Object.keys(errors).length > 0 ? invalidInput(errors) : input;
}

/**
 * Serving an unsecured host runs users' code directly on that Mac. A request
 * that would put one into service (or widen who it serves) must say the admin
 * saw the warning.
 */
export function unsecuredNeedsAck(
  before: { runtime: string; serving: boolean; scope: string } | null,
  after: { runtime: string; serving: boolean; scope: string },
  acknowledged: boolean | undefined,
): NextResponse | null {
  if (after.runtime !== "unsecure" || !after.serving || acknowledged) return null;
  const changed =
    !before ||
    before.runtime !== after.runtime ||
    !before.serving ||
    (before.scope === "beta" && after.scope === "all");
  if (!changed) return null;
  return NextResponse.json(
    {
      error: "This host runs user code outside a VM. Confirm the unsecured runtime warning to put it into service.",
      needsAcknowledgement: true,
    },
    { status: 409 },
  );
}
