// C336 RQ-2 (spec 0.1.66, SDK-API §18.5): dataset narrowing `narrowing.deepDatasets` and the match field `tools`.
// Engine: merge like memoryTags (anyOf intersect, noneOf unite, disjoint → [] = nothing passes), the local `datasetsMatch`
// contract, writer checks, `tools` matching. Hooks: the context hook emits `rules.narrowing.deepDatasets` next to
// `memoryTags` (same v 1, ruleId, reason); the gate matches `target.tool`. L34: each check is shown quiet on the good case
// AND firing on the bad case. The comparison is the local copy of the manifest helper until it is released (see engine.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAgainstSchema, validateManifest } from "@opt2-tealbrick/manifest";
import type { Json } from "@opt2-tealbrick/miniapp-sdk";
import { manifest } from "../src/app.ts";
import { type CallFacts, datasetsMatch, datasetsPass, evaluate, explain, mergeNarrowing, normalizeDataset, order, type Rule, recorded, redactionsFor, specProblem, strictestNarrowing } from "../src/engine.ts";
import { makeHooks, toolOf } from "../src/hooks.ts";
import { listDecisions, saveRule } from "../src/store.ts";
import { AGENT_A, AGENT_B, hookCtx, hookReq, migratedDb, OWNER, spec, trustFacts } from "./helpers.ts";

const rule = (id: string, s: Rule["spec"], updatedAt = 1): Rule => ({ id, rev: 1, spec: s, updatedAt });
const facts = (o: Partial<Omit<CallFacts, "caller" | "target">> & { effect?: string; product?: string; op?: string; tool?: string; dynamic?: boolean; caller?: string } = {}): CallFacts => ({
  caller: { type: "agent", id: o.caller ?? AGENT_A, mode: "free" },
  target: { product: o.product ?? "knowledge", op: o.op ?? "deep", effect: o.effect ?? "read", ...(o.tool !== undefined ? { tool: o.tool } : {}), ...(o.dynamic !== undefined ? { dynamic: o.dynamic } : {}) },
  claim: o.claim ?? null,
  claimVerified: o.claimVerified ?? false,
  claimTeams: o.claimTeams ?? [],
  claimTeamsAny: o.claimTeamsAny ?? o.claimTeams ?? [],
  callerTeams: o.callerTeams ?? [],
  callerTeamsAny: o.callerTeamsAny ?? o.callerTeams ?? [],
  ...trustFacts(o),
  fleetAvailable: o.fleetAvailable ?? true,
});

const hooks = makeHooks("rules");
const call = (id: string, ...args: unknown[]) => (hooks[id] as unknown as (...a: unknown[]) => Promise<Record<string, unknown>>)(...args);

// ── merge semantics ────────────────────────────────────────────────────────
test("deepDatasets merge: anyOf intersect, noneOf unite, normalised; disjoint anyOf → [] = nothing passes (C115)", () => {
  const a = { deepDatasets: { anyOf: ["Public.Orders", " public.customers "], noneOf: ["public.salaries"] } };
  const b = { deepDatasets: { anyOf: ["public.orders", "public.invoices"], noneOf: ["Public.Payroll", "public.salaries"] } };
  assert.deepEqual(mergeNarrowing(a, b), { deepDatasets: { anyOf: ["public.orders"], noneOf: ["public.salaries", "public.payroll"] } }, "intersection of anyOf, union of noneOf");
  const disjoint = mergeNarrowing({ deepDatasets: { anyOf: ["public.orders"] } }, { deepDatasets: { anyOf: ["public.invoices"] } });
  assert.deepEqual(disjoint, { deepDatasets: { anyOf: [] } }, "disjoint → empty anyOf");
  assert.equal(datasetsPass(["public.orders"], disjoint as { deepDatasets: { anyOf: string[] } }), false, "an empty anyOf passes nothing");
  assert.equal(datasetsPass(["public.invoices"], disjoint as { deepDatasets: { anyOf: string[] } }), false);
  // Only one side names anyOf: it stays; noneOf of the other side still unites.
  assert.deepEqual(mergeNarrowing({ deepDatasets: { anyOf: ["a.b"] } }, { deepDatasets: { noneOf: ["a.c"] } }), { deepDatasets: { anyOf: ["a.b"], noneOf: ["a.c"] } });
});

test("memoryTags and deepDatasets merge independently; a key no rule sets stays absent", () => {
  const tagsOnly = { memoryTags: { anyOf: ["work"] } };
  const setsOnly = { deepDatasets: { anyOf: ["public.orders"] } };
  assert.deepEqual(mergeNarrowing(tagsOnly, setsOnly), { memoryTags: { anyOf: ["work"] }, deepDatasets: { anyOf: ["public.orders"] } }, "both apply");
  assert.deepEqual(mergeNarrowing(tagsOnly, { memoryTags: { anyOf: ["ops"] } }), { memoryTags: { anyOf: [] } }, "tags unchanged: disjoint → []");
  const m = mergeNarrowing(tagsOnly, { memoryTags: { noneOf: ["x"] } });
  assert.equal(m?.deepDatasets, undefined, "no dataset key appears from tags-only narrowings");
  assert.equal(mergeNarrowing(null, setsOnly), setsOnly);
});

test("datasetsMatch (local copy of the manifest helper): trim + lower case; anyOf present-but-empty passes nothing; noneOf blocks", () => {
  assert.equal(normalizeDataset("  Public.Orders "), "public.orders");
  assert.equal(datasetsMatch(undefined, ["public.orders"]), true, "no narrowing = no constraint");
  assert.equal(datasetsMatch({}, ["public.orders"]), true, "absent anyOf and noneOf = no constraint");
  assert.equal(datasetsMatch({ anyOf: ["PUBLIC.orders"] }, [" public.Orders"]), true);
  assert.equal(datasetsMatch({ anyOf: ["public.orders"] }, ["public.orders", "public.customers"]), false, "EVERY named dataset must be in anyOf");
  assert.equal(datasetsMatch({ anyOf: [] }, ["public.orders"]), false, "[] passes nothing, it is not 'no constraint' (L13)");
  assert.equal(datasetsMatch({ noneOf: ["public.salaries"] }, ["public.orders", "Public.Salaries"]), false);
  assert.equal(datasetsMatch({ noneOf: ["public.salaries"] }, ["public.orders"]), true);
});

// ── the engine decides and merges ──────────────────────────────────────────
const HENRY = AGENT_A;
const henryOrders = rule(
  "rul_henry",
  spec({ title: "Henry: orders only", match: { agents: [HENRY], products: ["knowledge"] }, decision: "allow", reason: "Henry may read the orders dataset", narrowing: { deepDatasets: { anyOf: ["public.orders"] } } }),
);

test("evaluate: the owner's grant for Henry narrows deep knowledge to the datasets the rule allows; other agents are untouched", () => {
  const v = evaluate([henryOrders], facts({ caller: HENRY }));
  assert.equal(v.decision, "allow");
  assert.deepEqual(v.narrowing, { deepDatasets: { anyOf: ["public.orders"] } });
  assert.equal(v.narrowingRuleId, "rul_henry");
  const other = evaluate([henryOrders], facts({ caller: AGENT_B }));
  assert.equal(other.narrowing, null, "quiet on good: no rule for this caller, no narrowing");
  const otherApp = evaluate([henryOrders], facts({ caller: HENRY, product: "connect" }));
  assert.equal(otherApp.narrowing, null);
});

test("evaluate: narrowings of a skipped allow rule (Governance unavailable) merge strictly with the deciding rule, datasets included", () => {
  const rules = order([
    rule("rul_team", spec({ priority: 1, match: { callerTeams: ["tm_x"] }, decision: "allow", reason: "team", narrowing: { deepDatasets: { anyOf: ["public.orders", "public.invoices"] } } })),
    rule("rul_all", spec({ priority: 2, decision: "allow", reason: "all", narrowing: { deepDatasets: { anyOf: ["public.orders"], noneOf: ["public.salaries"] } } })),
  ]);
  const down = evaluate(rules, facts({ fleetAvailable: false }));
  assert.deepEqual(down.narrowing, { deepDatasets: { anyOf: ["public.orders"], noneOf: ["public.salaries"] } });
  assert.equal(down.closedOnFleet, true);
  const up = evaluate(rules, facts({ callerTeams: ["tm_x"] }));
  assert.equal(up.rule?.id, "rul_team", "the first match decides when the facts are there");
  assert.deepEqual(up.narrowing, { deepDatasets: { anyOf: ["public.orders", "public.invoices"] } });
});

test("evaluate: an unverified claim merges the narrowing of the claim rule and the base rule (datasets intersect)", () => {
  const rules = order([
    rule("rul_c", spec({ priority: 1, match: { onBehalfOf: { kinds: ["person"] } }, decision: "allow", reason: "people", narrowing: { deepDatasets: { anyOf: ["public.orders", "public.customers"] } } })),
    rule("rul_d", spec({ priority: 2, decision: "allow", reason: "all", narrowing: { deepDatasets: { anyOf: ["public.orders"] } } })),
  ]);
  const v = evaluate(rules, facts({ claim: { kind: "person", id: "psn_1" } }));
  assert.deepEqual(v.narrowing, { deepDatasets: { anyOf: ["public.orders"] } });
});

test("a deny or hold rule carries no narrowing (the writer refuses it, the engine ignores a stored one)", () => {
  const v = evaluate([rule("rul_x", spec({ decision: "deny", reason: "no", narrowing: { deepDatasets: { anyOf: ["public.orders"] } } }))], facts());
  assert.equal(v.decision, "deny");
  assert.equal(v.narrowing, null);
});

test("after-hook redaction by tags ignores a dataset-only narrowing (nothing to redact), and still works with both", () => {
  const out = { results: [{ tags: ["work"] }, { tags: ["personal"] }] };
  assert.deepEqual(redactionsFor(out, { deepDatasets: { anyOf: ["public.orders"] } }), [], "datasets are applied before the read, not by redaction");
  assert.deepEqual(redactionsFor(out, { memoryTags: { anyOf: ["work"] }, deepDatasets: { anyOf: ["public.orders"] } }), ["/results/1"]);
});

// ── writer checks ──────────────────────────────────────────────────────────
test("specProblem: deepDatasets and tools — quiet on a good rule, firing on each bad one (writer strict, L24, C115)", () => {
  const ok = spec({ decision: "allow", reason: "r", narrowing: { deepDatasets: { anyOf: ["public.orders"], noneOf: ["public.salaries"] } } });
  assert.equal(specProblem(ok), "", "good");
  assert.equal(specProblem(spec({ decision: "allow", match: { products: ["connect"], tools: ["gmail_send"] } })), "", "good tools rule");
  assert.equal(specProblem(spec({ decision: "deny", narrowing: { deepDatasets: { anyOf: ["public.orders"] } } })), "narrowing applies only to rules that allow");
  assert.equal(specProblem(spec({ decision: "allow", narrowing: { deepDatasets: {} } })), "narrowing.deepDatasets needs anyOf or noneOf");
  assert.equal(specProblem(spec({ decision: "allow", narrowing: { deepDatasets: { noneOf: [] } } })), "narrowing.deepDatasets needs anyOf or noneOf");
  assert.equal(specProblem(spec({ decision: "allow", narrowing: { deepDatasets: { anyOf: [] } } })), "narrowing.deepDatasets.anyOf needs at least one dataset", "an empty anyOf would hide every dataset");
  assert.equal(specProblem(spec({ decision: "allow", narrowing: { deepDatasets: { anyOf: ["  "] } } })), "narrowing.deepDatasets.anyOf needs at least one dataset");
  assert.equal(specProblem(spec({ decision: "allow", narrowing: { deepDatasets: { anyOf: ["public.orders", " "] } } })), "narrowing.deepDatasets names must not be blank");
  assert.equal(specProblem(spec({ decision: "allow", narrowing: { deepDatasets: { noneOf: [" "] } } })), "narrowing.deepDatasets names must not be blank");
  assert.match(specProblem(spec({ match: { tools: ["gmail_send"] } })), /tools need products/);
  assert.match(specProblem(spec({ match: { products: ["connect"], tools: [" "] } })), /tools must not be blank/);
});

// ── tools matching ─────────────────────────────────────────────────────────
const toolRule = (tools: string[], decision: "allow" | "deny" | "hold" = "deny") =>
  rule("rul_tool", spec({ title: "gate gmail send", match: { products: ["connect"], operations: ["tools"], tools }, decision, reason: "sends need the owner" }));

test("tools with a target.tool: the listed tool matches, another tool and a different case do not", () => {
  const r = toolRule(["gmail_send", "calendar_create"]);
  const at = (tool: string) => facts({ product: "connect", op: "tools", effect: "outward", dynamic: true, tool });
  assert.equal(evaluate([r], at("gmail_send")).decision, "deny", "fire-on-bad: the listed tool is refused");
  assert.equal(evaluate([r], at("calendar_create")).decision, "deny");
  const other = evaluate([r], at("gmail_read"));
  assert.equal(other.decision, "allow", "quiet-on-good: another tool of the same op passes");
  assert.equal(other.toolUnknown, false);
  assert.equal(evaluate([r], at("Gmail_Send")).decision, "allow", "tool names compare exactly");
  assert.deepEqual(
    explain([r], at("gmail_read")).map((s) => [s.matched, s.why]),
    [[false, "target tool differs"]],
  );
  // No `tools` on a rule: the tool name is irrelevant (existing rules keep matching dynamic calls).
  const plain = rule("rul_plain", spec({ match: { products: ["connect"], operations: ["tools"] }, decision: "hold", reason: "wait" }));
  assert.equal(evaluate([plain], at("gmail_send")).decision, "hold");
  assert.equal(evaluate([plain], facts({ product: "connect", op: "tools", effect: "outward", dynamic: true })).decision, "hold");
});

// Review of rules#18: a call WITHOUT target.tool. Static op: a `tools` rule never matches. Dynamic op: deny and hold rules
// APPLY (fail closed, like the Fleet facts, C236), allow rules do not. Dynamic with a tool: normal matching. Each cell quiet AND firing.
test("tools without target.tool: static op never matches; dynamic op fails closed for deny and hold, not for allow (decision matrix)", () => {
  const no = { product: "connect", effect: "outward" };
  const stat = facts({ ...no, op: "buzz_dm", dynamic: false });
  const dyn = facts({ ...no, op: "tools", dynamic: true });
  const unknown = facts({ ...no, op: "tools" }); // the catalog cannot place the op
  const rules = (decision: "allow" | "deny" | "hold") => [rule("rul_t", spec({ title: "t", match: { products: ["connect"], tools: ["gmail_send"] }, decision, reason: "tool rule" }))];
  for (const decision of ["deny", "hold"] as const) {
    // static op, no tool: quiet
    const s = evaluate(rules(decision), stat);
    assert.equal(s.decision, "allow", `${decision}: static op without a tool is not matched`);
    assert.equal(s.rule, null);
    assert.equal(s.toolUnknown, false);
    // dynamic op, no tool: fire
    const d = evaluate(rules(decision), dyn);
    assert.equal(d.decision, decision, `${decision}: dynamic op without a tool applies (fail closed)`);
    assert.equal(d.toolUnknown, true);
    assert.equal(d.closedOnFleet, false, "the Fleet flag is its own");
    assert.equal(recorded(dyn, d), true, "the decision is recorded");
    // an op the catalog cannot place counts as dynamic: fire
    assert.equal(evaluate(rules(decision), unknown).decision, decision, `${decision}: unplaced op without a tool applies`);
    // dynamic op, a tool: normal matching (fire on the listed tool, quiet on another)
    const hit = evaluate(rules(decision), { ...dyn, target: { ...dyn.target, tool: "gmail_send" } });
    assert.equal(hit.decision, decision);
    assert.equal(hit.toolUnknown, false, "a known tool is not 'unknown'");
    assert.equal(evaluate(rules(decision), { ...dyn, target: { ...dyn.target, tool: "gmail_read" } }).decision, "allow");
  }
  // allow rules with tools: never matched without a tool, on a static or a dynamic op
  for (const f of [stat, dyn, unknown]) {
    const a = evaluate(rules("allow"), f);
    assert.equal(a.rule, null, "an allow rule with tools does not match without a tool");
    assert.equal(a.toolUnknown, false);
  }
  assert.equal(evaluate(rules("allow"), { ...dyn, target: { ...dyn.target, tool: "gmail_send" } }).rule?.id, "rul_t", "allow rule with the listed tool: matched");
  assert.equal(evaluate(rules("allow"), { ...dyn, target: { ...dyn.target, tool: "gmail_read" } }).rule, null);
  // explain says why
  assert.deepEqual(explain(rules("deny"), dyn).map((x) => [x.matched, x.why]), [[true, "matches: the call names no tool, so this rule applies (fail closed)"]]);
  assert.deepEqual(explain(rules("deny"), stat).map((x) => [x.matched, x.why]), [[false, "call has no tool name (static operation)"]]);
  assert.deepEqual(explain(rules("allow"), dyn).map((x) => [x.matched, x.why]), [[false, "call has no tool name"]]);
});

test("tools without target.tool: the closed rule joins the severity scan (a later deny beats an earlier closed hold; a fact-free allow after it does not lift it)", () => {
  const dyn = facts({ product: "connect", op: "tools", effect: "outward", dynamic: true });
  const tl = (id: string, priority: number, decision: "allow" | "deny" | "hold") => rule(id, spec({ priority, match: { products: ["connect"], tools: ["gmail_send"] }, decision, reason: id }));
  const plain = (id: string, priority: number, decision: "allow" | "deny" | "hold") => rule(id, spec({ priority, match: { products: ["connect"] }, decision, reason: id }));
  assert.equal(evaluate(order([tl("rul_h", 1, "hold"), plain("rul_a", 2, "allow")]), dyn).rule?.id, "rul_h", "closed hold before a plain allow still holds");
  assert.equal(evaluate(order([tl("rul_h", 1, "hold"), plain("rul_d", 2, "deny")]), dyn).rule?.id, "rul_d", "the later deny is stricter");
  assert.equal(evaluate(order([plain("rul_a", 1, "allow"), tl("rul_d", 2, "deny")]), dyn).decision, "allow", "the first fact-free match decides when it comes first");
});

test("tools: strictestNarrowing (after-hook without a pin) skips a rule whose tools cannot match the call", () => {
  const r = rule("rul_t", spec({ match: { products: ["knowledge"], tools: ["deep_query"] }, decision: "allow", reason: "r", narrowing: { deepDatasets: { anyOf: ["public.orders"] } } }));
  assert.deepEqual(strictestNarrowing([r], facts({ tool: "deep_query" })), { deepDatasets: { anyOf: ["public.orders"] } });
  assert.equal(strictestNarrowing([r], facts({ tool: "deep_other" })), null);
  assert.equal(strictestNarrowing([r], facts()), null);
});

test("toolOf: only a non-empty string of at most 128 characters counts as the tool name", () => {
  const req = (tool: unknown) => ({ call: { target: { tool } } }) as unknown as Parameters<typeof toolOf>[0];
  assert.equal(toolOf(req("gmail_send")), "gmail_send");
  assert.equal(toolOf(req(undefined)), undefined);
  assert.equal(toolOf(req("")), undefined);
  assert.equal(toolOf(req(7)), undefined);
  assert.equal(toolOf(req("x".repeat(129))), undefined);
  assert.equal(toolOf(req("x".repeat(128))), "x".repeat(128));
});

// ── hooks ──────────────────────────────────────────────────────────────────
function henryDb() {
  const { db } = migratedDb();
  saveRule(db, {
    spec: spec({
      title: "Henry: orders only",
      match: { agents: [HENRY], effects: ["read"] },
      decision: "allow",
      reason: "Henry may read the orders dataset only",
      narrowing: { memoryTags: { anyOf: ["work"] }, deepDatasets: { anyOf: [" Public.Orders "], noneOf: ["public.salaries"] } },
    }),
    actor: OWNER,
  });
  return db;
}

test("context: rules.narrowing v1 carries deepDatasets next to memoryTags (same v, ruleId, reason)", async () => {
  const db = henryDb();
  const out = (await call("rules_context", hookReq("context", { effect: "read", product: "knowledge", op: "deep", caller: HENRY }), hookCtx(db))) as { add: Record<string, any> };
  const n = out.add["rules.narrowing"];
  assert.equal(n.v, 1);
  assert.match(n.ruleId, /^rul_/);
  assert.equal(n.reason, "Henry may read the orders dataset only");
  assert.deepEqual(n.memoryTags, { anyOf: ["work"] });
  assert.deepEqual(n.deepDatasets, { anyOf: [" Public.Orders "], noneOf: ["public.salaries"] }, "emitted as the rule has it; the reader compares after trim + lower case");
  assert.equal(n.ruleId, out.add["rules.matched"].ruleId);
  const other = (await call("rules_context", hookReq("context", { effect: "read", product: "knowledge", op: "deep", caller: AGENT_B }), hookCtx(db))) as { add: Record<string, unknown> };
  assert.deepEqual(other.add, {}, "quiet on good: another agent gets no narrowing");
  const trace = listDecisions(db, { limit: 10 }).items.find((t) => t.phase === "context");
  assert.ok(trace);
  assert.equal(trace.answered, "narrow");
  const kept = trace.detail?.narrowing as { deepDatasets: unknown } | undefined;
  assert.deepEqual(kept?.deepDatasets, { anyOf: [" Public.Orders "], noneOf: ["public.salaries"] }, "the trace keeps the narrowing");
});

test("context: a datasets-only narrowing is emitted without a memoryTags key; no narrowing key at all when neither is set", async () => {
  const { db } = migratedDb();
  saveRule(db, { spec: spec({ title: "datasets only", match: { agents: [HENRY] }, decision: "allow", reason: "orders only", narrowing: { deepDatasets: { anyOf: ["public.orders"] } } }), actor: OWNER });
  const out = (await call("rules_context", hookReq("context", { effect: "read", product: "knowledge", op: "deep", caller: HENRY }), hookCtx(db))) as { add: Record<string, any> };
  assert.deepEqual(Object.keys(out.add["rules.narrowing"]).sort(), ["deepDatasets", "reason", "ruleId", "v"]);
  const { db: db2 } = migratedDb();
  saveRule(db2, { spec: spec({ title: "plain allow", match: { agents: [HENRY] }, decision: "allow", reason: "ok" }), actor: OWNER });
  const plain = (await call("rules_context", hookReq("context", { effect: "read", caller: HENRY }), hookCtx(db2))) as { add: Record<string, any> };
  assert.equal(plain.add["rules.narrowing"], undefined);
  assert.ok(plain.add["rules.matched"]);
});

test("context: two matching allow rules (unverified claim) never emit a wider dataset list than either — merged by the engine", async () => {
  const { db } = migratedDb();
  saveRule(db, { spec: spec({ title: "claim people", priority: 1, match: { agents: [HENRY], onBehalfOf: { kinds: ["person"] } }, decision: "allow", reason: "people", narrowing: { deepDatasets: { anyOf: ["public.orders", "public.customers"] } } }), actor: OWNER });
  saveRule(db, { spec: spec({ title: "base", priority: 2, match: { agents: [HENRY] }, decision: "allow", reason: "base", narrowing: { deepDatasets: { anyOf: ["public.orders"], noneOf: ["public.salaries"] } } }), actor: OWNER });
  const ctx = { "tb.onBehalfOf": { claim: { kind: "person", id: "psn_1" }, verified: false, via: "mcp_meta" } } as Record<string, Json>;
  const out = (await call("rules_context", hookReq("context", { effect: "read", caller: HENRY, context: ctx }), hookCtx(db))) as { add: Record<string, any> };
  assert.deepEqual(out.add["rules.narrowing"].deepDatasets, { anyOf: ["public.orders"], noneOf: ["public.salaries"] });
});

test("gate: target.tool reaches the decision and the trace; without a catalog an absent tool fails closed with toolUnknown recorded", async () => {
  const { db, raw } = migratedDb();
  // The writer needs the app catalog to accept `tools` (catalog.test.ts covers that path); a stored rule is read as it is.
  const toolSpec = spec({ title: "gate gmail send", priority: 5, match: { products: ["connect"], operations: ["tools"], tools: ["gmail_send"] }, decision: "deny", reason: "sends need the owner" });
  raw
    .prepare("INSERT INTO rules (id, rev, spec, priority, active, deleted, source, created_at, updated_at) VALUES (?, 1, ?, 5, 1, 0, 'owner', ?, ?)")
    .run("rul_01J000000000000000000000TL", JSON.stringify(toolSpec), Date.now(), Date.now());
  const bad = await call("rules_gate", hookReq("before", { product: "connect", op: "tools", effect: "outward", tool: "gmail_send", callId: "cal_bad" }), hookCtx(db));
  assert.equal(bad.allow, false);
  assert.match(String(bad.reason), /sends need the owner/);
  const good = await call("rules_gate", hookReq("before", { product: "connect", op: "tools", effect: "outward", tool: "gmail_read", callId: "cal_good" }), hookCtx(db));
  assert.deepEqual(good, { allow: true });
  const noTool = await call("rules_gate", hookReq("before", { product: "connect", op: "tools", effect: "outward", callId: "cal_none" }), hookCtx(db));
  assert.equal(noTool.allow, false, "no catalog: the op cannot be placed, so it counts as dynamic and the deny rule applies");
  const traces = listDecisions(db, { limit: 10 }).items;
  assert.equal(traces.find((t) => t.callId === "cal_bad")?.target.tool, "gmail_send", "the decision log names the tool");
  assert.equal(traces.find((t) => t.callId === "cal_good")?.target.tool, "gmail_read");
  const none = traces.find((t) => t.callId === "cal_none");
  assert.equal(none?.target.tool, undefined);
  assert.equal(none?.detail?.toolUnknown, true, "the decision detail records that the tool was unknown");
  assert.equal(traces.find((t) => t.callId === "cal_bad")?.detail?.toolUnknown, undefined, "a known tool leaves no toolUnknown");
});

// ── the owner and agent ops accept the new fields and refuse out-of-range ones ─────────────────────────────────
type Schema = Parameters<typeof validateAgainstSchema>[0];
const opInput = (id: string) => (manifest.operations.find((o) => o.id === id) as unknown as { input: Schema }).input;
const ruleWith = (over: Record<string, unknown>) => ({ ...spec({ decision: "allow", reason: "r" }), ...over });

test("manifest: rules_set, rule_draft_submit and rules_preview take match.tools and narrowing.deepDatasets; limits hold", () => {
  assert.equal(validateManifest(manifest).ok, true, "the edited manifest is valid");
  const ok = ruleWith({ match: { products: ["connect"], tools: ["gmail_send"] }, narrowing: { deepDatasets: { anyOf: ["public.orders"], noneOf: ["public.salaries"] } } });
  assert.deepEqual(validateAgainstSchema(opInput("rules_set"), { rule: ok } as never), { ok: true });
  assert.deepEqual(validateAgainstSchema(opInput("rule_draft_submit"), { text: "orders only", rules: [ok] } as never), { ok: true });
  assert.deepEqual(validateAgainstSchema(opInput("rules_preview"), { call: { caller: { type: "agent", id: AGENT_A }, target: { product: "connect", op: "tools", effect: "read", tool: "gmail_send" } }, candidate: ok } as never), { ok: true });
  const refused = (rule: unknown) => validateAgainstSchema(opInput("rules_set"), { rule } as never).ok === false;
  assert.ok(refused(ruleWith({ narrowing: { deepDatasets: { anyOf: Array.from({ length: 65 }, (_, i) => `public.t${i}`) } } })), "at most 64 per list");
  assert.ok(!refused(ruleWith({ narrowing: { deepDatasets: { anyOf: Array.from({ length: 64 }, (_, i) => `public.t${i}`) } } })), "64 is fine");
  assert.ok(refused(ruleWith({ narrowing: { deepDatasets: { anyOf: ["x".repeat(129)] } } })), "at most 128 characters");
  assert.ok(!refused(ruleWith({ narrowing: { deepDatasets: { anyOf: ["x".repeat(128)] } } })));
  assert.ok(refused(ruleWith({ narrowing: { deepDatasets: { anyOf: [""] } } })), "no empty name");
  assert.ok(refused(ruleWith({ narrowing: { deepDatasets: { allOf: ["a.b"] } } })), "unknown key");
  assert.ok(refused(ruleWith({ match: { tools: [""] } })));
  assert.ok(refused(ruleWith({ match: { tools: ["x".repeat(129)] } })));
  assert.ok(refused(ruleWith({ match: { tools: Array.from({ length: 101 }, (_, i) => `t${i}`) } })));
});
