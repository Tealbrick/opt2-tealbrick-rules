// C373 item 5 (C236 property, extended): with the recipients UNKNOWN, the Governance facts UNAVAILABLE or the bridge caps ABSENT,
// a decision is never LESS strict, and an allow never narrowed less, than the same call with the facts KNOWN (any value they could
// have). Seeded (mulberry32), so a failing case reproduces; every default mode is drawn (the mode decides only when no rule
// matches, and a closed rule never lets the no-match path end up looser than the mode).
import assert from "node:assert/strict";
import { test } from "node:test";
import { type CallFacts, evaluate, order, type RecipientFact, type Rule, type Trust, tagsPass } from "../src/engine.ts";
import type { DefaultMode } from "../src/mode.ts";
import { AGENT_A, APP_INSTANCE, prng, spec } from "./helpers.ts";

const SEV = { allow: 0, hold: 1, deny: 2 } as const;
const TRUST: readonly Trust[] = ["unreviewed", "trusted", "limited", "blocked"];
const TEAMS = ["tm_a", "tm_b"] as const;
const WORKFLOWS = ["weekly-report", "daily-digest"] as const;
const TAGS = ["w", "p", "s"];
const SUBSETS = Array.from({ length: 8 }, (_, i) => TAGS.filter((_, b) => i & (1 << b)));
const MODES: readonly DefaultMode[] = ["permissive", "verification", "closed"];

test("PROPERTY (fuzz): unknown recipients, unavailable Governance facts and absent caps are never less strict (nor narrowed less) than any known facts", () => {
  const rnd = prng(0xc373);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const subset = <T,>(xs: readonly T[], min = 0): T[] => {
    for (;;) {
      const s = xs.filter(() => rnd() < 0.5);
      if (s.length >= min) return s;
    }
  };
  const passes = (v: ReturnType<typeof evaluate>) => SUBSETS.map((tags) => v.decision === "allow" && (!v.narrowing || tagsPass(tags, v.narrowing)));
  const recipient = (): RecipientFact => {
    const known = rnd() < 0.7;
    const teamsAny = known ? subset(TEAMS) : [];
    const allActive = rnd() < 0.8;
    return { teamsAny, teams: allActive ? teamsAny.filter(() => rnd() < 0.8) : [], trusts: known ? subset(TRUST, 1) : ["unreviewed"], allActive, known };
  };
  const CASES = 20_000;
  const seen = { recipients: 0, fleet: 0, caps: 0, stricterRecipients: 0, stricterFleet: 0, stricterCaps: 0 };
  for (let i = 0; i < CASES; i++) {
    const rules: Rule[] = [];
    for (let r = 0; r < 1 + Math.floor(rnd() * 5); r++) {
      const decision = pick(["allow", "deny", "hold"] as const);
      const match: Rule["spec"]["match"] = {};
      const kind = rnd();
      if (kind < 0.35) {
        match.effects = ["outward"];
        const c: NonNullable<typeof match.recipients> = {};
        if (rnd() < 0.5) c.teams = subset(TEAMS, 1);
        if (rnd() < 0.6) c.trust = subset(TRUST, 1);
        if (rnd() < 0.4 || (!c.teams && !c.trust)) c.known = rnd() < 0.5;
        match.recipients = c;
      } else if (kind < 0.55) match.callerTrust = subset(TRUST, 1);
      else if (kind < 0.7) match.callerTeams = subset(TEAMS, 1);
      else if (kind < 0.85) {
        match.callerProducts = ["evolution"];
        match.callerWorkflows = subset(WORKFLOWS, 1);
      } else if (rnd() < 0.5) match.effects = [pick(["outward", "read"] as const)];
      const narrowing = decision === "allow" && rnd() < 0.5 ? { memoryTags: rnd() < 0.5 ? { anyOf: subset(TAGS, 1) } : { noneOf: subset(TAGS, 1) } } : undefined;
      rules.push({ id: `rul_${r}`, rev: 1, updatedAt: 1, spec: spec({ priority: Math.floor(rnd() * 4), match, decision, reason: "r", ...(narrowing ? { narrowing } : {}) }) });
    }
    const ordered = order(rules);
    const mode = pick(MODES);
    const isApp = rnd() < 0.4;
    const product = isApp ? pick(["evolution", "evolution", "knowledge", null] as const) : null;
    const call: CallFacts = {
      caller: isApp ? { type: "app", id: APP_INSTANCE, mode: null } : { type: "agent", id: AGENT_A, mode: "free" },
      target: { product: "connect", op: "buzz_dm", effect: pick(["outward", "outward", "read"] as const) },
      claim: null,
      claimVerified: false,
      claimTeams: [],
      claimTeamsAny: [],
      callerTeams: [],
      callerTeamsAny: [],
      claimTrusts: [],
      claimTrustActive: true,
      fleetAvailable: true,
      callerProduct: product,
    };
    /** a world of KNOWN facts for this call */
    const world = (o: Partial<CallFacts> = {}): CallFacts => {
      const teamsAny = isApp ? [] : subset(TEAMS);
      return {
        ...call,
        callerTeamsAny: teamsAny,
        callerTeams: teamsAny.filter(() => rnd() < 0.8),
        callerTrusts: isApp ? [] : [pick(TRUST)],
        callerTrustActive: rnd() < 0.8,
        recipients: Array.from({ length: Math.floor(rnd() * 3) }, recipient),
        callerWorkflow: isApp && rnd() < 0.6 ? pick(WORKFLOWS) : null,
        workflowCapVisible: rnd() < 0.5,
        ...o,
      };
    };
    const where = (gap: string, a: CallFacts, b: CallFacts) => JSON.stringify({ gap, mode, rules: ordered.map((r) => [r.id, r.spec.priority, r.spec.outcome.decision, r.spec.match, r.spec.narrowing]), unknown: a, known: b });
    const notLooser = (gap: string, unknownFacts: CallFacts, knownFacts: CallFacts): boolean => {
      const u = evaluate(ordered, unknownFacts, mode);
      const k = evaluate(ordered, knownFacts, mode);
      assert.ok(SEV[u.decision] >= SEV[k.decision], `${gap}: less strict than known facts: ${where(gap, unknownFacts, knownFacts)}`);
      if (u.decision === "allow" && k.decision === "allow") {
        const pk = passes(k);
        assert.ok(passes(u).every((ok, j) => !ok || pk[j]), `${gap}: narrowed less than known facts: ${where(gap, unknownFacts, knownFacts)}`);
      }
      return SEV[u.decision] > SEV[k.decision];
    };
    for (let k = 0; k < 4; k++) {
      const known = world();
      // 1. recipients UNKNOWN (absent or recipientsIncomplete) vs any known list (incl. [])
      seen.recipients++;
      if (notLooser("recipients", { ...known, recipients: null }, known)) seen.stricterRecipients++;
      // 2. Governance UNAVAILABLE: the same call (same recipient count) with no Fleet facts, as fleetFacts() gives them
      seen.fleet++;
      const down: CallFacts = { ...known, fleetAvailable: false, callerTeams: [], callerTeamsAny: [], callerTrusts: [], callerTrustActive: true, recipients: known.recipients?.map(() => ({ teams: [], teamsAny: [], trusts: ["unreviewed"], allActive: true, known: false })) ?? null };
      if (notLooser("fleet", down, known)) seen.stricterFleet++;
      // 3. caps ABSENT: no workflow and no visible cap vs the cap visible, and vs any verified workflow
      seen.caps++;
      if (notLooser("caps", { ...known, callerWorkflow: null, workflowCapVisible: false }, known)) seen.stricterCaps++;
      // all gaps at once vs known
      notLooser("all", { ...down, recipients: null, callerWorkflow: null, workflowCapVisible: false }, known);
    }
  }
  assert.ok(seen.stricterRecipients > 2000 && seen.stricterFleet > 2000 && seen.stricterCaps > 500, `the fuzz exercised every gap: ${JSON.stringify(seen)}`);
  console.log(`fail-closed fuzz: ${CASES} rule sets, ${JSON.stringify(seen)}`);
});

test("Closed mode: a hold that applies only because the recipients are unknown never answers looser than the mode (known facts get the mode's refusal)", () => {
  const r = order([{ id: "rul_h", rev: 1, updatedAt: 1, spec: spec({ priority: 1, match: { effects: ["outward"], recipients: { known: false } }, decision: "hold", reason: "strangers wait" }) }]);
  const call: CallFacts = { caller: { type: "agent", id: AGENT_A, mode: "free" }, target: { product: "connect", op: "buzz_dm", effect: "outward" }, claim: null, claimVerified: false, claimTeams: [], claimTeamsAny: [], callerTeams: [], callerTeamsAny: [], claimTrusts: [], claimTrustActive: true, fleetAvailable: true, callerProduct: null };
  const knownFriend = { ...call, recipients: [{ teams: [], teamsAny: [], trusts: ["trusted" as const], allActive: true, known: true }] };
  assert.equal(evaluate(r, knownFriend, "closed").decision, "deny", "known recipient, no rule matches: Closed refuses");
  const unknown = evaluate(r, { ...call, recipients: null }, "closed");
  assert.deepEqual([unknown.decision, unknown.rule, unknown.byMode?.mode], ["deny", null, "closed"], "unknown: the stricter of the closed hold and the mode");
  // quiet: in Permissive and Verification the closed hold still decides (the mode is not stricter than hold)
  assert.equal(evaluate(r, { ...call, recipients: null }, "permissive").rule?.id, "rul_h");
  assert.equal(evaluate(r, { ...call, recipients: null }, "verification").rule?.id, "rul_h");
});
