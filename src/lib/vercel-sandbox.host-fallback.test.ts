/**
 * isHostUnreachable decides when an existing sandbox-host project is moved to
 * Vercel. It must fire for the tunnel/proxy failures seen when the box died
 * (Cloudflare 530/1033 → SDK "Can't parse JSON … <!doctype") and network
 * errors, but NOT when the host itself answered with a JSON error — that
 * would abandon a live project's files.
 *
 * Run with: npx vitest run src/lib/vercel-sandbox.host-fallback.test.ts
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { APIError as HostAPIError } from "@sandbox-host/sdk";
import { APIError as VercelAPIError } from "@vercel/sandbox";
import { isHostUnreachable } from "./vercel-sandbox";

type Ctor = new (response: Response, options?: { message?: string; json?: unknown; text?: string }) => Error;
const HostErr = HostAPIError as unknown as Ctor;
const VercelErr = VercelAPIError as unknown as Ctor;

test("Cloudflare HTML 5xx (the prod incident) → unreachable", () => {
  const err = new HostErr(new Response("<!doctype html>", { status: 530 }), {
    message: "Can't parse JSON: SyntaxError: Unexpected token '<', \"<!doctype \"... is not valid JSON",
    text: "<!doctype html>",
  });
  assert.equal(isHostUnreachable(err), true);
});

test("plain-text 502 from the proxy → unreachable", () => {
  const err = new HostErr(new Response("error code: 1033", { status: 502 }), { text: "error code: 1033" });
  assert.equal(isHostUnreachable(err), true);
});

test("JSON 5xx from the host itself → NOT unreachable", () => {
  const json = { error: { code: "internal", message: "boom" } };
  const err = new HostErr(new Response(JSON.stringify(json), { status: 500 }), { json });
  assert.equal(isHostUnreachable(err), false);
});

test("host 4xx (404 gone, 429 capacity) → NOT unreachable", () => {
  assert.equal(isHostUnreachable(new HostErr(new Response("", { status: 404 }), { json: {} })), false);
  assert.equal(isHostUnreachable(new HostErr(new Response("", { status: 429 }), { json: {} })), false);
});

test("Vercel SDK errors never count", () => {
  assert.equal(isHostUnreachable(new VercelErr(new Response("<html>", { status: 502 }), { text: "<html>" })), false);
});

test("network-level failures → unreachable", () => {
  assert.equal(isHostUnreachable(new TypeError("fetch failed")), true);
  assert.equal(isHostUnreachable(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })), true);
  assert.equal(isHostUnreachable(Object.assign(new Error("x"), { code: "ENOTFOUND" })), true);
  assert.equal(isHostUnreachable(Object.assign(new Error("t"), { name: "TimeoutError" })), true);
});

test("ordinary bugs → NOT unreachable", () => {
  assert.equal(isHostUnreachable(new Error("Cannot read properties of undefined")), false);
  assert.equal(isHostUnreachable(new TypeError("x is not a function")), false);
  assert.equal(isHostUnreachable(null), false);
});
