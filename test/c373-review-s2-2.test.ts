// Review 0.5.0 S2-2: a deny/hold `callerTeams` rule applied to APP callers while the Governance facts were missing, Rules' own
// `fleet/directory_feed` read included, so the facts never came back (self-sustaining fail-closed loop). Teams are agent facts:
// an app caller never matches a `callerTeams` rule, and no rule shape the writers accept refuses or holds Rules' own feed read
// ONLY because Governance data is missing.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Json } from "@opt2-tealbrick/miniapp-sdk";
import { type CallFacts, evaluate, order, type Rule, type RuleSpec, specProblem, type Trust } from "../src/engine.ts";
import { syncFleet } from "../src/fleet.ts";
import { makeHooks } from "../src/hooks.ts";
import { MODES } from "../src/mode.ts";
import { fleetFacts, saveRule } from "../src/store.ts";
import { feed, hookCtx, hookReq, migratedDb, OWNER, prng, spec } from "./helpers.ts";

const RULES_INS = "ins_01J000000000000000000RULES";
type Gate = (r: unknown, c: unknown) => Promise<{ allow: boolean; reason?: string }>;

test("S2-2: a callerTeams deny + Governance never read does not refuse Rules' own directory_feed read, so Governance comes back", async () => {
  const { db } = migratedDb();
  saveRule(db, { spec: spec({ title: "Block agents in team Dev", priority: 10, match: { callerTeams: ["tm_dev"] }, decision: "deny" }), actor: OWNER });
  const gate = (makeHooks("rules") as unknown as Record<string, Gate>).rules_gate as Gate;
  const feedReq = hookReq("before", { app: { id: RULES_INS, product: "rules" }, product: "fleet", op: "directory_feed", effect: "read" });
  assert.equal(fleetFacts(db).available, false);
  assert.deepEqual(await gate(feedReq, hookCtx(db)), { allow: true }, "apps are in no team");
  // the bridge runs Rules' gate on Rules' own companion call
  const callApp = async (product: string, op: string, input: Json) => {
    const ans = await gate(hookReq("before", { app: { id: RULES_INS, product: "rules" }, product, op, effect: "read", input }), hookCtx(db));
    if (!ans.allow) throw Object.assign(new Error(ans.reason ?? "refused"), { code: "hook_refused", httpStatus: 403 });
    return { status: "ok" as const, output: feed() };
  };
  await syncFleet(db, callApp);
  assert.equal(fleetFacts(db).available, true, "Governance facts came back");
  // the rule still applies to an agent while the facts are missing (fail closed for agents is unchanged)
  const agentReq = hookReq("before", { effect: "read", op: "buzz_read" });
  const fresh = migratedDb().db;
  saveRule(fresh, { spec: spec({ title: "Block agents in team Dev", priority: 10, match: { callerTeams: ["tm_dev"] }, decision: "deny" }), actor: OWNER });
  assert.equal((await gate(agentReq, hookCtx(fresh))).allow, false, "an agent still meets the closed team rule");
});

test("S2-2: a callerTeams rule never matches an app caller, with or without the Governance facts, for every decision", () => {
  for (const decision of ["allow", "deny", "hold"] as const) {
    const s: RuleSpec = { title: "t", active: true, priority: 1, match: { callerTeams: ["tm_x"] }, outcome: { decision, reason: "r" } };
    for (const fleetAvailable of [true, false]) {
      const v = evaluate(order([{ id: "r", rev: 1, spec: s, updatedAt: 1 }]), appFacts({ fleetAvailable, callerTeams: ["tm_x"], callerTeamsAny: ["tm_x"] }));
      assert.equal(v.rule, null, `${decision} fleet=${fleetAvailable}`);
    }
  }
});

// ── invariant: Governance data missing never makes Rules' own feed read stricter, for any rule set the writers accept ──
const TR: Trust[] = ["unreviewed", "trusted", "limited", "blocked"];
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const sub = <T>(r: () => number, xs: readonly T[]): T[] => xs.filter(() => r() < 0.5);

/** A rule shape a writer accepts that does not NAME the feed read explicitly (products fleet, callerProducts rules, Rules' instance). */
function randSpec(r: () => number, i: number): RuleSpec | null {
  const decision = pick(r, ["allow", "deny", "hold"] as const);
  const m: RuleSpec["match"] = {};
  if (r() < 0.3) m.agents = sub(r, ["agt_a", "ins_other"]);
  if (r() < 0.3) m.effects = sub(r, ["read", "write", "outward", "money"] as const);
  if (r() < 0.2) m.modes = [pick(r, ["free", "bound"] as const)];
  if (r() < 0.2) m.products = [pick(r, ["connect", "knowledge"])];
  if (r() < 0.4) m.callerTeams = [pick(r, ["tm_x", "tm_dev"])];
  if (r() < 0.3) m.callerTrust = [pick(r, TR)];
  if (r() < 0.25) m.callerProducts = [pick(r, ["evolution", "inbox", "kanban"])];
  if (r() < 0.15) {
    m.callerProducts = ["evolution"];
    m.callerWorkflows = [pick(r, ["wf-one", "wf-two"])];
  }
  if (r() < 0.25) {
    m.effects = ["outward"];
    m.recipients = r() < 0.5 ? { teams: [pick(r, ["tm_x"])] } : r() < 0.5 ? { trust: [pick(r, TR)] } : { known: r() < 0.5 };
  }
  if (r() < 0.3) m.onBehalfOf = r() < 0.5 ? { teams: [pick(r, ["tm_x"])] } : r() < 0.5 ? { trust: [pick(r, TR)] } : { kinds: ["person"] };
  const s: RuleSpec = { title: `r${i}`, active: true, priority: Math.floor(r() * 5), match: m, outcome: { decision, reason: "x" } };
  return specProblem(s) ? null : s;
}

function appFacts(over: Partial<CallFacts> = {}): CallFacts {
  return {
    caller: { type: "app", id: RULES_INS, mode: null },
    target: { product: "fleet", op: "directory_feed", effect: "read", dynamic: false },
    claim: null,
    claimVerified: false,
    claimTeams: [],
    claimTeamsAny: [],
    callerTeams: [],
    callerTeamsAny: [],
    callerTrusts: [],
    callerTrustActive: true,
    recipients: null,
    callerWorkflow: null,
    workflowCapVisible: false,
    claimTrusts: [],
    claimTrustActive: true,
    fleetAvailable: true,
    callerProduct: "rules",
    ...over,
  };
}

test("S2-2 invariant: no rule set the writers accept refuses or holds Rules' own feed read only because Governance data is missing", () => {
  const r = prng(20261027);
  let sets = 0;
  for (let n = 0; n < 6000; n++) {
    const rules: Rule[] = [];
    for (let i = 0; i < 1 + Math.floor(r() * 4); i++) {
      const s = randSpec(r, i);
      if (s) rules.push({ id: `rul_${i}`, rev: 1, spec: s, updatedAt: i });
    }
    if (rules.length === 0) continue;
    sets++;
    const ordered = order(rules);
    for (const mode of MODES) {
      // with and without an on-behalf-of claim on the read (the bridge copies none today; defence in depth)
      for (const claim of [null, { kind: "person" as const, id: "ct_1" }]) {
        const known = evaluate(ordered, appFacts({ claim }), mode);
        const missing = evaluate(ordered, appFacts({ claim, fleetAvailable: false }), mode);
        assert.equal(missing.decision, known.decision, `${mode} claim=${!!claim}: ${JSON.stringify(rules.map((x) => [x.spec.outcome.decision, x.spec.match]))}`);
      }
    }
  }
  assert.ok(sets > 4000);
});

test("S2-2: only a rule that names the feed read explicitly (products fleet or callerProducts rules) can refuse it", () => {
  for (const match of [{ products: ["fleet"] }, { callerProducts: ["rules"] }] as RuleSpec["match"][]) {
    const s: RuleSpec = { title: "t", active: true, priority: 1, match, outcome: { decision: "deny", reason: "r" } };
    assert.equal(evaluate(order([{ id: "r", rev: 1, spec: s, updatedAt: 1 }]), appFacts({ fleetAvailable: false })).decision, "deny");
  }
});

test("S2-2 UI: a refuse/hold rule that names the feed read warns “This rule cuts Rules off from Governance”; others do not", async () => {
  const { cutsOffGovernance, CUTS_OFF_GOVERNANCE } = await import("../src/ui/api.ts");
  assert.match(CUTS_OFF_GOVERNANCE, /^This rule cuts Rules off from Governance/);
  const r = (match: RuleSpec["match"], decision: "allow" | "deny" | "hold" = "deny"): RuleSpec => ({ title: "t", active: true, priority: 1, match, outcome: { decision, reason: "r" } });
  for (const m of [{ products: ["fleet"] }, { callerProducts: ["rules"] }, { products: ["fleet"], effects: ["read" as const] }, { products: ["fleet"], operations: ["directory_feed"] }]) assert.equal(cutsOffGovernance(r(m)), true, JSON.stringify(m));
  assert.equal(cutsOffGovernance(r({ products: ["fleet"] }, "hold")), true);
  for (const m of [{ products: ["fleet"] }]) assert.equal(cutsOffGovernance(r(m, "allow")), false);
  for (const m of [{ products: ["connect"] }, { products: ["fleet"], effects: ["outward" as const] }, { products: ["fleet"], operations: ["team_get"] }, { callerProducts: ["inbox"] }, { callerTeams: ["tm_dev"] }, {}])
    assert.equal(cutsOffGovernance(r(m)), false, JSON.stringify(m));
});
