// Delta re-check 0f5d25c, D-4 and S4. D-4: "Allow always" went ahead of EVERY hold that could match and named only the first. Now every skipped
// hold is named (title and priority), the allow goes just before the hold that held the call, and Save needs a tick when it skips others.
// S4: the plan follows edits; `rules_set` returns a non-blocking `placementWarning`; the "deny forces it after the hold" sentence is right.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { OP } from "#kit";
import { handlers, mergeModelDraft } from "../src/app.ts";
import type { RuleSpec } from "../src/engine.ts";
import { mayOverlap, placementWarning } from "../src/placement.ts";
import { saveRule } from "../src/store.ts";
import { allowPlan, overlaps, readAllowQuery, replanAllow } from "../src/ui/hold-allow.ts";
import { AGENT_A as A, AGENT_B as B, migratedDb, OWNER, opCtx, seedCatalog, spec } from "./helpers.ts";

type Run = (input: unknown, ctx: OpContext) => Promise<any>;
const run = (id: keyof typeof handlers) => (handlers[id] as unknown as { run: Run }).run;
const RUL = (c: string) => `rul_${c.repeat(26)}`;
const HOLD = "hld_01J0000000000000000000000Z";
const row = (id: string, title: string, priority: number, decision: RuleSpec["outcome"]["decision"], match: RuleSpec["match"], active = true) => ({ id, spec: { ...spec({ title, priority, match, decision }), active } });
const q = { product: "connect", op: "buzz_dm", hold: HOLD, agent: A };
const holdA = row("rul_a", "hold A's DMs", 10, "hold", { agents: [A], products: ["connect"], operations: ["buzz_dm"] });
const holdStrangers = row("rul_s", "hold DMs to strangers", 40, "hold", { effects: ["outward"], recipients: { known: false } });

test("D-4 (probe): the allow names EVERY hold it runs ahead of, and Save needs a tick", () => {
  const plan = allowPlan(q, [holdA, holdStrangers], "Hermes", false);
  assert.equal(plan.spec.priority, 9);
  assert.deepEqual(plan.skipped, [{ title: "hold DMs to strangers", priority: 40 }]);
  assert.equal(plan.needsAck, true);
  assert.ok(plan.warnings.some((w) => w.includes("“hold DMs to strangers” (priority 40)")), plan.warnings.join(" | "));
  assert.ok(plan.warnings.some((w) => /cannot tell which of your 2 hold rules held this call, so it assumed the first one, “hold A's DMs”/.test(w)));
});

test("D-4: one hold, or a hold that cannot match, needs no tick; inactive holds are not skipped", () => {
  assert.equal(allowPlan(q, [holdA], "Hermes", false).needsAck, false);
  assert.equal(allowPlan(q, [holdA, row("rul_o", "other app", 40, "hold", { products: ["knowledge"] })], "Hermes", false).needsAck, false);
  assert.equal(allowPlan(q, [holdA, { ...holdStrangers, spec: { ...holdStrangers.spec, active: false } }], "Hermes", false).needsAck, false);
});

test("D-4: with the hold rule in the link (rule=), the allow goes just before THAT hold; earlier holds still run first and are not skipped", () => {
  const early = row(RUL("E"), "hold everything early", 5, "hold", { products: ["connect"] });
  const decider = row(RUL("D"), "hold A's DMs", 30, "hold", { agents: [A] });
  const late = row(RUL("L"), "hold late", 60, "hold", { effects: ["outward"] });
  const plan = allowPlan({ ...q, rule: RUL("D") }, [early, decider, late], "Hermes", false);
  assert.equal(plan.spec.priority, 29, "just before the hold that held the call");
  assert.deepEqual(plan.skipped.map((s) => s.title), ["hold late"], "the early hold runs first (not skipped); the late one is skipped");
  assert.doesNotMatch(plan.warnings.join(" "), /cannot tell which/, "the link named the hold");
  assert.equal(plan.deciderId, RUL("D"));
  // a hold directly next to it cannot be kept in front: it is named
  const adjacent = row(RUL("N"), "hold next door", 29, "hold", { agents: [A] });
  assert.deepEqual(allowPlan({ ...q, rule: RUL("D") }, [adjacent, decider], "Hermes", false).skipped.map((s) => s.title), ["hold next door"]);
});

test("D-4: readAllowQuery reads rule= (a rul_ id) and refuses anything else", () => {
  const base = `?new=allow&product=connect&op=buzz_dm&hold=${HOLD}&agent=${A}`;
  const ok = readAllowQuery(`${base}&rule=${RUL("D")}`);
  assert.equal(ok.kind === "ok" && ok.query.rule, RUL("D"));
  assert.equal(readAllowQuery(`${base}&rule=rul_short`).kind, "bad");
  assert.equal(readAllowQuery(`${base}&rule=${RUL("D")}&rule=${RUL("E")}`).kind, "bad");
  assert.equal(readAllowQuery(base).kind === "ok" && "rule" in readAllowQuery(base), false);
});

test("S4: the sentence is right when a deny forces the allow AFTER the hold", () => {
  const hold = row("rul_h", "Sends wait", 60, "hold", { products: ["connect"] });
  const deny = row("rul_d", "No sends", 70, "deny", { products: ["connect"] });
  const plan = allowPlan(q, [hold, deny], "Hermes", false);
  assert.equal(plan.spec.priority, 71);
  assert.match(plan.why, /^Priority 71: after your hold rule “Sends wait” \(priority 60\), so that hold rule still runs first and after your refuse rule “No sends” \(priority 70\)/);
  assert.doesNotMatch(plan.why, /before your hold rule|no longer catches/);
  assert.ok(plan.warnings.some((w) => /still runs first/.test(w)));
  // the normal case keeps its sentence
  assert.match(allowPlan(q, [hold], "Hermes", false).why, /^Priority 59: before your hold rule “Sends wait” \(priority 60\), so the hold no longer catches this call/);
});

test("S4: the owner edits the prefilled rule: the placement is computed again from what it matches now", () => {
  const rules = [holdA, holdStrangers, row("rul_k", "hold knowledge", 25, "hold", { products: ["knowledge"] }), row("rul_n", "no knowledge", 90, "deny", { products: ["knowledge"] })];
  const plan = allowPlan(q, rules, "Hermes", false);
  assert.equal(plan.spec.priority, 9);
  // the owner moves the rule to the knowledge app: only the knowledge hold (25) and the knowledge deny (90) can match now
  const edited = { ...plan.spec, match: { products: ["knowledge"], operations: ["search"], agents: [A] } };
  const again = replanAllow(edited, rules, plan);
  assert.equal(again.spec.priority, 91, "after the knowledge deny at 90; the knowledge hold at 25 runs first");
  assert.deepEqual(again.skipped, []);
  assert.ok(again.warnings.some((w) => /“hold knowledge” \(priority 25\) still runs first/.test(w)));
  // a priority the owner typed stays, and the plan says which refuse and hold rules it runs ahead of
  const typed = replanAllow({ ...edited, priority: 5 }, rules, plan, true);
  assert.equal(typed.spec.priority, 5);
  assert.ok(typed.warnings.some((w) => /runs ahead of your refuse rule “no knowledge” \(priority 90\)/.test(w)));
  assert.deepEqual(typed.skipped.map((s) => s.title), ["hold DMs to strangers"], "the knowledge hold is the one the rule is for; the strangers hold has no app or operation, so it could match too");
  assert.equal(typed.needsAck, true);
  // a tool added to a dynamic operation lifts the tool requirement
  assert.equal(replanAllow({ ...edited, match: { ...edited.match, tools: ["gmail_send"] } }, rules, { ...plan, needTool: true }).needTool, false);
});

test("S4: the UI copy of the overlap rule agrees with the server's (and knows tools and caller kinds)", () => {
  const cases: [RuleSpec["match"], RuleSpec["match"]][] = [
    [{ agents: [A] }, { agents: [B] }],
    [{ agents: [A] }, { effects: ["money"] }],
    [{ effects: ["read"] }, { effects: ["money", "write"] }],
    [{ products: ["a"], operations: ["x"] }, { products: ["a"] }],
    [{ callerProducts: ["evolution"] }, { callerProducts: ["knowledge"] }],
    [{}, {}],
  ];
  for (const [a, b] of cases) assert.equal(overlaps(a, b), mayOverlap(a, b), JSON.stringify([a, b]));
  assert.equal(overlaps({ tools: ["a_b"] }, { tools: ["c_d"] }), false);
  assert.equal(overlaps({ agents: [A] }, { callerProducts: ["evolution"] }), false);
  assert.equal(overlaps({ callerProducts: ["evolution"] }, { agents: [A] }), false);
});

test("S4: rules_set returns a placementWarning when a saved allow runs ahead of an overlapping refuse or hold; nothing otherwise", async () => {
  const { db } = migratedDb();
  seedCatalog(db, ["connect"]);
  saveRule(db, { spec: spec({ title: "No sends", priority: 50, match: { agents: [A], effects: ["outward"] }, decision: "deny" }), actor: OWNER });
  saveRule(db, { spec: { ...spec({ title: "Paused hold", priority: 60, match: { agents: [A], effects: ["outward"] }, decision: "hold" }), active: false }, actor: OWNER });
  const ctx = opCtx(db, { type: "person", id: OWNER });
  const ahead = await run(OP.rulesSet)({ rule: spec({ title: "Allow sends", priority: 20, match: { agents: [A], effects: ["outward"] }, decision: "allow" }) }, ctx);
  assert.match(ahead.placementWarning, /^This allow rule \(priority 20\) runs before your refuse rule “No sends” \(priority 50\), hold rule “Paused hold” \(priority 60, inactive\)\./);
  assert.equal(ahead.rule.spec.priority, 20, "a note, not a refusal: the rule is saved");
  const behind = await run(OP.rulesSet)({ rule: spec({ title: "Allow sends later", priority: 70, match: { agents: [A], effects: ["outward"] }, decision: "allow" }) }, ctx);
  assert.equal("placementWarning" in behind, false);
  const other = await run(OP.rulesSet)({ rule: spec({ title: "Allow B", priority: 1, match: { agents: [B], effects: ["outward"] }, decision: "allow" }) }, ctx);
  assert.equal("placementWarning" in other, false, "the deny is for another agent");
  const deny = await run(OP.rulesSet)({ rule: spec({ title: "Another deny", priority: 1, match: { agents: [A] }, decision: "deny" }) }, ctx);
  assert.equal("placementWarning" in deny, false, "only allow rules get the note");
  // editing a rule does not count itself
  const edit = await run(OP.rulesSet)({ id: behind.rule.id, expectedRev: behind.rule.rev, rule: behind.rule.spec }, ctx);
  assert.equal("placementWarning" in edit, false);
  assert.equal(placementWarning(spec({ priority: 5, decision: "hold" }), []), "");
});

test("S4: the 10-rule cap keeps every parser rule and drops model additions first; `added` counts what is kept", () => {
  const parserRules = Array.from({ length: 8 }, (_, i) => spec({ title: `parser allow ${i}`, match: { agents: [A], operations: [`op_${i}x`], products: ["connect"] }, decision: "allow" }));
  const modelRules = Array.from({ length: 5 }, (_, i) => spec({ title: `model deny ${i}`, match: { agents: [B], operations: [`op_${i}y`], products: ["connect"] }, decision: "deny" }));
  const out = mergeModelDraft({ rules: parserRules, notes: [], unmatched: [{ text: "x", hint: "y" }] }, { rules: modelRules, notes: [], unmatched: [] }, []);
  const titles = out.proposal.rules.map((r) => r.title);
  assert.equal(titles.length, 10);
  for (const r of parserRules) assert.ok(titles.includes(r.title), `${r.title} stays`);
  assert.equal(out.added, 2, "only two model rules fit");
  assert.equal(titles.filter((t) => t.startsWith("model")).length, 2);
  assert.equal(out.proposal.unmatched.filter((u) => /holds at most 10 rules/.test(u.hint)).length, 3, "the other three are listed, not silently lost");
});
