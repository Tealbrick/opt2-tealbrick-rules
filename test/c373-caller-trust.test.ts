// Rules 0.5.0 (C373 D4b, RULES-INTERFACE §4): `match.callerTrust` = the CALLING agent's trust from the Governance feed
// (agents[].trust, key agent:<id>). Fail closed like callerTeams; an app caller never matches; an unknown agent is unreviewed.
// Every check has a quiet-on-good and a fire-on-bad case with exact outcomes (L27, L34).
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Json } from "@opt2-tealbrick/miniapp-sdk";
import { manifest } from "../src/app.ts";
import { type CallFacts, evaluate, explain, NEEDS_FLEET, order, type Rule, specProblem, strictestNarrowing } from "../src/engine.ts";
import { parseFeed } from "../src/fleet.ts";
import { makeHooks } from "../src/hooks.ts";
import { listDecisions, saveRule, writeFleet } from "../src/store.ts";
import { matchText } from "../src/ui/api.ts";
import { AGENT_A, AGENT_B, AGENT_R, APP_INSTANCE, feed, hookCtx, hookReq, migratedDb, OWNER, spec } from "./helpers.ts";

const AGENT_L = "agt_01J0000000000000000000000C";
const AGENT_U = "agt_01J0000000000000000000000D";
const rule = (id: string, s: Rule["spec"]): Rule => ({ id, rev: 1, spec: s, updatedAt: 1 });
const base: CallFacts = {
  caller: { type: "agent", id: AGENT_A, mode: "free" },
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
  callerProduct: null,
};
const agent = (callerTrusts: CallFacts["callerTrusts"], o: Partial<CallFacts> = {}): CallFacts => ({ ...base, callerTrusts, ...o });
const app = (o: Partial<CallFacts> = {}): CallFacts => ({ ...base, caller: { type: "app", id: APP_INSTANCE, mode: null }, callerProduct: "evolution", callerTrusts: [], ...o });
const one = (decision: "allow" | "deny" | "hold", callerTrust: Rule["spec"]["match"]["callerTrust"], extra: Partial<Rule["spec"]> = {}) =>
  order([rule("rul_t", spec({ priority: 10, match: { callerTrust }, decision, reason: `${decision} by trust`, ...extra }))]);
const out = (v: ReturnType<typeof evaluate>) => [v.decision, v.rule?.id ?? null, v.closedOnFleet] as const;

test("deny and hold: the rule matches when the calling agent's trust is listed; another trust passes (R-D4b)", () => {
  for (const decision of ["deny", "hold"] as const) {
    const r = one(decision, ["limited"]);
    assert.deepEqual(out(evaluate(r, agent(["limited"]))), [decision, "rul_t", false], `${decision}: limited agent`);
    assert.deepEqual(out(evaluate(r, agent(["trusted"]))), ["allow", null, false], `${decision}: trusted agent passes`);
    assert.deepEqual(explain(r, agent(["trusted"]))[0]?.why, "caller's trust is not listed");
  }
});

test("allow: every holder active and listed; a blocked or removed agent never matches; an unknown agent is unreviewed", () => {
  const r = one("allow", ["trusted"], { narrowing: { memoryTags: { anyOf: ["work"] } } });
  assert.deepEqual(evaluate(r, agent(["trusted"])).narrowing, { memoryTags: { anyOf: ["work"] } }, "quiet: a trusted active agent gets the allow");
  assert.equal(evaluate(r, agent(["trusted"], { callerTrustActive: false })).rule, null, "fire: an inactive agent never satisfies an allow by trust");
  assert.equal(evaluate(r, agent(["unreviewed"])).rule, null);
  // absent trust facts on an agent = unknown agent = unreviewed
  assert.equal(evaluate(one("hold", ["unreviewed"]), agent(undefined)).decision, "hold");
  assert.equal(evaluate(one("allow", ["unreviewed"]), agent(undefined)).decision, "allow");
});

test("an APP caller never matches a callerTrust rule (deny, hold, allow), also while Governance is unavailable", () => {
  for (const decision of ["deny", "hold", "allow"] as const) {
    const r = one(decision, ["unreviewed", "trusted", "limited", "blocked"]);
    for (const f of [app(), app({ fleetAvailable: false }), app({ callerTrusts: ["blocked"] })]) assert.deepEqual(out(evaluate(r, f)), ["allow", null, false], `${decision}: app`);
    assert.equal(explain(r, app())[0]?.why, "caller is not an agent");
    // fire: an agent with that trust does match
    assert.equal(evaluate(r, agent(["blocked"], { callerTrustActive: false })).rule?.id ?? null, decision === "allow" ? null : "rul_t", "a blocked agent: deny/hold match, allow never (inactive)");
  }
  assert.equal(strictestNarrowing(one("allow", ["trusted"], { narrowing: { memoryTags: { anyOf: ["w"] } } }), app()), null, "no narrowing of a callerTrust rule for an app");
});

test("Governance unavailable (C236 strict path): deny and hold apply and are flagged, allow is skipped with its narrowing kept", () => {
  const down = agent([], { fleetAvailable: false });
  assert.deepEqual(out(evaluate(one("deny", ["blocked"]), down)), ["deny", "rul_t", true]);
  assert.deepEqual(out(evaluate(one("hold", ["limited"]), down)), ["hold", "rul_t", true]);
  const allow = one("allow", ["trusted"], { narrowing: { memoryTags: { anyOf: ["work"] } } });
  const v = evaluate(allow, down);
  assert.deepEqual([v.decision, v.rule, v.narrowing, v.closedOnFleet], ["allow", null, { memoryTags: { anyOf: ["work"] } }, true]);
  assert.equal(explain(allow, down)[0]?.why, NEEDS_FLEET);
  assert.match(String(explain(one("deny", ["blocked"]), down)[0]?.why), /Fleet facts are unavailable, so this rule applies/);
});

test("gate: the feed's agent trust reaches the decision; the trace is flagged when Governance is unavailable", async () => {
  const { db } = migratedDb();
  const f = feed();
  (f.agents as Json[]).push({ id: AGENT_L, status: "active", trust: "limited", owner: null });
  writeFleet(db, parseFeed(f).model, { revision: 7, error: null });
  saveRule(db, { spec: spec({ title: "limited agents wait", priority: 10, match: { effects: ["outward"], callerTrust: ["limited"] }, decision: "hold", reason: "limited agents need review" }), actor: OWNER });
  saveRule(db, { spec: spec({ title: "unknown agents refused", priority: 20, match: { effects: ["outward"], callerTrust: ["unreviewed"] }, decision: "deny", reason: "unreviewed" }), actor: OWNER });
  const hooks = makeHooks("rules", { holdSupported: true });
  const gate = (caller: string, callId: string) => (hooks.rules_gate as unknown as (...a: unknown[]) => Promise<Record<string, any>>)(hookReq("before", { caller, callId }), hookCtx(db));
  assert.equal((await gate(AGENT_L, "cal_l")).hold?.family, "policy", "fire: the limited agent is held (R-D4b)");
  assert.deepEqual(await gate(AGENT_A, "cal_a"), { allow: true }, "quiet: the trusted agent passes");
  assert.equal((await gate(AGENT_B, "cal_b")).allow, false, "AGENT_B is unreviewed in the feed");
  assert.equal((await gate(AGENT_U, "cal_u")).allow, false, "an agent the feed does not list is unreviewed");
  assert.deepEqual(await gate(AGENT_R, "cal_r"), { allow: true }, "the removed agent is blocked: no rule lists blocked");
  // Governance gone: both rules apply strictly; the first (hold) is overtaken by the later deny (severity order)
  writeFleet(db, { teams: [], trust: new Map() }, { revision: null, error: "refused" });
  const down = await gate(AGENT_A, "cal_down");
  assert.equal(down.allow, false);
  assert.equal(down.hold, undefined, "the later closed deny beats the earlier closed hold");
  assert.deepEqual(listDecisions(db, { callId: "cal_down", limit: 1 }).items[0]?.detail, { fleetUnavailable: true });
});

test("writers: callerTrust is refused when it repeats a value, names no trust, or can never match (apps); good shapes pass", () => {
  const p = (match: Rule["spec"]["match"]) => specProblem(spec({ match }));
  assert.equal(p({ callerTrust: ["limited", "blocked"] }), "", "quiet on good");
  assert.equal(p({ callerTrust: ["limited"], agents: [AGENT_A] }), "");
  assert.equal(p({ callerTrust: ["limited", "limited"] }), "callerTrust lists “limited” twice");
  assert.equal(p({ callerTrust: ["nice" as never] }), "callerTrust values are unreviewed, trusted, limited or blocked");
  assert.match(p({ callerTrust: ["limited"], callerProducts: ["evolution"] }), /callerTrust is the trust of a calling agent \(an app has none\)/);
  assert.match(p({ callerTrust: ["limited"], agents: [APP_INSTANCE] }), /agents lists only apps/);
});

test("manifest: every rule-shaped schema takes callerTrust (enum, unique, at most 4); rules_preview answers callerTrust", () => {
  const good = { title: "t", active: true, priority: 1, match: { callerTrust: ["limited"] }, outcome: { decision: "hold", reason: "r" } };
  for (const [id, path] of [["rules_set", "rule"], ["rule_draft_submit", "rules"], ["rules_preview", "candidate"]] as const) {
    const input = manifest.operations.find((o) => o.id === id)?.input as Parameters<typeof validateAgainstSchema>[0];
    const wrap = (r: unknown) => (id === "rule_draft_submit" ? { text: "x", rules: [r] } : id === "rules_preview" ? { call: { caller: { type: "agent", id: AGENT_A }, target: { product: "connect", op: "buzz_dm", effect: "outward" } }, candidate: r } : { rule: r });
    assert.equal(validateAgainstSchema(input, wrap(good) as unknown as Json).ok, true, `${id} ${path}`);
    for (const bad of [["nice"], ["limited", "limited"], "limited"]) assert.equal(validateAgainstSchema(input, wrap({ ...good, match: { callerTrust: bad } }) as unknown as Json).ok, false, `${id}: ${JSON.stringify(bad)}`);
  }
  const out = manifest.operations.find((o) => o.id === "rules_preview")?.output as unknown as { required: string[] };
  assert.ok(out.required.includes("callerTrust"));
});

test("rule list text names the calling agent's trust", () => {
  assert.equal(matchText(spec({ match: { effects: ["outward"], callerTrust: ["limited", "unreviewed"] } }), (t) => t, (a) => a), "effects outward; calling agent's trust limited, unreviewed");
});
