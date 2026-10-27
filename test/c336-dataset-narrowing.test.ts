// C336 RQ-2 (spec 0.1.68, SDK-API §18.5): dataset narrowing `narrowing.deepDatasets` and the match field `tools`.
// Engine: merge like memoryTags (anyOf intersect, noneOf unite, disjoint → [] = nothing passes), the local `datasetsMatch`
// contract, writer checks, `tools` matching. Hooks: the context hook emits `rules.narrowing.deepDatasets` next to
// `memoryTags` (same v 1, ruleId, reason); the gate matches `target.tool`. L34: each check is shown quiet on the good case
// AND firing on the bad case. The comparison is the local copy of the manifest helper until it is released (see engine.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAgainstSchema, validateManifest } from "@opt2-tealbrick/manifest";
import type { Json } from "@opt2-tealbrick/miniapp-sdk";
import { manifest } from "../src/app.ts";
import { type CallFacts, datasetsMatch, datasetsPass, evaluate, explain, mergeNarrowing, order, type Rule, type RuleSpec, recorded, redactionsFor, specProblem, strictestNarrowing, toolListed } from "../src/engine.ts";
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
  callerProduct: o.callerProduct ?? null,
});

const hooks = makeHooks("rules");
const call = (id: string, ...args: unknown[]) => (hooks[id] as unknown as (...a: unknown[]) => Promise<Record<string, unknown>>)(...args);

// ── merge semantics ────────────────────────────────────────────────────────
test("deepDatasets merge: anyOf intersect, noneOf unite, EXACT ids; disjoint anyOf → [] = nothing passes (C115)", () => {
  const a = { deepDatasets: { anyOf: ["public.orders", "public.customers"], noneOf: ["public.salaries"] } };
  const b = { deepDatasets: { anyOf: ["public.orders", "public.invoices"], noneOf: ["public.payroll", "public.salaries"] } };
  assert.deepEqual(mergeNarrowing(a, b), { deepDatasets: { anyOf: ["public.orders"], noneOf: ["public.salaries", "public.payroll"] } }, "intersection of anyOf, union of noneOf");
  const disjoint = mergeNarrowing({ deepDatasets: { anyOf: ["public.orders"] } }, { deepDatasets: { anyOf: ["public.invoices"] } });
  assert.deepEqual(disjoint, { deepDatasets: { anyOf: [] } }, "disjoint → empty anyOf");
  assert.equal(datasetsPass(["public.orders"], disjoint as { deepDatasets: { anyOf: string[] } }), false, "an empty anyOf passes nothing");
  assert.equal(datasetsPass(["public.invoices"], disjoint as { deepDatasets: { anyOf: string[] } }), false);
  // A list present on either side survives (absent is not "all"): anyOf on one side, noneOf on the other, both stay.
  assert.deepEqual(mergeNarrowing({ deepDatasets: { anyOf: ["a.b"] } }, { deepDatasets: { noneOf: ["a.c"] } }), { deepDatasets: { anyOf: ["a.b"], noneOf: ["a.c"] } });
  assert.deepEqual(mergeNarrowing({ deepDatasets: { noneOf: ["a.c"] } }, { deepDatasets: { noneOf: ["a.d"] } }), { deepDatasets: { noneOf: ["a.c", "a.d"] } }, "noneOf only: no anyOf appears");
  // Identity is exact: a case variant is ANOTHER dataset, so it does not intersect and noneOf does not unite it away.
  assert.deepEqual(mergeNarrowing({ deepDatasets: { anyOf: ["Public.Orders"] } }, { deepDatasets: { anyOf: ["public.orders"] } }), { deepDatasets: { anyOf: [] } }, "case differs → disjoint");
  assert.deepEqual(mergeNarrowing({ deepDatasets: { noneOf: ["Public.Salaries"] } }, { deepDatasets: { noneOf: ["public.salaries"] } }), { deepDatasets: { noneOf: ["Public.Salaries", "public.salaries"] } }, "both ids stay blocked");
  assert.deepEqual(mergeNarrowing({ deepDatasets: { anyOf: [" a.b"] } }, { deepDatasets: { anyOf: ["a.b"] } }), { deepDatasets: { anyOf: [] } }, "no trimming");
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

test("datasetsMatch (local copy, SDK-API 18.5 rule 3): exact and case-sensitive; empty ids fail under anyOf and noneOf; noneOf blocks", () => {
  assert.equal(datasetsMatch(undefined, ["public.orders"]), true, "key absent = pass");
  assert.equal(datasetsMatch({}, ["public.orders"]), true, "absent anyOf and noneOf = no constraint");
  assert.equal(datasetsMatch({ anyOf: ["public.orders"] }, ["public.orders"]), true, "quiet on good: the allowed id");
  assert.equal(datasetsMatch({ anyOf: ["public.orders"] }, ["Public.Orders"]), false, "case variant is another id");
  assert.equal(datasetsMatch({ anyOf: ["public.orders"] }, [" public.orders"]), false, "no trimming");
  assert.equal(datasetsMatch({ anyOf: ["public.orders"] }, ["public.orders", "public.customers"]), false, "EVERY id must be in anyOf");
  assert.equal(datasetsMatch({ anyOf: ["public.orders"] }, []), false, "anyOf present and no ids: nothing to allow, refused (rule 3)");
  assert.equal(datasetsMatch({ anyOf: [] }, ["public.orders"]), false, "[] passes nothing, it is not 'no constraint' (L13)");
  assert.equal(datasetsMatch({ noneOf: ["public.salaries"] }, ["public.orders", "public.salaries"]), false);
  assert.equal(datasetsMatch({ noneOf: ["public.salaries"] }, ["public.orders", "Public.Salaries"]), true, "exact: the case variant is not the blocked id");
  // QA-SPEC47-11/12 (specs#47 bd00164): key present + EMPTY ids = "every dataset" → fails, under noneOf as under anyOf
  assert.equal(datasetsMatch({ noneOf: ["public.salaries"] }, []), false, "fire: noneOf with empty ids fails");
  assert.equal(datasetsMatch({ noneOf: [] }, []), false, "fire: even an empty noneOf with empty ids fails");
  assert.equal(datasetsMatch({ anyOf: ["public.orders"], noneOf: ["public.salaries"] }, []), false);
  assert.equal(datasetsMatch({ noneOf: ["public.salaries"] }, ["public.orders"]), true, "quiet: noneOf with a named, allowed id passes");
  assert.equal(datasetsMatch(undefined, []), true, "quiet: key absent passes whatever ids");
  assert.equal(datasetsMatch({}, []), false, "an empty object is not 'absent' (the schema refuses it at save)");
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
  assert.match(specProblem(spec({ decision: "allow", narrowing: { deepDatasets: { anyOf: [""] } } })), /1 to 128 characters/, "fire: an empty name");
  assert.match(specProblem(spec({ decision: "allow", narrowing: { deepDatasets: { noneOf: ["x".repeat(129)] } } })), /1 to 128 characters/, "fire: 129 characters");
  assert.equal(specProblem(spec({ decision: "allow", narrowing: { deepDatasets: { noneOf: ["x".repeat(128)] } } })), "", "quiet: 128 characters");
  assert.match(specProblem(spec({ decision: "allow", narrowing: { deepDatasets: { anyOf: Array.from({ length: 65 }, (_, i) => `d${i}`) } } })), /at most 64/, "fire: 65 names");
  assert.equal(specProblem(spec({ decision: "allow", narrowing: { deepDatasets: { anyOf: Array.from({ length: 64 }, (_, i) => `d${i}`) } } })), "", "quiet: 64 names");
  // exact identity: a space at either end can never equal a canonical id (in noneOf it would block nothing, so refuse it)
  assert.match(specProblem(spec({ decision: "allow", narrowing: { deepDatasets: { noneOf: ["public.salaries "] } } })), /no space at either end/);
  assert.match(specProblem(spec({ decision: "allow", narrowing: { deepDatasets: { anyOf: [" public.orders"] } } })), /no space at either end/);
  assert.equal(specProblem(spec({ decision: "allow", narrowing: { deepDatasets: { anyOf: ["Public.Orders", "my schema.t 1"] } } })), "", "mixed case and inner spaces are ids as they are");
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
  // QA-RULES18-4: a resolved variant `x__…` of a listed tool matches too, a look-alike does not
  assert.equal(evaluate([r], at("gmail_send__first_contact")).decision, "deny", "fire-on-bad: the resolved variant");
  assert.equal(evaluate([r], at("gmail_send_bulk")).decision, "allow", "quiet-on-good: not a prefix wildcard");
  assert.equal(evaluate([r], at("gmail_sendx")).decision, "allow");
  assert.equal(evaluate([toolRule(["gmail_send"], "allow")], at("gmail_send__first_contact")).rule?.id, "rul_tool", "allow rules follow the same rule");
  assert.equal(evaluate([toolRule(["gmail_send"], "allow")], at("gmail_send_bulk")).rule, null);
  // QA-RULES18-5 (a): the variant must START with `x__`; a name that merely contains it is another tool (kills `includes`)
  assert.equal(evaluate([toolRule(["gmail_send"], "allow")], at("xgmail_send__first_contact")).rule, null, "quiet-on-good: an allow on gmail_send does not admit xgmail_send__first_contact");
  assert.equal(evaluate([r, toolRule(["gmail_send"])], at("xgmail_send__first_contact")).decision, "allow", "a deny on gmail_send does not block it either");
  assert.equal(toolListed(["gmail_send"], "xgmail_send__first_contact"), false);
  assert.equal(toolListed(["gmail_send"], "send__first_contact"), false);
  assert.equal(toolListed(["gmail_send"], "gmail_send__"), true);
  assert.equal(toolListed(["gmail_send"], "gmail_send"), true);
  assert.equal(toolListed(["gmail_send"], "gmail_sen"), false);
  assert.equal(toolListed(["gmail_send"], "Gmail_Send__first_contact"), false, "case-sensitive");
  assert.match(specProblem(spec({ match: { products: ["connect"], tools: ["a__b"] } })), /contains “__”/, "the writer refuses a variant name");
  // QA-C354-3: every tools entry passes the catalog-name rule (spec 0.1.74 DYNAMIC_CATALOG_NAME_RE)
  for (const bad of ["gmail_send_", "Gmail_send", "1send", "s", "send-mail", "x".repeat(49)]) {
    assert.match(specProblem(spec({ match: { products: ["connect"], tools: [bad] } })), /not a catalog tool name/, bad);
  }
  for (const ok of ["gmail_send", "ab", "x".repeat(48)]) assert.equal(specProblem(spec({ match: { products: ["connect"], tools: [ok] } })), "", ok);
  assert.equal(specProblem(spec({ match: { products: ["connect"], tools: ["a_b", "gmail_send"] } })), "");
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

test("toolOf: only a catalog tool name (with at most one __ variant, at most 128 characters) counts as the tool name", () => {
  const req = (tool: unknown) => ({ call: { target: { tool } } }) as unknown as Parameters<typeof toolOf>[0];
  assert.equal(toolOf(req("gmail_send")), "gmail_send");
  assert.equal(toolOf(req(undefined)), undefined);
  assert.equal(toolOf(req("")), undefined);
  assert.equal(toolOf(req(7)), undefined);
  assert.equal(toolOf(req("x".repeat(129))), undefined);
  assert.equal(toolOf(req(`gmail_send__${"x".repeat(116)}`)), `gmail_send__${"x".repeat(116)}`);
  // S4-1 (review 0.5.0): a value that is no catalog tool name is ABSENT (a dynamic op then fails closed for deny/hold tools rules)
  for (const bad of ["Gmail_Send", "gmail_send ", "gmail send", "x".repeat(49), "gmail_send__", "a__b__c__D", "_x"]) assert.equal(toolOf(req(bad)), undefined, bad);
  assert.equal(toolOf(req("gmail_send__first_contact")), "gmail_send__first_contact");
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
      narrowing: { memoryTags: { anyOf: ["work"] }, deepDatasets: { anyOf: ["public.Orders"], noneOf: ["public.salaries"] } },
    }),
    actor: OWNER,
  });
  return db;
}

test("context: rules.narrowing v1 carries deepDatasets next to memoryTags (same v, ruleId, reason)", async () => {
  const db = henryDb();
  const out = (await call("rules_context", hookReq("context", { effect: "read", product: "knowledge", op: "deep", caller: HENRY }), hookCtx(db))) as { add: Record<string, any> };
  const n = out.add["rules.narrowing"];
  assert.equal(n.v, 2, "deepDatasets present → v 2 (a reader without dataset narrowing refuses it)");
  assert.match(n.ruleId, /^rul_/);
  assert.equal(n.reason, "Henry may read the orders dataset only");
  assert.deepEqual(n.memoryTags, { anyOf: ["work"] });
  assert.deepEqual(n.deepDatasets, { anyOf: ["public.Orders"], noneOf: ["public.salaries"] }, "emitted exactly as the rule has it: ids are case-sensitive");
  assert.equal(n.ruleId, out.add["rules.matched"].ruleId);
  const other = (await call("rules_context", hookReq("context", { effect: "read", product: "knowledge", op: "deep", caller: AGENT_B }), hookCtx(db))) as { add: Record<string, unknown> };
  assert.deepEqual(other.add, {}, "quiet on good: another agent gets no narrowing");
  const trace = listDecisions(db, { limit: 10 }).items.find((t) => t.phase === "context");
  assert.ok(trace);
  assert.equal(trace.answered, "narrow");
  const kept = trace.detail?.narrowing as { deepDatasets: unknown } | undefined;
  assert.deepEqual(kept?.deepDatasets, { anyOf: ["public.Orders"], noneOf: ["public.salaries"] }, "the trace keeps the narrowing");
});

test("context: a datasets-only narrowing is emitted without a memoryTags key; no narrowing key at all when neither is set", async () => {
  const { db } = migratedDb();
  saveRule(db, { spec: spec({ title: "datasets only", match: { agents: [HENRY] }, decision: "allow", reason: "orders only", narrowing: { deepDatasets: { anyOf: ["public.orders"] } } }), actor: OWNER });
  const out = (await call("rules_context", hookReq("context", { effect: "read", product: "knowledge", op: "deep", caller: HENRY }), hookCtx(db))) as { add: Record<string, any> };
  assert.deepEqual(Object.keys(out.add["rules.narrowing"]).sort(), ["deepDatasets", "reason", "ruleId", "v"], "a deepDatasets-only narrowing is emitted, not dropped");
  assert.equal(out.add["rules.narrowing"].v, 2);
  const { db: db2 } = migratedDb();
  saveRule(db2, { spec: spec({ title: "plain allow", match: { agents: [HENRY] }, decision: "allow", reason: "ok" }), actor: OWNER });
  const plain = (await call("rules_context", hookReq("context", { effect: "read", caller: HENRY }), hookCtx(db2))) as { add: Record<string, any> };
  assert.equal(plain.add["rules.narrowing"], undefined);
  assert.ok(plain.add["rules.matched"]);
});

test("context: v is 1 exactly when the merged narrowing has no deepDatasets; deepDatasets is never under v 1 (spec 0.1.68)", async () => {
  const emit = async (narrowing: RuleSpec["narrowing"]) => {
    const { db } = migratedDb();
    saveRule(db, { spec: spec({ title: "n", match: { agents: [HENRY] }, decision: "allow", reason: "r", narrowing }), actor: OWNER });
    const out = (await call("rules_context", hookReq("context", { effect: "read", product: "knowledge", op: "deep", caller: HENRY }), hookCtx(db))) as { add: Record<string, any> };
    return out.add["rules.narrowing"] as Record<string, unknown>;
  };
  const tags = await emit({ memoryTags: { anyOf: ["work"] } });
  assert.equal(tags.v, 1, "quiet on good: memory tags only stays v 1");
  assert.equal("deepDatasets" in tags, false);
  const sets = await emit({ deepDatasets: { noneOf: ["public.salaries"] } });
  assert.equal(sets.v, 2, "fire on bad: datasets → v 2");
  assert.equal("memoryTags" in sets, false, "no memoryTags key from a datasets-only rule");
  const both = await emit({ memoryTags: { anyOf: ["work"] }, deepDatasets: { anyOf: ["public.orders"] } });
  assert.equal(both.v, 2);
  assert.deepEqual(both.memoryTags, { anyOf: ["work"] });
  // every emission: a deepDatasets key implies v 2
  for (const n of [tags, sets, both]) assert.equal("deepDatasets" in n, n.v === 2);
  // merged from two rules (an unverified claim: the claim rule and the base rule both narrow): tags + datasets → v 2 with both keys
  const { db } = migratedDb();
  saveRule(db, { spec: spec({ title: "tags", priority: 1, match: { agents: [HENRY], onBehalfOf: { kinds: ["person"] } }, decision: "allow", reason: "t", narrowing: { memoryTags: { anyOf: ["work"] } } }), actor: OWNER });
  saveRule(db, { spec: spec({ title: "sets", priority: 2, match: { agents: [HENRY] }, decision: "allow", reason: "s", narrowing: { deepDatasets: { anyOf: ["public.orders"] } } }), actor: OWNER });
  const ctx = { "tb.onBehalfOf": { claim: { kind: "person", id: "psn_1" }, verified: false, via: "mcp_meta" } } as Record<string, Json>;
  const merged = (await call("rules_context", hookReq("context", { effect: "read", caller: HENRY, context: ctx }), hookCtx(db))) as { add: Record<string, any> };
  assert.equal(merged.add["rules.narrowing"].v, 2);
  assert.deepEqual(merged.add["rules.narrowing"].memoryTags, { anyOf: ["work"] });
  assert.deepEqual(merged.add["rules.narrowing"].deepDatasets, { anyOf: ["public.orders"] }, "a key present on either side survives the merge");
  const noClaim = (await call("rules_context", hookReq("context", { effect: "read", caller: HENRY }), hookCtx(db))) as { add: Record<string, any> };
  assert.equal(noClaim.add["rules.narrowing"].v, 2, "no claim: the datasets rule alone");
  assert.equal("memoryTags" in noClaim.add["rules.narrowing"], false);
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
  assert.ok(refused(ruleWith({ match: { tools: ["a"] } })), "canonical names have at least 2 characters");
  assert.ok(refused(ruleWith({ match: { tools: ["x".repeat(129)] } })));
  // tools are the bridge's canonical tool names (^[a-z][a-z0-9_]{1,47}$): exact, so a name that can never equal one is refused
  assert.ok(!refused(ruleWith({ match: { products: ["connect"], tools: ["a".repeat(63)] } })), "63 characters is the longest canonical name (catalog names <= 48; resolved variants such as <tool>__first_contact)");
  assert.ok(refused(ruleWith({ match: { products: ["connect"], tools: ["a".repeat(64)] } })));
  assert.ok(refused(ruleWith({ match: { products: ["connect"], tools: ["Gmail_Send"] } })), "case-sensitive canonical names are lower case");
  assert.ok(refused(ruleWith({ match: { products: ["connect"], tools: ["gmail*"] } })), "no wildcard or prefix");
  // the deepDatasets object needs a list
  assert.ok(refused(ruleWith({ narrowing: { deepDatasets: {} } })), "{} is not well-formed");
  assert.ok(!refused(ruleWith({ narrowing: { deepDatasets: { noneOf: ["a.b"] } } })));
  assert.ok(refused(ruleWith({ narrowing: { deepDatasets: { anyOf: "a.b" } } })), "a non-array");
  assert.ok(refused(ruleWith({ narrowing: { deepDatasets: { anyOf: [7] } } })), "a non-string item");
  assert.ok(refused(ruleWith({ narrowing: { deepDatasets: null } })));
  assert.ok(refused(ruleWith({ match: { tools: Array.from({ length: 101 }, (_, i) => `t${i}`) } })));
});

// QA-RULES18-5 (b): the after hook without a pinned verdict (restart, expiry, eviction) falls back to `strictestNarrowing`. The
// allow rule's narrowing must still apply to a resolved variant of its tool (kills a matcher that is exact only in this path).
test("rules_filter without a pin: the narrowing of an allow rule on gmail_send applies to gmail_send__first_contact, not to look-alikes", async () => {
  const { db, raw } = migratedDb();
  const allow = spec({ title: "gmail read narrowed", priority: 5, match: { products: ["connect"], operations: ["tools"], tools: ["gmail_send"] }, decision: "allow", reason: "work only", narrowing: { memoryTags: { anyOf: ["work"] } } });
  raw
    .prepare("INSERT INTO rules (id, rev, spec, priority, active, deleted, source, created_at, updated_at) VALUES (?, 1, ?, 5, 1, 0, 'owner', ?, ?)")
    .run("rul_01J000000000000000000000TN", JSON.stringify(allow), Date.now(), Date.now());
  const output = { results: [{ tags: ["work"] }, { tags: ["personal"] }] };
  const after = (tool: string | undefined, callId: string) => call("rules_filter", hookReq("after", { product: "connect", op: "tools", effect: "read", callId, output, ...(tool !== undefined ? { tool } : {}) }), hookCtx(db));
  // no pin exists for these call ids: the fallback decides
  const variant = facts({ product: "connect", op: "tools", effect: "read", dynamic: true, tool: "gmail_send__first_contact" });
  assert.deepEqual(strictestNarrowing([rule("rul_n", allow)], variant), { memoryTags: { anyOf: ["work"] } }, "engine: the variant is narrowed");
  assert.deepEqual(await after("gmail_send__first_contact", "cal_var"), { redactions: ["/results/1"] }, "fire-on-bad: the variant's result is redacted without a pin");
  assert.deepEqual(await after("gmail_send", "cal_exact"), { redactions: ["/results/1"] }, "the exact tool too");
  assert.deepEqual(await after("xgmail_send__first_contact", "cal_x1"), {}, "quiet-on-good: a name that only contains gmail_send__ is not narrowed");
  assert.deepEqual(await after("gmail_send_bulk", "cal_x2"), {}, "quiet-on-good: a look-alike is not narrowed");
});
