import assert from "node:assert/strict";
import test from "node:test";
import { selectSwiftRevenueCatConfig } from "@/lib/sandbox-env";

test("development Swift builds require a RevenueCat Test Store key", () => {
  assert.deepEqual(
    selectSwiftRevenueCatConfig(
      { productionSdkKey: "appl_live", testStoreSdkKey: null },
      "dev",
    ),
    { sdkKey: null, isTestStore: false },
  );
});

test("development Swift builds use the RevenueCat Test Store key when available", () => {
  assert.deepEqual(
    selectSwiftRevenueCatConfig(
      { productionSdkKey: "appl_live", testStoreSdkKey: "test_test" },
      "dev",
    ),
    { sdkKey: "test_test", isTestStore: true },
  );
});

test("release Swift builds always use the production RevenueCat key", () => {
  assert.deepEqual(
    selectSwiftRevenueCatConfig(
      { productionSdkKey: "appl_live", testStoreSdkKey: "test_test" },
      "release",
    ),
    { sdkKey: "appl_live", isTestStore: false },
  );
});

test("release Swift builds never fall back to a Test Store key", () => {
  assert.deepEqual(
    selectSwiftRevenueCatConfig({ productionSdkKey: null, testStoreSdkKey: "test_store" }, "release"),
    { sdkKey: null, isTestStore: false },
  );
});
