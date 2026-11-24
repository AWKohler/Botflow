import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guardPanel, parseSimHostInput, unsecuredNeedsAck } from "@/lib/sim-hosts/api";
import { clearSimHostHealthCache, probeSimHostHealth } from "@/lib/sim-hosts/health";
import { createSimHost, listSimHostRows, toSimHost } from "@/lib/sim-hosts/store";
import { simulatorProvider } from "@/lib/simulator-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(req: NextRequest) {
  const blocked = await guardPanel(req, { write: false });
  if (blocked) return blocked;

  try {
    if (req.nextUrl.searchParams.get("refresh") === "1") clearSimHostHealthCache();
    const rows = await listSimHostRows();
    const hosts = await Promise.all(
      rows.map(async (row) => ({ host: toSimHost(row), health: await probeSimHostHealth(row) })),
    );
    let provider: string;
    try {
      provider = simulatorProvider();
    } catch {
      provider = "invalid";
    }
    return NextResponse.json(
      {
        hosts,
        // "cloud" = these hosts serve users; "local" = the Mac cloud is switched
        // off for everyone (SIMULATOR_PROVIDER) and users get Botflow Companion.
        provider,
        // With no rows, routing uses the env-configured controller.
        envControllerConfigured: Boolean(process.env.SIM_CONTROLLER_URL),
        envTokenConfigured: Boolean(process.env.SIM_PLATFORM_TOKEN),
        generatedAt: new Date().toISOString(),
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.error("[panel/sim-hosts] list failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load simulator hosts" },
      { status: 500 },
    );
  }
}

const createBody = z.object({
  input: z.unknown(),
  platformToken: z.string().max(500).nullish(),
  serving: z.boolean().default(false),
  acknowledgeUnsecured: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  const blocked = await guardPanel(req, { write: true });
  if (blocked) return blocked;

  const body = createBody.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const input = parseSimHostInput(body.data.input);
  if (input instanceof NextResponse) return input;

  const needsAck = unsecuredNeedsAck(null, { ...input, serving: body.data.serving }, body.data.acknowledgeUnsecured);
  if (needsAck) return needsAck;

  try {
    const row = await createSimHost(input, {
      platformToken: body.data.platformToken?.trim() || null,
      serving: body.data.serving,
    });
    return NextResponse.json(
      { host: toSimHost(row), health: await probeSimHostHealth(row, { fresh: true }) },
      { status: 201, headers: NO_STORE },
    );
  } catch (error) {
    console.error("[panel/sim-hosts] create failed:", error);
    return NextResponse.json({ error: "Couldn't save the host." }, { status: 500 });
  }
}
