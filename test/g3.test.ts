// Rules 0.3.0 (C230, G-3): callerTeams, requester trust, rule spec validation, preview/explain, draft_status, draft source,
// and the upgrade of a 0.2.12-shaped database. Each item has a quiet-on-good and a fire-on-bad case with exact codes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Json, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { OP } from "#kit";
import { handlers, manifest, migrationsDir } from "../src/app.ts";
import { type CallFacts, evaluate, explain, order, type Rule, specProblem, type Trust } from "../src/engine.ts";
import { syncFleet } from "../src/fleet.ts";
import { makeHooks } from "../src/hooks.ts";
import { fleetFacts, getDraft, listDecisions, recordDecision, saveRule } from "../src/store.ts";
import { AGENT_A, AGENT_B, feed, hookCtx, hookReq, migratedDb, OWNER, opCtx, spec, trustFacts } from "./helpers.ts";

type Run = (input: unknown, ctx: OpContext) => Promise<any>;
const run = (id: keyof typeof handlers) => (handlers[id] as unknown as { run: Run }).run;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** Exact outcome of an evaluation: decision, deciding rule and narrowing (an absence test pins all three). */
const out = (v: ReturnType<typeof evaluate>) => ({ decision: v.decision, rule: v.rule?.id ?? null, narrowing: v.narrowing });
const NOTHING = { decision: "allow", rule: null, narrowing: null } as const;
const rule = (id: string, s: Rule["spec"]): Rule => ({ id, rev: 1, spec: s, updatedAt: 1 });
const facts = (o: Partial<CallFacts> & { claimTrust?: Trust | null } = {}): CallFacts => ({
  caller: { type: "agent", id: AGENT_A, mode: "free" },
  target: { product: "connect", op: "buzz_dm", effect: "outward" },
  claim: null,
  claimVerified: false,
  claimTeams: [],
  callerTeams: [],
  fleetAvailable: true,
  ...o,
  ...trustFacts(o),
  callerProduct: o.callerProduct ?? null,
  claimTeamsAny: o.claimTeamsAny ?? o.claimTeams ?? [],
  callerTeamsAny: o.callerTeamsAny ?? o.callerTeams ?? [],
});

// ── (b) match.callerTeams ─────────────────────────────────────────────────────────────────────────────────────
test("callerTeams: matches only an agent in one of the teams; no teams, other teams → no match", () => {
  const rules = order([rule("rul_a", spec({ match: { callerTeams: ["tm_x", "tm_z"] }, decision: "deny", reason: "team X may not send" }))]);
  assert.equal(evaluate(rules, facts({ callerTeams: ["tm_x"] })).rule?.id, "rul_a");
  assert.equal(evaluate(rules, facts({ callerTeams: ["tm_z", "tm_q"] })).rule?.id, "rul_a");
  assert.deepEqual(out(evaluate(rules, facts({ callerTeams: ["tm_y"] }))), NOTHING, "quiet: another team");
  assert.deepEqual(out(evaluate(rules, facts())), NOTHING, "quiet: no team");
  assert.deepEqual(explain(rules, facts({ callerTeams: ["tm_y"] }))[0], { ruleId: "rul_a", title: "rule", matched: false, why: "caller is not in the teams" });
});

// ── (c) match.onBehalfOf.trust ────────────────────────────────────────────────────────────────────────────────
test("onBehalfOf.trust: needs a claim whose contact has one of the listed trust states", () => {
  const rules = order([rule("rul_t", spec({ match: { onBehalfOf: { trust: ["unreviewed", "blocked"] } }, decision: "hold", reason: "unknown or blocked requester" }))]);
  const claim = { kind: "channel_sender" as const, id: "slack:U777" };
  assert.deepEqual(out(evaluate(rules, facts({ claim, claimTrust: "blocked" }))), { decision: "hold", rule: "rul_t", narrowing: null });
  assert.deepEqual(out(evaluate(rules, facts({ claim, claimTrust: "unreviewed" }))), { decision: "hold", rule: "rul_t", narrowing: null });
  assert.deepEqual(out(evaluate(rules, facts({ claim, claimTrust: "trusted" }))), NOTHING, "quiet: trusted");
  assert.deepEqual(
    (({ decision, rule }) => ({ decision, rule: rule?.id }))(evaluate(rules, facts({ claim, claimTrust: null }))),
    { decision: "hold", rule: "rul_t" },
    "a requester Governance does not know is unreviewed (fail closed)",
  );
  assert.deepEqual(out(evaluate(rules, facts({ claimTrust: "blocked" }))), NOTHING, "quiet: no claim");
  assert.equal(explain(rules, facts({ claim, claimTrust: "trusted" }))[0]?.why, "claimed requester's trust is not listed");
  assert.equal(explain(rules, facts({ claim, claimTrust: null }))[0]?.matched, true);
});

test("onBehalfOf.trust through an UNVERIFIED claim only narrows (C82): an allow by trust never beats a later deny", () => {
  const rules = order([
    rule("rul_allow", spec({ priority: 1, match: { onBehalfOf: { trust: ["trusted"] } }, decision: "allow", reason: "trusted requester" })),
    rule("rul_deny", spec({ priority: 2, match: { effects: ["outward"] }, decision: "deny", reason: "no sends" })),
  ]);
  const claim = { kind: "person" as const, id: "ct_anna" };
  assert.deepEqual(out(evaluate(rules, facts({ claim, claimTrust: "trusted", claimVerified: false }))), { decision: "deny", rule: "rul_deny", narrowing: null });
  assert.deepEqual(out(evaluate(rules, facts({ claim, claimTrust: "trusted", claimVerified: true }))), { decision: "allow", rule: "rul_allow", narrowing: null }, "verified: the allow applies");
  // a deny by trust through an unverified claim does apply (narrowing)
  const deny = order([rule("rul_b", spec({ match: { onBehalfOf: { trust: ["blocked"] } }, decision: "deny", reason: "blocked" }))]);
  assert.deepEqual(out(evaluate(deny, facts({ claim, claimTrust: "blocked", claimVerified: false }))), { decision: "deny", rule: "rul_b", narrowing: null });
});

// ── fail closed, engine level ─────────────────────────────────────────────────────────────────────────────────
test("FAIL CLOSED (engine): unavailable facts → deny/hold rules that name Fleet facts apply, allow rules do not; rules that name none are unaffected", () => {
  const claim = { kind: "person" as const, id: "ct_anna" };
  for (const m of [{ callerTeams: ["tm_x"] }, { onBehalfOf: { teams: ["tm_x"] } }, { onBehalfOf: { trust: ["blocked"] } }] as const) {
    for (const decision of ["deny", "hold"] as const) {
      const r = order([rule("rul_c", spec({ match: m as never, decision, reason: "closed" }))]);
      const down = evaluate(r, facts({ claim, fleetAvailable: false }));
      assert.deepEqual(out(down), { decision, rule: "rul_c", narrowing: null }, `${JSON.stringify(m)} ${decision}: applies while unavailable`);
      assert.equal(down.closedOnFleet, true);
      assert.equal(explain(r, facts({ claim, fleetAvailable: false }))[0]?.matched, true);
      const up = evaluate(r, facts({ claim, fleetAvailable: true }));
      assert.deepEqual(out(up), NOTHING, `${JSON.stringify(m)} ${decision}: quiet when available and not a member`);
      assert.equal(up.closedOnFleet, false);
    }
    const allow = order([rule("rul_a", spec({ match: m as never, decision: "allow", reason: "ok" }))]);
    const down = evaluate(allow, facts({ claim, fleetAvailable: false, callerTeams: ["tm_x"], claimTeams: ["tm_x"], claimTrust: "blocked" }));
    assert.deepEqual(out(down), NOTHING, `${JSON.stringify(m)}: an allow rule does not apply while unavailable, even if stale facts would match`);
    assert.match(explain(allow, facts({ claim, fleetAvailable: false }))[0]?.why ?? "", /^needs Fleet facts, which are unavailable/);
    assert.equal(evaluate(allow, facts({ claim, fleetAvailable: true, callerTeams: ["tm_x"], claimTeams: ["tm_x"], claimTrust: "blocked" })).rule?.id, "rul_a", "quiet: available and matching → applies");
  }
  // not fleet facts: the closure never touches other criteria
  const other = order([rule("rul_o", spec({ match: { effects: ["money"], callerTeams: ["tm_x"] }, decision: "deny", reason: "x" }))]);
  assert.deepEqual(out(evaluate(other, facts({ fleetAvailable: false }))), NOTHING, "effect differs → still no match");
  // a claim-dependent rule without a claim does not apply even when closed (it names a requester)
  const noClaim = order([rule("rul_n", spec({ match: { onBehalfOf: { teams: ["tm_x"] } }, decision: "deny", reason: "x" }))]);
  assert.deepEqual(out(evaluate(noClaim, facts({ fleetAvailable: false }))), NOTHING);
  // an id list is not a Fleet fact: wrong id → no match
  const ids = order([rule("rul_i", spec({ match: { onBehalfOf: { ids: ["slack:U111"], teams: ["tm_x"] } }, decision: "deny", reason: "x" }))]);
  assert.deepEqual(out(evaluate(ids, facts({ claim: { kind: "channel_sender", id: "slack:U222" }, fleetAvailable: false }))), NOTHING);
  assert.deepEqual(out(evaluate(ids, facts({ claim: { kind: "channel_sender", id: "slack:U111" }, fleetAvailable: false }))), { decision: "deny", rule: "rul_i", narrowing: null });
});

// ── rule spec validation ──────────────────────────────────────────────────────────────────────────────────────
test("rule spec validation: the manifest schemas accept callerTeams and trust and refuse bad values", () => {
  const ops = ["rules_set", "rule_draft_submit", "rules_preview"].map((id) => manifest.operations.find((o) => o.id === id));
  const base = spec({ title: "t", match: { callerTeams: ["tm_x"], onBehalfOf: { trust: ["blocked", "limited"] } }, decision: "deny", reason: "r" });
  const wrap = (id: string, rule: unknown): Json => (id === "rules_set" ? { rule } : id === "rule_draft_submit" ? { text: "t", rules: [rule] } : { call: { caller: { type: "agent", id: "a" }, target: { product: "connect", op: "buzz_dm", effect: "outward" } }, candidate: rule }) as Json;
  for (const op of ops) {
    const id = op?.id as string;
    const input = op?.input as Parameters<typeof validateAgainstSchema>[0];
    assert.equal(validateAgainstSchema(input, wrap(id, base)).ok, true, `${id}: valid spec`);
    const badTrust = { ...base, match: { onBehalfOf: { trust: ["vip"] } } };
    assert.equal(validateAgainstSchema(input, wrap(id, badTrust)).ok, false, `${id}: unknown trust`);
    const badTeams = { ...base, match: { callerTeams: [""] } };
    assert.equal(validateAgainstSchema(input, wrap(id, badTeams)).ok, false, `${id}: empty team id`);
    const tooMany = { ...base, match: { callerTeams: Array.from({ length: 51 }, (_, i) => `t${i}`) } };
    assert.equal(validateAgainstSchema(input, wrap(id, tooMany)).ok, false, `${id}: more than 50 teams`);
    const extra = { ...base, match: { callerTeam: ["tm_x"] } };
    assert.equal(validateAgainstSchema(input, wrap(id, extra)).ok, false, `${id}: misspelled criterion`);
  }
  assert.equal(specProblem(base), "");
});

test("a draft with callerTeams and trust is accepted by an agent and applies after approval", async () => {
  const { db } = migratedDb();
  const agent = opCtx(db, { type: "agent", id: AGENT_A });
  const owner = opCtx(db, { type: "person", id: OWNER });
  const s = await run(OP.ruleDraftSubmit)({ text: "Hold sends of team X.", rules: [spec({ match: { callerTeams: ["tm_x"], effects: ["outward"] }, decision: "hold", reason: "review" })] }, agent);
  await run(OP.draftDecide)({ id: s.draftId, decision: "approve" }, owner);
  await syncFleet(db, async () => ({ status: "ok" as const, output: feed() }));
  const hooks = makeHooks("rules");
  const gate = (caller: string) => (hooks.rules_gate as unknown as (...a: unknown[]) => Promise<Record<string, unknown>>)(hookReq("before", { caller, effect: "outward" }), hookCtx(db));
  assert.equal((await gate(AGENT_A)).allow, false, "A is in team X: hold");
  assert.deepEqual(await gate(AGENT_B), { allow: true }, "B is in team Y only");
});

// ── preview / explain ─────────────────────────────────────────────────────────────────────────────────────────
test("rules_preview shows the Fleet facts used and whether they were available", async () => {
  const { db } = migratedDb();
  const owner = (callApp?: OpContext["callApp"]) => opCtx(db, { type: "person", id: OWNER }, callApp);
  saveRule(db, { spec: spec({ title: "team X holds", match: { callerTeams: ["tm_x"], effects: ["outward"] }, decision: "hold", reason: "review" }), actor: OWNER });
  saveRule(db, { spec: spec({ title: "blocked requesters", priority: 5, match: { onBehalfOf: { trust: ["blocked"] } }, decision: "deny", reason: "blocked" }), actor: OWNER });
  const call = (caller: string, id?: string) => ({ caller: { type: "agent", id: caller, mode: "free" }, target: { product: "connect", op: "buzz_dm", effect: "outward" }, ...(id ? { onBehalfOf: { kind: "channel_sender", id } } : {}) });
  // unavailable (no grant): both rules apply, the answer says so
  const down = await run(OP.rulesPreview)({ call: call(AGENT_B, "slack:U777") }, owner());
  assert.equal(down.fleetAvailable, false);
  assert.equal(down.decision, "deny", "both rules apply while unavailable; the lower priority number (the trust deny) decides");
  assert.ok(down.steps.every((st: { matched: boolean; why: string }) => st.matched && /Fleet facts are unavailable/.test(st.why)));
  assert.deepEqual([down.callerTeams, down.trust], [[], null]);
  const feedOk = (async () => ({ status: "ok" as const, output: feed() })) as unknown as OpContext["callApp"];
  const up = await run(OP.rulesPreview)({ call: call(AGENT_B, "slack:U666") }, owner(feedOk));
  assert.equal(up.fleetAvailable, true);
  assert.deepEqual(up.callerTeams, ["tm_y"]);
  assert.equal(up.trust, "blocked");
  assert.equal(up.decision, "deny", "blocked requester (unverified claim narrows)");
  const quiet = await run(OP.rulesPreview)({ call: call(AGENT_B, "slack:U777") }, owner(feedOk));
  assert.equal(quiet.decision, "allow", "B is not in team X; requester is trusted");
  assert.equal(quiet.trust, "trusted");
  const inX = await run(OP.rulesPreview)({ call: call(AGENT_A) }, owner(feedOk));
  assert.equal(inX.decision, "hold");
  assert.deepEqual(inX.callerTeams, ["tm_x"]);
});

test("rules_explain tells the agent when a rule applied only because Fleet facts were unavailable", async () => {
  const { db } = migratedDb();
  saveRule(db, { spec: spec({ title: "team X holds", match: { callerTeams: ["tm_x"], effects: ["outward"] }, decision: "hold", reason: "review" }), actor: OWNER });
  const hooks = makeHooks("rules");
  await (hooks.rules_gate as unknown as (...a: unknown[]) => Promise<unknown>)(hookReq("before", { callId: "cal_down", effect: "outward" }), hookCtx(db));
  await syncFleet(db, async () => ({ status: "ok" as const, output: feed() }));
  await (hooks.rules_gate as unknown as (...a: unknown[]) => Promise<unknown>)(hookReq("before", { callId: "cal_up", effect: "outward" }), hookCtx(db));
  const out = await run(OP.rulesExplain)({}, opCtx(db, { type: "agent", id: AGENT_A }));
  const by = Object.fromEntries(out.decisions.map((d: { callId: string; fleetUnavailable: boolean; decision: string }) => [d.callId, d]));
  assert.equal(by.cal_down.fleetUnavailable, true);
  assert.equal(by.cal_down.decision, "hold");
  assert.equal(by.cal_up.fleetUnavailable, false);
  assert.equal(by.cal_up.decision, "hold", "A is in team X");
  assert.equal(listDecisions(db, { callId: "cal_up", limit: 1 }).items[0]?.detail, null);
  void recordDecision;
  assert.equal(fleetFacts(db).available, true);
});

// ── (d) draft_status ──────────────────────────────────────────────────────────────────────────────────────────
test("draft_status: only the submitter sees a draft; anyone else gets the SAME not_found as for a missing id", async () => {
  const { db } = migratedDb();
  const a = opCtx(db, { type: "agent", id: AGENT_A });
  const b = opCtx(db, { type: "agent", id: AGENT_B });
  const app = opCtx(db, { type: "app", id: "ins_01J00000000000000000000GOV", name: "Governance", product: "fleet" });
  const owner = opCtx(db, { type: "person", id: OWNER });
  const sub = (ctx: OpContext) => run(OP.ruleDraftSubmit)({ text: "t", rules: [spec({})] }, ctx);
  const da = await sub(a);
  const dapp = await sub(app);
  // quiet on good
  const mine = await run(OP.draftStatus)({ draftId: da.draftId }, a);
  assert.deepEqual({ ...mine, submittedAt: "x" }, { draftId: da.draftId, status: "pending", submittedAt: "x", decidedAt: null, ruleCount: 0 });
  assert.equal((await run(OP.draftStatus)({ draftId: dapp.draftId }, app)).status, "pending");
  // fire on bad: another agent, an app asking for an agent's draft, an agent asking for an app's draft, the owner (agent-audience op)
  const missing = await run(OP.draftStatus)({ draftId: "drf_nope" }, a).catch((e) => e);
  assert.equal(missing.code, "not_found");
  assert.equal(missing.httpStatus, 404);
  for (const [who, id] of [[b, da.draftId], [app, da.draftId], [a, dapp.draftId], [owner, da.draftId]] as const) {
    const e = await run(OP.draftStatus)({ draftId: id }, who).catch((x) => x);
    assert.equal(e.code, "not_found");
    assert.equal(e.httpStatus, 404);
    assert.equal(e.message, missing.message, "identical to a missing draft: no existence oracle");
  }
  // follows the decision
  await run(OP.draftDecide)({ id: da.draftId, decision: "approve" }, owner);
  const done = await run(OP.draftStatus)({ draftId: da.draftId }, a);
  assert.equal(done.status, "approved");
  assert.equal(done.ruleCount, 1);
  assert.ok(done.decidedAt);
  await run(OP.draftDecide)({ id: dapp.draftId, decision: "reject" }, owner);
  assert.equal((await run(OP.draftStatus)({ draftId: dapp.draftId }, app)).status, "rejected");
  // never more than the contract: no text, no rules
  assert.deepEqual(Object.keys(done).sort(), ["decidedAt", "draftId", "ruleCount", "status", "submittedAt"]);
});

// ── (e) draft source ──────────────────────────────────────────────────────────────────────────────────────────
test("rule_draft_submit from an APP records source {kind:'app', product, name}; an agent records {kind:'agent'}", async () => {
  const { db } = migratedDb();
  const owner = opCtx(db, { type: "person", id: OWNER });
  const app = opCtx(db, { type: "app", id: "ins_01J00000000000000000000GOV", name: "Governance", product: "fleet" });
  const unknown = opCtx(db, { type: "app", id: "ins_01J00000000000000000000OTH", name: "Some Other App", product: "other" });
  const agent = opCtx(db, { type: "agent", id: AGENT_A, name: "Front desk" });
  const ids: Record<string, string> = {};
  for (const [k, ctx] of [["app", app], ["unknown", unknown], ["agent", agent]] as const) ids[k] = (await run(OP.ruleDraftSubmit)({ text: k, rules: [spec({})] }, ctx)).draftId;
  assert.deepEqual(getDraft(db, ids.app as string)?.source, { kind: "app", product: "fleet", name: "Governance", instance: "ins_01J00000000000000000000GOV" }, "the verified Caller.product");
  assert.deepEqual(getDraft(db, ids.unknown as string)?.source, { kind: "app", product: "other", name: "Some Other App", instance: "ins_01J00000000000000000000OTH" }, "another app: same shape");
  assert.deepEqual(getDraft(db, ids.agent as string)?.source, { kind: "agent" });
  const listed = (await run(OP.draftsList)({}, owner)).drafts;
  assert.equal(listed.find((d: { id: string }) => d.id === ids.app).source.name, "Governance");
  // the draft list output stays valid against the manifest (source is declared)
  const listOp = manifest.operations.find((o) => o.id === "drafts_list");
  assert.equal(validateAgainstSchema(listOp?.output as never, { drafts: listed } as Json).ok, true);
});

// ── (f) app callers are identified by the verified product, never by the name (C236, SDK 0.1.27) ─────────────
test("an app caller is identified by its verified product; a name that matches another app's name gives nothing", async () => {
  const { db } = migratedDb();
  const owner = opCtx(db, { type: "person", id: OWNER });
  // two different apps with the SAME manifest name, and one app named like a product
  const real = opCtx(db, { type: "app", id: "ins_01J00000000000000000000AAA", name: "Observer", product: "observer" });
  const twin = opCtx(db, { type: "app", id: "ins_01J00000000000000000000BBB", name: "Observer", product: "evil" });
  const sub = (ctx: OpContext) => run(OP.ruleDraftSubmit)({ text: "t", rules: [spec({})] }, ctx);
  const dReal = await sub(real);
  const dTwin = await sub(twin);
  assert.deepEqual(getDraft(db, dReal.draftId)?.source, { kind: "app", product: "observer", name: "Observer", instance: "ins_01J00000000000000000000AAA" });
  assert.deepEqual(getDraft(db, dTwin.draftId)?.source, { kind: "app", product: "evil", name: "Observer", instance: "ins_01J00000000000000000000BBB" });
  assert.equal(getDraft(db, dReal.draftId)?.submittedBy.id, "observer", "the recorded identity is the product");
  // the same name does not open the other's draft; the product does, from a new instance too
  assert.equal((await run(OP.draftStatus)({ draftId: dReal.draftId }, real)).status, "pending");
  const e = await run(OP.draftStatus)({ draftId: dReal.draftId }, twin).catch((x) => x);
  assert.equal(e.code, "not_found");
  const reinstalled = opCtx(db, { type: "app", id: "ins_01J00000000000000000000CCC", name: "Renamed", product: "observer" });
  assert.equal((await run(OP.draftStatus)({ draftId: dReal.draftId }, reinstalled)).status, "pending", "same product, other instance and name");
  // the pending-draft cap counts per product, not per name
  const cap = opCtx(db, { type: "app", id: "ins_01J00000000000000000000DDD", name: "Observer", product: "capped" });
  for (let i = 0; i < 20; i++) await sub(cap).catch(() => undefined);
  const over = await sub(cap).catch((x) => x);
  assert.equal(over.code, "too_many_drafts");
  assert.equal((await sub(opCtx(db, { type: "app", id: "ins_01J00000000000000000000EEE", name: "Observer", product: "other2" }))).status, "pending", "another product with the same name is not capped");
  // the listing output still validates against the manifest
  const listed = (await run(OP.draftsList)({}, owner)).drafts;
  const listOp = manifest.operations.find((o) => o.id === "drafts_list");
  assert.equal(validateAgainstSchema(listOp?.output as never, { drafts: listed } as Json).ok, true);
});

test("an app caller with no verified product fails closed: no product is recorded or matched, whatever its name says", async () => {
  const { db } = migratedDb();
  // the real "fleet" app: verified product fleet
  const real = opCtx(db, { type: "app", id: "ins_01J00000000000000000000FLT", name: "Governance", product: "fleet" });
  const dReal = await run(OP.ruleDraftSubmit)({ text: "t", rules: [spec({})] }, real);
  // another app with no verified product, whose manifest name AND instance claim to be "fleet"
  const noProduct = opCtx(db, { type: "app", id: "ins_01J00000000000000000000NOP", name: "fleet" });
  const empty = opCtx(db, { type: "app", id: "ins_01J00000000000000000000EMP", name: "fleet", product: "" });
  const dNo = await run(OP.ruleDraftSubmit)({ text: "t", rules: [spec({})] }, noProduct);
  const dEmpty = await run(OP.ruleDraftSubmit)({ text: "t", rules: [spec({})] }, empty);
  // it runs (a draft is only a proposal), but no product is recorded: the owner sees an unverified app
  assert.deepEqual(getDraft(db, dNo.draftId)?.source, { kind: "app", name: "fleet", instance: "ins_01J00000000000000000000NOP" });
  assert.deepEqual(getDraft(db, dEmpty.draftId)?.source, { kind: "app", name: "fleet", instance: "ins_01J00000000000000000000EMP" });
  assert.equal(getDraft(db, dNo.draftId)?.submittedBy.id, "ins_01J00000000000000000000NOP", "keyed by the verified instance id, never by the name");
  // it cannot read the verified app's draft (same not_found as a missing id), and the verified app cannot read its drafts
  for (const [who, id] of [[noProduct, dReal.draftId], [empty, dReal.draftId], [real, dNo.draftId]] as const) {
    const e = await run(OP.draftStatus)({ draftId: id }, who).catch((x: unknown) => x);
    assert.equal((e as { code: string }).code, "not_found");
  }
  assert.equal((await run(OP.draftStatus)({ draftId: dNo.draftId }, noProduct)).status, "pending", "its own draft, by its instance id");
});

test("unverified apps share ONE pending cap: a reinstall (new instance id) cannot reset it; an agent and an app with the same id do not share a cap", async () => {
  const { db } = migratedDb();
  const sub = (ctx: OpContext) => run(OP.ruleDraftSubmit)({ text: "t", rules: [spec({})] }, ctx);
  const unverified = (n: number) => opCtx(db, { type: "app", id: `ins_01J0000000000000000000${String(n).padStart(4, "0")}`, name: "Observer" });
  for (let i = 0; i < 20; i++) await sub(unverified(i));
  // a reinstall = a new instance id: still capped; so is any other unverified app, whatever its name
  const again = await sub(unverified(99)).catch((x: unknown) => x);
  assert.equal((again as { code: string }).code, "too_many_drafts");
  assert.equal(((await sub(opCtx(db, { type: "app", id: "ins_01J00000000000000000000ZZZ", name: "Other" })).catch((x: unknown) => x)) as { code: string }).code, "too_many_drafts");
  // a verified app is not affected by the unverified cap, and an agent neither
  assert.equal((await sub(opCtx(db, { type: "app", id: "ins_01J00000000000000000000VER", name: "Observer", product: "observer" }))).status, "pending");
  assert.equal((await sub(opCtx(db, { type: "agent", id: AGENT_A }))).status, "pending");
  // the cap is per type: an agent and an app (verified product) with the SAME id string do not share it
  for (let i = 0; i < 20; i++) await sub(opCtx(db, { type: "agent", id: "agt_shared" }));
  assert.equal(((await sub(opCtx(db, { type: "agent", id: "agt_shared" })).catch((x: unknown) => x)) as { code: string }).code, "too_many_drafts");
  assert.equal((await sub(opCtx(db, { type: "app", id: "ins_01J00000000000000000000SHR", name: "x", product: "agt_shared" }))).status, "pending", "an agent id equal to a product id: other type, other cap");
});

test("a product that is not a valid product id is no verified product (defence in depth)", async () => {
  const { db } = migratedDb();
  const bad = ["", "Fleet", " fleet", "fleet ", "fl/eet", "../fleet", "-fleet", "_fleet", "flêet", "fleet\u202e", "a".repeat(41)];
  for (const [i, product] of bad.entries()) {
    const ctx = opCtx(db, { type: "app", id: `ins_01J0000000000000000000B${String(i).padStart(3, "0")}`, name: "fleet", product });
    const d = await run(OP.ruleDraftSubmit)({ text: "t", rules: [spec({})] }, ctx);
    const src = getDraft(db, d.draftId)?.source;
    assert.equal(src?.product, undefined, `product ${JSON.stringify(product)} is not verified`);
    assert.equal(getDraft(db, d.draftId)?.submittedBy.id, `ins_01J0000000000000000000B${String(i).padStart(3, "0")}`);
  }
  for (const [i, product] of ["fleet", "a", "my-app_2", "a".repeat(40)].entries()) {
    const d = await run(OP.ruleDraftSubmit)({ text: "t", rules: [spec({})] }, opCtx(db, { type: "app", id: `ins_01J0000000000000000000G${String(i).padStart(3, "0")}`, name: "n", product }));
    assert.equal(getDraft(db, d.draftId)?.source.product, product);
  }
});

test("rules_explain for an app answers for the decisions recorded under its (verified) instance id", async () => {
  const { db } = migratedDb();
  const ins = "ins_01J00000000000000000000XPL";
  const app = opCtx(db, { type: "app", id: ins, name: "Explainer", product: "explainer" });
  const facts = (id: string): CallFacts => ({ caller: { type: "app", id, mode: null }, target: { product: "connect", op: "tools", effect: "outward" }, claim: null, claimVerified: false, claimTeams: [], claimTeamsAny: [], callerTeams: [], callerTeamsAny: [], claimTrusts: [], claimTrustActive: true, fleetAvailable: true, callerProduct: null });
  const rec = (callId: string, id: string) =>
    recordDecision(db, { callId, phase: "before", facts: facts(id), decision: "allow", answered: "allow", reason: "no rule", rule: null, durationUs: 1 });
  rec("cal_mine", ins);
  rec("cal_other", "ins_01J00000000000000000000OTH");
  const mine = await run(OP.rulesExplain)({}, app);
  assert.deepEqual(mine.decisions.map((d: { callId: string }) => d.callId), ["cal_mine"]);
});

// ── migrations: the upgrade from a 0.2.12-shaped database ────────────────────────────────────────────────────
test("released migrations 0001 and 0002 are byte-for-byte what 0.2.12 shipped", () => {
  const sums = Object.fromEntries(["0001_init.sql", "0002_catalog.sql"].map((f) => [f, sha256(readFileSync(join(migrationsDir, f), "utf8"))]));
  assert.deepEqual(sums, {
    "0001_init.sql": "6386d3c572cd7a8c678a8b3d4ad18fdf228cc73a865456ab0ac236399b177a32",
    "0002_catalog.sql": "77879e04075f37575b37a285a4f4dfe7243a62756bd946c7a588846058184c79",
  });
  assert.deepEqual(readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort(), ["0001_init.sql", "0002_catalog.sql", "0003_feed.sql", "0004_feed_sets.sql", "0005_feed_holders.sql", "0006_caller_product.sql", "0007_revision_restored_from.sql", "0008_default_mode.sql"]);
});

test("upgrade from a 0.2.12 database: rules, drafts and decisions stay; the old Fleet copy is cleared and unusable; old drafts get a derived source", () => {
  const raw = new DatabaseSync(":memory:");
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files.filter((x) => x < "0003")) raw.exec(readFileSync(join(migrationsDir, f), "utf8"));
  // 0.2.12-shaped data
  raw.exec(`
    INSERT INTO rules (id, rev, spec, priority, active, deleted, source, created_at, updated_at) VALUES ('rul_old', 1, '{"title":"old","active":true,"priority":1,"match":{"onBehalfOf":{"teams":["tm_x"]}},"outcome":{"decision":"hold","reason":"r"}}', 1, 1, 0, 'owner', 1, 1);
    INSERT INTO drafts (id, status, text, note, rules, submitted_by_type, submitted_by_id, submitted_by_name, submitted_at) VALUES ('drf_agent', 'pending', 't', '', '[]', 'agent', 'agt_1', 'Front desk', 5);
    INSERT INTO drafts (id, status, text, note, rules, submitted_by_type, submitted_by_id, submitted_by_name, submitted_at) VALUES ('drf_app', 'approved', 't', '', '[]', 'app', 'ins_1', 'Governance', 6);
    INSERT INTO fleet_teams (id, name, people, agents) VALUES ('tm_x', 'Team X', 1, 0);
    INSERT INTO fleet_members (team_id, member_key) VALUES ('tm_x', 'person:psn_1'), ('tm_x', 'handle:slack:U777');
    UPDATE fleet_sync SET revision = 9, synced_at = ${Date.now()}, stale = 0 WHERE id = 1;
  `);
  assert.equal(Number(raw.prepare("SELECT stale FROM fleet_sync").get()?.stale), 0, "0.2.12: a fresh, usable copy");
  for (const f of files.filter((x) => x >= "0003")) raw.exec(readFileSync(join(migrationsDir, f), "utf8"));
  const q = (sql: string) => raw.prepare(sql).all() as Record<string, unknown>[];
  assert.equal(q("SELECT id FROM rules")[0]?.id, "rul_old", "rules stay");
  assert.equal(q("SELECT id FROM drafts").length, 2, "drafts stay");
  assert.equal(q("SELECT * FROM fleet_members").length + q("SELECT * FROM fleet_teams").length, 0, "person:<id> keys are gone");
  const sync = q("SELECT revision, synced_at, stale, usable FROM fleet_sync")[0];
  assert.deepEqual({ ...sync }, { revision: null, synced_at: null, stale: 1, usable: 0 }, "the next read is a full one and the facts are unavailable until it succeeds");
  assert.deepEqual(q("SELECT * FROM fleet_trust"), []);
  assert.throws(() => raw.exec("INSERT INTO fleet_trust (member_key, trusts, all_active) VALUES ('contact:x', '', 1)"), /CHECK/);
  assert.equal(q("SELECT source FROM drafts WHERE id = 'drf_app'")[0]?.source, null);
  // through the store: a derived source, and the old hold rule is fail-closed until the first feed read
  const db = {
    exec: (s: string) => raw.exec(s),
    prepare: (s: string) => raw.prepare(s),
    transaction<T>(fn: () => T): T {
      raw.exec("BEGIN");
      const out = fn();
      raw.exec("COMMIT");
      return out;
    },
  } as never;
  assert.deepEqual(getDraft(db, "drf_app")?.source, { kind: "app", name: "Governance", instance: "ins_1" });
  assert.deepEqual(getDraft(db, "drf_agent")?.source, { kind: "agent" });
  assert.equal(fleetFacts(db).available, false);
});
