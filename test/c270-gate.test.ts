// C270 checker items for 0.5.0 (C373), through the real `rules_gate` on a migrated database:
// 1. A call to an operation the cached app catalog does not list (an unknown op of a known app, an app the catalog does not
//    list, or no catalog at all) is still judged by the rules: a matching deny or hold rule applies. The gate has no method
//    registry and no passthrough for calls it cannot place.
// 2. An APP caller (`caller.type` "app", with and without a verified product) goes through the same gate as an agent: a deny by
//    its instance id in `agents`, and a deny or hold by `callerProducts` (fail closed when the product is absent).
// Every case has a fire-on-bad and a quiet-on-good outcome, asserted exactly (L27).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuleSpec } from "../src/engine.ts";
import { makeHooks } from "../src/hooks.ts";
import { listDecisions, saveRule } from "../src/store.ts";
import { AGENT_A, APP_INSTANCE, hookCtx, hookReq, migratedDb, OWNER, seedCatalog, spec } from "./helpers.ts";

type Db = ReturnType<typeof migratedDb>["db"];
const hooks = makeHooks("rules");
const call = (id: string, ...args: unknown[]) => (hooks[id] as unknown as (...a: unknown[]) => Promise<Record<string, any>>)(...args);
const gate = (db: Db, o: Parameters<typeof hookReq>[1]) => call("rules_gate", hookReq("before", o), hookCtx(db));
const traces = (db: Db) => Object.fromEntries(listDecisions(db, { limit: 50 }).items.map((t) => [t.callId, t]));
const OTHER_INSTANCE = "ins_01J0000000000000000000APP2";

/** A rule stored before the catalog lost its app (readers tolerate it): written like `saveRule` does, without the writer check. */
function storeRaw(db: Db, id: string, s: RuleSpec): void {
  const now = Date.now();
  db.prepare("INSERT INTO rules (id, rev, spec, priority, active, deleted, source, created_at, updated_at) VALUES (?, 1, ?, ?, 1, 0, 'owner', ?, ?)").run(id, JSON.stringify(s), s.priority, now, now);
}

// ── 1. operations the cached catalog does not list ─────────────────────────────────────────────────────────────
test("C270: a call to an op the catalog does not list (known app) is refused by a deny rule on that app; another app's call is not", async () => {
  // the catalog knows the app `ghostapp` but lists none of its operations
  const db = seedCatalog(migratedDb().db, ["ghostapp", "connect"]);
  saveRule(db, { spec: spec({ title: "no ghostapp", priority: 1, match: { products: ["ghostapp"] }, decision: "deny", reason: "ghostapp is off" }), actor: OWNER });
  for (const [i, effect] of ["read", "write", "outward"].entries()) {
    const r = await gate(db, { callId: `cal_ghost${i}`, product: "ghostapp", op: "unlisted_op", effect });
    assert.equal(r.allow, false, `${effect}: the op is not in the catalog, the deny rule still applies`);
    assert.match(String(r.reason), /^Rules: ghostapp is off \(rule rul_/);
  }
  // quiet-on-good: a call to another app (also an op the catalog does not list) is not touched by that rule
  assert.deepEqual(await gate(db, { callId: "cal_other", product: "connect", op: "unlisted_op", effect: "outward" }), { allow: true });
  const t = traces(db);
  assert.deepEqual([t.cal_ghost0?.answered, t.cal_ghost0?.target], ["deny", { product: "ghostapp", op: "unlisted_op", effect: "read" }], "the trace keeps the op as sent");
  assert.deepEqual([t.cal_other?.answered, t.cal_other?.ruleId], ["allow", null]);
});

test("C270: a call to an app the catalog does not list at all is gated by a deny or hold rule that matches it by caller or effect", async () => {
  const db = seedCatalog(migratedDb().db, ["connect"]);
  saveRule(db, { spec: spec({ title: "agent A may not send", priority: 1, match: { agents: [AGENT_A], effects: ["outward"] }, decision: "deny", reason: "agent A may not send" }), actor: OWNER });
  saveRule(db, { spec: spec({ title: "money needs review", priority: 2, match: { effects: ["money"] }, decision: "hold", reason: "money needs review" }), actor: OWNER });
  const denied = await gate(db, { callId: "cal_deny", product: "nowhere", op: "nothing", effect: "outward" });
  assert.equal(denied.allow, false);
  assert.match(String(denied.reason), /^Rules: agent A may not send \(rule rul_/);
  const held = await gate(db, { callId: "cal_hold", product: "nowhere", op: "pay_out", effect: "money" });
  assert.deepEqual([held.allow, held.hold?.family], [false, "policy"]);
  assert.match(String(held.hold?.reason), /^Needs owner review: money needs review \(rule rul_/);
  // quiet-on-good: another agent's outward call to the same unknown op matches no rule (default allow, recorded as outward)
  assert.deepEqual(await gate(db, { callId: "cal_quiet", caller: "agt_01J0000000000000000000000Z", product: "nowhere", op: "nothing", effect: "outward" }), { allow: true });
  const t = traces(db);
  assert.deepEqual(
    [t.cal_deny?.answered, t.cal_hold?.answered, t.cal_quiet?.answered, t.cal_quiet?.ruleId],
    ["deny", "hold", "allow", null],
  );
});

test("C270: a stored rule that names an app and op the catalog no longer lists still refuses that call; with no catalog at all too", async () => {
  for (const withCatalog of [true, false]) {
    const fresh = migratedDb().db;
    const db = withCatalog ? seedCatalog(fresh, ["connect"]) : fresh;
    storeRaw(db, "rul_01J00000000000000000VANISH", spec({ title: "no vanished pay", priority: 1, match: { products: ["vanished"], operations: ["gone_op"] }, decision: "deny", reason: "vanished pay is off" }));
    const r = await gate(db, { callId: "cal_gone", product: "vanished", op: "gone_op", effect: "read" });
    assert.deepEqual(r, { allow: false, reason: "Rules: vanished pay is off (rule rul_01J00000000000000000VANISH)" }, `catalog ${withCatalog}: the rule applies by product and op`);
    // quiet-on-good: another op of the same app is not named by the rule
    assert.deepEqual(await gate(db, { callId: "cal_near", product: "vanished", op: "gone_op2", effect: "read" }), { allow: true }, `catalog ${withCatalog}`);
  }
});

test("C270: a deny rule with tools on an app whose op the catalog cannot place applies to a call without a tool name (fail closed)", async () => {
  const db = migratedDb().db; // no catalog: no op can be placed
  storeRaw(db, "rul_01J0000000000000000000TOOL", spec({ title: "no gmail send", priority: 1, match: { products: ["connect"], tools: ["gmail_send"] }, decision: "deny", reason: "no gmail send" }));
  assert.equal((await gate(db, { callId: "cal_notool", product: "connect", op: "unknown_dyn", effect: "outward" })).allow, false, "no tool name: the deny applies");
  assert.equal((await gate(db, { callId: "cal_listed", product: "connect", op: "unknown_dyn", effect: "outward", tool: "gmail_send__first_contact" })).allow, false, "a variant of the listed tool");
  assert.deepEqual(await gate(db, { callId: "cal_other", product: "connect", op: "unknown_dyn", effect: "outward", tool: "slack_post" }), { allow: true }, "quiet: another tool");
  const t = traces(db);
  assert.deepEqual([t.cal_notool?.detail, t.cal_listed?.detail, t.cal_other?.detail], [{ toolUnknown: true }, { tool: "gmail_send__first_contact" }, { tool: "slack_post" }], "a call with a tool name is not 'unknown'");
});

// ── 2. app callers go through the same gate ────────────────────────────────────────────────────────────────────
test("C270: an app caller is refused by a deny rule that lists its instance id in agents, with and without a verified product", async () => {
  const db = seedCatalog(migratedDb().db, ["connect", "knowledge"]);
  saveRule(db, { spec: spec({ title: "that instance may not send", priority: 1, match: { agents: [APP_INSTANCE], effects: ["outward"] }, decision: "deny", reason: "that instance may not send" }), actor: OWNER });
  for (const [label, app] of [
    ["verified product", { product: "knowledge" }],
    ["no product", {}],
  ] as const) {
    const r = await gate(db, { callId: `cal_${label.replace(/ /g, "_")}`, effect: "outward", app });
    assert.equal(r.allow, false, label);
    assert.match(String(r.reason), /^Rules: that instance may not send \(rule rul_/, label);
  }
  // quiet-on-good: another instance (same product) and an agent are not listed
  assert.deepEqual(await gate(db, { callId: "cal_other_ins", effect: "outward", app: { id: OTHER_INSTANCE, product: "knowledge" } }), { allow: true });
  assert.deepEqual(await gate(db, { callId: "cal_agent", effect: "outward" }), { allow: true });
  const t = traces(db);
  assert.deepEqual(t.cal_verified_product?.caller, { type: "app", id: APP_INSTANCE, mode: null, product: "knowledge" });
  assert.deepEqual(t.cal_no_product?.caller, { type: "app", id: APP_INSTANCE, mode: null, product: null });
  assert.equal(t.cal_no_product?.detail, null, "the rule names no product: nothing rests on the missing one");
});

test("C270: callerProducts deny and hold gate an app caller with its product listed, and fail closed without a product; an agent and an unlisted app pass", async () => {
  const db = seedCatalog(migratedDb().db, ["connect", "knowledge", "crm"]);
  saveRule(db, { spec: spec({ title: "knowledge may not send", priority: 1, match: { effects: ["outward"], callerProducts: ["knowledge"] }, decision: "deny", reason: "knowledge may not send" }), actor: OWNER });
  saveRule(db, { spec: spec({ title: "knowledge money", priority: 2, match: { effects: ["money"], callerProducts: ["knowledge"] }, decision: "hold", reason: "knowledge money needs review" }), actor: OWNER });
  const cases = [
    ["listed_out", { effect: "outward", app: { product: "knowledge" } }, "deny"],
    ["absent_out", { effect: "outward", app: {} }, "deny"],
    ["listed_pay", { effect: "money", app: { product: "knowledge" } }, "hold"],
    ["absent_pay", { effect: "money", app: {} }, "hold"],
    ["unlisted_out", { effect: "outward", app: { product: "crm" } }, "allow"],
    ["unlisted_pay", { effect: "money", app: { product: "crm" } }, "allow"],
    ["agent_out", { effect: "outward" }, "allow"],
    ["agent_pay", { effect: "money" }, "allow"],
  ] as const;
  for (const [id, o, want] of cases) {
    const r = await gate(db, { callId: `cal_${id}`, ...o });
    const got = r.allow === true ? "allow" : r.hold ? "hold" : "deny";
    assert.equal(got, want, id);
  }
  const t = traces(db);
  assert.deepEqual(
    cases.map(([id]) => [id, t[`cal_${id}`]?.answered, t[`cal_${id}`]?.detail ?? null]),
    [
      ["listed_out", "deny", null],
      ["absent_out", "deny", { callerProductUnavailable: true }],
      ["listed_pay", "hold", null],
      ["absent_pay", "hold", { callerProductUnavailable: true }],
      ["unlisted_out", "allow", null],
      ["unlisted_pay", "allow", null],
      ["agent_out", "allow", null],
      ["agent_pay", "allow", null],
    ],
  );
});

test("C270: an allow rule by callerProducts never opens a later deny for an app without a verified product; with the product it does", async () => {
  const db = seedCatalog(migratedDb().db, ["connect", "knowledge"]);
  saveRule(db, { spec: spec({ title: "knowledge may send", priority: 1, match: { effects: ["outward"], callerProducts: ["knowledge"] }, decision: "allow", reason: "knowledge may send" }), actor: OWNER });
  saveRule(db, { spec: spec({ title: "nothing else sends", priority: 2, match: { effects: ["outward"] }, decision: "deny", reason: "nothing else sends" }), actor: OWNER });
  assert.deepEqual(await gate(db, { callId: "cal_ok", effect: "outward", app: { product: "knowledge" } }), { allow: true });
  const absent = await gate(db, { callId: "cal_absent", effect: "outward", app: {} });
  assert.equal(absent.allow, false);
  assert.match(String(absent.reason), /^Rules: nothing else sends \(rule rul_/);
  assert.equal((await gate(db, { callId: "cal_agent", effect: "outward" })).allow, false, "an agent never matches the product rule");
});
