// C378 (spec 0.1.88): acting agents narrow only. Deny and hold rules on agents, teams and trust reach the agent behind an app call; an allow rule never does.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ActingFact, type CallFacts, evaluate, type Rule } from "../src/engine.ts";
import { actingFacts, actingIdsOf } from "../src/hooks.ts";

const A = "agt_01M5XDKEN9NV1EKQE9EZR1Y8KP";
const B = "agt_01M5XDKX4QSFVDPPKRXMFNFG7T";
const rule = (id: string, match: Record<string, unknown>, decision: "allow" | "hold" | "deny", priority = 10): Rule => ({ id, rev: 1, updatedAt: 1, spec: { title: id, active: true, priority, match, outcome: { decision, reason: "r" } } as never });
const facts = (acting: readonly ActingFact[], over: Partial<CallFacts> = {}): CallFacts => ({
  caller: { type: "app", id: "ins_1", mode: null }, target: { product: "kanban", op: "issue_create", effect: "write" }, claim: null, claimVerified: false,
  claimTeams: [], claimTeamsAny: [], callerTeams: [], callerTeamsAny: [], claimTrusts: [], claimTrustActive: true, fleetAvailable: true, callerProduct: "evolution", acting, ...over,
});
const sales: ActingFact = { id: A, teamsAny: ["sales"], trusts: ["limited"] };
const other: ActingFact = { id: B, teamsAny: ["ops"], trusts: ["trusted"] };

test("deny and hold rules on agents, teams and trust match an acting agent; ANY agent of the list is enough", () => {
  for (const [name, match] of [["agents", { agents: [A] }], ["teams", { callerTeams: ["sales"] }], ["trust", { callerTrust: ["limited"] }]] as const) {
    for (const d of ["deny", "hold"] as const) {
      assert.equal(evaluate([rule("r", match, d)], facts([sales])).decision, d, `${name} ${d}`);
      assert.equal(evaluate([rule("r", match, d)], facts([other, sales])).decision, d, `${name} ${d} second agent`);
      assert.equal(evaluate([rule("r", match, d)], facts([other])).decision, "allow", `${name} ${d} other agent`);
    }
  }
});

test("NARROW ONLY: an allow rule on agents, teams or trust never matches because of an acting agent", () => {
  for (const match of [{ agents: [A] }, { callerTeams: ["sales"] }, { callerTrust: ["limited"] }]) {
    const v = evaluate([rule("allow", match, "allow"), rule("deny-all", { products: ["kanban"] }, "deny", 20)], facts([sales]));
    assert.equal(v.decision, "deny", JSON.stringify(match));
    assert.equal(evaluate([rule("allow", match, "allow")], facts([sales]), "closed").decision, "deny", "Closed stays closed");
  }
});

test("a call with no acting agent is the app's own work: agent rules do not match, product rules do", () => {
  for (const match of [{ agents: [A] }, { callerTeams: ["sales"] }, { callerTrust: ["limited"] }]) assert.equal(evaluate([rule("r", match, "deny")], facts([])).decision, "allow");
  assert.equal(evaluate([rule("r", { callerProducts: ["evolution"] }, "deny")], facts([])).decision, "deny");
  assert.equal(evaluate([rule("r", { callerProducts: ["evolution"], callerTeams: ["sales"] }, "hold")], facts([sales])).decision, "hold", "both named: both must match");
  assert.equal(evaluate([rule("r", { callerProducts: ["observer"], callerTeams: ["sales"] }, "hold")], facts([sales])).decision, "allow");
});

test("an agent caller is unchanged, whatever acting says", () => {
  const f = facts([sales], { caller: { type: "agent", id: B, mode: null }, callerProduct: null, callerTeamsAny: ["ops"], callerTeams: ["ops"], callerTrusts: ["trusted"] });
  assert.equal(evaluate([rule("r", { agents: [A] }, "deny")], f).decision, "allow");
  assert.equal(evaluate([rule("r", { callerTeams: ["sales"] }, "deny")], f).decision, "allow");
});

test("Fleet facts unavailable: a deny or hold by team or trust applies to an acting agent; the app's own read stays free", () => {
  const dark = (acting: readonly ActingFact[]) => facts(acting, { fleetAvailable: false });
  const none: ActingFact = { id: A, teamsAny: [], trusts: [] };
  assert.equal(evaluate([rule("r", { callerTeams: ["sales"] }, "deny")], dark([none])).decision, "deny");
  assert.equal(evaluate([rule("r", { callerTrust: ["blocked"] }, "hold")], dark([none])).decision, "hold");
  // S2-2 stays closed: Rules' own feed read has no acting agent, so a team rule never reaches it
  const feed = facts([], { fleetAvailable: false, callerProduct: "rules", target: { product: "fleet", op: "directory_feed", effect: "read" } });
  assert.equal(evaluate([rule("r", { callerTeams: ["sales"] }, "deny")], feed).decision, "allow");
});

test("tb.acting is read strictly: absent = none; anything malformed throws (the gate refuses)", () => {
  assert.deepEqual(actingIdsOf({}), []);
  assert.deepEqual(actingIdsOf({ "tb.acting": { v: 1, agents: [{ id: A, via: "ticket", job: "j" }, { id: B, via: "parent_call" }] } }), [A, B]);
  for (const bad of [null, "x", {}, { agents: [] }, { agents: [{}] }, { agents: [{ id: "ins_1" }] }, { agents: Array.from({ length: 5 }, () => ({ id: A })) }]) assert.throws(() => actingIdsOf({ "tb.acting": bad }), /malformed/, JSON.stringify(bad));
});

test("actingFacts: an unknown agent is unreviewed; with no copy the trust is unknown", () => {
  const fx = { available: true, teamsAny: new Map([[`agent:${A}`, ["sales"]]]), trust: new Map([[`agent:${A}`, { trusts: ["limited"], allActive: true }]]) } as never;
  assert.deepEqual(actingFacts(fx, [A, B]), [{ id: A, teamsAny: ["sales"], trusts: ["limited"] }, { id: B, teamsAny: [], trusts: ["unreviewed"] }]);
  assert.deepEqual(actingFacts({ ...(fx as object), available: false } as never, [A])[0]?.trusts, []);
});
