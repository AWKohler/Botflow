// Admin test of one simulator host: start a session on exactly this host
// (serving or not), upload the built-in "Botflow host check" app, and hand the
// browser the stream URL. The panel measures startup and frame rate from the
// stream itself, then saves the result here.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guardPanel, testResultSchema } from "@/lib/sim-hosts/api";
import {
  SIM_DEMO_APP_BUNDLE_ID,
  SIM_DEMO_APP_SCHEME,
  SIM_DEMO_APP_TGZ_BASE64,
} from "@/lib/sim-hosts/demo-app.generated";
import { forgetSimRoute, rememberSimRoute } from "@/lib/sim-hosts/routing";
import { getSimHostRow, toSimTarget, updateSimHost } from "@/lib/sim-hosts/store";
import {
  createSession,
  releaseSession,
  sessionWsUrl,
  uploadBuild,
  type SimDeviceModel,
  type SimTarget,
} from "@/lib/sim-platform";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Context = { params: Promise<{ id: string }> };

const startBody = z.object({
  deviceModel: z.enum(["iPhone-16-Pro", "iPad-Pro"]).default("iPhone-16-Pro"),
});

export async function POST(req: NextRequest, context: Context) {
  const blocked = await guardPanel(req, { write: true });
  if (blocked) return blocked;

  const { id } = await context.params;
  const row = await getSimHostRow(id);
  if (!row) return NextResponse.json({ error: "Host not found" }, { status: 404 });
  const body = startBody.safeParse((await req.json().catch(() => ({}))) ?? {});
  const deviceModel: SimDeviceModel = body.success ? body.data.deviceModel : "iPhone-16-Pro";

  let target: SimTarget;
  try {
    target = toSimTarget(row);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Host is not configured" }, { status: 400 });
  }

  let sessionId: string | null = null;
  try {
    const t0 = Date.now();
    const session = await createSession({ awaitBuild: true, deviceModel }, target);
    sessionId = session.sessionId;
    await rememberSimRoute("session", sessionId, target);
    const t1 = Date.now();
    const tarball = Buffer.from(SIM_DEMO_APP_TGZ_BASE64, "base64");
    await uploadBuild(sessionId, tarball, { scheme: SIM_DEMO_APP_SCHEME, bundleId: SIM_DEMO_APP_BUNDLE_ID }, target);
    const t2 = Date.now();
    return NextResponse.json(
      {
        sessionId,
        wsUrl: sessionWsUrl(sessionId, session.streamToken, target),
        agentHostId: session.hostId,
        queuePosition: session.queuePosition,
        createMs: t1 - t0,
        uploadMs: t2 - t1,
        tarBytes: tarball.length,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    if (sessionId) await releaseSession(sessionId, target).catch(() => undefined);
    const message = error instanceof Error ? error.message : "Couldn't start the test";
    console.error("[panel/sim-hosts/test] start failed:", message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

/** Save the measured result as the host's last test. */
export async function PUT(req: NextRequest, context: Context) {
  const blocked = await guardPanel(req, { write: true });
  if (blocked) return blocked;
  const { id } = await context.params;
  const parsed = testResultSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid result." }, { status: 400 });
  const updated = await updateSimHost(id, { lastTest: { ...parsed.data, at: new Date().toISOString() } });
  if (!updated) return NextResponse.json({ error: "Host not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

/** End the test session (`?sessionId=`). */
export async function DELETE(req: NextRequest, context: Context) {
  const blocked = await guardPanel(req, { write: true });
  if (blocked) return blocked;
  const { id } = await context.params;
  const sessionId = req.nextUrl.searchParams.get("sessionId") ?? "";
  if (!/^[0-9a-fA-F-]{36}$/.test(sessionId)) {
    return NextResponse.json({ error: "sessionId query param is required" }, { status: 400 });
  }
  const row = await getSimHostRow(id);
  if (!row) return NextResponse.json({ error: "Host not found" }, { status: 404 });
  try {
    await releaseSession(sessionId, toSimTarget(row));
  } catch (error) {
    console.warn("[panel/sim-hosts/test] release failed:", error instanceof Error ? error.message : error);
  }
  await forgetSimRoute("session", sessionId);
  return new NextResponse(null, { status: 204 });
}
