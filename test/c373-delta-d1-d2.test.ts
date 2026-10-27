// Delta re-check 0f5d25c, D-1 and D-2: approval placement moved a draft HOLD behind an existing ALLOW (the hold then did less than
// written, with a note that said it "never weakens" anything), and a draft ALLOW WITH A NARROWING behind a broader allow (narrowing lost).
// Now such a move is refused with 409 `draft_no_room` and a plain reason; where a slot exists the rule moves only as far as needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { OP } from "#kit";
import { handlers } from "../src/app.ts";
import { type CallFacts, evaluate, order, type Rule, type RuleSpec } from "../src/engine.ts";
import { narrowsAtLeast, placeDraft } from "../src/placement.ts";
import { decideDraft, liveRules, saveRule, submitDraft } from "../src/store.ts";
import { AGENT_A as A, AGENT_B as B, migratedDb, OWNER, opCtx, seedCatalog, spec } from "./helpers.ts";

type Run = (input: unknown, ctx: OpContext) => Promise<any>;
const run = (id: keyof typeof handlers) => (handlers[id] as unknown as { run: Run }).run;
const r = (title: string, priority: number, decision: RuleSpec["outcome"]["decision"], match: RuleSpec["match"], extra: Partial<RuleSpec> = {}): RuleSpec => spec({ title, priority, match, decision, ...extra });
const facts = (caller: string, o: Partial<CallFacts["target"]> = {}): CallFacts => ({
  caller: { type: "agent", id: caller, mode: "free" },
  target: { product: "connect", op: "pay", effect: "money", ...o },
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
  recipients: [],
});
const rules = (specs: RuleSpec[]): Rule[] => order(specs.map((s, i) => ({ id: s.title, rev: 1, spec: s, updatedAt: i })));
const by = { type: "agent", id: A, name: "Hermes" };

const denyA = r("deny A money", 50, "deny", { agents: [A], effects: ["money"] });
const allowB = r("allow B money", 30, "allow", { agents: [B], effects: ["money"] });
const holdAll = r("hold all money", 10, "hold", { effects: ["money"] });

test("D-1 (probe DELTA-1): a draft hold that must move behind a deny does not go behind an allow it was ahead of: no room, plain reason", () => {
  const plan = placeDraft([holdAll], [denyA, allowB]);
  assert.match(plan.problem, /^This draft cannot be applied: rule 1 \(“hold all money”\) is a hold rule\./);
  assert.match(plan.problem, /“deny A money” \(priority 50\)/);
  assert.match(plan.problem, /“allow B money” \(priority 30\)/);
  assert.match(plan.problem, /Change the priority of one of these rules first\.$/);
});

test("D-1: through approval: 409 draft_no_room, nothing saved; drafts_list shows the problem before approve", async () => {
  const { db } = migratedDb();
  saveRule(db, { spec: denyA, actor: OWNER });
  saveRule(db, { spec: allowB, actor: OWNER });
  const d = submitDraft(db, { text: "x", rules: [holdAll], by });
  assert.throws(() => decideDraft(db, { id: d.id, decision: "approve", actor: OWNER }), (e: { code?: string; httpStatus?: number; message?: string }) => e.code === "draft_no_room" && e.httpStatus === 409 && /allow B money/.test(e.message ?? ""));
  assert.equal(liveRules(db).length, 2);
  const out = await run(OP.draftsList)({}, opCtx(db, { type: "person", id: OWNER }));
  assert.match(out.drafts.find((x: { id: string }) => x.id === d.id).placeProblem, /would decide first/);
});

test("D-1: inactive allow rules count too (re-activating one later must not skip the hold)", () => {
  const paused = { ...allowB, active: false };
  assert.match(placeDraft([holdAll], [denyA, paused]).problem, /allow B money/);
});

test("D-1: where a slot exists the hold moves only past the deny and keeps its promise (as written == after approval)", () => {
  const farAllow = r("allow B money late", 80, "allow", { agents: [B], effects: ["money"] });
  const plan = placeDraft([holdAll], [denyA, farAllow]);
  assert.equal(plan.problem, "");
  assert.equal(plan.specs[0]?.priority, 51);
  assert.match(plan.places[0]?.why ?? "", /never weakens it/);
  // B (no deny for B): as written hold, after approval hold. A: the move is what keeps A's deny a deny (as written the hold weakened it).
  const approvedSpecs = [denyA, farAllow, plan.specs[0] as RuleSpec];
  assert.equal(evaluate(rules([denyA, farAllow, holdAll]), facts(B)).decision, "hold");
  assert.equal(evaluate(rules(approvedSpecs), facts(B)).decision, "hold");
  assert.equal(evaluate(rules(approvedSpecs), facts(A)).decision, "deny");
});

test("D-1: an allow that cannot overlap the hold, or that was already ahead of it as written, does not block the move", () => {
  const otherEffect = r("allow B reads", 30, "allow", { agents: [B], effects: ["read"] });
  assert.equal(placeDraft([holdAll], [denyA, otherEffect]).problem, "");
  const ahead = r("owner exception", 5, "allow", { agents: [B], effects: ["money"] });
  const plan = placeDraft([holdAll], [denyA, ahead]);
  assert.equal(plan.problem, "");
  assert.equal(plan.specs[0]?.priority, 51, "the exception was ahead of the hold as written and stays ahead");
});

const holdExport = r("hold knowledge export", 50, "hold", { products: ["knowledge"], operations: ["export"] });
const broad = r("allow reads", 30, "allow", { effects: ["read"] });
const narrow = r("B reads work only", 20, "allow", { agents: [B], effects: ["read"] }, { narrowing: { memoryTags: { anyOf: ["work"] } } });

test("D-2 (probe DELTA-2): a draft allow with a narrowing does not go behind a broader allow: no room, plain reason", () => {
  const plan = placeDraft([narrow], [holdExport, broad]);
  assert.match(plan.problem, /^This draft cannot be applied: rule 1 \(“B reads work only”\) is an allow rule\./);
  assert.match(plan.problem, /“hold knowledge export” \(priority 50\)/);
  assert.match(plan.problem, /“allow reads” \(priority 30\)/);
  assert.match(plan.problem, /limits/);
});

test("D-2: through approval: 409 draft_no_room, nothing saved", () => {
  const { db } = migratedDb();
  seedCatalog(db, ["knowledge"]);
  saveRule(db, { spec: { ...holdExport, match: { products: ["knowledge"] } }, actor: OWNER });
  saveRule(db, { spec: broad, actor: OWNER });
  const d = submitDraft(db, { text: "x", rules: [narrow], by });
  assert.throws(() => decideDraft(db, { id: d.id, decision: "approve", actor: OWNER }), (e: { code?: string }) => e.code === "draft_no_room");
  assert.equal(liveRules(db).length, 2);
});

test("D-2: an allow WITHOUT narrowing still moves (nothing is lost); a stricter or equal existing allow does not block; a wider one does", () => {
  const plain = { ...narrow, narrowing: undefined } as RuleSpec;
  assert.equal(placeDraft([plain], [holdExport, broad]).problem, "");
  const stricter = r("allow reads, work and private", 30, "allow", { effects: ["read"] }, { narrowing: { memoryTags: { anyOf: ["work"], noneOf: ["private"] } } });
  const plan = placeDraft([narrow], [holdExport, stricter]);
  assert.equal(plan.problem, "");
  assert.equal(plan.specs[0]?.priority, 51);
  const wider = r("allow reads, work and play", 30, "allow", { effects: ["read"] }, { narrowing: { memoryTags: { anyOf: ["work", "play"] } } });
  assert.match(placeDraft([narrow], [holdExport, wider]).problem, /allow reads, work and play/);
  // after approval the narrowing the call gets is the one that was written (equal or stricter)
  const f = facts(B, { product: "knowledge", op: "search", effect: "read" });
  const asWritten = evaluate(rules([holdExport, stricter, narrow]), f).narrowing;
  const approved = evaluate(rules([holdExport, stricter, plan.specs[0] as RuleSpec]), f).narrowing;
  assert.deepEqual(approved?.memoryTags?.anyOf, ["work"]);
  assert.deepEqual(asWritten?.memoryTags?.anyOf, ["work"]);
});

test("D-2: narrowsAtLeast compares lists (tags and datasets)", () => {
  const w = { memoryTags: { anyOf: ["work"] } };
  assert.equal(narrowsAtLeast(undefined, w), false);
  assert.equal(narrowsAtLeast(w, undefined), true);
  assert.equal(narrowsAtLeast(w, w), true);
  assert.equal(narrowsAtLeast({ memoryTags: { anyOf: ["work", "play"] } }, w), false);
  assert.equal(narrowsAtLeast({ memoryTags: { anyOf: [] } }, w), true, "anyOf [] passes nothing: stricter");
  assert.equal(narrowsAtLeast({ memoryTags: { noneOf: ["x"] } }, w), false);
  assert.equal(narrowsAtLeast({ deepDatasets: { anyOf: ["a"] } }, { deepDatasets: { anyOf: ["a", "b"] } }), true);
  assert.equal(narrowsAtLeast({ deepDatasets: { anyOf: ["a", "b"] } }, { deepDatasets: { anyOf: ["a"] } }), false);
});
