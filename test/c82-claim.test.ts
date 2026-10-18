// C82 (claims only narrow) under unavailable Fleet facts (C236, C266): an UNVERIFIED on-behalf-of claim never makes a
// decision less strict than the same call without the claim. Before 0.3.1 a claim rule that matched ended the scan early,
// so an earlier closed hold decided where the scan without the claim reached a later deny (review S1). Quiet-on-good and
// fire-on-bad in every test.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Json } from "@opt2-tealbrick/miniapp-sdk";
import { type CallFacts, evaluate, order, type Rule, TRUSTS, type Trust, tagsPass } from "../src/engine.ts";
import { makeHooks } from "../src/hooks.ts";
import { listDecisions, saveRule } from "../src/store.ts";
import { AGENT_A, hookCtx, hookReq, migratedDb, OWNER, spec, trustFacts } from "./helpers.ts";

const hooks = makeHooks("rules");
const call = (id: string, ...args: unknown[]) => (hooks[id] as unknown as (...a: unknown[]) => Promise<Record<string, any>>)(...args);
const rule = (id: string, s: Rule["spec"]): Rule => ({ id, rev: 1, spec: s, updatedAt: 1 });
const SEV = { allow: 0, hold: 1, deny: 2 } as const;
const facts = (o: Partial<CallFacts> & { claimTrust?: Trust | null } = {}): CallFacts => ({
  caller: { type: "agent", id: AGENT_A, mode: "free" },
  target: { product: "connect", op: "buzz_dm", effect: "outward" },
  claim: null,
  claimVerified: false,
  claimTeams: [],
  claimTeamsAny: [],
  callerTeams: [],
  callerTeamsAny: [],
  fleetAvailable: true,
  ...o,
  ...trustFacts(o),
});

// hold on a team (closed while the facts are unavailable), then allow by claim kind, then deny all
const RULES = order([
  rule("rul_h", spec({ priority: 1, match: { callerTeams: ["tm_x"] }, decision: "hold", reason: "hold X" })),
  rule("rul_c", spec({ priority: 2, match: { onBehalfOf: { kinds: ["person"] } }, decision: "allow", reason: "claim ok" })),
  rule("rul_d", spec({ priority: 3, match: {}, decision: "deny", reason: "deny all" })),
]);
const PERSON = { kind: "person" as const, id: "ctc_1" };

test("engine: an unverified claim never turns the deny into the earlier closed hold (facts unavailable)", () => {
  const pick = (f: CallFacts) => {
    const v = evaluate(RULES, f);
    return [v.decision, v.rule?.id ?? null];
  };
  // fire-on-bad: before the fix the unverified claim gave hold rul_h
  assert.deepEqual(pick(facts({ fleetAvailable: false, claim: PERSON })), ["deny", "rul_d"]);
  assert.deepEqual(pick(facts({ fleetAvailable: false })), ["deny", "rul_d"], "no claim: the deny");
  assert.deepEqual(pick(facts({ claim: PERSON })), ["deny", "rul_d"], "facts available, unverified claim: the deny");
  // quiet-on-good: a VERIFIED claim may widen (C82 limits only unverified claims)
  assert.deepEqual(pick(facts({ claim: PERSON, claimVerified: true })), ["allow", "rul_c"]);
  assert.deepEqual(pick(facts({ fleetAvailable: false, claim: PERSON, claimVerified: true })), ["hold", "rul_h"], "verified claim, facts unavailable: the closed hold still applies");
});

test("gate: an unverified claim never weakens deny to hold while the Fleet facts were never read", async () => {
  const { db } = migratedDb();
  for (const r of RULES) saveRule(db, { spec: r.spec, actor: OWNER });
  const claim = (verified: boolean) => ({ "tb.onBehalfOf": { claim: PERSON, verified } }) as Record<string, Json>;
  const gate = (callId: string, context: Record<string, Json>) => call("rules_gate", hookReq("before", { callId, context }), hookCtx(db));
  const a = await gate("cal_01J0000000000000000000NOCL", {});
  const b = await gate("cal_01J0000000000000000000UNVR", claim(false));
  const c = await gate("cal_01J0000000000000000000VERI", claim(true));
  const dec = Object.fromEntries(listDecisions(db, { limit: 10 }).items.map((d) => [d.callId, d.decision]));
  assert.equal(dec["cal_01J0000000000000000000NOCL"], "deny");
  assert.equal(dec["cal_01J0000000000000000000UNVR"], "deny", "fire-on-bad: was hold before the fix");
  assert.equal(dec["cal_01J0000000000000000000VERI"], "hold", "quiet-on-good: a verified claim reaches the closed hold");
  assert.notEqual(a.allow, true);
  assert.notEqual(b.allow, true);
  assert.notEqual(c.allow, true);
});

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("PROPERTY (fuzz): an unverified claim is never less strict than no claim, with and without the Fleet facts (narrowing included)", () => {
  const rnd = prng(0xc082);
  const pickOne = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const subset = <T,>(xs: readonly T[], min = 0): T[] => {
    for (;;) {
      const s = xs.filter(() => rnd() < 0.5);
      if (s.length >= min) return s;
    }
  };
  const TAGS = ["w", "p", "s"];
  const subsets = Array.from({ length: 8 }, (_, i) => TAGS.filter((_, b) => i & (1 << b)));
  const passes = (v: ReturnType<typeof evaluate>) => subsets.map((tags) => (v.decision !== "allow" ? false : v.narrowing ? tagsPass(tags, v.narrowing) : true));
  const CASES = 40_000;
  let stricter = 0;
  let claimRuleDecided = 0;
  let identical = 0;
  let secondPassStricter = 0;
  for (let i = 0; i < CASES; i++) {
    const rules: Rule[] = [];
    // the S1 shape (closed hold on a team, then an allow by claim, then a deny) in 10% of the cases, with the facts
    // unavailable, so the bug path is always exercised (review of #15: random sets alone hit it about 7 times in 40 000)
    const s1Shape = rnd() < 0.1;
    if (s1Shape) {
      rules.push(rule("rul_sh", spec({ priority: 0, match: { callerTeams: ["a"] }, decision: "hold", reason: "r" })));
      rules.push(rule("rul_sc", spec({ priority: 1, match: { onBehalfOf: { kinds: ["person", "channel_sender"] } }, decision: "allow", reason: "r" })));
      rules.push(rule("rul_sd", spec({ priority: 3, match: {}, decision: "deny", reason: "r" })));
    }
    for (let r = 0; r < 1 + Math.floor(rnd() * 6); r++) {
      const decision = pickOne(["allow", "deny", "hold"] as const);
      const match: Record<string, unknown> = {};
      if (rnd() < 0.4) match.effects = [pickOne(["outward", "read"])];
      if (rnd() < 0.4) match.callerTeams = subset(["a", "b"], 1);
      const obo: Record<string, unknown> = {};
      // claim rules by kind or id ALONE (no Fleet fact) are the ones that end the scan early
      if (rnd() < 0.35) obo.kinds = [pickOne(["person", "channel_sender"])];
      if (rnd() < 0.15) obo.ids = [pickOne(["ctc_1", "slack:U123"])];
      if (rnd() < 0.2) obo.teams = subset(["a", "b"], 1);
      if (rnd() < 0.2) obo.trust = subset(TRUSTS, 1);
      if (Object.keys(obo).length) match.onBehalfOf = obo;
      const narrowing = decision === "allow" && rnd() < 0.5 ? { memoryTags: rnd() < 0.5 ? { anyOf: subset(TAGS, 1) } : { noneOf: subset(TAGS, 1) } } : undefined;
      rules.push(rule(`rul_${r}`, spec({ priority: Math.floor(rnd() * 4), match: match as never, decision, reason: "r", ...(narrowing ? { narrowing } : {}) })));
    }
    const ordered = order(rules);
    const claim = pickOne([
      { kind: "person", id: "ctc_1" },
      { kind: "channel_sender", id: "slack:U123" },
    ] as const);
    const callerTeams = subset(["a", "b"]);
    const claimTeams = subset(["a", "b"]);
    const common = {
      target: { product: "connect", op: "buzz_dm", effect: pickOne(["outward", "read"]) },
      fleetAvailable: !s1Shape && rnd() < 0.5,
      callerTeams,
      callerTeamsAny: [...new Set([...callerTeams, ...subset(["a", "b"])])],
    };
    const none = facts(common);
    const unverified = facts({
      ...common,
      claim,
      claimVerified: false,
      claimTeams,
      claimTeamsAny: [...new Set([...claimTeams, ...subset(["a", "b"])])],
      claimTrusts: subset(TRUSTS, 1),
      claimTrustActive: rnd() < 0.7,
    });
    const a = evaluate(ordered, none);
    const b = evaluate(ordered, unverified);
    const where = JSON.stringify({ rules: ordered.map((r) => [r.id, r.spec.priority, r.spec.outcome.decision, r.spec.match, r.spec.narrowing]), unverified, a: [a.decision, a.rule?.id, a.narrowing], b: [b.decision, b.rule?.id, b.narrowing] });
    assert.ok(SEV[b.decision] >= SEV[a.decision], `an unverified claim must not be less strict than no claim: ${where}`);
    if (SEV[b.decision] > SEV[a.decision]) stricter++;
    if (b.viaClaim) claimRuleDecided++;
    // the claim pass alone (a verified claim decides by it): the second pass made the result stricter although the
    // claim pass was not decided by a claim rule = the S1 path that 0.3.0 skipped
    const claimPass = evaluate(ordered, { ...unverified, claimVerified: true });
    if (!claimPass.viaClaim && SEV[b.decision] > SEV[claimPass.decision]) secondPassStricter++;
    if (a.decision === "allow" && b.decision === "allow") {
      const pa = passes(a);
      const pb = passes(b);
      assert.ok(pb.every((ok, k) => !ok || pa[k]), `narrowing with an unverified claim must pass a subset of what passes without it: ${where}`);
    }
    // quiet-on-good: no rule names the claim → the claim changes nothing
    if (!ordered.some((r) => r.spec.match.onBehalfOf !== undefined)) {
      identical++;
      assert.deepEqual([b.decision, b.rule?.id, b.narrowing], [a.decision, a.rule?.id, a.narrowing], `no claim criterion: identical: ${where}`);
    }
  }
  assert.ok(stricter > 500 && claimRuleDecided > 500 && identical > 500 && secondPassStricter > 100, `the fuzz exercised every side (stricter ${stricter}, claim rule decided ${claimRuleDecided}, identical ${identical}, S1 path ${secondPassStricter})`);
});
