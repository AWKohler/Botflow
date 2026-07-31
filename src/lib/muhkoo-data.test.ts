/**
 * MuhKoo data-plane contract + token-retry policy.
 *
 * The status mappings asserted here were taken from live probes against
 * api.muhkoo.dev (2026-07-30), not from documentation — in particular that a
 * rejected key, a garbage key and an empty key are ALL `401 {"error":"API key
 * required"}`, which is why the retry has to be bounded rather than
 * condition-driven.
 *
 * Run: node --import tsx --test src/lib/muhkoo-data.test.ts
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  queryMuhkooTable,
  insertMuhkooRow,
  updateMuhkooRow,
  deleteMuhkooRow,
} from "./muhkoo-platform";
import { runWithTokenRetry } from "./muhkoo-provision";

const realFetch = globalThis.fetch;

/** Queue of canned responses, consumed in order; records every request. */
let calls: Array<{ method: string; url: string; body: unknown }> = [];

function stubFetch(responses: Array<{ status: number; body: unknown }>) {
  let i = 0;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    calls.push({
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("data-plane writes", () => {
  test("insert returns the created row and its id", async () => {
    stubFetch([{ status: 201, body: { row: { _id: 2, title: "hi" }, id: 2 } }]);
    const r = await insertMuhkooRow("mk_test_at_x", "items", { title: "hi" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.row, { _id: 2, title: "hi" });
    assert.equal(r.ok && r.id, 2);
    assert.equal(calls[0].method, "POST");
    assert.match(calls[0].url, /\/api\/db\/items$/);
    // The API expects the row nested under `values`, not spread at the top.
    assert.deepEqual(calls[0].body, { values: { title: "hi" } });
  });

  test("an unknown column surfaces the API's own message", async () => {
    stubFetch([{ status: 400, body: { error: 'unknown column "nope"' } }]);
    const r = await insertMuhkooRow("mk_test_at_x", "items", { nope: 1 });
    assert.equal(r.ok, false);
    // Naming the offending column is what lets the agent fix it unaided.
    assert.match(!r.ok ? r.error : "", /unknown column "nope"/);
    assert.equal(!r.ok && r.authFailed, undefined);
  });

  test("update PATCHes the row url and returns the updated row", async () => {
    stubFetch([{ status: 200, body: { row: { _id: 2, done: true } } }]);
    const r = await updateMuhkooRow("mk_test_at_x", "items", 2, { done: true });
    assert.equal(r.ok, true);
    assert.equal(calls[0].method, "PATCH");
    assert.match(calls[0].url, /\/api\/db\/items\/2$/);
    assert.deepEqual(calls[0].body, { values: { done: true } });
  });

  test("updating a missing row reports the API's 404", async () => {
    stubFetch([{ status: 404, body: { error: "Row not found" } }]);
    const r = await updateMuhkooRow("mk_test_at_x", "items", 999, { done: true });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /Row not found/);
  });

  test("delete is idempotent: a missing row is ok with deleted 0", async () => {
    stubFetch([{ status: 200, body: { deleted: 0 } }]);
    const r = await deleteMuhkooRow("mk_test_at_x", "items", 999);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.deleted, 0);
    assert.equal(calls[0].method, "DELETE");
  });

  test("a missing table with no API message gets the provision hint", async () => {
    stubFetch([{ status: 404, body: {} }]);
    const r = await queryMuhkooTable("mk_test_at_x", "ghost");
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /provision_muhkoo_table/);
  });

  test("query maps rows and nextCursor", async () => {
    stubFetch([{ status: 200, body: { rows: [{ _id: 1 }], nextCursor: "c1" } }]);
    const r = await queryMuhkooTable("mk_test_at_x", "items", { limit: 1 });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.nextCursor, "c1");
    assert.equal(r.ok && r.rows.length, 1);
  });

  test("every operation flags a 401 as authFailed", async () => {
    // Live behaviour: revoked, garbage, malformed and empty keys are all
    // indistinguishable here, so this flag is the only signal callers get.
    for (const op of [
      () => queryMuhkooTable("bad", "items"),
      () => insertMuhkooRow("bad", "items", { a: 1 }),
      () => updateMuhkooRow("bad", "items", 1, { a: 1 }),
      () => deleteMuhkooRow("bad", "items", 1),
    ]) {
      stubFetch([{ status: 401, body: { error: "API key required" } }]);
      const r = await op();
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.authFailed, true);
    }
  });

  test("a network failure is reported, not thrown", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const r = await insertMuhkooRow("mk_test_at_x", "items", { a: 1 });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /ECONNREFUSED/);
  });
});

describe("token retry policy", () => {
  test("a successful call does not renew", async () => {
    const forced: boolean[] = [];
    let runs = 0;
    const r = await runWithTokenRetry(
      async (force) => {
        forced.push(force);
        return "tok";
      },
      async () => {
        runs += 1;
        return { ok: true as const };
      },
    );
    assert.equal(r.ok, true);
    assert.equal(runs, 1);
    assert.deepEqual(forced, [false]);
  });

  test("a non-auth failure does not renew", async () => {
    let runs = 0;
    const r = await runWithTokenRetry(
      async () => "tok",
      async () => {
        runs += 1;
        return { ok: false as const, error: "no such table" };
      },
    );
    assert.equal(r.ok, false);
    assert.equal(runs, 1);
  });

  test("authFailed renews once and retries once", async () => {
    const forced: boolean[] = [];
    const used: string[] = [];
    let runs = 0;
    const r = await runWithTokenRetry(
      async (force) => {
        forced.push(force);
        return force ? "fresh" : "stale";
      },
      async (tok) => {
        used.push(tok);
        runs += 1;
        return runs === 1
          ? { ok: false as const, authFailed: true, error: "rejected" }
          : { ok: true as const };
      },
    );
    assert.equal(r.ok, true);
    assert.equal(runs, 2);
    assert.deepEqual(forced, [false, true], "second fetch must force a re-mint");
    assert.deepEqual(used, ["stale", "fresh"], "retry must use the NEW token");
  });

  test("a permanently bad credential stops after exactly two attempts", async () => {
    // The regression that matters: without a hard bound this loops forever,
    // because a broken key looks exactly like an expired one.
    let runs = 0;
    const r = await runWithTokenRetry(
      async () => "tok",
      async () => {
        runs += 1;
        return { ok: false as const, authFailed: true, error: "rejected" };
      },
    );
    assert.equal(r.ok, false);
    assert.equal(runs, 2, "must not attempt a third time");
  });

  test("no token means not provisioned, and run is never called", async () => {
    let runs = 0;
    const r = await runWithTokenRetry(
      async () => null,
      async () => {
        runs += 1;
        return { ok: true as const };
      },
    );
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /not provisioned/);
    assert.equal(runs, 0);
  });

  test("a renewal failure returns the original error rather than throwing", async () => {
    let runs = 0;
    const r = await runWithTokenRetry(
      async (force) => {
        if (force) throw new Error("dev session expired");
        return "stale";
      },
      async () => {
        runs += 1;
        return { ok: false as const, authFailed: true, error: "rejected" };
      },
    );
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /rejected/);
    assert.equal(runs, 1);
  });
});
