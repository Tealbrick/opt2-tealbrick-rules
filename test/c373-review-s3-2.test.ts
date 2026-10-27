// Review 0.5.0 S3-2: a composed HOLD was placed ahead of an existing DENY (priority 10 < 50), so approving it weakened that deny to
// a hold. Composed rules go deny before hold before allow relative to the existing rules, never on a tie with another decision.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCatalog, catalogProblem } from "../src/catalog.ts";
import { type ComposeEnv, composeRules, placeProposal, placement, priorityWhy } from "../src/compose.ts";
import { type CallFacts, evaluate, order, type RuleSpec, specProblem } from "../src/engine.ts";

const HERMES = "agt_01J000000000000000000HERMES";
const cat = buildCatalog([{ product: "connect", ops: [{ id: "buzz_dm", title: "Send a DM", effect: "outward", audience: "agent", dynamic: false, tools: [] }] }]);
const problem = (s: RuleSpec) => specProblem(s) || catalogProblem(s, cat);
const env = (over: Partial<ComposeEnv> = {}): ComposeEnv => ({ agents: [{ id: HERMES, name: "Hermes" }], teams: [], apps: [{ id: "connect" }], problem, ...over });
const facts: CallFacts = { caller: { type: "agent", id: HERMES, mode: "bound" }, target: { product: "connect", op: "buzz_dm", effect: "outward" }, claim: null, claimVerified: false, claimTeams: [], claimTeamsAny: [], callerTeams: [], callerTeamsAny: [], claimTrusts: [], claimTrustActive: true, fleetAvailable: true, callerProduct: null };

test("S3-2: a composed hold goes after an existing deny, so approving it never weakens that deny (review probe)", () => {
  const existing = [{ priority: 50, decision: "deny" as const }];
  const p = composeRules("Hold outward actions", env({ existing }));
  const hold = p.rules[0] as RuleSpec;
  assert.equal(hold.outcome.decision, "hold");
  assert.equal(hold.priority, 51);
  const deny: RuleSpec = { title: "deny hermes outward", active: true, priority: 50, match: { agents: [HERMES], effects: ["outward"] }, outcome: { decision: "deny", reason: "no" } };
  const before = evaluate(order([{ id: "d", rev: 1, spec: deny, updatedAt: 1 }]), facts);
  const after = evaluate(order([{ id: "d", rev: 1, spec: deny, updatedAt: 1 }, { id: "h", rev: 1, spec: hold, updatedAt: 2 }]), facts);
  assert.equal(before.decision, "deny");
  assert.equal(after.decision, "deny", "approving the composed hold kept the existing deny");
  assert.match(priorityWhy(hold, existing), /^Priority 51: after your refuse rules \(highest priority 50\), so it never weakens them\.$/);
});

test("S3-2: deny before hold before allow; a hold with no room between an existing deny and an existing allow is not proposed", () => {
  const existing = [
    { priority: 30, decision: "deny" as const },
    { priority: 60, decision: "allow" as const },
    { priority: 40, decision: "hold" as const },
  ];
  const pl = placement(existing);
  assert.equal(pl.strict, 10);
  assert.equal(pl.hold, 31);
  assert.equal(pl.allow, 50);
  // no room: deny at 70 and allow at 60 → a hold would either weaken the deny or come after the allow
  const p = composeRules("Hold outward actions", env({ existing: [{ priority: 70, decision: "deny" }, { priority: 60, decision: "allow" }] }));
  assert.deepEqual(p.rules, []);
  assert.match(p.unmatched[0]?.hint ?? "", /no priority left/);
  // a refuse in the same situation still goes first (it is only stricter)
  const d = composeRules("Block outward actions", env({ existing: [{ priority: 70, decision: "deny" }, { priority: 60, decision: "allow" }] }));
  assert.equal(d.rules[0]?.priority, 10);
});

test("S3-2: never a tie with an existing allow at priority 0 (a later edit of the allow would put it first)", () => {
  const existing = [{ priority: 0, decision: "allow" as const }];
  for (const text of ["Block outward actions", "Hold outward actions"]) {
    const p = composeRules(text, env({ existing }));
    assert.deepEqual(p.rules, [], text);
    assert.match(p.unmatched[0]?.hint ?? "", /priority 0/, text);
  }
  // the model drafter's rules get the same places
  const spec: RuleSpec = { title: "hold sends", active: true, priority: 0, match: { effects: ["outward"] }, outcome: { decision: "hold", reason: "r" } };
  const placed = placeProposal({ rules: [spec], notes: [], unmatched: [] }, [{ priority: 50, decision: "deny" }]);
  assert.equal(placed.rules[0]?.priority, 51);
  const none = placeProposal({ rules: [spec], notes: [], unmatched: [] }, existing);
  assert.deepEqual(none.rules, []);
});
