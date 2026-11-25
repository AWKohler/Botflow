import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guardPanel, parseSimHostInput, unsecuredNeedsAck } from "@/lib/sim-hosts/api";
import { probeSimHostHealth } from "@/lib/sim-hosts/health";
import { deleteSimHost, getSimHostRow, inputFromRow, toSimHost, updateSimHost } from "@/lib/sim-hosts/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Context = { params: Promise<{ id: string }> };

const patchBody = z
  .object({
    input: z.unknown().optional(),
    /** Omitted = keep; null or "" = use the deployment's SIM_PLATFORM_TOKEN; text = replace. */
    platformToken: z.string().max(500).nullable().optional(),
    serving: z.boolean().optional(),
    acknowledgeUnsecured: z.boolean().optional(),
  })
  .strict();

/**
 * Edit a host, switch it in or out of service, or change its token. Routing
 * reads the registry on every new session, so a change applies to the next
 * simulator a user opens; sessions already running on a host that is switched
 * off keep running until they end.
 */
export async function PATCH(req: NextRequest, context: Context) {
  const blocked = await guardPanel(req, { write: true });
  if (blocked) return blocked;

  const { id } = await context.params;
  const row = await getSimHostRow(id);
  if (!row) return NextResponse.json({ error: "Host not found" }, { status: 404 });

  const body = patchBody.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  let input = inputFromRow(row);
  if (body.data.input !== undefined) {
    const parsed = parseSimHostInput(body.data.input);
    if (parsed instanceof NextResponse) return parsed;
    input = parsed;
  }
  const serving = body.data.serving ?? row.serving;
  const needsAck = unsecuredNeedsAck(row, { runtime: input.runtime, scope: input.scope, serving }, body.data.acknowledgeUnsecured);
  if (needsAck) return needsAck;

  try {
    const updated = await updateSimHost(id, {
      input: body.data.input !== undefined ? input : undefined,
      platformToken:
        body.data.platformToken === undefined ? undefined : body.data.platformToken?.trim() || null,
      serving: body.data.serving,
    });
    if (!updated) return NextResponse.json({ error: "Host not found" }, { status: 404 });
    return NextResponse.json(
      { host: toSimHost(updated), health: await probeSimHostHealth(updated, { fresh: true }) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error("[panel/sim-hosts] update failed:", error);
    return NextResponse.json({ error: "Couldn't save the host." }, { status: 500 });
  }
}

/** Remove a host from the registry. Sessions already on it are not touched. */
export async function DELETE(req: NextRequest, context: Context) {
  const blocked = await guardPanel(req, { write: true });
  if (blocked) return blocked;
  const { id } = await context.params;
  const row = await getSimHostRow(id);
  if (!row) return NextResponse.json({ error: "Host not found" }, { status: 404 });
  await deleteSimHost(id);
  return new NextResponse(null, { status: 204 });
}
