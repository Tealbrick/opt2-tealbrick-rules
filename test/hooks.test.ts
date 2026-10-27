// Hook handlers on a migrated database: decisions and traces, fail-closed paths (budget, abort, store failure),
// rules.narrowing v1 from an onBehalfOf claim resolved through the Fleet read model, after-hook redactions.
import assert from "node:assert/strict";
import { test } from "node:test";
import { hookResponseProblem, reduceBeforeChain } from "@opt2-tealbrick/manifest";
import type { Json } from "@opt2-tealbrick/miniapp-sdk";
import type { RuleSpec } from "../src/engine.ts";
import { syncFleet } from "../src/fleet.ts";
import { FAIL_CLOSED, GATE_BUDGET_MS, HOLD_SUPPORTED, makeHooks } from "../src/hooks.ts";
import { fleetFacts, fleetIndex, fleetState, fleetTeams, listDecisions, liveRules, saveRule, writeFleet } from "../src/store.ts";
import { AGENT_A, AGENT_B, feed, hookCtx, hookReq, migratedDb, OWNER, spec } from "./helpers.ts";

const hooks = makeHooks("rules");
const call = (id: string, ...args: unknown[]) => (hooks[id] as unknown as (...a: unknown[]) => Promise<Record<string, unknown>>)(...args);
const CLAIM = { "tb.onBehalfOf": { claim: { kind: "channel_sender", id: "slack:u777" }, verified: false, via: "mcp_meta" } } as Record<string, Json>;

function j3Db() {
  const { db, raw } = migratedDb();
  writeFleet(db, { teams: [{ id: "tm_x", name: "Team X", people: 1, agents: 0, keys: ["contact:psn_1", "handle:slack:U777"], activeKeys: ["contact:psn_1", "handle:slack:U777"] }], trust: new Map([["handle:slack:U777", { trusts: ["trusted" as const], allActive: true }]]) }, { revision: 3, error: null });
  saveRule(db, { spec: spec({ title: "Team X: nothing with money", priority: 10, match: { effects: ["money"], onBehalfOf: { teams: ["tm_x"] } }, decision: "deny", reason: "Requests from team X may not involve money" }), actor: OWNER });
  saveRule(db, {
    spec: spec({ title: "Team X: work only", priority: 20, match: { onBehalfOf: { teams: ["tm_x"] } }, decision: "allow", reason: "Team X sees only work memories", narrowing: { memoryTags: { anyOf: ["work"], noneOf: ["critical"] } } }),
    actor: OWNER,
  });
  return { db, raw };
}

test("gate: deny with reason and a trace keyed by callId; ungated read without a rule leaves no trace", async () => {
  const { db } = j3Db();
  const out = await call("rules_gate", hookReq("before", { effect: "money", op: "pay", callId: "cal_money", context: CLAIM }), hookCtx(db));
  assert.equal(out.allow, false);
  assert.match(String(out.reason), /may not involve money \(rule rul_/);
  const allowed = await call("rules_gate", hookReq("before", { effect: "read", product: "knowledge", op: "memory_recall", callId: "cal_read" }), hookCtx(db));
  assert.deepEqual(allowed, { allow: true });
  const outward = await call("rules_gate", hookReq("before", { effect: "outward", callId: "cal_out" }), hookCtx(db));
  assert.deepEqual(outward, { allow: true }, "no rule → allow (C84)");
  const traces = listDecisions(db, { limit: 10 }).items;
  assert.deepEqual(traces.map((t) => [t.callId, t.answered]).sort(), [
    ["cal_money", "deny"],
    ["cal_out", "allow"],
  ]);
  const money = traces.find((t) => t.callId === "cal_money");
  assert.equal(money?.ruleTitle, "Team X: nothing with money");
  assert.deepEqual(money?.onBehalfOf, { kind: "channel_sender", id: "slack:u777", verified: false, teams: ["tm_x"], trust: ["trusted"] });
});

test("gate fails closed: over budget, aborted signal, store failure", async () => {
  const { db, raw } = j3Db();
  let t = 0;
  const slow = makeHooks("rules", { clock: () => (t += GATE_BUDGET_MS + 1) });
  const r1 = await (slow.rules_gate as unknown as (...a: unknown[]) => Promise<Record<string, unknown>>)(hookReq("before", {}), hookCtx(db));
  assert.deepEqual(r1, { allow: false, reason: FAIL_CLOSED });
  const ac = new AbortController();
  ac.abort();
  assert.deepEqual(await call("rules_gate", hookReq("before", {}), hookCtx(db, ac.signal)), { allow: false, reason: FAIL_CLOSED });
  const broken = migratedDb();
  broken.raw.exec("DROP TABLE rules");
  assert.deepEqual(await call("rules_gate", hookReq("before", {}), hookCtx(broken.db)), { allow: false, reason: FAIL_CLOSED });
  raw.close();
});

test("gate: hold rule → policy hold verdict the SDK/bridge validator accepts (spec 0.1.13); the retry gets the same verdict", async () => {
  assert.equal(HOLD_SUPPORTED, true, "manifest 0.1.8 accepts a policy hold");
  const { db } = migratedDb();
  saveRule(db, { spec: spec({ match: { effects: ["money"] }, decision: "hold", reason: "Payments need the owner" }), actor: OWNER });
  const held = await call("rules_gate", hookReq("before", { effect: "money", op: "pay", callId: "cal_h1" }), hookCtx(db));
  assert.deepEqual(Object.keys(held).sort(), ["allow", "hold", "reason"]);
  assert.equal(held.reason, (held.hold as { reason: string }).reason, "an older bridge refuses with the same reason (fail closed)");
  assert.deepEqual(reduceBeforeChain([{ by: "rules/rules_gate", answer: held as never }]), {
    kind: "hold",
    by: "rules/rules_gate",
    verdict: { family: "policy", reason: (held.hold as { reason: string }).reason },
  });
  assert.equal(held.allow, false);
  assert.equal((held.hold as { family: string }).family, "policy");
  assert.match((held.hold as { reason: string }).reason, /^Needs owner review: Payments need the owner \(rule rul_/);
  assert.equal(hookResponseProblem("before", held, "rules"), null);
  // The retry after approval passes the gate again: same verdict (the target app's approved hold lets it run once).
  const retry = await call("rules_gate", hookReq("before", { effect: "money", op: "pay", callId: "cal_h2" }), hookCtx(db));
  assert.deepEqual(retry, held);
  assert.deepEqual(
    listDecisions(db, { limit: 5 }).items.map((d) => d.answered),
    ["hold", "hold"],
  );
  // Refuse on retry still wins (C82): the owner turns the rule into a deny → the gate refuses.
  const rule = liveRules(db)[0];
  saveRule(db, { id: rule?.id, spec: { ...(rule?.spec as RuleSpec), outcome: { decision: "deny", reason: "No payments" } }, actor: OWNER });
  const refused = await call("rules_gate", hookReq("before", { effect: "money", op: "pay", callId: "cal_h3" }), hookCtx(db));
  assert.equal(refused.allow, false);
  assert.equal(refused.hold, undefined);
  // An SDK without the hold verdict → refuse with the reason (fail closed).
  const off = makeHooks("rules", { holdSupported: false });
  saveRule(db, { spec: spec({ priority: 1, match: { effects: ["money"] }, decision: "hold", reason: "Payments need the owner" }), actor: OWNER });
  const r = await (off.rules_gate as unknown as (...a: unknown[]) => Promise<Record<string, unknown>>)(hookReq("before", { effect: "money", op: "pay" }), hookCtx(db));
  assert.match(String(r.reason), /Payments need the owner.*refused/);
});

test("context: rules.narrowing v1 for a team-tagged knowledge read; nothing without a claim", async () => {
  const { db } = j3Db();
  const out = (await call("rules_context", hookReq("context", { effect: "read", product: "knowledge", op: "memory_recall", context: CLAIM }), hookCtx(db))) as { add: Record<string, any> };
  assert.deepEqual(out.add["rules.narrowing"].memoryTags, { anyOf: ["work"], noneOf: ["critical"] });
  assert.equal(out.add["rules.narrowing"].v, 1);
  assert.match(out.add["rules.narrowing"].ruleId, /^rul_/);
  assert.equal(out.add["rules.matched"].decision, "allow");
  assert.deepEqual(out.add["rules.onBehalfOf"].teams, ["tm_x"]);
  assert.ok(Object.keys(out.add).every((k) => k.startsWith("rules.")), "keys are namespaced");
  const none = (await call("rules_context", hookReq("context", { effect: "read", product: "knowledge" }), hookCtx(db))) as { add: Record<string, unknown> };
  assert.deepEqual(none.add, {});
  // Live Fleet facts (fleet.requesterTeams) add teams the local copy does not know yet.
  const live = { ...CLAIM, "tb.onBehalfOf": { claim: { kind: "person", id: "psn_new" }, verified: false }, "fleet.requesterTeams": [{ id: "tm_x", name: "Team X", role: "member" }] } as Record<string, Json>;
  const viaLive = (await call("rules_context", hookReq("context", { effect: "read", context: live }), hookCtx(db))) as { add: Record<string, any> };
  assert.ok(viaLive.add["rules.narrowing"]);
});

test("after: results outside the narrowing are redacted and the redaction is traced", async () => {
  const { db } = j3Db();
  const output = { memories: [{ id: "m1", tags: ["work"] }, { id: "m2", tags: ["family"] }, { id: "m3", tags: ["work", "critical"] }] } as Json;
  const out = await call("rules_filter", hookReq("after", { effect: "read", product: "knowledge", op: "memory_recall", context: CLAIM, output, callId: "cal_r" }), hookCtx(db));
  assert.deepEqual(out, { redactions: ["/memories/2", "/memories/1"] });
  assert.equal(listDecisions(db, { callId: "cal_r", limit: 5 }).items[0]?.answered, "redact");
  assert.deepEqual(await call("rules_filter", hookReq("after", { effect: "read", output }), hookCtx(db)), {}, "no claim → no narrowing → untouched");
});

// A2A-9 (QA S3) + C230/C236: a Fleet refusal must never leave stale membership that a team rule could match, AND the gap
// must never switch a deny/hold rule off (fail closed): deny/hold rules that name Fleet facts apply, allow rules do not.
const T0 = 1_800_000_000_000;
const MIN = 60_000;
const holdTeam = { title: "Team X sends need review", priority: 1, match: { effects: ["outward" as const], onBehalfOf: { teams: ["tm_x"] } }, decision: "hold" as const, reason: "Team X sends need review" };
const allowTeam = { title: "Team X may send", priority: 1, match: { effects: ["outward" as const], onBehalfOf: { teams: ["tm_x"] } }, decision: "allow" as const, reason: "Team X may send" };
const gate = (db: ReturnType<typeof migratedDb>["db"], o: Record<string, unknown> = {}) => call("rules_gate", hookReq("before", { effect: "outward", context: CLAIM, ...o }), hookCtx(db));

test("Fleet fail safe: refusal clears at once, transient keeps ≤ 10 min then clears, the gate never matches a stale team", async () => {
  const teamsOf = (db: ReturnType<typeof migratedDb>["db"], at: number) => fleetIndex(db, at).get("handle:slack:U777") ?? [];
  for (const refusal of [{ code: "no_grant" }, { code: "not_found" }, { code: "unlicensed" }, { code: "whatever", httpStatus: 403 }]) {
    const { db } = migratedDb();
    let err: Record<string, unknown> | null = null;
    const callApp = async () => {
      if (err) throw Object.assign(new Error("refused"), err);
      return { status: "ok" as const, output: feed() };
    };
    await syncFleet(db, callApp, () => T0);
    assert.deepEqual(teamsOf(db, T0), ["tm_x"]);
    err = refusal;
    await syncFleet(db, callApp, () => T0 + MIN);
    assert.deepEqual(teamsOf(db, T0 + MIN), [], `${JSON.stringify(refusal)} clears at once`);
    assert.equal(fleetTeams(db).length, 0);
    assert.equal(fleetFacts(db, T0 + MIN).available, false, "a refusal makes the facts unavailable even though the last read is recent");
    assert.match(String(fleetState(db).error), /^Governance not reachable: /);
    // still retrying: a later success restores the copy (full read, no stale sinceRevision)
    err = null;
    await syncFleet(db, async (_p: string, _o: string, input: unknown) => {
      assert.deepEqual(input, { accept: ["agent_handles"] }, "after a clear the next read is a full one");
      return { status: "ok" as const, output: feed() };
    });
    assert.deepEqual(fleetIndex(db).get("handle:slack:U777"), ["tm_x"]);
    assert.equal(fleetFacts(db).available, true);
  }
  // transient (5xx / timeout / the feed's 503 feed_too_large): keep while the last success is ≤ 10 min old, then clear
  for (const transient of [{ code: "bridge_unavailable", httpStatus: 503 }, { code: "feed_too_large", httpStatus: 503 }, { code: "app_timeout", httpStatus: 504 }]) {
    const { db } = migratedDb();
    let err: Record<string, unknown> | null = null;
    const callApp = async () => {
      if (err) throw Object.assign(new Error("down"), err);
      return { status: "ok" as const, output: feed() };
    };
    await syncFleet(db, callApp, () => T0);
    err = transient;
    await syncFleet(db, callApp, () => T0 + 5 * MIN);
    assert.deepEqual(teamsOf(db, T0 + 5 * MIN), ["tm_x"], `kept after ${transient.code}`);
    assert.equal(fleetFacts(db, T0 + 5 * MIN).available, true, "a transient failure is NOT a refusal: facts stay available");
    assert.equal(fleetState(db).syncedAt, T0, "errors never move the last successful read");
    await syncFleet(db, callApp, () => T0 + 9 * MIN);
    assert.deepEqual(teamsOf(db, T0 + 9 * MIN), ["tm_x"]);
    assert.deepEqual(teamsOf(db, T0 + 11 * MIN), [], "the gate stops using a copy older than 10 min even before the next sync");
    assert.equal(fleetFacts(db, T0 + 11 * MIN).available, false);
    await syncFleet(db, callApp, () => T0 + 11 * MIN);
    assert.equal(fleetTeams(db).length, 0, "the sync after 10 min clears it");
  }
});

test("FAIL CLOSED (C230, C236): fire-on-bad — Fleet facts unavailable (never read, refused, too old): a HOLD or DENY team rule applies, an ALLOW team rule does not", async () => {
  const wait = (db: ReturnType<typeof migratedDb>["db"]) => db;
  for (const decision of ["hold", "deny"] as const) {
    // never synced
    const never = migratedDb().db;
    saveRule(never, { spec: spec({ ...holdTeam, decision }), actor: OWNER });
    const r1 = await gate(wait(never));
    assert.equal(r1.allow, false, `${decision}: never synced → the rule applies`);
    assert.equal(Boolean(r1.hold), decision === "hold");
    assert.deepEqual(listDecisions(never, { limit: 1 }).items[0]?.detail, { fleetUnavailable: true }, "the trace says why");
    // refused
    const refused = migratedDb().db;
    saveRule(refused, { spec: spec({ ...holdTeam, decision }), actor: OWNER });
    await syncFleet(refused, async () => ({ status: "ok" as const, output: feed() }), () => Date.now());
    assert.equal((await gate(refused, { context: { "tb.onBehalfOf": { claim: { kind: "channel_sender", id: "slack:u888" }, verified: false } } })).allow, true, "available + requester not in team → quiet");
    await syncFleet(refused, async () => Promise.reject(Object.assign(new Error("no"), { code: "no_grant" })), () => Date.now());
    assert.equal((await gate(refused)).allow, false, `${decision}: refused → the rule applies`);
    // too old: the copy is intact but no read within 10 min
    const old = migratedDb().db;
    saveRule(old, { spec: spec({ ...holdTeam, decision }), actor: OWNER });
    await syncFleet(old, async () => ({ status: "ok" as const, output: feed({ teams: [] }) }), () => Date.now() - 11 * MIN);
    assert.equal((await gate(old)).allow, false, `${decision}: stale beyond the limit → the rule applies`);
  }
  // allow rule: does not apply while unavailable (the gate falls through to the default or a later rule)
  const db = migratedDb().db;
  saveRule(db, { spec: spec(allowTeam), actor: OWNER });
  saveRule(db, { spec: spec({ title: "everything outward needs review", priority: 50, match: { effects: ["outward"] }, decision: "hold", reason: "review all sends" }), actor: OWNER });
  const down = await gate(db);
  assert.match(String(down.reason), /review all sends/, "unavailable → the allow team rule is skipped, the later hold decides");
  await syncFleet(db, async () => ({ status: "ok" as const, output: feed() }), () => Date.now());
  assert.deepEqual(await gate(db, { context: { "tb.onBehalfOf": { claim: { kind: "channel_sender", id: "slack:u777" }, verified: true } } }), { allow: true }, "quiet on good: facts available, verified requester in team X → the allow rule applies");
  assert.match(String((await gate(db)).reason), /review all sends/, "an UNVERIFIED claim cannot use the allow rule past the later hold (C82)");
});

test("FAIL CLOSED: callerTeams and requester trust follow the same rule; an unverified claim still only narrows (C82)", async () => {
  const db = migratedDb().db;
  saveRule(db, { spec: spec({ title: "team Y agents may not send", priority: 1, match: { callerTeams: ["tm_y"], effects: ["outward"] }, decision: "deny", reason: "team Y does not send" }), actor: OWNER });
  saveRule(db, { spec: spec({ title: "blocked requester", priority: 2, match: { onBehalfOf: { trust: ["blocked"] } }, decision: "deny", reason: "blocked requester" }), actor: OWNER });
  // facts unavailable: both deny rules apply (caller A is not even in team Y)
  assert.equal((await gate(db, { caller: AGENT_A, context: {} })).allow, false, "callerTeams deny applies while unavailable");
  const open = migratedDb().db;
  saveRule(open, { spec: spec({ title: "x", match: { onBehalfOf: { trust: ["blocked"] } }, decision: "deny", reason: "blocked requester" }), actor: OWNER });
  assert.equal((await gate(open, { context: {} })).allow, true, "no claim → a claim-dependent rule does not apply even when unavailable (it names no requester)");
  assert.equal((await gate(open)).allow, false, "a claim exists and the facts are unavailable → deny applies");
  // available: quiet on good, fire on bad
  await syncFleet(db, async () => ({ status: "ok" as const, output: feed() }), () => Date.now());
  assert.deepEqual(await gate(db, { caller: AGENT_A, context: {} }), { allow: true }, "A is in team X only");
  assert.equal((await gate(db, { caller: AGENT_B, context: {} })).allow, false, "B (paused) keeps team Y");
  assert.deepEqual(await gate(db), { allow: true }, "trusted requester, A: nothing applies");
  const blocked = { "tb.onBehalfOf": { claim: { kind: "channel_sender", id: "slack:u666" }, verified: false } } as Record<string, Json>;
  assert.equal((await gate(db, { context: blocked })).allow, false, "blocked requester by canonical handle");
  const byId = { "tb.onBehalfOf": { claim: { kind: "person", id: "ct_block" }, verified: false } } as Record<string, Json>;
  assert.equal((await gate(db, { context: byId })).allow, false, "blocked requester by contact id");
  // a verified claim is not special for the closed rule; an UNVERIFIED allow-by-trust rule never widens past a later deny
  const w = migratedDb().db;
  saveRule(w, { spec: spec({ title: "trusted may send", priority: 1, match: { onBehalfOf: { trust: ["trusted"] } }, decision: "allow", reason: "trusted" }), actor: OWNER });
  saveRule(w, { spec: spec({ title: "no sends", priority: 2, match: { effects: ["outward"] }, decision: "deny", reason: "no sends" }), actor: OWNER });
  await syncFleet(w, async () => ({ status: "ok" as const, output: feed() }), () => Date.now());
  assert.equal((await gate(w)).allow, false, "unverified trusted claim cannot widen past the deny (C82)");
  assert.deepEqual(await gate(w, { context: { "tb.onBehalfOf": { claim: { kind: "channel_sender", id: "slack:u777" }, verified: true } } }), { allow: true }, "verified claim: the allow rule applies");
});

test("blocked contact carries no team: a team-scoped ALLOW rule does not widen for it (fire) and still applies to an active member (quiet); deny-by-trust still sees it", async () => {
  const as = (id: string, kind = "channel_sender") => ({ "tb.onBehalfOf": { claim: { kind, id }, verified: true } }) as Record<string, Json>;
  const gateAs = (db: ReturnType<typeof migratedDb>["db"], ctx: Record<string, Json>) => call("rules_gate", hookReq("before", { effect: "outward", context: ctx }), hookCtx(db));
  const setup = async (withTrustRule: boolean) => {
    const { db } = migratedDb();
    saveRule(db, { spec: spec({ title: "Team X may send", priority: 1, match: { effects: ["outward"], onBehalfOf: { teams: ["tm_x"] } }, decision: "allow", reason: "team X" }), actor: OWNER });
    saveRule(db, { spec: spec({ title: "no sends", priority: 5, match: { effects: ["outward"] }, decision: "deny", reason: "no sends" }), actor: OWNER });
    if (withTrustRule) saveRule(db, { spec: spec({ title: "blocked", priority: 0, match: { onBehalfOf: { trust: ["blocked"] } }, decision: "deny", reason: "blocked requester" }), actor: OWNER });
    await syncFleet(db, async () => ({ status: "ok" as const, output: feed() }));
    return db;
  };
  const plain = await setup(false);
  assert.deepEqual(await gateAs(plain, as("slack:u777")), { allow: true }, "quiet: an active member rides the team allow rule");
  assert.match(String((await gateAs(plain, as("slack:u666"))).reason), /no sends/, "fire: blocked by handle has no team, so the allow rule does not apply");
  assert.match(String((await gateAs(plain, as("ct_block", "person"))).reason), /no sends/, "fire: blocked by contact id, same");
  const withTrust = await setup(true);
  assert.match(String((await gateAs(withTrust, as("slack:u666"))).reason), /blocked requester/, "its trust stays 'blocked': a deny by trust still applies");
  assert.deepEqual(await gateAs(withTrust, as("slack:u777")), { allow: true }, "quiet: the trust deny does not touch a trusted member");
});
