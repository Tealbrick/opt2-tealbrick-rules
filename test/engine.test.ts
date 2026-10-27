// Engine semantics: first match by priority, no match = allow, criteria (incl. Free vs Bound), the onBehalfOf
// "narrow only" rule, narrowing merge, redaction pointers, handle format, and the time budget at scale.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { type CallFacts, evaluate, explain, handleOf, mergeNarrowing, NO_MATCH_REASON, order, type Rule, redactionsFor, specProblem, type Trust } from "../src/engine.ts";
import { gateAnswer } from "../src/hooks.ts";
import { AGENT_A, AGENT_B, cpuNowMs, NPUB, spec, trustFacts, WALL_CEILING_MS } from "./helpers.ts";

const rule = (id: string, s: Rule["spec"], updatedAt = 1): Rule => ({ id, rev: 1, spec: s, updatedAt });
const facts = (o: Partial<Omit<CallFacts, "caller" | "target">> & { claimTrust?: Trust | null; effect?: string; product?: string; op?: string; mode?: string | null; caller?: string; callerType?: string } = {}): CallFacts => ({
  caller: { type: o.callerType ?? "agent", id: o.caller ?? AGENT_A, mode: o.mode === undefined ? "free" : o.mode },
  target: { product: o.product ?? "connect", op: o.op ?? "buzz_dm", effect: o.effect ?? "outward" },
  claim: o.claim ?? null,
  claimVerified: o.claimVerified ?? false,
  claimTeams: o.claimTeams ?? [],
  claimTeamsAny: o.claimTeamsAny ?? o.claimTeams ?? [],
  callerTeams: o.callerTeams ?? [],
  callerTeamsAny: o.callerTeamsAny ?? o.callerTeams ?? [],
  ...trustFacts(o),
  fleetAvailable: o.fleetAvailable ?? true,
  callerProduct: o.callerProduct ?? null,
});

test("no rule matches → allow with the default reason (C84)", () => {
  const v = evaluate([], facts());
  assert.equal(v.decision, "allow");
  assert.equal(v.reason, NO_MATCH_REASON);
  assert.equal(v.rule, null);
});

test("first match by priority; ties → newest update; inactive rules never match", () => {
  const rules = order([
    rule("rul_low", spec({ priority: 200, decision: "allow", reason: "low" })),
    rule("rul_old", spec({ priority: 10, decision: "deny", reason: "old" }), 1),
    rule("rul_new", spec({ priority: 10, decision: "hold", reason: "new" }), 2),
    rule("rul_off", spec({ priority: 0, active: false, decision: "allow", reason: "off" })),
  ]);
  const v = evaluate(rules, facts());
  assert.equal(v.rule?.id, "rul_new");
  assert.equal(v.decision, "hold");
  assert.deepEqual(
    explain(rules, facts()).map((s) => [s.ruleId, s.matched]),
    [
      ["rul_off", false],
      ["rul_new", true],
      ["rul_old", true],
      ["rul_low", true],
    ],
  );
});

test("criteria: caller, mode (Free vs Bound), product, operation, effect", () => {
  const rules = order([
    rule("rul_bound", spec({ priority: 1, match: { modes: ["bound"] }, decision: "deny", reason: "bound agents may not send" })),
    rule("rul_b", spec({ priority: 2, match: { agents: [AGENT_B] }, decision: "deny", reason: "agent B is muted" })),
    rule("rul_money", spec({ priority: 3, match: { effects: ["money"] }, decision: "hold", reason: "money needs review" })),
    rule("rul_op", spec({ priority: 4, match: { products: ["knowledge"], operations: ["memory_delete"] }, decision: "deny", reason: "no deletes" })),
  ]);
  assert.equal(evaluate(rules, facts({ mode: "bound" })).rule?.id, "rul_bound");
  assert.equal(evaluate(rules, facts({ mode: "free" })).decision, "allow", "Free caller, outward, not B → no rule");
  assert.equal(evaluate(rules, facts({ caller: AGENT_B })).rule?.id, "rul_b");
  assert.equal(evaluate(rules, facts({ effect: "money" })).rule?.id, "rul_money");
  assert.equal(evaluate(rules, facts({ product: "knowledge", op: "memory_delete", effect: "destructive" })).rule?.id, "rul_op");
  assert.equal(evaluate(rules, facts({ product: "knowledge", op: "memory_recall", effect: "read" })).decision, "allow");
  assert.equal(evaluate(rules, facts({ mode: null })).decision, "allow", "an app caller has no mode: a mode rule does not match it");
});

// J3: "when tagged by team X: only work topics, only work-tagged memories, nothing with money"
const TEAM = "tm_sales";
const j3 = order([
  rule("rul_money", spec({ title: "Team X: nothing with money", priority: 10, match: { effects: ["money"], onBehalfOf: { teams: [TEAM] } }, decision: "deny", reason: "Requests from team X may not involve money" })),
  rule(
    "rul_work",
    spec({
      title: "Team X: work only",
      priority: 20,
      match: { onBehalfOf: { teams: [TEAM] } },
      decision: "allow",
      reason: "Requests from team X see only work memories",
      narrowing: { memoryTags: { anyOf: ["work"], noneOf: ["critical"] } },
    }),
  ),
]);
const tagged = { claim: { kind: "channel_sender" as const, id: "slack:U123" }, claimTeams: [TEAM] };

test("J3 dynamic rule: money → deny with reason; knowledge read → allow narrowed to work tags; no claim → untouched", () => {
  const money = evaluate(j3, facts({ effect: "money", product: "connect", op: "pay", ...tagged }));
  assert.equal(money.decision, "deny");
  assert.match(money.reason, /money/);
  const read = evaluate(j3, facts({ effect: "read", product: "knowledge", op: "memory_recall", ...tagged }));
  assert.equal(read.decision, "allow");
  assert.deepEqual(read.narrowing, { memoryTags: { anyOf: ["work"], noneOf: ["critical"] } });
  assert.equal(read.rule?.id, "rul_work");
  const untagged = evaluate(j3, facts({ effect: "money" }));
  assert.equal(untagged.decision, "allow");
  assert.equal(untagged.narrowing, null);
  const otherTeam = evaluate(j3, facts({ effect: "money", claim: tagged.claim, claimTeams: ["tm_other"] }));
  assert.equal(otherTeam.decision, "allow");
});

test("an unverified claim only narrows: it never turns a deny into an allow", () => {
  const rules = order([
    rule("rul_vip", spec({ priority: 1, match: { onBehalfOf: { ids: ["slack:UVIP"] } }, decision: "allow", reason: "VIP may do anything" })),
    rule("rul_base", spec({ priority: 50, match: { effects: ["outward"] }, decision: "deny", reason: "no outward sends" })),
  ]);
  const claimed = facts({ claim: { kind: "channel_sender", id: "slack:uvip" } });
  const v = evaluate(rules, claimed);
  assert.equal(v.decision, "deny", "the claim-dependent allow loses to the base deny");
  assert.equal(v.rule?.id, "rul_base");
  // A verified claim (pluggable attestation, later) is honoured as written.
  assert.equal(evaluate(rules, { ...claimed, claimVerified: true }).decision, "allow");
  // Narrowing from the claim rule and the base rule merge: anyOf intersect, noneOf unite.
  const both = order([
    rule("rul_c", spec({ priority: 1, match: { onBehalfOf: { kinds: ["person"] } }, decision: "allow", reason: "people", narrowing: { memoryTags: { anyOf: ["work", "ops"] } } })),
    rule("rul_d", spec({ priority: 2, decision: "allow", reason: "all", narrowing: { memoryTags: { anyOf: ["work"], noneOf: ["secret"] } } })),
  ]);
  const n = evaluate(both, facts({ claim: { kind: "person", id: "psn_1" } }));
  assert.deepEqual(n.narrowing, { memoryTags: { anyOf: ["work"], noneOf: ["secret"] } });
});

test("mergeNarrowing and spec checks", () => {
  assert.deepEqual(mergeNarrowing({ memoryTags: { anyOf: ["a", "b"] } }, { memoryTags: { anyOf: ["c"] } }), { memoryTags: { anyOf: [] } }, "disjoint anyOf → nothing passes");
  assert.equal(specProblem(spec({ decision: "deny", narrowing: { memoryTags: { anyOf: ["x"] } } })), "narrowing applies only to rules that allow");
  assert.match(specProblem(spec({ match: { operations: ["x_y"] } })), /operations need products/);
  assert.equal(specProblem(spec({ decision: "allow", narrowing: { memoryTags: {} } })), "narrowing.memoryTags needs anyOf or noneOf");
  assert.equal(specProblem(spec({})), "");
  // C115 writer strict: an owner-written empty anyOf would hide every memory.
  assert.equal(specProblem(spec({ decision: "allow", narrowing: { memoryTags: { anyOf: [] } } })), "narrowing.memoryTags.anyOf needs at least one tag");
  assert.equal(specProblem(spec({ decision: "allow", narrowing: { memoryTags: { anyOf: ["  "], noneOf: ["x"] } } })), "narrowing.memoryTags.anyOf needs at least one tag");
  assert.equal(specProblem(spec({ decision: "allow", narrowing: { memoryTags: { anyOf: ["work"] } } })), "");
  // Merge compares after the shared normalizeTag (SDK-API §18.1).
  assert.deepEqual(mergeNarrowing({ memoryTags: { anyOf: ["Work", "ops"] } }, { memoryTags: { anyOf: [" work"], noneOf: ["Secret"] } }), { memoryTags: { anyOf: ["work"], noneOf: ["secret"] } });
});

test("G5 shared comparison (manifest tagsMatch): case-insensitive, and a merged empty anyOf redacts every tagged item (C115)", () => {
  const out = { results: [{ id: 1, tags: ["WORK"] }, { id: 2, tags: [" Personal "] }, { id: 3, tags: [] }] };
  assert.deepEqual(redactionsFor(out, { memoryTags: { anyOf: ["work"] } }), ["/results/2", "/results/1"]);
  assert.deepEqual(redactionsFor(out, { memoryTags: { noneOf: ["personal"] } }), ["/results/1"]);
  const disjoint = mergeNarrowing({ memoryTags: { anyOf: ["a"] } }, { memoryTags: { anyOf: ["b"] } });
  assert.deepEqual(disjoint, { memoryTags: { anyOf: [] } });
  assert.deepEqual(redactionsFor(out, disjoint as never), ["/results/2", "/results/1", "/results/0"], "anyOf [] = nothing passes");
});

test("gate answers: hold needs spec 0.1.13, otherwise it is refused with the reason (fail closed)", () => {
  const hold = evaluate([rule("rul_h", spec({ decision: "hold", reason: "owner reviews payments" }))], facts());
  const off = gateAnswer(hold, false);
  assert.equal(off.answered, "deny");
  assert.equal(off.answer.allow, false);
  assert.match((off.answer as { reason: string }).reason, /owner reviews payments.*refused/);
  const on = gateAnswer(hold, true);
  assert.equal(on.answered, "hold");
  assert.deepEqual((on.answer as { hold: { family: string } }).hold.family, "policy");
  const long = gateAnswer(evaluate([rule("rul_l", spec({ reason: "x".repeat(280) }))], facts()), false);
  assert.ok((long.answer as { reason: string }).reason.length <= 280);
});

test("redactions: objects whose tags fail the narrowing, JSON-pointer escaped, last first", () => {
  const out = { results: [{ id: 1, tags: ["work"] }, { id: 2, tags: ["private"] }, { id: 3, tags: ["work", "critical"] }], "a/b": { tags: [] } };
  const n = { memoryTags: { anyOf: ["work"], noneOf: ["critical"] } };
  assert.deepEqual(redactionsFor(out, n), ["/a~1b", "/results/2", "/results/1"]);
  assert.deepEqual(redactionsFor({ tags: ["private"] }, n), [], "the root itself is never redacted (output stays an object)");
  const huge = { items: Array.from({ length: 30_000 }, (_, i) => ({ i })) };
  assert.throws(() => redactionsFor(huge, n), /too large/);
});

test("handle format is the ONE shared normalizeHandle (G-4): bare npub = buzz, slack upper case, an invalid id has no handle", () => {
  assert.equal(handleOf(NPUB.slice(5)), NPUB, "bare npub");
  assert.equal(handleOf(NPUB), NPUB);
  assert.equal(handleOf("slack:u123"), "slack:U123");
  assert.equal(handleOf("telegram:42"), "telegram:42");
  assert.equal(handleOf("npub1ABC"), null, "bad checksum: null, never the raw input");
  assert.equal(handleOf("psn_1"), null);
});

test("budget: 500 rules evaluate far below the 2 s hook limit (no model call, no I/O)", () => {
  const many = order(
    Array.from({ length: 500 }, (_, i) =>
      rule(`rul_${String(i).padStart(4, "0")}`, spec({ priority: i, match: { products: [`p${i}`], effects: ["outward"], onBehalfOf: { teams: [`t${i}`] } }, decision: "deny" })),
    ),
  );
  const f = facts({ claim: { kind: "person", id: "psn_x" }, claimTeams: ["t499"], product: "p499" });
  let worst = 0;
  let worstCpu = 0;
  const wall: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const t0 = performance.now();
    const c0 = cpuNowMs();
    evaluate(many, f);
    worstCpu = Math.max(worstCpu, cpuNowMs() - c0);
    wall.push(performance.now() - t0);
    worst = Math.max(worst, wall[wall.length - 1] as number);
  }
  // the median is immune to preemption and GC pauses: measured about 0.02 ms, ceiling 1 ms (an O(n^2) slip is ~10 ms)
  const median = wall.sort((x, y) => x - y)[wall.length >> 1] as number;
  assert.ok(median < 1, `median evaluation ${median.toFixed(3)} ms`);
  assert.equal(evaluate(many, f).rule?.id, "rul_0499");
  // ceilings (T-1): CPU worst measured 1 to 4 ms at load 9 to 12 (2026-10-18), ceiling 25 ms leaves room for one GC sweep; wall clock only loose (see cpuNowMs)
  assert.ok(worstCpu < 25, `worst evaluation CPU ${worstCpu.toFixed(2)} ms`);
  assert.ok(worst < WALL_CEILING_MS, `worst evaluation wall clock ${worst.toFixed(2)} ms`);
});
