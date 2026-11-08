import test from "node:test";
import assert from "node:assert/strict";
import { formatNear, isValidAccountId, summarize, view, loadAllSpends } from "./leash.js";

test("formatNear", () => {
  assert.equal(formatNear("50000000000000000000000"), "0.05 NEAR");
  assert.equal(formatNear("8357995223320813600000000"), "8.3579 NEAR");
  assert.equal(formatNear("1000000000000000000000000"), "1 NEAR");
  assert.equal(formatNear("0"), "0 NEAR");
});
test("account id validation", () => {
  assert.ok(isValidAccountId("leash-11020911.testnet"));
  for (const bad of ["", "A.testnet", "a..b", "x", "evil<script>.near", "-a.near"]) assert.ok(!isValidAccountId(bad), bad);
});
test("summarize counts and blocked value", () => {
  const s = summarize([{ status: "Allowed", amount: "5" }, { status: "Blocked", amount: "7" }, { status: "Blocked", amount: "3" }]);
  assert.deepEqual(s.byStatus, { Allowed: 1, Blocked: 2 });
  assert.equal(s.blockedYocto, "10");
});
test("view rejects bad contract before any network call", async () => {
  let called = false;
  await assert.rejects(view("testnet", "Bad Id", "get_status", {}, () => { called = true; }));
  assert.equal(called, false);
});
test("loadAllSpends pages through the log", async () => {
  const calls = [];
  const fake = async (_u, opts) => {
    const p = JSON.parse(opts.body).params; const a = JSON.parse(atob(p.args_base64)); calls.push(a);
    const items = Array.from({ length: Math.min(a.limit, 120 - a.from_index) }, (_, i) => ({ id: a.from_index + i }));
    return { json: async () => ({ result: { result: [...new TextEncoder().encode(JSON.stringify(items))] } }) };
  };
  const out = await loadAllSpends("testnet", "leash-11020911.testnet", 120, fake, 50);
  assert.equal(out.length, 120); assert.equal(calls.length, 3); assert.equal(out[119].id, 119);
});
