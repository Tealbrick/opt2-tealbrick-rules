// Rules 0.5.0 (C373 D2c, Evolution P1 §4): `match.callerWorkflows` = the VERIFIED workflow id of an APP caller (bridge
// `caller.workflow`). Agreed fail-closed rule with Evolution: with the bridge cap `app_workflow_grants` visible, a call without a
// workflow is not a workflow call (no match); without it, deny/hold apply to an `evolution` caller and allow never matches. Agents
// never match. The writer requires `callerProducts` with `evolution`. Quiet-on-good and fire-on-bad with exact outcomes (L27, L34).
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Json } from "@opt2-tealbrick/miniapp-sdk";
import { OP } from "#kit";
import { definition, handlers, manifest } from "../src/app.ts";
import { type CallFacts, evaluate, explain, NEEDS_WORKFLOW, order, type Rule, specProblem, strictestNarrowing } from "../src/engine.ts";
import { bridgeCapsOf, makeHooks, registerBridgeCaps, workflowCapVisible, workflowOf } from "../src/hooks.ts";
import { listDecisions, saveRule } from "../src/store.ts";
import { matchText } from "../src/ui/api.ts";
import { AGENT_A, APP_INSTANCE, hookCtx, hookReq, migratedDb, OWNER, opCtx, seedCatalog, spec } from "./helpers.ts";

const rule = (id: string, s: Rule["spec"]): Rule => ({ id, rev: 1, spec: s, updatedAt: 1 });
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
  callerProduct: "evolution",
};
const app = (callerWorkflow: string | null, o: Partial<CallFacts> = {}): CallFacts => ({ ...base, callerWorkflow, ...o });
const agent = (o: Partial<CallFacts> = {}): CallFacts => ({ ...base, caller: { type: "agent", id: AGENT_A, mode: "free" }, callerProduct: null, ...o });
const WF = { callerProducts: ["evolution"], callerWorkflows: ["weekly-report"] };
const one = (decision: "allow" | "deny" | "hold", match: Rule["spec"]["match"] = WF, extra: Partial<Rule["spec"]> = {}) =>
  order([rule("rul_w", spec({ priority: 10, match, decision, reason: `${decision} by workflow`, ...extra }))]);
const out = (v: ReturnType<typeof evaluate>) => [v.decision, v.rule?.id ?? null, v.closedOnWorkflow] as const;

test("a listed verified workflow matches; another workflow does not (deny, hold, allow alike)", () => {
  for (const decision of ["deny", "hold", "allow"] as const) {
    assert.deepEqual(out(evaluate(one(decision), app("weekly-report"))), [decision, "rul_w", false], decision);
    assert.deepEqual(out(evaluate(one(decision), app("daily-digest"))), ["allow", null, false], decision);
    assert.equal(explain(one(decision), app("daily-digest"))[0]?.why, "calling workflow is not listed");
  }
});

test("an AGENT never matches a callerWorkflows rule, with or without the cap, whatever it claims", () => {
  for (const decision of ["deny", "hold", "allow"] as const)
    for (const f of [agent(), agent({ callerWorkflow: "weekly-report" }), agent({ workflowCapVisible: true }), agent({ fleetAvailable: false })]) {
      assert.deepEqual(out(evaluate(one(decision), f)), ["allow", null, false], decision);
      assert.equal(explain(one(decision), f)[0]?.why, "caller is not an app");
    }
});

test("no workflow WITH the cap visible: not a workflow call, no match (deny, hold, allow)", () => {
  for (const decision of ["deny", "hold", "allow"] as const) {
    assert.deepEqual(out(evaluate(one(decision), app(null, { workflowCapVisible: true }))), ["allow", null, false], decision);
    assert.equal(explain(one(decision), app(null, { workflowCapVisible: true }))[0]?.why, "not a workflow call");
  }
});

test("no workflow WITHOUT the cap: deny and hold apply to evolution (flagged), allow is skipped with its narrowing kept", () => {
  for (const unseen of [{}, { workflowCapVisible: false }]) {
    assert.deepEqual(out(evaluate(one("deny"), app(null, unseen))), ["deny", "rul_w", true]);
    assert.deepEqual(out(evaluate(one("hold"), app(null, unseen))), ["hold", "rul_w", true]);
    const v = evaluate(one("allow", WF, { narrowing: { memoryTags: { anyOf: ["work"] } } }), app(null, unseen));
    assert.deepEqual([v.decision, v.rule, v.narrowing, v.closedOnWorkflow], ["allow", null, { memoryTags: { anyOf: ["work"] } }, true]);
  }
  assert.equal(explain(one("allow"), app(null))[0]?.why, NEEDS_WORKFLOW);
  assert.match(String(explain(one("hold"), app(null))[0]?.why), /the bridge cannot confirm the calling workflow, so this rule applies \(fail closed\)/);
  // an app whose product is unverified could be Evolution: both gaps apply
  const v = evaluate(one("hold"), app(null, { callerProduct: null }));
  assert.deepEqual([v.decision, v.closedOnProduct, v.closedOnWorkflow], ["hold", true, true]);
  // another VERIFIED product without a workflow never matches (only Evolution runs workflows)
  const both = one("deny", { callerProducts: ["evolution", "knowledge"], callerWorkflows: ["weekly-report"] });
  assert.deepEqual(out(evaluate(both, app(null, { callerProduct: "knowledge" }))), ["allow", null, false]);
  assert.deepEqual(out(evaluate(both, app("weekly-report", { callerProduct: "knowledge" }))), ["deny", "rul_w", false], "a verified workflow from a listed product matches");
});

test("strictestNarrowing: a workflow allow rule's narrowing could apply only where the rule could match", () => {
  const r = one("allow", WF, { narrowing: { memoryTags: { anyOf: ["w"] } } });
  assert.deepEqual(strictestNarrowing(r, app("weekly-report")), { memoryTags: { anyOf: ["w"] } });
  assert.deepEqual(strictestNarrowing(r, app(null)), { memoryTags: { anyOf: ["w"] } }, "no cap: could apply (fail closed)");
  for (const f of [app("daily-digest"), app(null, { workflowCapVisible: true }), agent()]) assert.equal(strictestNarrowing(r, f), null);
});

test("workflowOf reads the workflow of an APP caller only; anything but a workflow id is none", () => {
  assert.equal(workflowOf({ type: "app", id: APP_INSTANCE, workflow: "weekly-report" } as never), "weekly-report");
  for (const w of ["Weekly", "ab", "1abc", "a".repeat(41), "has space", 7, null]) assert.equal(workflowOf({ type: "app", id: APP_INSTANCE, workflow: w } as never), null, String(w));
  assert.equal(workflowOf({ type: "agent", id: AGENT_A, workflow: "weekly-report" } as never), null);
});

test("bridge caps: registered at onStart per database; never registered, or a throwing reader, = no caps (the strict path)", async () => {
  const { db } = migratedDb();
  assert.deepEqual(bridgeCapsOf(db), []);
  assert.equal(workflowCapVisible(db), false);
  let caps: string[] = ["hook_tool"];
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  await definition.onStart?.({ db, log: quiet, callApp: async () => Promise.reject(new Error("offline")), statusChanged() {}, bridgeCaps: () => caps } as never);
  assert.equal(workflowCapVisible(db), false, "quiet: another cap");
  caps = ["hook_tool", "app_workflow_grants"];
  assert.equal(workflowCapVisible(db), true, "read on every call: the current slice's caps");
  const other = migratedDb().db;
  registerBridgeCaps(other, () => {
    throw new Error("slice gone");
  });
  assert.equal(workflowCapVisible(other), false);
});

test("gate: an Evolution workflow is held by its rule; another passes; no workflow without the cap holds (flagged), with the cap passes", async () => {
  const db = seedCatalog(migratedDb().db, ["evolution", "connect"]);
  saveRule(db, { spec: spec({ title: "weekly report sends wait", priority: 10, match: { effects: ["outward"], ...WF }, decision: "hold", reason: "the weekly report needs review" }), actor: OWNER });
  const hooks = makeHooks("rules", { holdSupported: true });
  const gate = (callId: string, workflow?: string) =>
    (hooks.rules_gate as unknown as (...a: unknown[]) => Promise<Record<string, any>>)(hookReq("before", { callId, app: { product: "evolution" }, ...(workflow ? { callerExtra: { workflow } } : {}) }), hookCtx(db));
  assert.equal((await gate("cal_w", "weekly-report")).hold?.family, "policy", "fire: the listed workflow");
  assert.deepEqual(await gate("cal_o", "daily-digest"), { allow: true }, "quiet: another workflow");
  assert.equal((await gate("cal_none")).hold?.family, "policy", "fire: no workflow and no cap (fail closed)");
  registerBridgeCaps(db, () => ["app_workflow_grants"]);
  assert.deepEqual(await gate("cal_none_cap"), { allow: true }, "quiet: with the cap, no workflow = not a workflow call");
  const row = (id: string) => listDecisions(db, { callId: id, limit: 1 }).items[0]?.detail;
  assert.deepEqual(row("cal_w"), { workflow: "weekly-report" });
  assert.deepEqual(row("cal_none"), { workflowUnavailable: true });
  const ex = await (handlers[OP.rulesExplain] as unknown as { run: (i: unknown, c: unknown) => Promise<any> }).run({ callId: "cal_none" }, opCtx(db, { type: "app", id: APP_INSTANCE, product: "evolution" }));
  assert.equal(ex.decisions[0].workflowUnavailable, true);
  assert.equal(validateAgainstSchema(manifest.operations.find((o) => o.id === "rules_explain")?.output as never, ex).ok, true);
});

test("writers: callerWorkflows need workflow ids, no repeats, and callerProducts with evolution", () => {
  const p = (match: Rule["spec"]["match"]) => specProblem(spec({ match }));
  assert.equal(p(WF), "", "quiet on good");
  assert.equal(p({ callerProducts: ["evolution"], callerWorkflows: ["Bad"] }), "callerWorkflows has “Bad”, which is not a workflow id (a lower-case letter, then 2 to 39 lower-case letters, digits or -)");
  assert.equal(p({ callerProducts: ["evolution"], callerWorkflows: ["abc", "abc"] }), "callerWorkflows lists “abc” twice");
  assert.equal(p({ callerWorkflows: ["weekly-report"] }), "callerWorkflows are workflows of Evolving Workflows: add “evolution” to callerProducts");
  assert.equal(p({ callerProducts: ["knowledge"], callerWorkflows: ["weekly-report"] }), "callerWorkflows are workflows of Evolving Workflows: add “evolution” to callerProducts");
});

test("manifest: every rule schema takes callerWorkflows; rules_preview takes caller.workflow and answers workflowUnavailable", async () => {
  const input = manifest.operations.find((o) => o.id === "rules_set")?.input as Parameters<typeof validateAgainstSchema>[0];
  const ok = (cw: unknown) => validateAgainstSchema(input, { rule: { title: "t", active: true, priority: 1, match: { callerProducts: ["evolution"], callerWorkflows: cw }, outcome: { decision: "hold", reason: "r" } } } as unknown as Json).ok;
  assert.equal(ok(["weekly-report"]), true);
  for (const bad of [["Bad"], ["ab"], ["x", "x"], "weekly-report"]) assert.equal(ok(bad), false, JSON.stringify(bad));
  const db = seedCatalog(migratedDb().db, ["evolution", "connect"]);
  saveRule(db, { spec: spec({ title: "w", match: { effects: ["outward"], ...WF }, decision: "deny", reason: "r" }), actor: OWNER });
  const pv = manifest.operations.find((o) => o.id === "rules_preview");
  const preview = async (caller: Record<string, unknown>) => {
    const i = { call: { caller, target: { product: "connect", op: "buzz_dm", effect: "outward" } } };
    assert.equal(validateAgainstSchema(pv?.input as never, i as never).ok, true);
    const o = await (handlers[OP.rulesPreview] as unknown as { run: (i: unknown, c: unknown) => Promise<any> }).run(i, opCtx(db, { type: "person", id: OWNER }));
    assert.equal(validateAgainstSchema(pv?.output as never, o).ok, true);
    return [o.decision, o.workflowUnavailable];
  };
  assert.deepEqual(await preview({ type: "app", id: "ins_preview", product: "evolution", workflow: "weekly-report" }), ["deny", false]);
  assert.deepEqual(await preview({ type: "app", id: "ins_preview", product: "evolution" }), ["deny", true]);
  assert.deepEqual(await preview({ type: "app", id: "ins_preview", product: "evolution", workflow: "other-one" }), ["allow", false]);
  assert.equal(validateAgainstSchema(pv?.input as never, { call: { caller: { type: "app", id: "x", workflow: "Bad" }, target: { product: "connect", op: "buzz_dm", effect: "outward" } } } as never).ok, false);
});

test("rule list text names the workflows", () => {
  assert.equal(matchText(spec({ match: WF }), (t) => t, (a) => a), "calls from app evolution; from workflow weekly-report");
});
