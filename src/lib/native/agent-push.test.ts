import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { setupTestDb, currentTestDb } from "@/test/db";
import { createUser } from "@/test/auth";
import { createProject } from "@/test/factories";
import { chatSessions } from "@/db/schema";
import { apnsConfig, providerToken, setApnsTransportForTests, type ApnsRequest, type ApnsResult } from "./apns";
import { listDevices, registerDevice, registerLiveActivity, getLiveActivity } from "./devices";
import { getTurnProgress, notifyNeedsInput, notifyTurnEnded, plainSummary, pushTurnProgress, seedActivityState, wantsProgressBeacon } from "./agent-push";

setupTestDb();

const DEVICE = "a".repeat(64);
const ACTIVITY = "b".repeat(160);
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

let sent: ApnsRequest[] = [];
let respond: (request: ApnsRequest) => ApnsResult = () => ({ ok: true, status: 200 });
let restore: () => void = () => {};

function configure() {
  vi.stubEnv("APNS_KEY_ID", "KEY1234567");
  vi.stubEnv("APNS_TEAM_ID", "TEAM123456");
  vi.stubEnv("APNS_PRIVATE_KEY", PEM.replace(/\n/g, "\\n"));
}

beforeEach(() => {
  sent = [];
  respond = () => ({ ok: true, status: 200 });
  restore = setApnsTransportForTests(async (request) => {
    sent.push(request);
    return respond(request);
  });
});
afterEach(() => {
  restore();
  vi.unstubAllEnvs();
});

async function seed() {
  await createUser({ id: "u1" });
  const project = await createProject({ userId: "u1", name: "Tidewater Coffee" });
  const [thread] = await currentTestDb()
    .insert(chatSessions)
    .values({ projectId: project.id, createdBy: "u1", title: "Add online ordering", model: "gpt-6-luna" })
    .returning();
  return { projectId: project.id, threadId: thread.id };
}

describe("provider token", () => {
  test("is an ES256 JWT Apple can verify with the key's public half", () => {
    configure();
    const token = providerToken(apnsConfig()!, Date.UTC(2026, 10, 22));
    const [header, claims, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString()).iss).toBe("TEAM123456");
    const verifier = createVerify("SHA256");
    verifier.update(`${header}.${claims}`);
    expect(verifier.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"))).toBe(true);
  });
});

describe("without an APNs key", () => {
  test("nothing is sent", async () => {
    const { projectId, threadId } = await seed();
    await registerDevice("u1", { token: DEVICE, environment: "production", bundleId: "io.botflow.app" });
    await notifyTurnEnded({ userId: "u1", projectId, threadId, outcome: "done", summary: "Done." });
    expect(await pushTurnProgress({ userId: "u1", threadId, tool: "Read", detail: "a.ts", steps: 1 })).toBe(false);
    expect(sent).toHaveLength(0);
    // The step is still recorded: the app's Agents tab reads it.
    expect((await getTurnProgress([threadId])).get(threadId)).toMatchObject({ tool: "Read", detail: "a.ts", steps: 1 });
    // ...and cleared when the turn is over.
    await notifyTurnEnded({ userId: "u1", projectId, threadId, outcome: "done", summary: "Done." });
    expect((await getTurnProgress([threadId])).size).toBe(0);
  });
});

describe("with an APNs key", () => {
  beforeEach(configure);

  test("a heartbeat is only requested for people with the app", async () => {
    await createUser({ id: "u1" });
    expect(await wantsProgressBeacon("u1")).toBe(false);
    await registerDevice("u1", { token: DEVICE, environment: "production", bundleId: "io.botflow.app" });
    expect(await wantsProgressBeacon("u1")).toBe(true);
  });

  test("a finished turn alerts the device and ends the Live Activity", async () => {
    const { projectId, threadId } = await seed();
    await registerDevice("u1", { token: DEVICE, environment: "development", bundleId: "io.botflow.app" });
    await registerLiveActivity("u1", threadId, { token: ACTIVITY, environment: "development", projectId });

    await notifyTurnEnded({ userId: "u1", projectId, threadId, outcome: "done", summary: "Ordering **works** end to end." });

    const activity = sent.find((r) => r.pushType === "liveactivity")!;
    expect(activity.topic).toBe("io.botflow.app.push-type.liveactivity");
    expect(activity.deviceToken).toBe(ACTIVITY);
    const aps = (activity.payload as { aps: Record<string, unknown> }).aps;
    expect(aps.event).toBe("end");
    expect(aps["content-state"]).toMatchObject({ phase: "done", action: "Finished", detail: "Ordering works end to end." });

    const alert = sent.find((r) => r.pushType === "alert")!;
    expect(alert.environment).toBe("development");
    expect(alert.collapseId).toBe(`turn-${threadId}`);
    expect(alert.payload).toMatchObject({
      aps: {
        alert: { title: "Tidewater Coffee: the agent finished", subtitle: "Add online ordering", body: "Ordering works end to end." },
        category: "AGENT_FINISHED",
      },
      projectId,
      threadId,
    });
    // The activity is over; its token is forgotten.
    expect(await getLiveActivity("u1", threadId)).toBeNull();
  });

  test("a stop the person asked for ends the activity without an alert", async () => {
    const { projectId, threadId } = await seed();
    await registerDevice("u1", { token: DEVICE, environment: "production", bundleId: "io.botflow.app" });
    await registerLiveActivity("u1", threadId, { token: ACTIVITY, environment: "production", projectId });
    await notifyTurnEnded({ userId: "u1", projectId, threadId, outcome: "stopped", summary: "" });
    expect(sent.map((r) => r.pushType)).toEqual(["liveactivity"]);
  });

  test("a failure says so", async () => {
    const { projectId, threadId } = await seed();
    await registerDevice("u1", { token: DEVICE, environment: "production", bundleId: "io.botflow.app" });
    await notifyTurnEnded({ userId: "u1", projectId, threadId, outcome: "failed", summary: "Rate limit reached" });
    expect(sent[0].payload).toMatchObject({ aps: { category: "AGENT_FAILED", alert: { title: "Tidewater Coffee: the agent stopped", body: "Rate limit reached" } } });
  });

  test("a question is a time-sensitive alert", async () => {
    const { projectId, threadId } = await seed();
    await registerDevice("u1", { token: DEVICE, environment: "production", bundleId: "io.botflow.app" });
    await notifyNeedsInput({ userId: "u1", projectId, threadId, question: "Which menu layout should the homepage use?" });
    expect(sent[0].payload).toMatchObject({
      aps: { category: "AGENT_NEEDS_INPUT", "interruption-level": "time-sensitive", alert: { title: "Tidewater Coffee needs your input" } },
    });
  });

  test("a token Apple has retired is dropped", async () => {
    const { projectId, threadId } = await seed();
    await registerDevice("u1", { token: DEVICE, environment: "production", bundleId: "io.botflow.app" });
    respond = () => ({ ok: false, status: 410, reason: "Unregistered" });
    await notifyTurnEnded({ userId: "u1", projectId, threadId, outcome: "done", summary: "Done." });
    expect(await listDevices("u1")).toHaveLength(0);
  });

  test("progress updates the activity with the step, a running count and the app's clock", async () => {
    const { projectId, threadId } = await seed();
    await registerLiveActivity("u1", threadId, { token: ACTIVITY, environment: "production", projectId });
    const startedAt = Date.UTC(2026, 10, 22, 12, 0, 0);
    await seedActivityState("u1", threadId, startedAt);

    expect(await pushTurnProgress({ userId: "u1", threadId, tool: "Edit", detail: "src/components/Cart.tsx", steps: 3 })).toBe(true);
    expect(await pushTurnProgress({ userId: "u1", threadId, tool: "Bash", detail: "pnpm build", steps: 4 })).toBe(true);

    const last = sent[sent.length - 1];
    expect(last.priority).toBe(5);
    const state = (last.payload as { aps: { "content-state": Record<string, unknown> } }).aps["content-state"];
    expect(state).toMatchObject({
      phase: "working",
      action: "Running",
      detail: "pnpm build",
      symbol: "terminal",
      steps: 4,
      recent: ["Editing src/components/Cart.tsx", "Running pnpm build"],
    });
    // Swift decodes dates as seconds since 2001-01-01.
    expect(state.startedAt).toBe(startedAt / 1000 - 978_307_200);
  });

  test("progress for a thread with no activity sends nothing", async () => {
    const { threadId } = await seed();
    expect(await pushTurnProgress({ userId: "u1", threadId, tool: "Read", detail: "a.ts", steps: 1 })).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

test("notification text is plain", () => {
  expect(plainSummary("The **cart** is in `src/Cart.tsx`.\n\n```ts\nconst x = 1\n```\nDone.")).toBe("The cart is in src/Cart.tsx. Done.");
});
