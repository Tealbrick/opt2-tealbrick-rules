// Rules 0.3.1 (C237): "calls from product X" (`match.callerProducts`). The hook's VERIFIED caller product (spec 0.1.45) for app callers:
// engine semantics (agent never matches, listed / not listed, absent or invalid = fail closed with its own flag), the fact source
// (the caller only), writer strictness (L24), the decision trace and rules_explain by verified product (S4-3), the upgrade of a
// 0.3.0 database. Every check has a quiet-on-good and a fire-on-bad case with exact outcomes (L27, L34).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Json } from "@opt2-tealbrick/miniapp-sdk";
import { OP } from "#kit";
import { handlers, manifest, migrationsDir } from "../src/app.ts";
import { type CallFacts, dependsOnProduct, evaluate, explain, NEEDS_PRODUCT, NO_MATCH_REASON, order, type Rule, specProblem, strictestNarrowing, tagsPass, validProduct } from "../src/engine.ts";
import { callerProductOf, makeHooks } from "../src/hooks.ts";
import { decideDraft, listDecisions, listDrafts, recordDecision, saveRule, submitDraft } from "../src/store.ts";
import { AGENT_A, APP_INSTANCE, hookCtx, hookReq, migratedDb, OWNER, opCtx, prng, spec } from "./helpers.ts";

type Db = ReturnType<typeof migratedDb>["db"];
type Run = (input: unknown, ctx: ReturnType<typeof opCtx>) => Promise<any>;
const run = (id: keyof typeof handlers) => (handlers[id] as unknown as { run: Run }).run;
const hooks = makeHooks("rules");
const call = (id: string, ...args: unknown[]) => (hooks[id] as unknown as (...a: unknown[]) => Promise<Record<string, any>>)(...args);
const gate = (db: Db, o: Record<string, unknown> = {}) => call("rules_gate", hookReq("before", { effect: "outward", ...o }), hookCtx(db));
const readCall = { effect: "read", product: "knowledge", op: "memory_recall" } as const;
const rule = (id: string, s: Rule["spec"]): Rule => ({ id, rev: 1, spec: s, updatedAt: 1 });
const WORK = { memoryTags: { anyOf: ["work"] } };

const base: CallFacts = {
  caller: { type: "app", id: APP_INSTANCE, mode: null },
  target: { product: "connect", op: "buzz_dm", effect: "outward" },
  claim: null,
  claimVerified: false,
  claimTeams: [],
  claimTeamsAny: [],
  callerTeams: [],
  callerTeamsAny: [],
  claimTrusts: [],
  claimTrustActive: true,
  fleetAvailable: true,
  callerProduct: null,
};
/** An app caller with this verified product (null = the bridge sent none / an invalid one). */
const app = (callerProduct: string | null, o: Partial<CallFacts> = {}): CallFacts => ({ ...base, callerProduct, ...o });
const agent = (o: Partial<CallFacts> = {}): CallFacts => ({ ...base, caller: { type: "agent", id: AGENT_A, mode: "free" }, ...o });
/** The exact outcome of an evaluation: decision, deciding rule, narrowing and both closed flags. */
const out = (v: ReturnType<typeof evaluate>) => ({ decision: v.decision, rule: v.rule?.id ?? null, narrowing: v.narrowing, closedOnFleet: v.closedOnFleet, closedOnProduct: v.closedOnProduct });
const NOTHING = { decision: "allow", rule: null, narrowing: null, closedOnFleet: false, closedOnProduct: false } as const;
const ruleOf = (decision: "allow" | "deny" | "hold", match: Rule["spec"]["match"], extra: Partial<Rule["spec"]> = {}, id = "rul_x", priority = 10) =>
  rule(id, spec({ priority, match, decision, reason: `${decision} by ${id}`, ...extra }));

// ── 1. an agent never matches ───────────────────────────────────────────────────────────────────────────────
test("an AGENT caller never matches a rule that names callerProducts: deny, hold and allow alike; an app with the listed product does", () => {
  for (const decision of ["deny", "hold", "allow"] as const) {
    const r = order([ruleOf(decision, { callerProducts: ["a"] }, decision === "allow" ? { narrowing: { memoryTags: { anyOf: ["work"] } } } : {})]);
    // an agent has no product; even if one were passed, an agent is not a product; Fleet being down changes nothing for it
    for (const f of [agent(), agent({ callerProduct: "a" }), agent({ fleetAvailable: false })])
      assert.deepEqual(out(evaluate(r, f)), NOTHING, `${decision}: agent`);
    assert.deepEqual(explain(r, agent())[0], { ruleId: "rul_x", title: "rule", matched: false, why: "caller is not an app" });
    // fire: the same rule decides for an app with the listed product
    assert.deepEqual(out(evaluate(r, app("a"))), { decision, rule: "rul_x", narrowing: decision === "allow" ? WORK : null, closedOnFleet: false, closedOnProduct: false }, `${decision}: app`);
  }
});

test("an agent is only affected by the rules that do not name callerProducts (property: the same as the rule set without them)", () => {
  const withP = order([
    ruleOf("deny", { callerProducts: ["a"] }, {}, "rul_p", 1),
    ruleOf("allow", { callerProducts: ["a"] }, { narrowing: { memoryTags: { anyOf: ["x"] } } }, "rul_pa", 2),
    ruleOf("hold", { effects: ["outward"] }, {}, "rul_h", 3),
  ]);
  const without = order(withP.filter((r) => r.id === "rul_h"));
  for (const f of [agent(), agent({ fleetAvailable: false })]) assert.deepEqual(out(evaluate(withP, f)), out(evaluate(without, f)));
  assert.equal(evaluate(withP, agent()).rule?.id, "rul_h", "exact: the hold decides for the agent");
  assert.equal(evaluate(withP, app("a")).rule?.id, "rul_p", "fire: the product deny decides for the app");
});

// ── 2. an app with a verified product ───────────────────────────────────────────────────────────────────────
test("an app with a verified product: a plain list match, listed or not", () => {
  const r = order([ruleOf("deny", { callerProducts: ["a", "b"] })]);
  assert.deepEqual(out(evaluate(r, app("a"))), { decision: "deny", rule: "rul_x", narrowing: null, closedOnFleet: false, closedOnProduct: false });
  assert.equal(evaluate(r, app("b")).rule?.id, "rul_x");
  assert.deepEqual(out(evaluate(r, app("c"))), NOTHING, "quiet: another product");
  assert.deepEqual(out(evaluate(r, app("A"))), NOTHING, "ids are compared exactly");
  assert.deepEqual(explain(r, app("c"))[0], { ruleId: "rul_x", title: "rule", matched: false, why: "calling app is not listed" });
  assert.deepEqual(explain(r, app("a"))[0], { ruleId: "rul_x", title: "rule", matched: true, why: "matches" });
  // a listed app and the other criteria still all have to match
  const eff = order([ruleOf("deny", { callerProducts: ["a"], effects: ["money"] })]);
  assert.deepEqual(out(evaluate(eff, app("a"))), NOTHING, "outward is not money");
  assert.equal(evaluate(eff, app("a", { target: { product: "connect", op: "pay", effect: "money" } })).rule?.id, "rul_x");
});

// ── 3. an app whose product is absent or invalid: fail closed ───────────────────────────────────────────────
test("app with NO verified product: deny applies and is flagged, hold applies, allow is skipped and its narrowing stays", () => {
  const deny = order([ruleOf("deny", { callerProducts: ["a"] })]);
  assert.deepEqual(out(evaluate(deny, app(null))), { decision: "deny", rule: "rul_x", narrowing: null, closedOnFleet: false, closedOnProduct: true });
  assert.deepEqual(explain(deny, app(null))[0], { ruleId: "rul_x", title: "rule", matched: true, why: "matches: the calling app's verified product is unavailable, so this rule applies (fail closed)" });
  const hold = order([ruleOf("hold", { callerProducts: ["a"] })]);
  assert.deepEqual(out(evaluate(hold, app(null))), { decision: "hold", rule: "rul_x", narrowing: null, closedOnFleet: false, closedOnProduct: true });
  // an allow rule never matches without the product: nothing to narrow = the default allow, nothing flagged
  const plain = order([ruleOf("allow", { callerProducts: ["a"] })]);
  assert.deepEqual(out(evaluate(plain, app(null))), NOTHING);
  assert.deepEqual(explain(plain, app(null))[0], { ruleId: "rul_x", title: "rule", matched: false, why: NEEDS_PRODUCT });
  // ... but its narrowing still applies (never wider than with the product), flagged, and it is the narrowing's rule
  const narrow = order([ruleOf("allow", { callerProducts: ["a"] }, { narrowing: { memoryTags: { anyOf: ["work"] } } })]);
  const v = evaluate(narrow, app(null));
  assert.deepEqual(out(v), { decision: "allow", rule: null, narrowing: WORK, closedOnFleet: false, closedOnProduct: true });
  assert.equal(v.narrowingRuleId, "rul_x");
  assert.equal(v.reason, NO_MATCH_REASON);
  // the skipped allow rule's narrowing merges into the rule that decides after it
  const after = order([ruleOf("allow", { callerProducts: ["a"] }, { narrowing: { memoryTags: { anyOf: ["work"] } } }, "rul_s", 1), ruleOf("allow", {}, {}, "rul_all", 2)]);
  assert.deepEqual(out(evaluate(after, app(null))), { decision: "allow", rule: "rul_all", narrowing: WORK, closedOnFleet: false, closedOnProduct: true });
  assert.deepEqual(out(evaluate(after, app("a"))), { decision: "allow", rule: "rul_s", narrowing: WORK, closedOnFleet: false, closedOnProduct: false }, "fire: with the product the allow rule decides");
  assert.deepEqual(out(evaluate(after, app("z"))), { decision: "allow", rule: "rul_all", narrowing: null, closedOnFleet: false, closedOnProduct: false }, "quiet: another product, no narrowing, no flag");
  // a later fact-free deny wins, and carries no flag
  const denyAfter = order([ruleOf("allow", { callerProducts: ["a"] }, { narrowing: { memoryTags: { anyOf: ["work"] } } }, "rul_s", 1), ruleOf("deny", {}, {}, "rul_d", 2)]);
  assert.deepEqual(out(evaluate(denyAfter, app(null))), { decision: "deny", rule: "rul_d", narrowing: null, closedOnFleet: false, closedOnProduct: false });
});

test("the closed-rule severity order holds for products: the highest severity before the first fact-free match decides", () => {
  const holdA = ruleOf("hold", { callerProducts: ["a"] }, {}, "rul_h", 1);
  const denyAll = ruleOf("deny", { effects: ["outward"] }, {}, "rul_d", 2);
  const allowAll = ruleOf("allow", { effects: ["outward"] }, {}, "rul_a", 2);
  const denyB = ruleOf("deny", { callerProducts: ["b"] }, {}, "rul_cd", 3);
  assert.deepEqual(out(evaluate(order([holdA, allowAll]), app(null))), { decision: "hold", rule: "rul_h", narrowing: null, closedOnFleet: false, closedOnProduct: true });
  assert.deepEqual(out(evaluate(order([holdA, denyAll]), app(null))), { decision: "deny", rule: "rul_d", narrowing: null, closedOnFleet: false, closedOnProduct: false }, "a later fact-free deny beats the closed hold");
  assert.deepEqual(out(evaluate(order([holdA, denyB]), app(null))), { decision: "deny", rule: "rul_cd", narrowing: null, closedOnFleet: false, closedOnProduct: true }, "two closed rules: the deny wins");
  assert.equal(evaluate(order([holdA, ruleOf("hold", { callerProducts: ["z"] }, {}, "rul_h2", 2)]), app(null)).rule?.id, "rul_h", "equal severity: the earlier rule");
  // with the product known the first match decides: product a → the hold; product b → the deny-all
  assert.equal(evaluate(order([holdA, denyAll]), app("a")).rule?.id, "rul_h");
  assert.equal(evaluate(order([holdA, denyAll]), app("b")).rule?.id, "rul_d");
});

test("Fleet and product gaps are told apart: each flag names only what the decisive rule rests on", () => {
  const claim = { kind: "channel_sender" as const, id: "slack:U1" };
  const both = order([ruleOf("deny", { callerProducts: ["a"], onBehalfOf: { teams: ["tm_x"] } })]);
  const f = (callerProduct: string | null, fleetAvailable: boolean, claimTeamsAny: string[] = []) => app(callerProduct, { claim, claimVerified: true, fleetAvailable, claimTeamsAny, claimTeams: claimTeamsAny });
  assert.deepEqual(out(evaluate(both, f(null, false))), { decision: "deny", rule: "rul_x", narrowing: null, closedOnFleet: true, closedOnProduct: true });
  assert.deepEqual(out(evaluate(both, f("a", false))), { decision: "deny", rule: "rul_x", narrowing: null, closedOnFleet: true, closedOnProduct: false });
  assert.deepEqual(out(evaluate(both, f(null, true, ["tm_x"]))), { decision: "deny", rule: "rul_x", narrowing: null, closedOnFleet: false, closedOnProduct: true });
  assert.deepEqual(out(evaluate(both, f("a", true, ["tm_x"]))), { decision: "deny", rule: "rul_x", narrowing: null, closedOnFleet: false, closedOnProduct: false }, "the facts decide: no flag");
  // a later criterion that fails leaves no flag behind
  assert.deepEqual(out(evaluate(both, f(null, true, ["tm_other"]))), NOTHING);
  assert.deepEqual(out(evaluate(both, f("b", false))), NOTHING);
  assert.equal(explain(both, f(null, false))[0]?.why, "matches: Fleet facts and the calling app's verified product are unavailable, so this rule applies (fail closed)");
  // a skipped allow rule rests on both
  const allow = order([ruleOf("allow", { callerProducts: ["a"], onBehalfOf: { teams: ["tm_x"] } }, { narrowing: { memoryTags: { anyOf: ["work"] } } })]);
  assert.deepEqual(out(evaluate(allow, f(null, false))), { decision: "allow", rule: null, narrowing: WORK, closedOnFleet: true, closedOnProduct: true });
  assert.deepEqual(out(evaluate(allow, f("a", false))), { decision: "allow", rule: null, narrowing: WORK, closedOnFleet: true, closedOnProduct: false });
});

test("strictestNarrowing (no pinned verdict): an allow rule's narrowing could apply to an app without a verified product; never to an agent or an unlisted app", () => {
  const r = order([ruleOf("allow", { callerProducts: ["a"] }, { narrowing: { memoryTags: { anyOf: ["work"] } } })]);
  assert.deepEqual(strictestNarrowing(r, app(null)), WORK);
  assert.deepEqual(strictestNarrowing(r, app("a")), WORK);
  assert.equal(strictestNarrowing(r, app("b")), null, "quiet: another verified product");
  assert.equal(strictestNarrowing(r, agent()), null, "quiet: an agent");
});

test("PROPERTY (fuzz): an app without a verified product is never decided less strictly, nor narrowed less, than with ANY product; an agent never sees a product rule", () => {
  const rnd = prng(0xc237);
  const pickOne = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const subset = <T,>(xs: readonly T[], min = 0): T[] => {
    for (;;) {
      const s = xs.filter(() => rnd() < 0.5);
      if (s.length >= min) return s;
    }
  };
  const SEV = { allow: 0, hold: 1, deny: 2 } as const;
  const TAGS = ["w", "p", "s"];
  const subsets = Array.from({ length: 8 }, (_, i) => TAGS.filter((_, b) => i & (1 << b)));
  const passes = (v: ReturnType<typeof evaluate>) => subsets.map((tags) => (v.decision !== "allow" ? false : v.narrowing ? tagsPass(tags, v.narrowing) : true));
  const PRODUCTS = ["a", "b", "z"] as const;
  const CASES = 30_000;
  let stricter = 0;
  let flagged = 0;
  for (let i = 0; i < CASES; i++) {
    const rules: Rule[] = [];
    for (let r = 0; r < 1 + Math.floor(rnd() * 6); r++) {
      const decision = pickOne(["allow", "deny", "hold"] as const);
      const match: Rule["spec"]["match"] = {};
      if (rnd() < 0.4) match.effects = [pickOne(["outward", "read"])];
      if (rnd() < 0.7) match.callerProducts = subset(["a", "b"], 1);
      const narrowing = decision === "allow" && rnd() < 0.5 ? { memoryTags: rnd() < 0.5 ? { anyOf: subset(TAGS, 1) } : { noneOf: subset(TAGS, 1) } } : undefined;
      rules.push(rule(`rul_${r}`, spec({ priority: Math.floor(rnd() * 4), match, decision, reason: "r", ...(narrowing ? { narrowing } : {}) })));
    }
    const ordered = order(rules);
    const effect = pickOne(["outward", "read"]);
    const target = { product: "connect", op: "buzz_dm", effect };
    const absent = evaluate(ordered, app(null, { target }));
    const where = JSON.stringify({ rules: ordered.map((r) => [r.id, r.spec.priority, r.spec.outcome.decision, r.spec.match, r.spec.narrowing]), effect, absent: [absent.decision, absent.rule?.id, absent.narrowing] });
    for (const p of PRODUCTS) {
      const known = evaluate(ordered, app(p, { target }));
      assert.ok(SEV[absent.decision] >= SEV[known.decision], `no product must not be less strict than product ${p}: ${where}`);
      if (known.decision === "allow" && absent.decision === "allow") {
        const pk = passes(known);
        assert.ok(passes(absent).every((ok, k) => !ok || pk[k]), `narrowing without the product must pass a subset of what passes with ${p}: ${where}`);
      }
      assert.equal(known.closedOnProduct, false, "a verified product is never a gap");
    }
    if (SEV[absent.decision] > SEV[evaluate(ordered, app("z", { target })).decision]) stricter++;
    if (absent.closedOnProduct) flagged++;
    // an agent: the rules that name callerProducts do not exist for it
    const agentResult = evaluate(ordered, agent({ target }));
    const noProductRules = evaluate(order(ordered.filter((r) => !dependsOnProduct(r.spec))), agent({ target }));
    assert.deepEqual([agentResult.decision, agentResult.rule?.id ?? null, agentResult.narrowing, agentResult.closedOnProduct], [noProductRules.decision, noProductRules.rule?.id ?? null, noProductRules.narrowing, false], `an agent: ${where}`);
  }
  assert.ok(stricter > 1000 && flagged > 1000, `the fuzz exercised the gap (stricter without the product ${stricter}, flagged ${flagged})`);
  console.log(`product fuzz cases: ${CASES} (strictly stricter without the product than with an unlisted one: ${stricter}, flagged: ${flagged})`);
});

// ── 4. where the product comes from ─────────────────────────────────────────────────────────────────────────
test("validProduct: [a-z0-9][a-z0-9_-]*, at most 40 characters", () => {
  for (const ok of ["a", "0", "fleet", "my-app_2", "a".repeat(40)]) assert.equal(validProduct(ok), true, ok);
  for (const bad of ["", "Fleet", " fleet", "fleet ", "-a", "_a", "a/b", "../a", "flêet", "a‮", "a".repeat(41), 5, null, undefined, {}, ["a"]])
    assert.equal(validProduct(bad), false, JSON.stringify(bad));
});

test("callerProductOf reads the product of an APP caller only; an invalid or missing one is null", () => {
  assert.equal(callerProductOf({ type: "app", id: APP_INSTANCE, product: "fleet" } as never), "fleet");
  assert.equal(callerProductOf({ type: "app", id: APP_INSTANCE } as never), null, "a bridge older than 0.2.2");
  assert.equal(callerProductOf({ type: "agent", id: AGENT_A, mode: "free", product: "fleet" } as never), null, "an agent has no product, whatever the request says");
  for (const bad of ["Fleet", "", "a".repeat(41), "fl eet", 7, null, {}, ["fleet"]]) assert.equal(callerProductOf({ type: "app", id: APP_INSTANCE, product: bad } as never), null, JSON.stringify(bad));
});

// ── 5. the gate, the context hook and the after hook ────────────────────────────────────────────────────────
function productDb() {
  const { db } = migratedDb();
  saveRule(db, { spec: spec({ title: "blocked app may not send", priority: 1, match: { effects: ["outward"], callerProducts: ["blocked-app"] }, decision: "deny", reason: "that app may not send" }), actor: OWNER });
  saveRule(db, { spec: spec({ title: "watched app money", priority: 2, match: { effects: ["money"], callerProducts: ["watched"] }, decision: "hold", reason: "money from that app needs review" }), actor: OWNER });
  return db;
}
const traces = (db: Db) => listDecisions(db, { limit: 50 }).items;

test("gate: an app with a listed verified product is refused; another app and an agent are not; the trace records the product", async () => {
  const db = productDb();
  const denied = await gate(db, { callId: "cal_listed", app: { product: "blocked-app" } });
  assert.equal(denied.allow, false);
  assert.match(String(denied.reason), /^Rules: that app may not send \(rule rul_/);
  assert.deepEqual(await gate(db, { callId: "cal_other", app: { product: "other-app" } }), { allow: true });
  // an agent that carries a product field in the request is still an agent
  assert.deepEqual(await gate(db, { callId: "cal_agent", callerExtra: { product: "blocked-app" } }), { allow: true });
  const t = Object.fromEntries(traces(db).map((x) => [x.callId, x]));
  assert.deepEqual([t.cal_listed?.answered, t.cal_listed?.caller], ["deny", { type: "app", id: APP_INSTANCE, mode: null, product: "blocked-app" }]);
  assert.equal(t.cal_listed?.detail, null, "the product was verified: nothing unavailable");
  assert.deepEqual([t.cal_other?.answered, t.cal_other?.caller.product], ["allow", "other-app"]);
  assert.deepEqual([t.cal_agent?.answered, t.cal_agent?.caller], ["allow", { type: "agent", id: AGENT_A, mode: "free", product: null }], "an agent has no product on its trace");
});

test("gate: an app with NO verified product (older bridge, unmapped caller): deny applies and is flagged, hold applies and is flagged", async () => {
  const db = productDb();
  const denied = await gate(db, { callId: "cal_deny", app: {} });
  assert.equal(denied.allow, false);
  assert.match(String(denied.reason), /^Rules: that app may not send \(rule rul_/);
  const held = await gate(db, { callId: "cal_hold", effect: "money", app: {} });
  assert.deepEqual([held.allow, held.hold?.family], [false, "policy"]);
  assert.match(String(held.hold?.reason), /^Needs owner review: money from that app needs review \(rule rul_/);
  const t = Object.fromEntries(traces(db).map((x) => [x.callId, x]));
  assert.deepEqual([t.cal_deny?.answered, t.cal_deny?.detail, t.cal_deny?.caller.product], ["deny", { callerProductUnavailable: true }, null]);
  assert.deepEqual([t.cal_hold?.answered, t.cal_hold?.detail], ["hold", { callerProductUnavailable: true }]);
  // quiet: a read by an unverified app is decided by no rule and leaves no trace (nothing is flagged without a rule that rests on the gap)
  assert.deepEqual(await gate(db, { callId: "cal_read", ...readCall, app: {} }), { allow: true });
  assert.equal(traces(db).some((x) => x.callId === "cal_read"), false);
});

test("gate: an invalid product string from the bridge is treated as absent (fail closed)", async () => {
  const db = productDb();
  for (const [i, product] of ["Blocked-App", "", "blocked app", "a".repeat(41), "blocked-app‮", 7, null, {}, ["blocked-app"]].entries()) {
    const r = await gate(db, { callId: `cal_bad${i}`, app: { product } });
    assert.equal(r.allow, false, `${JSON.stringify(product)} is no verified product: the deny rule applies`);
  }
  const flagged = traces(db).filter((x) => x.callId?.startsWith("cal_bad") && (x.detail as { callerProductUnavailable?: boolean } | null)?.callerProductUnavailable === true);
  assert.equal(flagged.length, 9, "every one of them is flagged");
  assert.deepEqual(await gate(db, { callId: "cal_ok", app: { product: "fine-app" } }), { allow: true }, "quiet: a valid product that is not listed");
});

test("the product comes from the caller only: a product in the input, the context or a name never counts", async () => {
  const { db } = migratedDb();
  saveRule(db, { spec: spec({ title: "good app may send", priority: 1, match: { effects: ["outward"], callerProducts: ["good"] }, decision: "allow", reason: "good app" }), actor: OWNER });
  saveRule(db, { spec: spec({ title: "nothing else sends", priority: 2, match: { effects: ["outward"] }, decision: "deny", reason: "nothing else sends" }), actor: OWNER });
  const lie = { input: { product: "good", caller: { product: "good" } }, context: { product: "good", "tb.caller": { product: "good" }, "tb.product": "good" } as Record<string, Json> };
  // the verified caller says "evil": the claims of the input and the context do not make it "good"
  assert.equal((await gate(db, { callId: "cal_lie1", app: { product: "evil" }, ...lie })).allow, false);
  // no verified product: the allow rule is skipped, whatever the input and the context say
  assert.equal((await gate(db, { callId: "cal_lie2", app: {}, ...lie })).allow, false);
  // an agent whose name or id looks like the product
  assert.equal((await gate(db, { callId: "cal_lie3", caller: "good", ...lie })).allow, false);
  // fire: the verified product "good" is allowed by the very same rules
  assert.deepEqual(await gate(db, { callId: "cal_true", app: { product: "good" } }), { allow: true });
  const t = Object.fromEntries(traces(db).map((x) => [x.callId, x.caller.product]));
  assert.deepEqual([t.cal_lie1, t.cal_lie2, t.cal_lie3, t.cal_true], ["evil", null, null, "good"]);
});

test("context and after hooks: the narrowing of an allow rule that names callerProducts survives an unverified product (flagged, strict)", async () => {
  const { db } = migratedDb();
  const r = saveRule(db, { spec: spec({ title: "good app: work only", priority: 1, match: { callerProducts: ["good"] }, decision: "allow", reason: "good app sees work memories", narrowing: WORK }), actor: OWNER });
  const ctx = (o: Record<string, unknown>) => call("rules_context", hookReq("context", { ...readCall, ...o }), hookCtx(db));
  const narrowingOf = (a: Record<string, any>) => a.add["rules.narrowing"];
  assert.deepEqual(narrowingOf(await ctx({ callId: "cal_c1", app: { product: "good" } })), { v: 1, ruleId: r.id, reason: "good app sees work memories", memoryTags: WORK.memoryTags });
  assert.deepEqual(narrowingOf(await ctx({ callId: "cal_c2", app: {} })), { v: 1, ruleId: r.id, reason: "The calling app's product is unverified: the narrowing of an allow rule applies", memoryTags: WORK.memoryTags });
  assert.equal(narrowingOf(await ctx({ callId: "cal_c3", app: { product: "other" } })), undefined, "quiet: another app");
  assert.equal(narrowingOf(await ctx({ callId: "cal_c4" })), undefined, "quiet: an agent");
  const t = Object.fromEntries(traces(db).map((x) => [x.callId, x]));
  assert.deepEqual(t.cal_c2?.detail?.callerProductUnavailable, true);
  assert.equal(t.cal_c1?.detail?.callerProductUnavailable, undefined);
  assert.ok(t.cal_c1, "the verified app's narrowing is recorded too");
  assert.equal(t.cal_c3, undefined);
  // after hook: the before phase pinned the narrowing; the unverified app gets the same redaction as the verified one
  const output = { items: [{ id: 1, tags: ["work"] }, { id: 2, tags: ["private"] }] } as Json;
  for (const [callId, app] of [["cal_f1", { product: "good" }], ["cal_f2", {}]] as const) {
    assert.deepEqual(await gate(db, { callId, ...readCall, app }), { allow: true });
    assert.deepEqual(await call("rules_filter", hookReq("after", { callId, ...readCall, app, output }), hookCtx(db)), { redactions: ["/items/1"] }, `${callId}: redacted`);
  }
  assert.deepEqual(await gate(db, { callId: "cal_f3", ...readCall, app: { product: "other" } }), { allow: true });
  assert.deepEqual(await call("rules_filter", hookReq("after", { callId: "cal_f3", ...readCall, app: { product: "other" }, output }), hookCtx(db)), {}, "quiet: another app is not narrowed");
});

// ── 6. writers stay strict (L24), readers tolerate ──────────────────────────────────────────────────────────
test("writers refuse a callerProducts rule that is malformed or can never match an app; good shapes pass", () => {
  const p = (match: Rule["spec"]["match"]) => specProblem(spec({ match }));
  // quiet-on-good
  for (const ok of [{ callerProducts: ["a"] }, { callerProducts: ["a", "b-2", "c_3"] }, { callerProducts: ["a"], agents: ["ins_01J0000000000000000000APP1"] }, { callerProducts: ["a"], agents: ["agt_X1", "ins_X2"] }, { callerProducts: ["a"], effects: ["outward"], products: ["connect"], onBehalfOf: { kinds: ["person"] } }, { callerProducts: [], modes: ["free"] }])
    assert.equal(p(ok as never), "", JSON.stringify(ok));
  // fire-on-bad, exact reasons
  assert.equal(p({ callerProducts: ["Bad"] }), "callerProducts has “Bad”, which is not a product id (lower-case letters, digits, - and _; at most 40 characters)");
  assert.match(p({ callerProducts: ["a", ""] }), /^callerProducts has “”, which is not a product id/);
  assert.match(p({ callerProducts: ["a".repeat(41)] }), /which is not a product id/);
  assert.equal(p({ callerProducts: ["a", "b", "a"] }), "callerProducts lists “a” twice");
  assert.match(p({ callerProducts: ["a"], agents: ["agt_X1"] }), /^callerProducts names apps, but agents lists only agents \(agt_…\)/);
  assert.match(p({ callerProducts: ["a"], agents: ["agt_X1", "agt_X2"] }), /agents lists only agents/);
  assert.match(p({ callerProducts: ["a"], modes: ["free"] }), /^callerProducts names apps, but modes \(free, bound\) apply to agents only/);
  assert.match(p({ callerProducts: ["a"], callerTeams: ["tm_x"] }), /^callerProducts names apps, but callerTeams are teams of agents/);
});

test("the writers apply it: rules_set, a draft from an agent and approving a stored draft; the manifest schemas back it up", async () => {
  const { db } = migratedDb();
  const owner = opCtx(db, { type: "person", id: OWNER });
  const bad = spec({ title: "agent-only app rule", match: { callerProducts: ["a"], modes: ["free"] }, decision: "deny", reason: "r" });
  const refused = await run(OP.rulesSet)({ rule: bad }, owner).catch((e: unknown) => e as { code: string; httpStatus: number; message: string });
  assert.deepEqual([refused.code, refused.httpStatus], ["input_invalid", 400]);
  assert.match(refused.message, /modes \(free, bound\) apply to agents only/);
  assert.equal((await run(OP.rulesList)({}, owner)).rules.length, 0, "nothing was stored");
  const good = spec({ title: "app rule", match: { callerProducts: ["a"] }, decision: "deny", reason: "r" });
  assert.deepEqual((await run(OP.rulesSet)({ rule: good }, owner)).rule.spec.match, { callerProducts: ["a"] });
  // a draft names the rule (rule 2) in its refusal and stores nothing
  const agentCtx = opCtx(db, { type: "agent", id: AGENT_A });
  const dup = spec({ title: "twice", match: { callerProducts: ["a", "a"] }, decision: "deny", reason: "r" });
  const e = await run(OP.ruleDraftSubmit)({ text: "t", rules: [good, dup] }, agentCtx).catch((x: unknown) => x as { code: string; message: string });
  assert.deepEqual([e.code, e.message], ["input_invalid", "rule 2 (“twice”): callerProducts lists “a” twice"]);
  assert.equal(listDrafts(db, undefined, 10).length, 0);
  assert.equal((await run(OP.ruleDraftSubmit)({ text: "t", rules: [good] }, agentCtx)).status, "pending", "quiet: a good draft");
  // a draft stored before this check cannot be applied
  db.prepare("INSERT INTO drafts (id, status, text, note, rules, submitted_by_type, submitted_by_id, submitted_by_name, submitted_at) VALUES ('drf_old', 'pending', 't', '', ?, 'agent', 'agt_1', 'x', 1)").run(JSON.stringify([bad]));
  const e2 = await run(OP.draftDecide)({ id: "drf_old", decision: "approve" }, owner).catch((x: unknown) => x as { code: string; httpStatus: number; message: string });
  assert.deepEqual([e2.code, e2.httpStatus], ["draft_never_matches", 409]);
  // the schemas: every rule schema of the manifest has the criterion; duplicates, bad ids and too many are refused
  const sets = [] as unknown[];
  const walk = (v: unknown): void => {
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if ("callerTeams" in o && "agents" in o) sets.push(o);
    Object.values(o).forEach(walk);
  };
  walk(manifest);
  assert.equal(sets.length, 8, "rules_list, rules_get, rules_set (in, out), preview candidate, drafts_list, draft_decide, rule_draft_submit");
  for (const s of sets) assert.deepEqual((s as Record<string, unknown>).callerProducts, { type: "array", maxItems: 50, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 40, pattern: "^[a-z0-9][a-z0-9_-]*$" } });
  const input = manifest.operations.find((o) => o.id === "rules_set")?.input as Parameters<typeof validateAgainstSchema>[0];
  const withProducts = (callerProducts: unknown) => ({ rule: { ...good, match: { callerProducts } } }) as Json;
  assert.equal(validateAgainstSchema(input, withProducts(["a", "my-app_2"])).ok, true);
  for (const badList of [["a", "a"], ["Bad"], [""], ["a".repeat(41)], Array.from({ length: 51 }, (_, i) => `p${i}`), "a", [1]]) assert.equal(validateAgainstSchema(input, withProducts(badList)).ok, false, JSON.stringify(badList));
});

test("readers tolerate: a stored rule that can never match is listed with its problem and the gate does not throw on it", async () => {
  const { db } = migratedDb();
  const stored = spec({ title: "stored", priority: 1, match: { callerProducts: ["Bad", "a", "a"], agents: ["agt_X1"] }, decision: "deny", reason: "r" });
  db.prepare("INSERT INTO rules (id, rev, spec, priority, active, deleted, source, created_at, updated_at) VALUES ('rul_stored', 1, ?, 1, 1, 0, 'owner', 1, 1)").run(JSON.stringify(stored));
  const listed = await run(OP.rulesList)({}, opCtx(db, { type: "person", id: OWNER }));
  assert.match(listed.rules[0].problem, /^callerProducts has “Bad”/);
  assert.deepEqual(await gate(db, { app: { product: "a" } }), { allow: true }, "agents lists an agent only: it never matches an app");
  assert.deepEqual(await gate(db, {}), { allow: true }, "and never an agent");
});

// ── 7. the dry run ──────────────────────────────────────────────────────────────────────────────────────────
test("rules_preview: an app caller with a product, without one, an unlisted one and an agent; the answer says when the product was unavailable", async () => {
  const { db } = migratedDb();
  const owner = opCtx(db, { type: "person", id: OWNER });
  saveRule(db, { spec: spec({ title: "app a is refused", match: { callerProducts: ["a"] }, decision: "deny", reason: "no" }), actor: OWNER });
  const preview = (caller: Record<string, unknown>) => run(OP.rulesPreview)({ call: { caller, target: { product: "connect", op: "buzz_dm", effect: "outward" } } }, owner);
  const pick = (r: Record<string, any>) => [r.decision, r.ruleTitle, r.callerProductUnavailable];
  assert.deepEqual(pick(await preview({ type: "app", id: "ins_preview", product: "a" })), ["deny", "app a is refused", false]);
  const noProduct = await preview({ type: "app", id: "ins_preview" });
  assert.deepEqual(pick(noProduct), ["deny", "app a is refused", true]);
  assert.equal(noProduct.steps[0].why, "matches: the calling app's verified product is unavailable, so this rule applies (fail closed)");
  assert.deepEqual(pick(await preview({ type: "app", id: "ins_preview", product: "Fleet" })), ["deny", "app a is refused", true], "an invalid product is no product");
  assert.deepEqual(pick(await preview({ type: "app", id: "ins_preview", product: "b" })), ["allow", null, false], "quiet: another app");
  const asAgent = await preview({ type: "agent", id: AGENT_A, mode: "free", product: "a" });
  assert.deepEqual(pick(asAgent), ["allow", null, false], "an agent never matches");
  assert.equal(asAgent.steps[0].why, "caller is not an app");
  // a candidate rule is judged the same way
  const cand = await run(OP.rulesPreview)({ call: { caller: { type: "app", id: "ins_preview" }, target: { product: "connect", op: "buzz_dm", effect: "outward" } }, candidate: spec({ title: "cand", priority: 0, match: { callerProducts: ["z"] }, decision: "deny", reason: "r" }) }, owner);
  assert.deepEqual([cand.decision, cand.ruleId, cand.callerProductUnavailable], ["deny", "candidate", true], "two closed denies: the earlier rule is named");
  // the answers fit the manifest's output schema; the product is part of the input schema
  const op = manifest.operations.find((o) => o.id === "rules_preview");
  assert.equal(validateAgainstSchema(op?.output as never, noProduct as never).ok, true);
  assert.equal(validateAgainstSchema(op?.input as never, { call: { caller: { type: "app", id: "ins_1", product: "a" }, target: { product: "connect", op: "buzz_dm", effect: "outward" } } } as never).ok, true);
  assert.equal(validateAgainstSchema(op?.input as never, { call: { caller: { type: "app", id: "ins_1", product: "Bad" }, target: { product: "connect", op: "buzz_dm", effect: "outward" } } } as never).ok, false);
});

// ── 8. rules_explain reads an app's decisions by verified product (S4-3) ────────────────────────────────────
test("rules_explain: an app reads its decisions by VERIFIED product (any instance of it); older rows and unverified apps by instance id; an agent by its own id", async () => {
  const { db } = migratedDb();
  saveRule(db, { spec: spec({ title: "app p refused", match: { effects: ["outward"], callerProducts: ["p"] }, decision: "deny", reason: "no" }), actor: OWNER });
  const I1 = "ins_01J000000000000000000000I1";
  const I2 = "ins_01J000000000000000000000I2";
  const I3 = "ins_01J000000000000000000000I3";
  const I4 = "ins_01J000000000000000000000I4";
  await gate(db, { callId: "cal_p_i1", app: { id: I1, product: "p" } });
  await gate(db, { callId: "cal_p_i2", app: { id: I2, product: "p" } }); // the same product after a reinstall
  await gate(db, { callId: "cal_q_i3", app: { id: I3, product: "q" } });
  await gate(db, { callId: "cal_none_i4", app: { id: I4 } }); // no verified product
  await gate(db, { callId: "cal_agent", caller: AGENT_A });
  // rows recorded before 0.3.1 have no product: they belong to an instance id only
  const legacy = (callId: string, id: string) =>
    recordDecision(db, { callId, phase: "before", facts: { ...base, caller: { type: "app", id, mode: null }, callerProduct: null }, decision: "allow", answered: "allow", reason: "old", rule: null, durationUs: 1 });
  legacy("cal_old_i1", I1);
  legacy("cal_old_i3", I3);
  const ids = async (caller: Parameters<typeof opCtx>[1]) => (await run(OP.rulesExplain)({}, opCtx(db, caller))).decisions.map((d: { callId: string }) => d.callId).sort();
  assert.deepEqual(await ids({ type: "app", id: I1, product: "p" }), ["cal_old_i1", "cal_p_i1", "cal_p_i2"], "product p: both instances, plus its own older row");
  assert.deepEqual(await ids({ type: "app", id: I2, product: "p" }), ["cal_p_i1", "cal_p_i2"], "the other instance sees the same history, not I1's older row");
  assert.deepEqual(await ids({ type: "app", id: I3, product: "q" }), ["cal_old_i3", "cal_q_i3"]);
  assert.deepEqual(await ids({ type: "app", id: I1, product: "nobody" }), ["cal_old_i1"], "a product with no history sees only its instance's older rows");
  // unverified: the instance id only, never another instance of the same product
  assert.deepEqual(await ids({ type: "app", id: I4 }), ["cal_none_i4"]);
  assert.deepEqual(await ids({ type: "app", id: I1 }), ["cal_old_i1", "cal_p_i1"]);
  assert.deepEqual(await ids({ type: "app", id: I1, product: "Not Valid" }), ["cal_old_i1", "cal_p_i1"], "an invalid product is no product");
  // an agent: its own calls only, and none of an app's
  assert.deepEqual(await ids({ type: "agent", id: AGENT_A }), ["cal_agent"]);
  // callId narrows within the caller's own history; another caller's call id answers nothing
  const one = await run(OP.rulesExplain)({ callId: "cal_p_i2" }, opCtx(db, { type: "app", id: I1, product: "p" }));
  assert.deepEqual(one.decisions.map((d: { callId: string }) => d.callId), ["cal_p_i2"]);
  assert.deepEqual((await run(OP.rulesExplain)({ callId: "cal_q_i3" }, opCtx(db, { type: "app", id: I1, product: "p" }))).decisions, []);
  // the unavailable flag, and the answer fits the output schema
  const flagged = await run(OP.rulesExplain)({ callId: "cal_none_i4" }, opCtx(db, { type: "app", id: I4 }));
  assert.deepEqual([flagged.decisions[0].decision, flagged.decisions[0].callerProductUnavailable, flagged.decisions[0].fleetUnavailable], ["deny", true, false]);
  const verified = await run(OP.rulesExplain)({ callId: "cal_p_i1" }, opCtx(db, { type: "app", id: I1, product: "p" }));
  assert.deepEqual([verified.decisions[0].decision, verified.decisions[0].callerProductUnavailable], ["deny", false]);
  assert.equal(validateAgainstSchema(manifest.operations.find((o) => o.id === "rules_explain")?.output as never, flagged as never).ok, true);
});

test("decisions_list and rules_list carry the product (owner pages); the answers fit their output schemas", async () => {
  const { db } = migratedDb();
  saveRule(db, { spec: spec({ title: "app p refused", match: { callerProducts: ["p"] }, decision: "deny", reason: "no" }), actor: OWNER });
  await gate(db, { callId: "cal_1", app: { product: "p" } });
  await gate(db, { callId: "cal_2", caller: AGENT_A });
  const owner = opCtx(db, { type: "person", id: OWNER });
  const list = await run(OP.decisionsList)({}, owner);
  assert.deepEqual(Object.fromEntries(list.items.map((d: any) => [d.callId, d.caller.product])), { cal_1: "p", cal_2: null });
  assert.equal(validateAgainstSchema(manifest.operations.find((o) => o.id === "decisions_list")?.output as never, list as never).ok, true);
  const rules = await run(OP.rulesList)({}, owner);
  assert.deepEqual(rules.catalog.productIds, [], "no catalog read yet: nothing to choose from");
  assert.deepEqual(rules.rules[0].spec.match.callerProducts, ["p"]);
  assert.equal(validateAgainstSchema(manifest.operations.find((o) => o.id === "rules_list")?.output as never, rules as never).ok, true);
});

// ── 9. migration 0006 on a database that ran 0.3.0 ──────────────────────────────────────────────────────────
test("migration 0006 on a 0.3.0 database: the column is added, no row changes, old rows stay readable by instance id", () => {
  const raw = new DatabaseSync(":memory:");
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  assert.deepEqual(files.at(-1), "0006_caller_product.sql");
  for (const f of files.filter((x) => x < "0006")) raw.exec(readFileSync(join(migrationsDir, f), "utf8"));
  const q = (sql: string) => raw.prepare(sql).all() as Record<string, unknown>[];
  assert.equal(q("PRAGMA table_info(decisions)").some((c) => c.name === "caller_product"), false, "0.3.0 has no such column");
  // 0.3.0-shaped data: a decision of an app (instance id only), a rule and a draft
  raw.exec(`
    INSERT INTO decisions (id, call_id, phase, at, caller_type, caller_id, caller_mode, product, op, effect, decision, answered, reason, duration_us) VALUES ('dec_old', 'cal_old', 'before', 5, 'app', 'ins_old', NULL, 'connect', 'buzz_dm', 'outward', 'allow', 'allow', 'no rule', 3);
    INSERT INTO rules (id, rev, spec, priority, active, deleted, source, created_at, updated_at) VALUES ('rul_old', 1, '{"title":"old","active":true,"priority":1,"match":{},"outcome":{"decision":"deny","reason":"r"}}', 1, 1, 0, 'owner', 1, 1);
  `);
  const oldRow = { ...q("SELECT * FROM decisions")[0] };
  const rulesBefore = JSON.stringify(q("SELECT * FROM rules"));
  raw.exec(readFileSync(join(migrationsDir, "0006_caller_product.sql"), "utf8"));
  assert.equal(q("PRAGMA table_info(decisions)").find((c) => c.name === "caller_product")?.notnull, 0, "nullable");
  assert.equal(q("SELECT * FROM decisions").length, 1);
  assert.deepEqual({ ...q("SELECT * FROM decisions")[0] }, { ...oldRow, caller_product: null }, "the old row is unchanged, product NULL");
  assert.equal(JSON.stringify(q("SELECT * FROM rules")), rulesBefore, "rules are untouched");
  assert.ok(q("PRAGMA index_list(decisions)").some((i) => i.name === "decisions_by_caller_product"));
  // through the store: the old row is found by instance id, a new row by product
  const db = { exec: (s: string) => raw.exec(s), prepare: (s: string) => raw.prepare(s), transaction: <T>(fn: () => T) => fn() } as never;
  assert.deepEqual(listDecisions(db, { appCaller: { product: "connect", instance: "ins_old" }, limit: 10 }).items.map((d) => [d.callId, d.caller.product]), [["cal_old", null]]);
  recordDecision(db, { callId: "cal_new", phase: "before", facts: { ...base, caller: { type: "app", id: "ins_new", mode: null }, callerProduct: "connect" }, decision: "allow", answered: "allow", reason: "x", rule: null, durationUs: 1 });
  assert.deepEqual(
    listDecisions(db, { appCaller: { product: "connect", instance: "ins_old" }, limit: 10 })
      .items.map((d) => [d.callId, d.caller.product])
      .sort(),
    [["cal_new", "connect"], ["cal_old", null]],
  );
  assert.deepEqual(listDecisions(db, { appCaller: { product: null, instance: "ins_new" }, limit: 10 }).items.map((d) => d.callId), ["cal_new"]);
});

// ── 10. the draft path still keys apps by product (0.3.0), unchanged ────────────────────────────────────────
test("a draft from a verified app is keyed by product as before (quiet-on-good: no change to 0.3.0 drafts)", () => {
  const { db } = migratedDb();
  const d = submitDraft(db, { text: "t", rules: [spec({ match: { callerProducts: ["a"] } })], by: { type: "app", id: "fleet", name: "Observer", product: "fleet", instance: "ins_1" } });
  assert.deepEqual(d.source, { kind: "app", product: "fleet", name: "Observer", instance: "ins_1" });
  assert.equal(decideDraft(db, { id: d.id, decision: "approve", actor: OWNER }).ruleIds.length, 1);
});
