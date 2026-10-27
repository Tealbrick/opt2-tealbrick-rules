// The owner's English rule box (C373, J3): the deterministic parser turns plain English into a PROPOSAL of structured rules.
// Every shape the lead asked for, names that are not found or are shared (never guessed), the writer check (a rule the
// writers refuse is never proposed), and the drafter interface (any drafter's proposal is vetted the same way).
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCatalog, catalogProblem } from "../src/catalog.ts";
import { ALLOW_PRIORITY, type ComposeEnv, composeRules, describeRule, parserDrafter, STRICT_PRIORITY, vetProposal } from "../src/compose.ts";
import { evaluate, order, type RuleSpec, specProblem } from "../src/engine.ts";

const HERMES = "agt_01J000000000000000000HERMES";
const CEO = "agt_01J0000000000000000000000CEO";
const cat = buildCatalog([
  {
    product: "connect",
    ops: [
      { id: "buzz_dm", title: "Send a DM", effect: "outward", audience: "agent", dynamic: false, tools: [] },
      { id: "buzz_read", title: "Read", effect: "read", audience: "agent", dynamic: false, tools: [] },
    ],
  },
  { product: "evolution", ops: [{ id: "run_step", title: "Run a step", effect: "write", audience: "agent", dynamic: false, tools: [] }] },
]);
/** The writer check the app passes (`ruleProblem` = specProblem, then the catalog), on a catalog with Connect and Evolution. */
const problem = (s: RuleSpec) => specProblem(s) || catalogProblem(s, cat);
const env = (over: Partial<ComposeEnv> = {}): ComposeEnv => ({
  agents: [
    { id: HERMES, name: "Hermes" },
    { id: CEO, name: "CEO" },
  ],
  teams: [
    { id: "tm_x", name: "Team X" },
    { id: "tm_dev", name: "Dev" },
  ],
  apps: [{ id: "connect" }, { id: "evolution" }],
  problem,
  ...over,
});
const compose = (text: string, over: Partial<ComposeEnv> = {}) => composeRules(text, env(over));

test("“Hold Hermes's outward actions” → hold {agents: [Hermes], effects: [outward]}", () => {
  for (const text of ["Hold Hermes's outward actions", "hold hermes’s outward actions.", "Hermes's sends need my approval"]) {
    const p = compose(text);
    assert.deepEqual(p.unmatched, [], text);
    assert.equal(p.rules.length, 1, text);
    const r = p.rules[0] as RuleSpec;
    assert.deepEqual(r.match, { agents: [HERMES], effects: ["outward"] }, text);
    assert.equal(r.outcome.decision, "hold");
    assert.equal(r.priority, STRICT_PRIORITY);
    assert.ok(r.outcome.reason.length <= 280 && r.outcome.reason.includes(text.replace(/\.$/, "").replace("’", "'")), r.outcome.reason);
    assert.equal(r.active, true);
  }
});

test("“Block money for all agents” → deny {effects: [money]} for any agent", () => {
  const p = compose("Block money for all agents");
  assert.deepEqual(p.unmatched, []);
  assert.deepEqual(
    p.rules.map((r) => [r.outcome.decision, r.match]),
    [["deny", { effects: ["money"] }]],
  );
});

test("“When someone from team X tags the CEO agent: only work-tagged memories, no money” → deny money + allow narrowed, both on behalf of team X", () => {
  const p = compose("When someone from team X tags the CEO agent: only work-tagged memories, no money");
  assert.deepEqual(p.unmatched, []);
  assert.equal(p.rules.length, 2);
  const [deny, allow] = p.rules as [RuleSpec, RuleSpec];
  assert.deepEqual(deny.match, { agents: [CEO], effects: ["money"], onBehalfOf: { teams: ["tm_x"] } });
  assert.equal(deny.outcome.decision, "deny");
  assert.deepEqual(allow.match, { agents: [CEO], onBehalfOf: { teams: ["tm_x"] } });
  assert.equal(allow.outcome.decision, "allow");
  assert.deepEqual(allow.narrowing, { memoryTags: { anyOf: ["work"] } });
  assert.ok(deny.priority < allow.priority, "refuse runs before the narrowing allow");
  assert.equal(allow.priority, ALLOW_PRIORITY);
  assert.ok(p.notes.some((n) => /claim/.test(n)), "C82: who asked is a claim that can only narrow");
  // The engine agrees: an unverified claim from team X → money refused, a recall narrowed to work; without the claim neither applies.
  const rules = order(p.rules.map((spec, i) => ({ id: `r${i}`, rev: 1, spec, updatedAt: 1 })));
  const facts = (effect: string, claim: boolean) => ({
    caller: { type: "agent", id: CEO, mode: "free" },
    target: { product: "knowledge", op: "memory_recall", effect },
    claim: claim ? { kind: "person" as const, id: "ct_anna" } : null,
    claimVerified: false,
    claimTeams: claim ? ["tm_x"] : [],
    claimTeamsAny: claim ? ["tm_x"] : [],
    callerTeams: [],
    callerTeamsAny: [],
    claimTrusts: [],
    claimTrustActive: true,
    fleetAvailable: true,
    callerProduct: null,
  });
  assert.equal(evaluate(rules, facts("money", true)).decision, "deny");
  assert.deepEqual(evaluate(rules, facts("read", true)).narrowing, { memoryTags: { anyOf: ["work"] } });
  assert.equal(evaluate(rules, facts("money", false)).decision, "allow");
  assert.equal(evaluate(rules, facts("read", false)).narrowing, null);
});

test("Martin's spoken J3 rule: the team must be named; named, it gives the same two rules (non-critical → noneOf critical)", () => {
  const spoken =
    "if it's tagged by the members of the team you're allowed to basically talk about work things only and about memories that are clearly tagged work, non-critical, etc. And no like money involved";
  const vague = compose(spoken);
  assert.deepEqual(vague.rules, [], "no team named: nothing is guessed");
  assert.equal(vague.unmatched.length, 2);
  assert.match(vague.unmatched[0]?.hint ?? "", /Which team\? Name it/);
  assert.match(vague.unmatched[1]?.hint ?? "", /continues the sentence before/);

  const named = compose(
    "If the members of team X tag the CEO agent, you're allowed to basically talk about work things only and about memories that are clearly tagged work, non-critical, etc. And no like money involved",
  );
  assert.deepEqual(named.unmatched, []);
  assert.deepEqual(
    named.rules.map((r) => [r.outcome.decision, r.match, r.narrowing ?? null]),
    [
      ["deny", { agents: [CEO], effects: ["money"], onBehalfOf: { teams: ["tm_x"] } }, null],
      ["allow", { agents: [CEO], onBehalfOf: { teams: ["tm_x"] } }, { memoryTags: { anyOf: ["work"], noneOf: ["critical"] } }],
    ],
  );
  assert.ok(named.notes.some((n) => /non-critical/.test(n) && /never memories tagged/.test(n)));
  assert.ok(named.notes.some((n) => /uses who from the sentence before/.test(n)));
});

test("“Agents in team Dev may not post in connect” → deny {callerTeams: [Dev], products: [connect], effects: [outward]}", () => {
  const p = compose("Agents in team Dev may not post in connect");
  assert.deepEqual(p.unmatched, []);
  assert.deepEqual(
    p.rules.map((r) => [r.outcome.decision, r.match]),
    [["deny", { products: ["connect"], effects: ["outward"], callerTeams: ["tm_dev"] }]],
  );
  // the caller's team (callerTeams) vs who asked (onBehalfOf)
  assert.deepEqual(compose("The Dev team's agents need my approval before they send").rules[0]?.match, { effects: ["outward"], callerTeams: ["tm_dev"] });
  assert.deepEqual(compose("When someone from the Dev team asks Hermes, hold sends").rules[0]?.match, { agents: [HERMES], effects: ["outward"], onBehalfOf: { teams: ["tm_dev"] } });
});

test("“Hold Evolution's outward actions” → hold {callerProducts: [evolution], effects: [outward]} (the app that makes the call)", () => {
  for (const text of ["Hold Evolution's outward actions", "Hold outward calls from the Evolution app"]) {
    const p = compose(text);
    assert.deepEqual(p.unmatched, [], text);
    assert.deepEqual(
      p.rules.map((r) => [r.outcome.decision, r.match]),
      [["hold", { callerProducts: ["evolution"], effects: ["outward"] }]],
      text,
    );
  }
  assert.equal(describeRule(compose("Hold Evolution's outward actions").rules[0] as RuleSpec, String, String), "Hold for my review: calls from app evolution with effect outward.");
  // an app does not belong to a team: the writers refuse the mix, so it is never proposed
  const mixed = compose("Agents in team Dev and Evolution's sends need my approval");
  assert.deepEqual(mixed.rules, []);
  assert.match(mixed.unmatched[0]?.hint ?? "", /callerProducts names apps, but callerTeams/);
});

test("several decisions in one text; “And …” keeps who; or-lists split; same decision merges", () => {
  const p = compose("Never let Hermes pay or delete. Also hold its posts in Connect.");
  assert.deepEqual(p.unmatched, []);
  assert.deepEqual(
    p.rules.map((r) => [r.outcome.decision, r.match]),
    [
      ["deny", { agents: [HERMES], effects: ["money", "destructive"] }],
      ["hold", { agents: [HERMES], products: ["connect"], effects: ["outward"] }],
    ],
  );
  const block = compose("Block Hermes");
  assert.deepEqual(block.rules[0]?.match, { agents: [HERMES] }, "a refusal with no action refuses every call of the agent");
});

test("unknown names are never guessed: the sentence is unmatched and close names are listed", () => {
  const typo = compose("Hold Hermez's sends");
  assert.deepEqual(typo.rules, []);
  assert.equal(typo.unmatched[0]?.hint, "No agent named “Hermez”. Close names: Hermes.");
  const none = compose("Block Zed's payments");
  assert.equal(none.unmatched[0]?.hint, "No agent named “Zed”. Your agents: Hermes, CEO.");
  const agentLess = compose("Block Zed's payments", { agents: [] });
  assert.match(agentLess.unmatched[0]?.hint ?? "", /no agents are connected yet\. Ask your agent to draft this rule\./);
  const team = compose("Agents in team Sales may not pay");
  assert.equal(team.unmatched[0]?.hint, "No team named “Sales”. Your teams: Team X, Dev.");
  assert.match(compose("Hold the Boss agent's sends").unmatched[0]?.hint ?? "", /No agent named “Boss”/);
  assert.match(compose("Block agt_01J0000000000000000000UNKNOWN").unmatched[0]?.hint ?? "", /No agent named “agt_01J0000000000000000000UNKNOWN”/);
});

test("a name two agents (or teams) share is ambiguous: no rule, a plain note", () => {
  const twins = compose("Hold Hermes's sends", {
    agents: [
      { id: HERMES, name: "Hermes" },
      { id: "agt_01J0000000000000000000TWIN", name: "hermes" },
    ],
  });
  assert.deepEqual(twins.rules, []);
  assert.match(twins.unmatched[0]?.hint ?? "", /2 agents are named “Hermes”, so Rules does not guess/);
  const teams = compose("Agents in team Dev may not pay", {
    teams: [
      { id: "tm_dev", name: "Dev" },
      { id: "tm_dev2", name: "Dev" },
    ],
  });
  assert.deepEqual(teams.rules, []);
  assert.match(teams.unmatched[0]?.hint ?? "", /2 teams are named “Dev”/);
});

test("what the parser cannot read goes to unmatched with a plain hint; a partial allow is never proposed", () => {
  assert.deepEqual(compose("Make the agents happy").unmatched, [
    { text: "Make the agents happy", hint: "Rules could not find what to do (send, pay, delete …) or a decision (hold, refuse, allow) in it. Ask your agent to draft this rule." },
  ]);
  assert.match(compose("Sends by Hermes").unmatched[0]?.hint ?? "", /Say what should happen to “sends by”: hold, refuse or allow\./);
  const partial = compose("Allow Hermes to send in Slack");
  assert.deepEqual(partial.rules, [], "“Slack” is no known app: allowing every send would be wider than the owner said");
  assert.match(partial.unmatched[0]?.hint ?? "", /could not read “slack”/);
  // a refusal that misses a word is only stricter: proposed, with a note
  const strict = compose("Block Connect sends for Hermes");
  assert.deepEqual(strict.rules[0]?.match, { agents: [HERMES], effects: ["outward"] });
  assert.ok(strict.notes.some((n) => /looks like an app/.test(n)));
});

test("the writer check: a rule the writers refuse is never proposed (the whole sentence goes to unmatched)", () => {
  const p = compose("Block money in connect");
  assert.deepEqual(p.rules, []);
  assert.match(p.unmatched[0]?.hint ?? "", /^This rule cannot be saved: app “connect” has no agent operation with effect money/);
  // without a catalog, a rule that names an app cannot be checked, so it is not proposed either
  const noCatalog = compose("Hold sends in connect", { problem: (s) => specProblem(s) || catalogProblem(s, null) });
  assert.deepEqual(noCatalog.rules, []);
  assert.match(noCatalog.unmatched[0]?.hint ?? "", /has not read the app catalog yet/);
  // every produced rule passes the check
  for (const r of compose("When someone from team X tags the CEO agent: only work-tagged memories, no money. Agents in team Dev may not post in connect").rules) assert.equal(problem(r), "");
});

test("drafters: the parser is deterministic; vetProposal checks ANY drafter's proposal the same way and caps it at 10", async () => {
  const text = "When someone from team X tags the CEO agent: only work-tagged memories, no money";
  assert.deepEqual(await parserDrafter.draft(text, env()), await parserDrafter.draft(text, env()));
  assert.equal(parserDrafter.id, "parser");
  const good: RuleSpec = { title: "ok", active: true, priority: 10, match: { effects: ["money"] }, outcome: { decision: "deny", reason: "r" } };
  const bad: RuleSpec = { ...good, title: "bad", outcome: { decision: "deny", reason: "r" }, narrowing: { memoryTags: { anyOf: ["work"] } } };
  const v = vetProposal({ rules: [bad, ...Array.from({ length: 11 }, (_, i) => ({ ...good, title: `ok ${i}` }))], notes: ["n", "n"], unmatched: [] }, problem);
  assert.equal(v.rules.length, 10);
  assert.deepEqual(v.notes, ["n"]);
  assert.deepEqual(
    v.unmatched.map((u) => u.text),
    ["bad", "ok 10"],
  );
  assert.match(v.unmatched[0]?.hint ?? "", /narrowing applies only to rules that allow/);
});

test("describeRule: one readable line per rule", () => {
  const [deny, allow] = compose("When someone from team X tags the CEO agent: only work-tagged memories, no money").rules as [RuleSpec, RuleSpec];
  const agent = (id: string) => (id === CEO ? "CEO" : id);
  const team = (id: string) => (id === "tm_x" ? "Team X" : id);
  assert.equal(describeRule(deny, agent, team), "Refuse: calls by CEO on behalf of team Team X with effect money.");
  assert.equal(describeRule(allow, agent, team), "Allow: calls by CEO on behalf of team Team X, only memories tagged work.");
});
