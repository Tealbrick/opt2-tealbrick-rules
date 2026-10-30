// C373c: the workspace DEFAULT MODE for calls that match no rule (Permissive allow, Verification hold, Closed refuse), its
// built-in exemptions (Rules' own Governance read first), `mode_set` (looser needs confirm, every change recorded, person
// only), the dry run, `rules_explain`, and migration 0008 on a 0.4.x-shaped database. Every case asserts the exact outcome
// and has a fire-on-bad counterpart (L27).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { OP } from "#kit";
import { definition, handlers, manifest, migrationsDir } from "../src/app.ts";
import { type CallFacts, evaluate, NO_MATCH_REASON, order, type Rule, recorded } from "../src/engine.ts";
import { syncFleet } from "../src/fleet.ts";
import { gateAnswer, makeHooks } from "../src/hooks.ts";
import { CLOSED_REASON, composeModeNotes, type DefaultMode, EXEMPTIONS, exemptionOf, looser, MODES, modeDetail, traceDecidedBy, VERIFICATION_REASON } from "../src/mode.ts";
import { currentMode, invalidateMode, modeHistory, setMode } from "../src/mode-store.ts";
import { listDecisions, saveRule } from "../src/store.ts";
import { AGENT_A, AGENT_B, APP_INSTANCE, feed, hookCtx, hookReq, migratedDb, OWNER, opCtx, seedCatalog, spec } from "./helpers.ts";

type Db = ReturnType<typeof migratedDb>["db"];
type Run = (input: unknown, ctx: OpContext) => Promise<any>;
const run = (id: keyof typeof handlers) => (handlers[id] as unknown as { run: Run }).run;
const hooks = makeHooks("rules");
const gate = (db: Db, o: Parameters<typeof hookReq>[1]) => (hooks.rules_gate as unknown as (...a: unknown[]) => Promise<Record<string, any>>)(hookReq("before", o), hookCtx(db));
const traces = (db: Db) => Object.fromEntries(listDecisions(db, { limit: 100 }).items.map((t) => [t.callId, t]));
const owner = (db: Db) => opCtx(db, { type: "person", id: OWNER });

const rule = (id: string, s: Rule["spec"]): Rule => ({ id, rev: 1, spec: s, updatedAt: 1 });
const facts = (o: { callerType?: "agent" | "app"; caller?: string; callerProduct?: string | null; product?: string; op?: string; effect?: string; fleetAvailable?: boolean } = {}): CallFacts => ({
  caller: { type: o.callerType ?? "agent", id: o.caller ?? (o.callerType === "app" ? APP_INSTANCE : AGENT_A), mode: o.callerType === "app" ? null : "free" },
  target: { product: o.product ?? "connect", op: o.op ?? "buzz_dm", effect: o.effect ?? "outward" },
  claim: null,
  claimVerified: false,
  claimTeams: [],
  claimTeamsAny: [],
  callerTeams: [],
  callerTeamsAny: [],
  claimTrusts: [],
  claimTrustActive: true,
  fleetAvailable: o.fleetAvailable ?? true,
  callerProduct: o.callerProduct ?? null,
});
const RULES = order([
  rule("rul_allow", spec({ title: "reads ok", priority: 10, match: { products: ["knowledge"], effects: ["read"] }, decision: "allow", reason: "reads are fine", narrowing: { memoryTags: { anyOf: ["work"] } } })),
  rule("rul_deny", spec({ title: "no money", priority: 20, match: { effects: ["money"] }, decision: "deny", reason: "no money" })),
  rule("rul_hold", spec({ title: "sends wait", priority: 30, match: { products: ["connect"], operations: ["buzz_dm"] }, decision: "hold", reason: "sends wait" })),
]);

// ── 1. engine: each mode × no match / allow / deny / hold match, agent and app caller ────────────────────────────
for (const mode of MODES) {
  test(`engine, ${mode} mode: a match decides as before; only the no-match path follows the mode`, () => {
    for (const callerType of ["agent", "app"] as const) {
      const base = { callerType, ...(callerType === "app" ? { callerProduct: "observer" } : {}) };
      const allow = evaluate(RULES, facts({ ...base, product: "knowledge", op: "recall", effect: "read" }), mode);
      assert.deepEqual([allow.decision, allow.rule?.id, allow.narrowing, allow.byMode], ["allow", "rul_allow", { memoryTags: { anyOf: ["work"] } }, undefined], `${callerType}: allow rule`);
      const deny = evaluate(RULES, facts({ ...base, product: "billing", op: "pay", effect: "money" }), mode);
      assert.deepEqual([deny.decision, deny.rule?.id, deny.reason], ["deny", "rul_deny", "no money"], `${callerType}: deny rule`);
      const hold = evaluate(RULES, facts({ ...base }), mode);
      assert.deepEqual([hold.decision, hold.rule?.id, hold.reason], ["hold", "rul_hold", "sends wait"], `${callerType}: hold rule`);
      // no match: an op nobody names (also unknown to any catalog)
      const none = evaluate(RULES, facts({ ...base, product: "ghostapp", op: "unknown_op", effect: "write" }), mode);
      const want = { permissive: ["allow", NO_MATCH_REASON], verification: ["hold", VERIFICATION_REASON], closed: ["deny", CLOSED_REASON] }[mode];
      assert.deepEqual([none.decision, none.reason, none.rule, none.byMode], [...want, null, { mode, exemption: null }], `${callerType}: no match`);
      assert.equal(recorded(facts({ ...base, effect: "write" }), none), true, "a write that matched no rule is recorded in every mode (QA-C373-RU-2)");
      assert.equal(recorded(facts({ ...base, effect: "read" }), none), mode !== "permissive", "a read is recorded only when the mode refused or held it");
    }
  });
}

test("engine: the default mode argument is permissive (callers that pass none keep the old behaviour)", () => {
  const v = evaluate([], facts());
  assert.deepEqual([v.decision, v.reason, v.byMode], ["allow", NO_MATCH_REASON, { mode: "permissive", exemption: null }]);
});

test("engine: an allow rule skipped for unavailable Fleet facts leaves the call unmatched, so Closed refuses it (fail closed)", () => {
  const rules = [rule("rul_team", spec({ title: "team reads", match: { callerTeams: ["tm_x"] }, decision: "allow", reason: "team may" }))];
  assert.equal(evaluate(rules, facts({ fleetAvailable: false }), "closed").decision, "deny");
  assert.equal(evaluate(rules, facts({ fleetAvailable: false }), "verification").decision, "hold");
  assert.equal(evaluate(rules, facts({ fleetAvailable: false }), "permissive").decision, "allow");
});

test("engine: an unverified on-behalf-of claim cannot open a Closed workspace (claims only narrow, C82)", () => {
  const rules = [rule("rul_claim", spec({ title: "anna may", match: { onBehalfOf: { ids: ["slack:U777"] } }, decision: "allow", reason: "anna" }))];
  const f = { ...facts(), claim: { kind: "channel_sender" as const, id: "slack:U777" } };
  assert.equal(evaluate(rules, { ...f, claimVerified: false }, "closed").decision, "deny", "unverified claim: the scan without the claim refuses");
  assert.equal(evaluate(rules, { ...f, claimVerified: true }, "closed").decision, "allow", "verified claim: the allow rule decides");
});

// ── 2. the gate: answers and traces ────────────────────────────────────────────────────────────────────────────
test("gate: Verification holds a no-match call (family policy) and Closed refuses it, with the exact reasons; traces say the mode decided", async () => {
  const { db } = migratedDb();
  assert.deepEqual(await gate(db, { callId: "cal_p", effect: "write" }), { allow: true }, "fresh install: Permissive");
  setMode(db, { mode: "verification", actor: OWNER });
  const held = await gate(db, { callId: "cal_v", effect: "write" });
  const hr = "Needs owner review: no rule covers this call (Verification mode)";
  assert.deepEqual(held, { allow: false, reason: hr, hold: { family: "policy", reason: hr } });
  setMode(db, { mode: "closed", actor: OWNER });
  assert.deepEqual(await gate(db, { callId: "cal_c", effect: "write" }), { allow: false, reason: "Rules: no rule allows this call (Closed mode)" });
  // an app (companion) caller and an Evolution-style engine call reach the same gate
  assert.deepEqual(await gate(db, { callId: "cal_app", app: { product: "evolution" }, product: "kanban", op: "issue_create", effect: "write" }), { allow: false, reason: "Rules: no rule allows this call (Closed mode)" });
  const t = traces(db);
  assert.deepEqual([t.cal_p?.answered, t.cal_p?.ruleId, t.cal_p?.detail], ["allow", null, { decidedBy: "mode", mode: "permissive" }], "QA-C373-RU-2: a Permissive write that matched no rule is recorded with the mode");
  assert.deepEqual([t.cal_v?.answered, t.cal_v?.ruleId, t.cal_v?.detail], ["hold", null, { decidedBy: "mode", mode: "verification" }]);
  assert.deepEqual([t.cal_c?.answered, t.cal_c?.detail], ["deny", { decidedBy: "mode", mode: "closed" }]);
  assert.deepEqual([t.cal_app?.answered, t.cal_app?.caller.product], ["deny", "evolution"]);
});

test("gate: an older bridge without hold support refuses a Verification no-match call (fail closed)", () => {
  const v = evaluate([], facts(), "verification");
  const { answer, answered } = gateAnswer(v, false);
  assert.equal(answered, "deny");
  assert.match((answer as { reason: string }).reason, /^Rules: no rule covers this call \(Verification mode\)\. This needs owner review/);
});

test("gate: in Closed mode a call that matches an allow rule still runs (narrowing unchanged)", async () => {
  const db = seedCatalog(migratedDb().db, ["connect"]);
  saveRule(db, { spec: spec({ title: "dms ok", match: { products: ["connect"] }, decision: "allow", reason: "dms are fine" }), actor: OWNER });
  setMode(db, { mode: "closed", actor: OWNER });
  assert.deepEqual(await gate(db, { callId: "cal_ok" }), { allow: true });
  assert.equal((await gate(db, { callId: "cal_no", product: "billing", op: "pay", effect: "money" })).allow, false);
});

test("gate: the mode is cached (no settings query per call) and a mode_set takes effect at once", async () => {
  const { db } = migratedDb();
  let queries = 0;
  const prepare = (sql: string) => {
    if (sql.includes("FROM settings")) queries++;
    return db.prepare(sql);
  };
  const counting = { ...db, prepare } as unknown as Db;
  invalidateMode(counting);
  for (let i = 0; i < 20; i++) await gate(counting, { callId: `cal_${i}`, effect: "read" });
  assert.ok(queries <= 1, `settings read ${queries} times for 20 calls`);
  setMode(counting, { mode: "closed", actor: OWNER });
  assert.equal((await gate(counting, { callId: "cal_after", effect: "read" })).allow, false);
});

// ── 3. built-in exemptions ───────────────────────────────────────────────────────────────────────────────────────
test("exemption (a): Rules' own Governance read is never held or refused by the mode", async () => {
  const { db } = migratedDb();
  for (const mode of ["verification", "closed"] as const) {
    setMode(db, { mode, confirm: true, actor: OWNER });
    assert.deepEqual(await gate(db, { callId: `cal_feed_${mode}`, app: { product: "rules" }, product: "fleet", op: "directory_feed", effect: "read" }), { allow: true }, mode);
  }
});

test("exemption (a) fire-on-bad: an ins_ caller without a verified product, another fleet op, another caller product and an agent are NOT exempt", async () => {
  const { db } = migratedDb();
  setMode(db, { mode: "closed", actor: OWNER });
  const refused = { allow: false, reason: "Rules: no rule allows this call (Closed mode)" };
  assert.deepEqual(await gate(db, { callId: "cal_noprod", app: { id: APP_INSTANCE }, product: "fleet", op: "directory_feed", effect: "read" }), refused, "app without product");
  assert.deepEqual(await gate(db, { callId: "cal_badprod", app: { product: "Rules " }, product: "fleet", op: "directory_feed", effect: "read" }), refused, "product that is no product id");
  assert.deepEqual(await gate(db, { callId: "cal_otherop", app: { product: "rules" }, product: "fleet", op: "agents_list", effect: "read" }), refused, "another op on fleet");
  assert.deepEqual(await gate(db, { callId: "cal_otherprod", app: { product: "observer" }, product: "fleet", op: "directory_feed", effect: "read" }), refused, "another caller product");
  assert.deepEqual(await gate(db, { callId: "cal_agent", product: "fleet", op: "directory_feed", effect: "read" }), refused, "an agent");
  assert.deepEqual(await gate(db, { callId: "cal_rulesother", app: { product: "rules" }, product: "connect", op: "buzz_dm", effect: "outward" }), refused, "Rules calling another app");
});

test("C378 internal calls pass Verification and Closed: each exemption with its exact caller and ops, read back in the trace", async () => {
  const cases = [
    ["knowledge-governance-feed", "knowledge", "fleet", ["directory_feed"], "read"],
    ["governance-reads-connect", "fleet", "connect", ["identities_list", "contacts_list"], "read"],
    ["owner-decision-relay", "connect", "inbox", ["item_decide_dm"], "write"],
    ["apps-ask-owner", "evolution", "inbox", ["inbox_ask", "inbox_status", "inbox_reply", "inbox_withdraw"], "write"],
    ["apps-ask-owner", "observer", "inbox", ["inbox_ask", "inbox_status"], "write"],
  ] as const;
  for (const mode of ["verification", "closed"] as const) {
    const { db } = migratedDb();
    setMode(db, { mode, confirm: true, actor: OWNER });
    for (const [id, caller, product, ops, effect] of cases)
      for (const op of ops) {
        const callId = `cal_${mode}_${caller}_${op}`;
        assert.deepEqual(await gate(db, { callId, app: { product: caller }, product, op, effect }), { allow: true }, callId);
        if (effect === "write") assert.deepEqual(traces(db)[callId]?.detail, { decidedBy: "exemption", mode, exemption: id }, callId);
      }
  }
});

test("C378 fire-on-bad: no verified product, another product, another op, another target and an agent are NOT exempt; a deny rule still decides", async () => {
  const { db } = migratedDb();
  setMode(db, { mode: "closed", actor: OWNER });
  const refused = { allow: false, reason: "Rules: no rule allows this call (Closed mode)" };
  const bad = [
    ["knowledge without a verified product", { id: APP_INSTANCE }, "fleet", "directory_feed", "read"],
    ["knowledge another fleet op", { product: "knowledge" }, "fleet", "agents_list", "read"],
    ["observer reads the feed", { product: "observer" }, "fleet", "directory_feed", "read"],
    ["fleet another connect op", { product: "fleet" }, "connect", "data_pull", "read"],
    ["fleet writes through connect", { product: "fleet" }, "connect", "buzz_dm", "outward"],
    ["observer reads the directory", { product: "observer" }, "connect", "contacts_list", "read"],
    ["kanban decides a DM", { product: "kanban" }, "inbox", "item_decide_dm", "write"],
    ["evolution decides a DM", { product: "evolution" }, "inbox", "item_decide_dm", "write"],
    ["connect another inbox op", { product: "connect" }, "inbox", "items_list", "read"],
    ["app without a product asks", { id: APP_INSTANCE }, "inbox", "inbox_ask", "write"],
    ["same op name on another app", { product: "evolution" }, "kanban", "inbox_ask", "write"],
    ["evolution sends through connect", { product: "evolution" }, "connect", "tools", "outward"],
    ["observer pulls data", { product: "observer" }, "connect", "data_pull", "read"],
    ["evolution writes the board", { product: "evolution" }, "kanban", "issue_create", "write"],
  ] as const;
  for (const [name, app, product, op, effect] of bad) assert.deepEqual(await gate(db, { callId: `cal_${name}`, app, product, op, effect }), refused, name);
  for (const [name, product, op] of [["agent reads feed", "fleet", "directory_feed"], ["agent decides", "inbox", "item_decide_dm"], ["agent asks", "inbox", "inbox_ask"], ["agent reads directory", "connect", "contacts_list"]] as const)
    assert.deepEqual(await gate(db, { callId: `cal_${name}`, product, op, effect: "read" }), refused, name);
  const cdb = seedCatalog(migratedDb().db, ["inbox"]);
  saveRule(cdb, { spec: spec({ title: "no inbox", match: { products: ["inbox"] }, decision: "deny", reason: "off" }), actor: OWNER });
  setMode(cdb, { mode: "closed", actor: OWNER });
  assert.equal((await gate(cdb, { callId: "cal_x", app: { product: "connect" }, product: "inbox", op: "item_decide_dm", effect: "write" })).allow, false);
});

test("exemption (a) does not override an owner rule: a matching deny rule on the feed still refuses it", async () => {
  const db = seedCatalog(migratedDb().db, ["fleet"]);
  saveRule(db, { spec: spec({ title: "no fleet", match: { products: ["fleet"] }, decision: "deny", reason: "fleet is off" }), actor: OWNER });
  setMode(db, { mode: "closed", actor: OWNER });
  assert.equal((await gate(db, { callId: "cal_f", app: { product: "rules" }, product: "fleet", op: "directory_feed", effect: "read" })).allow, false);
});

test("exemption (a2): Operator Inbox's owner DMs through Connect pass Verification and Closed (no hold-notification loop)", async () => {
  const { db } = migratedDb();
  for (const mode of ["verification", "closed"] as const) {
    setMode(db, { mode, confirm: true, actor: OWNER });
    for (const op of ["buzz_dm", "buzz_dm_first", "channel_dm", "channel_dm_first"])
      assert.deepEqual(await gate(db, { callId: `cal_${mode}_${op}`, app: { product: "inbox" }, product: "connect", op, effect: "outward" }), { allow: true }, `${mode} ${op}`);
  }
  // outward, so recorded: the trace says the exemption, not a rule, let it pass
  assert.deepEqual(traces(db).cal_closed_buzz_dm?.detail, { decidedBy: "exemption", mode: "closed", exemption: "inbox-owner-alerts" });
});

test("exemption (a2) fire-on-bad: an ins_ caller without a product, another product calling buzz_dm, Inbox calling another Connect op, an agent calling buzz_dm are NOT exempt", async () => {
  const { db } = migratedDb();
  setMode(db, { mode: "verification", actor: OWNER });
  const held = (r: Record<string, any>) => [r.allow, r.hold?.family];
  assert.deepEqual(held(await gate(db, { callId: "cal_a", app: { id: APP_INSTANCE }, product: "connect", op: "buzz_dm", effect: "outward" })), [false, "policy"], "app without product");
  assert.deepEqual(held(await gate(db, { callId: "cal_b", app: { product: "observer" }, product: "connect", op: "buzz_dm", effect: "outward" })), [false, "policy"], "another product");
  assert.deepEqual(held(await gate(db, { callId: "cal_c", app: { product: "inbox" }, product: "connect", op: "tools", effect: "outward" })), [false, "policy"], "another connect op");
  assert.deepEqual(held(await gate(db, { callId: "cal_d", product: "connect", op: "buzz_dm", effect: "outward" })), [false, "policy"], "an agent");
  assert.deepEqual(held(await gate(db, { callId: "cal_e", app: { product: "inbox" }, product: "kanban", op: "buzz_dm", effect: "outward" })), [false, "policy"], "the same op name on another app");
  // an owner rule still decides: a deny on connect refuses Inbox's DM
  const cdb = seedCatalog(migratedDb().db, ["connect"]);
  saveRule(cdb, { spec: spec({ title: "no dms", match: { products: ["connect"] }, decision: "deny", reason: "dms are off" }), actor: OWNER });
  setMode(cdb, { mode: "closed", actor: OWNER });
  assert.equal((await gate(cdb, { callId: "cal_f", app: { product: "inbox" }, product: "connect", op: "buzz_dm", effect: "outward" })).allow, false);
});

test("exemptions (b) and (c): Rules' self-service ops and standard tb.* ops pass the mode; look-alikes do not", () => {
  for (const op of ["rules_explain", "rule_draft_submit", "draft_status"]) assert.equal(exemptionOf(facts({ product: "rules", op })), "rules-self-service", op);
  for (const op of ["tb.holds_pending", "tb.hold_status"]) assert.equal(exemptionOf(facts({ callerType: "app", callerProduct: "inbox", product: "kanban", op })), "platform-standard-ops", op);
  // fire-on-bad: an owner op of Rules (unreachable for agents anyway), the same op name on another app, a non-tb op
  assert.equal(exemptionOf(facts({ product: "rules", op: "mode_set" })), null);
  assert.equal(exemptionOf(facts({ product: "kanban", op: "rules_explain" })), null);
  assert.equal(exemptionOf(facts({ product: "kanban", op: "tbholds_pending" })), null);
  const v = evaluate([], facts({ product: "rules", op: "rule_draft_submit", effect: "write" }), "closed");
  assert.deepEqual([v.decision, v.byMode, modeDetail(v)], ["allow", { mode: "closed", exemption: "rules-self-service" }, { decidedBy: "exemption", mode: "closed", exemption: "rules-self-service" }]);
  assert.deepEqual(
    EXEMPTIONS.map((e) => e.id),
    ["rules-governance-feed", "knowledge-governance-feed", "governance-reads-connect", "governance-reads-access", "inbox-owner-alerts", "owner-decision-relay", "apps-ask-owner", "rules-self-service", "platform-standard-ops"],
  );
});

// ── 4. mode_set / mode_get ─────────────────────────────────────────────────────────────────────────────────────
test("mode_set: tighter needs no confirm; looser without confirm is 409 confirm_required and changes nothing; every change is recorded", async () => {
  const { db } = migratedDb();
  const set = (input: unknown) => run(OP.modeSet)(input, owner(db));
  const out = await set({ mode: "closed" });
  assert.deepEqual([out.mode, out.previous, out.changed, out.changedBy], ["closed", "permissive", true, OWNER]);
  await assert.rejects(set({ mode: "verification" }), (e: { code?: string; httpStatus?: number; message?: string }) => e.code === "confirm_required" && e.httpStatus === 409 && /Closed to Verification/.test(String(e.message)));
  await assert.rejects(set({ mode: "permissive", confirm: false }), { code: "confirm_required" });
  assert.equal(currentMode(db), "closed", "a refused change keeps the mode");
  assert.equal((await set({ mode: "verification", confirm: true })).mode, "verification");
  assert.equal((await set({ mode: "closed" })).mode, "closed", "tighter again: no confirm");
  assert.equal((await set({ mode: "permissive", confirm: true })).mode, "permissive");
  const got = await run(OP.modeGet)({}, owner(db));
  assert.deepEqual(
    got.history.map((h: { from: string; to: string; actor: string }) => `${h.from}>${h.to}:${h.actor === OWNER}`),
    ["closed>permissive:true", "verification>closed:true", "closed>verification:true", "permissive>closed:true"],
  );
  assert.equal(got.mode, "permissive");
  assert.equal(got.system.length, EXEMPTIONS.length);
  assert.deepEqual([looser("closed", "verification"), looser("verification", "permissive"), looser("permissive", "closed"), looser("closed", "closed")], [true, true, false, false]);
});

test("mode_set: setting the current mode again (a replay) changes and records nothing; the op requires an idempotency key", async () => {
  const { db } = migratedDb();
  await run(OP.modeSet)({ mode: "verification" }, owner(db));
  const again = await run(OP.modeSet)({ mode: "verification" }, owner(db));
  assert.deepEqual([again.changed, again.previous, modeHistory(db).length], [false, "verification", 1]);
  const m = manifest.operations.find((o) => o.id === "mode_set");
  assert.deepEqual([m?.audience, m?.crud, m?.effect, m?.idempotency], ["person", ["update"], "write", "required"]);
  assert.equal(manifest.operations.find((o) => o.id === "mode_get")?.audience, "person");
});

test("mode_set and mode_get are person-only: an agent or an app is refused 403 and the mode stays", async () => {
  const { db } = migratedDb();
  for (const caller of [{ type: "agent" as const, id: AGENT_A }, { type: "app" as const, id: APP_INSTANCE, product: "observer" }]) {
    await assert.rejects(run(OP.modeSet)({ mode: "permissive", confirm: true }, opCtx(db, caller)), { code: "forbidden" });
    await assert.rejects(run(OP.modeGet)({}, opCtx(db, caller)), { code: "forbidden" });
  }
  assert.deepEqual([currentMode(db), modeHistory(db).length], ["permissive", 0]);
});

test("rules_list returns the mode, the matching default decision and the read-only system lines", async () => {
  const { db } = migratedDb();
  const a = await run(OP.rulesList)({}, owner(db));
  assert.deepEqual([a.mode.mode, a.mode.changedBy, a.defaultDecision, a.system.map((s: { id: string }) => s.id)], ["permissive", null, "allow", EXEMPTIONS.map((e) => e.id)]);
  setMode(db, { mode: "verification", actor: OWNER });
  const b = await run(OP.rulesList)({}, owner(db));
  assert.deepEqual([b.mode.mode, b.mode.changedBy, b.defaultDecision], ["verification", OWNER, "hold"]);
});

// ── 5. dry run and explain ───────────────────────────────────────────────────────────────────────────────────────
test("rules_preview: no match shows what the current mode would do; `mode` compares modes; a rule match is unchanged", async () => {
  const { db } = migratedDb();
  setMode(db, { mode: "verification", actor: OWNER });
  const call = { caller: { type: "agent", id: AGENT_A, mode: "free" }, target: { product: "connect", op: "buzz_dm", effect: "outward" } };
  const p = await run(OP.rulesPreview)({ call }, owner(db));
  assert.deepEqual([p.mode, p.decision, p.answered, p.decidedBy, p.modeNote], ["verification", "hold", "hold", "mode", "No rule matches → Verification mode would HOLD this call"]);
  const c = await run(OP.rulesPreview)({ call, mode: "closed" }, owner(db));
  assert.deepEqual([c.mode, c.decision, c.modeNote], ["closed", "deny", "No rule matches → Closed mode would REFUSE this call"]);
  const pm = await run(OP.rulesPreview)({ call, mode: "permissive" }, owner(db));
  assert.deepEqual([pm.decision, pm.modeNote], ["allow", "No rule matches → Permissive mode would ALLOW this call"]);
  assert.equal(currentMode(db), "verification", "the dry run changes nothing");
  const feed = await run(OP.rulesPreview)({ call: { caller: { type: "app", id: "ins_preview", product: "rules" }, target: { product: "fleet", op: "directory_feed", effect: "read" } }, mode: "closed" }, owner(db));
  assert.deepEqual([feed.decision, feed.decidedBy, feed.exemption], ["allow", "exemption", "rules-governance-feed"]);
  assert.match(String(feed.modeNote), /system exemption: Rules reads Governance/);
  const withRule = await run(OP.rulesPreview)({ call, candidate: spec({ title: "dms ok", match: {}, decision: "allow", reason: "ok" }), mode: "closed" }, owner(db));
  assert.deepEqual([withRule.decision, withRule.decidedBy, withRule.modeNote], ["allow", "rule", null]);
});

test("rules_explain: an agent sees that the MODE decided (decidedBy, mode name); rule rows and old rows read correctly", async () => {
  const { db } = migratedDb();
  setMode(db, { mode: "closed", actor: OWNER });
  await gate(db, { callId: "cal_mode", effect: "write" });
  const out = await run(OP.rulesExplain)({}, opCtx(db, { type: "agent", id: AGENT_A }));
  assert.deepEqual(
    out.decisions.map((d: Record<string, unknown>) => [d.callId, d.decidedBy, d.mode, d.reason]),
    [["cal_mode", "mode", "closed", CLOSED_REASON]],
  );
  assert.deepEqual(traceDecidedBy("rul_1", null), { decidedBy: "rule", mode: null });
  assert.deepEqual(traceDecidedBy(null, null), { decidedBy: "mode", mode: "permissive" }, "a row from before 0.5.0 with no rule was a Permissive allow");
  assert.deepEqual(traceDecidedBy(null, { decidedBy: "exemption", mode: "closed" }), { decidedBy: "exemption", mode: "closed" });
});

// ── 6. migration 0008 ────────────────────────────────────────────────────────────────────────────────────────────
test("migration 0008 on a 0.4.x-shaped database (0001 to 0007, with rules and decisions): the mode starts Permissive, nothing else changes", async () => {
  const raw = new DatabaseSync(":memory:");
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(files.includes("0008_default_mode.sql"));
  for (const f of files.filter((x) => x < "0008")) raw.exec(readFileSync(join(migrationsDir, f), "utf8"));
  raw.exec("INSERT INTO rules (id, rev, spec, priority, active, deleted, source, created_at, updated_at) VALUES ('rul_old', 1, '{}', 1, 1, 0, 'owner', 1, 1)");
  const before = raw.prepare("SELECT COUNT(*) AS n FROM rules").get()?.n;
  for (const f of files.filter((x) => x >= "0008")) raw.exec(readFileSync(join(migrationsDir, f), "utf8"));
  assert.deepEqual(raw.prepare("SELECT key, value, updated_at, updated_by FROM settings").all().map((r) => ({ ...r })), [{ key: "default_mode", value: "permissive", updated_at: null, updated_by: null }]);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM rules").get()?.n, before);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM mode_changes").get()?.n, 0);
  assert.throws(() => raw.exec("UPDATE settings SET value = 'open' WHERE key = 'default_mode'"), /CHECK/, "only the three modes can be stored");
});

test("a damaged settings row (missing) reads as Closed: fail closed", () => {
  const { db } = migratedDb();
  db.prepare("DELETE FROM settings WHERE key = 'default_mode'").run();
  invalidateMode(db);
  assert.equal(currentMode(db), "closed");
  setMode(db, { mode: "closed", actor: OWNER });
  assert.equal(modeHistory(db).length, 0, "already closed: nothing to record");
  const m: DefaultMode = currentMode(db);
  assert.equal(m, "closed");
});

// ── 7. the English box names the mode when it proposes an allow rule ───────────────────────────────────────────────
test("rule_compose: a proposal with an allow rule says what the mode does outside it; a proposal without one does not", async () => {
  const { db } = migratedDb();
  const callApp = (async () => ({ status: "ok" as const, output: feed() })) as unknown as OpContext["callApp"];
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  await definition.events?.agentsChanged?.(
    [
      { id: AGENT_A, name: "Hermes", mode: "free", status: "active" },
      { id: AGENT_B, name: "CEO", mode: "free", status: "active" },
    ] as never,
    { db, log: quiet, callApp, statusChanged() {} } as never,
  );
  await syncFleet(db, callApp as never);
  const ctx = opCtx(db, { type: "person", id: OWNER, name: "Martin" }, callApp);
  setMode(db, { mode: "closed", actor: OWNER });
  const allow = await run(OP.ruleCompose)({ text: "When someone from team X tags the CEO agent: only work-tagged memories" }, ctx);
  assert.ok(allow.rules.some((r: { outcome: { decision: string } }) => r.outcome.decision === "allow"), "the parser proposes an allow rule");
  assert.equal(allow.notes[0], "In Closed mode, calls outside your allow rules are refused.");
  const hold = await run(OP.ruleCompose)({ text: "Hold Hermes's outward actions" }, ctx);
  assert.equal(hold.notes.some((n: string) => /mode/.test(n)), false, "no allow rule: no mode note");
  assert.deepEqual(composeModeNotes([{ outcome: { decision: "allow" } }], "verification"), ["In Verification mode, calls outside your rules wait for your review."]);
  assert.match(composeModeNotes([{ outcome: { decision: "allow" } }], "permissive")[0] ?? "", /^In Permissive mode, calls outside your rules are allowed anyway/);
});
