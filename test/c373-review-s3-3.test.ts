// Review 0.5.0 S3-3: draft priorities were frozen at compose (or submit) time. An owner deny added after the draft (or an inactive
// deny activated later) was skipped by the approved allow. Approval now places every draft rule again against the CURRENT rules,
// active and inactive, and the Drafts page shows the final priority before approve.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { OP } from "#kit";
import { handlers } from "../src/app.ts";
import { type CallFacts, evaluate, type RuleSpec } from "../src/engine.ts";
import { mayOverlap, placeDraft } from "../src/placement.ts";
import { decideDraft, liveRules, saveRule, submitDraft } from "../src/store.ts";
import { AGENT_A, AGENT_B, migratedDb, OWNER, opCtx, spec } from "./helpers.ts";

type Run = (input: unknown, ctx: OpContext) => Promise<any>;
const run = (id: keyof typeof handlers) => (handlers[id] as unknown as { run: Run }).run;
const by = { type: "agent", id: AGENT_A, name: "Hermes" };
const facts = (effect: string, caller = AGENT_A): CallFacts => ({ caller: { type: "agent", id: caller, mode: "free" }, target: { product: "connect", op: "buzz_dm", effect }, claim: null, claimVerified: false, claimTeams: [], claimTeamsAny: [], callerTeams: [], callerTeamsAny: [], claimTrusts: [], claimTrustActive: true, fleetAvailable: true, callerProduct: null });
const allowSends = spec({ title: "Allow Hermes to send", priority: 20, match: { agents: [AGENT_A], effects: ["outward"] }, decision: "allow" });

test("S3-3: a deny added after the draft was written still applies: the approved allow is placed after it", () => {
  const { db } = migratedDb();
  saveRule(db, { spec: spec({ title: "old deny", priority: 10, match: { effects: ["money"] }, decision: "deny" }), actor: OWNER });
  const d = submitDraft(db, { text: "Allow Hermes to send messages", rules: [allowSends], by });
  // the owner adds a deny after the draft was written
  saveRule(db, { spec: spec({ title: "no sends by Hermes", priority: 50, match: { agents: [AGENT_A], effects: ["outward"] }, decision: "deny" }), actor: OWNER });
  decideDraft(db, { id: d.id, decision: "approve", actor: OWNER });
  const allow = liveRules(db).find((r) => r.spec.title === "Allow Hermes to send") as { spec: RuleSpec };
  assert.equal(allow.spec.priority, 51);
  assert.equal(evaluate(liveRules(db), facts("outward")).decision, "deny", "the new deny is not skipped");
});

test("S3-3: inactive deny/hold rules count (re-activating one later must not be weakened); an agent's priority 0 allow is moved", () => {
  const { db } = migratedDb();
  saveRule(db, { spec: { ...spec({ title: "paused deny", priority: 30, match: { effects: ["outward"] }, decision: "deny" }), active: false }, actor: OWNER });
  const d = submitDraft(db, { text: "x", rules: [{ ...allowSends, priority: 0 }], by });
  decideDraft(db, { id: d.id, decision: "approve", actor: OWNER });
  const rules = liveRules(db);
  const allow = rules.find((r) => r.spec.outcome.decision === "allow") as { spec: RuleSpec };
  assert.equal(allow.spec.priority, 31);
  // re-activate the deny: it still decides Hermes's sends
  const paused = rules.find((r) => r.spec.title === "paused deny") as { id: string; rev: number; spec: RuleSpec };
  saveRule(db, { id: paused.id, expectedRev: paused.rev, spec: { ...paused.spec, active: true }, actor: OWNER });
  assert.equal(evaluate(liveRules(db), facts("outward")).decision, "deny");
});

test("S3-3: a draft hold goes after an overlapping deny (its own or an existing one); a rule that cannot overlap is not moved", () => {
  const hold = spec({ title: "hold Hermes", priority: 10, match: { agents: [AGENT_A] }, decision: "hold" });
  const deny = spec({ title: "deny Hermes money", priority: 10, match: { agents: [AGENT_A], effects: ["money"] }, decision: "deny" });
  // the draft's own deny and hold tie at 10: the hold goes after it, so the deny is never weakened
  const own = placeDraft([hold, deny], []);
  assert.deepEqual(own.places.map((p) => p.priority), [11, 10]);
  assert.match(own.places[0]?.why ?? "", /never weakens it/);
  // an allow for another agent cannot overlap a deny for Hermes: it keeps its priority
  const other = spec({ title: "allow CEO", priority: 5, match: { agents: [AGENT_B] }, decision: "allow" });
  assert.equal(placeDraft([other], [deny]).places[0]?.priority, 5);
  assert.equal(mayOverlap({ agents: [AGENT_A] }, { agents: [AGENT_B] }), false);
  assert.equal(mayOverlap({ agents: [AGENT_A] }, { effects: ["money"] }), true);
  assert.equal(mayOverlap({ effects: ["read"] }, { effects: ["money", "write"] }), false);
  // a refuse is never moved earlier (that could override an owner's exception), but the allow before it is named
  const allowFirst = placeDraft([deny], [spec({ title: "owner exception", priority: 5, match: { agents: [AGENT_A] }, decision: "allow" })]);
  assert.equal(allowFirst.places[0]?.priority, 10);
  assert.match(allowFirst.places[0]?.why ?? "", /owner exception.*runs before it/);
});

test("S3-3: no room after a deny at 1000 → approval refused (409 draft_no_room), nothing saved", () => {
  const { db } = migratedDb();
  saveRule(db, { spec: spec({ title: "last deny", priority: 1000, match: { effects: ["outward"] }, decision: "deny" }), actor: OWNER });
  const d = submitDraft(db, { text: "x", rules: [allowSends], by });
  assert.throws(() => decideDraft(db, { id: d.id, decision: "approve", actor: OWNER }), (e: { code?: string; httpStatus?: number; message?: string }) => e.code === "draft_no_room" && e.httpStatus === 409 && /no priority after 1000/.test(e.message ?? ""));
  assert.equal(liveRules(db).length, 1);
});

test("S3-3: drafts_list shows the final priority (and why) of each rule of a pending draft before approve", async () => {
  const { db } = migratedDb();
  const d = submitDraft(db, { text: "x", rules: [allowSends], by });
  saveRule(db, { spec: spec({ title: "no sends", priority: 50, match: { effects: ["outward"] }, decision: "hold" }), actor: OWNER });
  const owner = opCtx(db, { type: "person", id: OWNER, name: "Martin" });
  const out = await run(OP.draftsList)({}, owner);
  const row = out.drafts.find((x: { id: string }) => x.id === d.id);
  assert.deepEqual(row.places, [{ priority: 51, from: 20, why: "Moved from priority 20 to 51: after “no sends” (priority 50), so it never skips it." }]);
  assert.equal(row.placeProblem, undefined);
});
