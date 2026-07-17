import assert from "node:assert/strict";
import test from "node:test";
import { BOTFLOW_NATIVE_TOOLS } from "./tool-name-map";

test("RevenueCat payment tools survive agent-turn handoff", () => {
  for (const tool of [
    "initializeRevenueCatPayments",
    "getRevenueCatProducts",
    "createRevenueCatProduct",
  ]) {
    assert.equal(BOTFLOW_NATIVE_TOOLS.has(tool), true, `${tool} must be native`);
  }
});
