// Rules 0.5.0 (C373 D5, CONTRACT-RECIPIENTS): `match.recipients {teams?, trust?, known?}` — "who may talk to whom". Facts from the
// hook's `target.recipients` (canonical handles) through the Fleet read model's `handle:` keys and their holders. Deny/hold: ANY
// recipient matches ALL sub-criteria; allow: EVERY recipient, all holders active. Unknown recipients fail closed; `[]` matches none.
// Handles never reach a decision row (count only). Quiet-on-good and fire-on-bad with exact outcomes (L27, L34).
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Json } from "@opt2-tealbrick/miniapp-sdk";
import { OP } from "#kit";
import { handlers, manifest } from "../src/app.ts";
import { type CallFacts, evaluate, explain, NEEDS_RECIPIENTS, order, type RecipientFact, type Rule, specProblem, strictestNarrowing } from "../src/engine.ts";
import { parseFeed } from "../src/fleet.ts";
import { makeHooks, recipientFacts, recipientsOf } from "../src/hooks.ts";
import { fleetFacts, listDecisions, saveRule, writeFleet } from "../src/store.ts";
import { matchText } from "../src/ui/api.ts";
import { AGENT_A, feed, hookCtx, hookReq, migratedDb, NPUB, OWNER, opCtx, spec } from "./helpers.ts";

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
const R = (o: Partial<RecipientFact> = {}): RecipientFact => ({ teams: [], teamsAny: [], trusts: ["unreviewed"], allActive: true, known: false, ...o });
const TRUSTED_TEAM = R({ teams: ["tm_x"], teamsAny: ["tm_x"], trusts: ["trusted"], known: true });
const GONE = R({ teams: [], teamsAny: ["tm_x"], trusts: ["trusted"], allActive: false, known: true });
const STRANGER = R();
const facts = (recipients: CallFacts["recipients"], o: Partial<CallFacts> = {}): CallFacts => ({ ...base, recipients, ...o });
const one = (decision: "allow" | "deny" | "hold", recipients: Rule["spec"]["match"]["recipients"], extra: Partial<Rule["spec"]> = {}) =>
  order([rule("rul_r", spec({ priority: 10, match: { effects: ["outward"], recipients }, decision, reason: `${decision} by recipients`, ...extra }))]);
const out = (v: ReturnType<typeof evaluate>) => [v.decision, v.rule?.id ?? null, v.recipientsUnknown, v.closedOnFleet] as const;

test("deny/hold: ANY recipient that matches ALL sub-criteria; the C363 example holds a stranger and lets a trusted contact through", () => {
  // C363 shape: hold everything outward unless every recipient is trusted
  const c363 = one("hold", { trust: ["unreviewed", "limited", "blocked"] });
  assert.deepEqual(out(evaluate(c363, facts([TRUSTED_TEAM]))), ["allow", null, false, false], "quiet: only a trusted recipient");
  assert.deepEqual(out(evaluate(c363, facts([TRUSTED_TEAM, STRANGER]))), ["hold", "rul_r", false, false], "fire: one stranger is enough");
  // all sub-criteria on the SAME recipient
  const both = one("deny", { teams: ["tm_x"], trust: ["unreviewed"] });
  assert.equal(evaluate(both, facts([TRUSTED_TEAM, STRANGER])).rule, null, "tm_x member is trusted, the unreviewed one is in no team");
  assert.equal(evaluate(both, facts([R({ teamsAny: ["tm_x"], known: true })])).rule?.id, "rul_r");
  // deny/hold see every membership, incl. a departed holder
  assert.equal(evaluate(one("deny", { teams: ["tm_x"] }), facts([GONE])).rule?.id, "rul_r");
  // known
  assert.equal(evaluate(one("hold", { known: false }), facts([TRUSTED_TEAM])).rule, null);
  assert.equal(evaluate(one("hold", { known: false }), facts([TRUSTED_TEAM, STRANGER])).rule?.id, "rul_r");
  assert.equal(explain(one("deny", { known: false }), facts([TRUSTED_TEAM]))[0]?.why, "no recipient matches");
});

test("allow: at least one recipient, EVERY recipient matches with every holder active", () => {
  const allow = one("allow", { teams: ["tm_x"], known: true }, { narrowing: { memoryTags: { anyOf: ["work"] } } });
  assert.deepEqual(evaluate(allow, facts([TRUSTED_TEAM])).narrowing, { memoryTags: { anyOf: ["work"] } }, "quiet on good");
  assert.equal(evaluate(allow, facts([TRUSTED_TEAM, STRANGER])).rule, null, "fire: not every recipient");
  assert.equal(evaluate(allow, facts([GONE])).rule, null, "fire: a departed holder never satisfies an allow");
  assert.equal(explain(allow, facts([TRUSTED_TEAM, STRANGER]))[0]?.why, "not every recipient matches");
  assert.equal(evaluate(one("allow", { trust: ["trusted"] }), facts([R({ trusts: ["trusted", "blocked"], known: true })])).rule, null, "a handle with a trusted and a blocked holder");
});

test("UNKNOWN recipients (absent, incomplete): deny and hold apply and are flagged; allow is skipped, its narrowing kept", () => {
  for (const unknown of [null, undefined]) {
    assert.deepEqual(out(evaluate(one("deny", { known: false }), facts(unknown))), ["deny", "rul_r", true, false]);
    assert.deepEqual(out(evaluate(one("hold", { trust: ["trusted"] }), facts(unknown))), ["hold", "rul_r", true, false], "even a rule that names only trusted recipients");
    const v = evaluate(one("allow", { trust: ["trusted"] }, { narrowing: { memoryTags: { anyOf: ["w"] } } }), facts(unknown));
    assert.deepEqual([v.decision, v.rule, v.narrowing, v.recipientsUnknown], ["allow", null, { memoryTags: { anyOf: ["w"] } }, true]);
  }
  assert.equal(explain(one("allow", { known: true }), facts(null))[0]?.why, NEEDS_RECIPIENTS);
  assert.match(String(explain(one("hold", { known: false }), facts(null))[0]?.why), /the call's recipients are unknown, so this rule applies \(fail closed\)/);
});

test("[] (known: no recipients): no recipient rule matches, deny, hold or allow; no narrowing either", () => {
  for (const decision of ["deny", "hold", "allow"] as const) {
    const r = one(decision, { known: false }, decision === "allow" ? { narrowing: { memoryTags: { anyOf: ["w"] } } } : {});
    assert.deepEqual(out(evaluate(r, facts([]))), ["allow", null, false, false], decision);
    assert.equal(explain(r, facts([]))[0]?.why, "call has no recipients");
    assert.equal(strictestNarrowing(r, facts([])), null);
  }
});

test("Governance unavailable: the strict path of C236 (deny/hold apply flagged fleetUnavailable, allow skipped); [] still matches nothing", () => {
  const down = (recipients: CallFacts["recipients"]) => facts(recipients, { fleetAvailable: false });
  assert.deepEqual(out(evaluate(one("deny", { known: false }), down([R()]))), ["deny", "rul_r", false, true]);
  assert.deepEqual(out(evaluate(one("allow", { known: true }), down([TRUSTED_TEAM]))), ["allow", null, false, false]);
  assert.equal(evaluate(one("deny", { known: false }), down([])).rule, null);
});

test("recipientsOf: canonical handles only; absent, incomplete, too many or not canonical = unknown; duplicates collapse", () => {
  assert.deepEqual(recipientsOf({ recipients: ["slack:U777", "telegram:42", "slack:U777"] }), ["slack:U777", "telegram:42"]);
  assert.deepEqual(recipientsOf({ recipients: [] }), []);
  assert.equal(recipientsOf({}), null);
  assert.equal(recipientsOf({ recipients: "slack:U777" }), null);
  assert.equal(recipientsOf({ recipients: ["slack:U777"], recipientsIncomplete: true }), null);
  assert.equal(recipientsOf({ recipients: ["slack:u777"] }), null, "not canonical: the bridge would have normalised it");
  assert.equal(recipientsOf({ recipients: ["slack:U777", 7] }), null);
  assert.equal(recipientsOf({ recipients: Array.from({ length: 65 }, (_, i) => `telegram:${i + 1}`) }), null);
  assert.equal(recipientsOf({ recipients: Array.from({ length: 64 }, (_, i) => `telegram:${i + 1}`) })?.length, 64);
});

test("recipientFacts maps handles through the feed's holders: teams, trust set, known; an unknown handle is unreviewed", () => {
  const { db } = migratedDb();
  writeFleet(db, parseFeed(feed()).model, { revision: 7, error: null });
  const fx = fleetFacts(db);
  assert.deepEqual(recipientFacts(fx, ["slack:U777", "telegram:9", "slack:U666", "telegram:42"]), [
    { teams: ["tm_x"], teamsAny: ["tm_x"], trusts: ["trusted"], allActive: true, known: true },
    { teams: [], teamsAny: ["tm_x"], trusts: ["trusted"], allActive: false, known: true },
    { teams: [], teamsAny: ["tm_x"], trusts: ["blocked"], allActive: false, known: true },
    { teams: [], teamsAny: [], trusts: ["unreviewed"], allActive: true, known: false },
  ]);
  assert.equal(recipientFacts(fx, null), null);
});

test("gate: recipients decide; unknown recipients hold with recipientsUnknown; the trace keeps the COUNT, never a handle", async () => {
  const { db } = migratedDb();
  writeFleet(db, parseFeed(feed()).model, { revision: 7, error: null });
  saveRule(db, { spec: spec({ title: "C363", priority: 10, match: { agents: [AGENT_A], effects: ["outward"], recipients: { trust: ["unreviewed", "limited", "blocked"] } }, decision: "hold", reason: "Hermes talks freely to trusted people only" }), actor: OWNER });
  const hooks = makeHooks("rules", { holdSupported: true });
  const gate = (callId: string, target: Record<string, unknown>) =>
    (hooks.rules_gate as unknown as (...a: unknown[]) => Promise<Record<string, any>>)({ ...hookReq("before", { callId }), call: { ...hookReq("before", { callId }).call, target: { ...hookReq("before", {}).call.target, ...target } } }, hookCtx(db));
  assert.deepEqual(await gate("cal_ok", { recipients: ["slack:U777", NPUB] }), { allow: true }, "quiet: both handles are Anna's (trusted, active)");
  assert.equal((await gate("cal_stranger", { recipients: ["slack:U777", "telegram:42"] })).hold?.family, "policy", "fire: a stranger");
  assert.equal((await gate("cal_blocked", { recipients: ["slack:U666"] })).hold?.family, "policy", "fire: a blocked contact");
  assert.equal((await gate("cal_unknown", {})).hold?.family, "policy", "fire: recipients absent = unknown");
  assert.equal((await gate("cal_incomplete", { recipients: ["slack:U777"], recipientsIncomplete: true })).hold?.family, "policy", "fire: incomplete");
  assert.deepEqual(await gate("cal_none", { recipients: [] }), { allow: true }, "[]: the rule does not match");
  const row = (id: string) => listDecisions(db, { callId: id, limit: 1 }).items[0];
  assert.deepEqual(row("cal_stranger")?.detail, { recipients: 2 });
  assert.deepEqual(row("cal_unknown")?.detail, { recipientsUnknown: true });
  assert.deepEqual(row("cal_incomplete")?.detail, { recipientsUnknown: true });
  assert.deepEqual(row("cal_ok")?.detail, { recipients: 2 });
  const all = JSON.stringify(listDecisions(db, { limit: 50 }).items);
  for (const h of ["slack:U777", "telegram:42", "slack:U666", NPUB]) assert.ok(!all.includes(h), `no handle in any decision row: ${h}`);
  // rules_explain tells the agent the recipients were unknown
  const ex = await (handlers[OP.rulesExplain] as unknown as { run: (i: unknown, c: unknown) => Promise<any> }).run({ callId: "cal_unknown" }, opCtx(db, { type: "agent", id: AGENT_A }));
  assert.equal(ex.decisions[0].recipientsUnknown, true);
  assert.equal(validateAgainstSchema(manifest.operations.find((o) => o.id === "rules_explain")?.output as never, ex).ok, true);
});

test("writers: recipients need teams, trust or known and effects exactly [outward] (S2); empty lists and other effects are refused", () => {
  const p = (match: Rule["spec"]["match"]) => specProblem(spec({ match }));
  assert.equal(p({ effects: ["outward"], recipients: { trust: ["trusted"] } }), "", "quiet on good");
  assert.equal(p({ effects: ["outward"], products: ["connect"], recipients: { known: false } }), "");
  // S2: effects exactly [outward]; products only, no effects or another effect next to outward would catch reads and writes
  const EXACT = /^recipients need effects exactly \[outward\]/;
  assert.match(p({ products: ["connect"], recipients: { known: false } }), EXACT);
  assert.match(p({ effects: ["outward", "write"], recipients: { teams: ["tm_x"] } }), EXACT);
  assert.match(p({ recipients: { known: false } }), EXACT);
  assert.match(p({ effects: ["outward"], recipients: {} }), /^recipients needs teams, trust or known/);
  assert.equal(p({ effects: ["outward"], recipients: { teams: [] } }), "recipients.teams needs at least one team");
  assert.equal(p({ effects: ["outward"], recipients: { trust: [] } }), "recipients.trust needs at least one trust value");
  assert.match(p({ effects: ["read"], products: ["connect"], recipients: { known: false } }), EXACT);
});

test("manifest: every rule schema takes recipients (≥ 1 key); rules_preview takes target.recipients and answers recipientsUnknown", async () => {
  const good = { title: "t", active: true, priority: 1, match: { effects: ["outward"], recipients: { trust: ["unreviewed"], known: false } }, outcome: { decision: "hold", reason: "r" } };
  const input = manifest.operations.find((o) => o.id === "rules_set")?.input as Parameters<typeof validateAgainstSchema>[0];
  const ok = (r: unknown) => validateAgainstSchema(input, { rule: r } as unknown as Json).ok;
  assert.equal(ok(good), true);
  for (const bad of [{}, { teams: [] }, { trust: ["nice"] }, { known: "yes" }, { other: 1 }]) assert.equal(ok({ ...good, match: { recipients: bad } }), false, JSON.stringify(bad));
  const { db } = migratedDb();
  writeFleet(db, parseFeed(feed()).model, { revision: 7, error: null });
  saveRule(db, { spec: spec({ title: "strangers wait", match: { effects: ["outward"], recipients: { known: false } }, decision: "hold", reason: "r" }), actor: OWNER });
  const owner = opCtx(db, { type: "person", id: OWNER }, (async () => ({ status: "ok", output: feed() })) as never);
  const pv = manifest.operations.find((o) => o.id === "rules_preview");
  const preview = async (target: Record<string, unknown>) => {
    const i = { call: { caller: { type: "agent", id: AGENT_A }, target: { product: "connect", op: "buzz_dm", effect: "outward", ...target } } };
    assert.equal(validateAgainstSchema(pv?.input as never, i as never).ok, true);
    const o = await (handlers[OP.rulesPreview] as unknown as { run: (i: unknown, c: unknown) => Promise<any> }).run(i, owner);
    assert.equal(validateAgainstSchema(pv?.output as never, o).ok, true);
    return [o.decision, o.recipientsUnknown];
  };
  assert.deepEqual(await preview({ recipients: ["slack:u777"] }), ["allow", false], "typed handles are normalised like the bridge does");
  assert.deepEqual(await preview({ recipients: ["slack:U777", "telegram:42"] }), ["hold", false]);
  assert.deepEqual(await preview({}), ["hold", true]);
  assert.deepEqual(await preview({ recipients: ["not a handle"] }), ["hold", true], "a value that is not a handle = unknown");
  assert.deepEqual(await preview({ recipients: ["slack:U777"], recipientsIncomplete: true }), ["hold", true]);
  assert.deepEqual(await preview({ recipients: [] }), ["allow", false]);
});

test("rule list text names the recipient criteria", () => {
  const t = matchText(spec({ match: { effects: ["outward"], recipients: { teams: ["tm_x"], trust: ["trusted"], known: true } } }), (id) => (id === "tm_x" ? "Team X" : id), (a) => a);
  assert.equal(t, "effects outward; recipients in team Team X and with trust trusted and known to Governance");
});
