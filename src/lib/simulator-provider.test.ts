import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { simulatorProvider } from "./simulator-provider";

const original = process.env.SIMULATOR_PROVIDER;
afterEach(() => {
  if (original === undefined) delete process.env.SIMULATOR_PROVIDER;
  else process.env.SIMULATOR_PROVIDER = original;
});
test("existing deployments retain cloud mode without a flag", () => {
  delete process.env.SIMULATOR_PROVIDER;
  assert.equal(simulatorProvider(), "cloud");
});
test("reads provider changes at request time", () => {
  process.env.SIMULATOR_PROVIDER = "local";
  assert.equal(simulatorProvider(), "local");
  process.env.SIMULATOR_PROVIDER = "cloud";
  assert.equal(simulatorProvider(), "cloud");
});
test("a misconfigured flag cannot silently allocate cloud Macs", () => {
  process.env.SIMULATOR_PROVIDER = "LOCAL_ONLY";
  assert.throws(simulatorProvider, /must be cloud or local/);
});
