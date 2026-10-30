// Delta re-check 0f5d25c, D-3: an empty match list (`agents: []`) means "any" in the engine, so a model "allow everything" passed the
// add-only guard. Writers now refuse any empty list in `match`; the manifest input schemas say `minItems: 1`; a stored legacy rule with
// `[]` keeps working (readers are tolerant, the output schemas have no `minItems`); the model merge refuses an allow that names nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { OP } from "#kit";
import { handlers, mergeModelDraft } from "../src/app.ts";
import { emptyListProblem, emptyLists, evaluate, matchesEverything, type RuleSpec } from "../src/engine.ts";
import { decideDraft, getRule, liveRules, restoreRule, saveRule, submitDraft } from "../src/store.ts";
import manifest from "../tealbrick.manifest.json" with { type: "json" };
import { AGENT_A, migratedDb, OWNER, opCtx, spec } from "./helpers.ts";

type Run = (input: unknown, ctx: OpContext) => Promise<any>;
const run = (id: keyof typeof handlers) => (handlers[id] as unknown as { run: Run }).run;
const LISTS: Record<string, unknown> = {
  agents: [],
  products: [],
  operations: [],
  effects: [],
  tools: [],
  modes: [],
  callerTeams: [],
  callerTrust: [],
  callerProducts: [],
  callerWorkflows: [],
};
const NESTED: [string, string][] = [["onBehalfOf", "teams"], ["onBehalfOf", "ids"], ["onBehalfOf", "kinds"], ["onBehalfOf", "trust"], ["recipients", "teams"], ["recipients", "trust"]];
const by = { type: "agent", id: AGENT_A, name: "Hermes" };
const bad = (match: unknown): RuleSpec => spec({ title: "empty list", match: match as RuleSpec["match"], decision: "allow" });

test("D-3: every writer refuses every empty match list, with a plain message", async () => {
  const cases: [string, unknown][] = [...Object.entries(LISTS).map(([k, v]) => [k, { [k]: v }] as [string, unknown]), ...NESTED.map(([a, b]) => [`${a}.${b}`, { [a]: { [b]: [] } }] as [string, unknown])];
  for (const [name, match] of cases) {
    const { db } = migratedDb();
    const s = bad(match);
    assert.match(emptyListProblem(s), new RegExp(`match\\.${name.replace(".", "\\.")} is an empty list`), name);
    const refused = (e: { code?: string; message?: string }) => e.code === "input_invalid" && e.message?.includes(`match.${name}`) === true;
    assert.throws(() => saveRule(db, { spec: s, actor: OWNER }), refused, `rules_set ${name}`);
    assert.throws(() => submitDraft(db, { text: "x", rules: [s], by }), refused, `rule_draft_submit ${name}`);
    await assert.rejects(run(OP.ruleComposeSave)({ text: "x", rules: [s] }, opCtx(db, { type: "person", id: OWNER })), refused, `rule_compose_save ${name}`);
    await assert.rejects(run(OP.rulesSet)({ rule: s }, opCtx(db, { type: "person", id: OWNER })), refused, `rules_set op ${name}`);
  }
});

test("D-3: restore and approve refuse an old revision / draft with an empty list; nothing is saved", () => {
  const { db, raw } = migratedDb();
  const fine = saveRule(db, { spec: spec({ title: "fine", match: { agents: [AGENT_A] } }), actor: OWNER });
  // an old revision and an old pending draft written before the fix (inserted raw: the writers would refuse them now)
  const legacy = JSON.stringify(bad({ agents: [] }));
  raw.prepare("INSERT INTO rule_revisions (rule_id, rev, change, spec, actor, at) VALUES (?, 0, 'created', ?, ?, 1)").run(fine.id, legacy, OWNER);
  assert.throws(() => restoreRule(db, { id: fine.id, rev: 0, actor: OWNER }), (e: { code?: string; message?: string }) => e.code === "input_invalid" && /match\.agents is an empty list/.test(e.message ?? ""));
  const d = submitDraft(db, { text: "x", rules: [spec({ title: "ok", match: { agents: [AGENT_A] } })], by });
  raw.prepare("UPDATE drafts SET rules = ? WHERE id = ?").run(JSON.stringify([bad({ agents: [] })]), d.id);
  assert.throws(() => decideDraft(db, { id: d.id, decision: "approve", actor: OWNER }), (e: { code?: string; message?: string }) => e.code === "draft_never_matches" && /match\.agents is an empty list/.test(e.message ?? ""));
  assert.equal(liveRules(db).length, 1);
});

test("D-3: a stored legacy rule with [] keeps matching and is listed without error (readers are tolerant)", async () => {
  const { db, raw } = migratedDb();
  const r = saveRule(db, { spec: spec({ title: "ok", match: { agents: [AGENT_A] } }), actor: OWNER });
  raw.prepare("UPDATE rules SET spec = ? WHERE id = ?").run(JSON.stringify(spec({ title: "legacy", match: { agents: [] }, decision: "deny" })), r.id);
  const { invalidateRules } = await import("../src/store.ts");
  invalidateRules(db);
  const v = evaluate(liveRules(db), { caller: { type: "agent", id: AGENT_A, mode: "free" }, target: { product: "connect", op: "pay", effect: "money" }, claim: null, claimVerified: false, claimTeams: [], claimTeamsAny: [], callerTeams: [], callerTeamsAny: [], claimTrusts: [], claimTrustActive: true, fleetAvailable: true, callerProduct: null, recipients: [] } as never);
  assert.equal(v.decision, "deny", "the old rule still matches every call");
  const listed = await run(OP.rulesList)({}, opCtx(db, { type: "person", id: OWNER }));
  assert.equal(listed.rules[0].problem, null, "not flagged as never matching");
  assert.deepEqual(emptyLists(getRule(db, r.id).rule.spec.match), ["agents"]);
});

test("D-3: manifest input schemas have minItems 1 on every match array (all input copies identical); output copies stay tolerant", () => {
  const ops = (manifest as unknown as { operations: { id: string; input?: any; output?: any }[] }).operations;
  const inputs = ops.filter((o) => o.input?.$defs?.RuleSpec);
  assert.deepEqual(inputs.map((o) => o.id), ["rules_set", "rules_preview", "rules_preview_recent", "rule_draft_submit", "rule_compose_save"]);
  assert.equal(new Set(inputs.map((o) => JSON.stringify(o.input.$defs.RuleSpec))).size, 1, "input copies are identical");
  const arrays = (m: any): any[] => Object.values(m.properties).flatMap((p: any) => (p.type === "array" ? [p] : p.type === "object" ? Object.values(p.properties ?? {}).filter((q: any) => q.type === "array") : []));
  for (const o of inputs) {
    const list = arrays(o.input.$defs.RuleSpec.properties.match);
    assert.equal(list.length, 17, `${o.id}: 11 match lists + 4 onBehalfOf + 2 recipients`);
    for (const a of list) assert.equal(a.minItems, 1, o.id);
  }
  const outputs = ops.filter((o) => o.output?.$defs?.RuleSpec);
  assert.equal(new Set(outputs.map((o) => JSON.stringify(o.output.$defs.RuleSpec))).size, 1, "output copies are identical");
  const loose = arrays(outputs[0]?.output.$defs.RuleSpec.properties.match).filter((a) => a.minItems !== 1);
  assert.ok(loose.length >= 14, "a legacy rule with [] must still pass the output schema of rules_list");
});

test("D-3 (probe DELTA-3): a model allow with match {agents: []} (= every call) is refused by the merge", () => {
  const drafted = { rules: [spec({ title: "allow everything", priority: 20, match: { agents: [] }, decision: "allow" })], notes: [], unmatched: [] };
  const out = mergeModelDraft({ rules: [], notes: [], unmatched: [{ text: "x", hint: "y" }] }, drafted, []);
  assert.equal(out.added, 0, "an every-call allow from the model is not proposed");
  assert.equal(out.refused.length, 1);
});

test("D-3: the model merge also refuses an allow that only has empty lists, every effect or both modes; a real match passes", () => {
  for (const match of [{}, { agents: [], products: [] }, { effects: ["read", "write", "outward", "destructive", "money"] }, { modes: ["free", "bound"] }, { onBehalfOf: { teams: [] } }]) {
    assert.equal(matchesEverything(match), true, JSON.stringify(match));
    const out = mergeModelDraft({ rules: [], notes: [], unmatched: [] }, { rules: [spec({ title: "all", match: match as RuleSpec["match"], decision: "allow" })], notes: [], unmatched: [] }, []);
    assert.equal(out.added, 0, JSON.stringify(match));
  }
  for (const match of [{ agents: [AGENT_A] }, { effects: ["read"] }, { recipients: { known: false }, effects: ["outward"] }, { products: ["connect"], agents: [] }]) assert.equal(matchesEverything(match), false, JSON.stringify(match));
  const out = mergeModelDraft({ rules: [], notes: [], unmatched: [] }, { rules: [spec({ title: "reads", match: { agents: [AGENT_A], effects: ["read"] }, decision: "allow" })], notes: [], unmatched: [] }, []);
  assert.equal(out.added, 1);
});
