// Delta D-2, English box: a composed ALLOW WITH A NARROWING ("Hermes may read, only work memories") was placed after every refuse/hold rule
// (highest + 10), which can be behind an existing broader allow: the narrowing was lost. It now goes before that allow, or has no place.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ComposeEnv, composeRules, placeProposal, priorityWhy } from "../src/compose.ts";
import { type CallFacts, evaluate, order, type Rule, type RuleSpec } from "../src/engine.ts";
import { AGENT_A as A, AGENT_B as B, spec } from "./helpers.ts";

const env = (existing: ComposeEnv["existing"]): ComposeEnv => ({ agents: [{ id: A, name: "Hermes" }, { id: B, name: "Zed" }], teams: [], apps: [], problem: () => "", existing });
const facts = (caller: string): CallFacts =>
  ({ caller: { type: "agent", id: caller, mode: "free" }, target: { product: "knowledge", op: "search", effect: "read" }, claim: null, claimVerified: false, claimTeams: [], claimTeamsAny: [], callerTeams: [], callerTeamsAny: [], claimTrusts: [], claimTrustActive: true, fleetAvailable: true, callerProduct: null, recipients: [] }) as CallFacts;
const rules = (specs: RuleSpec[]): Rule[] => order(specs.map((s, i) => ({ id: s.title, rev: 1, spec: s, updatedAt: i })));
const TEXT = "Allow Hermes to read, only work-tagged memories";
const wide = { priority: 15, decision: "allow" as const, match: { effects: ["read"] as const } };

test("D-2 compose: a narrowing allow goes before an existing broader allow that could overlap it (the default place is behind it)", () => {
  const existing = [{ priority: 40, decision: "deny" as const, match: { agents: [B] } }, { ...wide, priority: 25, match: { effects: ["read" as const] } }];
  const p = composeRules(TEXT, env(existing as never));
  assert.equal(p.unmatched.length, 0);
  const allow = p.rules[0] as RuleSpec;
  assert.deepEqual(allow.narrowing, { memoryTags: { anyOf: ["work"] } });
  // the deny is for another agent (cannot overlap), so the slot before the wide allow exists: 24
  assert.equal(allow.priority, 24);
  const live = rules([{ ...spec({ title: "wide", priority: 25, match: { effects: ["read"] }, decision: "allow" }) }, allow]);
  assert.deepEqual(evaluate(live, facts(A)).narrowing, { memoryTags: { anyOf: ["work"] } }, "the narrowing applies to Hermes");
  assert.match(priorityWhy(allow, existing as never), /before your wider allow rule, so its limits apply/);
});

test("D-2 compose: without a narrowing the allow keeps the usual place; a stricter existing allow does not move it", () => {
  const existing = [{ ...wide, priority: 25 }];
  assert.equal(composeRules("Allow Hermes to read", env(existing as never)).rules[0]?.priority, 20);
  const strict = [{ priority: 25, decision: "allow" as const, match: { effects: ["read" as const] }, narrowing: { memoryTags: { anyOf: ["work"], noneOf: ["private"] } } }];
  assert.equal(composeRules(TEXT, env(strict as never)).rules[0]?.priority, 20);
});

test("D-2 compose: an existing allow that cannot overlap (another agent) does not move it", () => {
  const existing = [{ priority: 5, decision: "allow" as const, match: { agents: [B], effects: ["read" as const] } }];
  assert.equal(composeRules(TEXT, env(existing as never)).rules[0]?.priority, 20);
});

test("D-2 compose: no slot (a refuse rule that could overlap sits at or after the wider allow) → unmatched with a plain hint, nothing proposed", () => {
  const existing = [{ priority: 50, decision: "deny" as const, match: { agents: [A] } }, { ...wide, priority: 25 }];
  const p = composeRules(TEXT, env(existing as never));
  assert.equal(p.rules.length, 0);
  assert.match(p.unmatched[0]?.hint ?? "", /before your wider allow rule/);
  // an existing entry with no match/narrowing (an older caller of `placement`) is read as strict: wide and overlapping
  const bare = [{ priority: 25, decision: "allow" as const }, { priority: 30, decision: "hold" as const }];
  assert.equal(composeRules(TEXT, env(bare)).rules.length, 0);
});

test("D-2 compose: placeProposal (the model merge) uses the same rule", () => {
  const existing = [{ ...wide, priority: 15 }] as never;
  const s = spec({ title: "reads", match: { agents: [A], effects: ["read"] }, decision: "allow", narrowing: { memoryTags: { anyOf: ["work"] } } });
  assert.equal(placeProposal({ rules: [s], notes: [], unmatched: [] }, existing).rules[0]?.priority, 14);
});
