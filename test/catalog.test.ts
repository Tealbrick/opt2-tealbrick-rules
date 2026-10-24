// App catalog (0.2.7, QA Lane C S2): a rule that names an operation the target app does not declare can never match, so
// every writer refuses it (owner rule create/update, draft submit, draft apply, dry-run candidate); an MCP tool name gets a
// "did you mean" hint. L34: each check is shown quiet on the good case AND firing on the bad case. The catalog comes from a
// signed index (test key) through the same sync code that reads the real one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { generateKeyPair, type Manifest, signReleaseIndex, validateManifest } from "@opt2-tealbrick/manifest";
import type { Db, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { OP } from "#kit";
import { handlers, manifest as rulesManifest } from "../src/app.ts";
import { CATALOG_MISSING, catalogOf, catalogProblem, catalogState, syncCatalog } from "../src/catalog.ts";
import { makeHooks } from "../src/hooks.ts";
import { AGENT_A, hookCtx, hookReq, migratedDb, OWNER, opCtx, spec } from "./helpers.ts";

type Run = (input: unknown, ctx: OpContext) => Promise<any>;
const run = (id: keyof typeof handlers) => (handlers[id] as unknown as { run: Run }).run;

const connect = JSON.parse(readFileSync(new URL("./fixtures/connect.manifest.json", import.meta.url), "utf8")) as Manifest;
const INDEX = "https://registry.test/index.json";

/** A signed index listing Connect (trimmed fixture) and Rules, served by a fake fetch. */
async function signedIndex(opts: { tamperDigest?: boolean; otherKey?: boolean } = {}) {
  const key = await generateKeyPair({ extractable: true });
  const signer = opts.otherKey ? await generateKeyPair({ extractable: true }) : key;
  const files = new Map<string, string>();
  const rec = (m: Manifest, n: number) => {
    const v = validateManifest(m);
    assert.ok(v.ok, `fixture manifest ${m.id} is valid`);
    const url = `https://raw.test/${m.id}/tealbrick.manifest.json`;
    files.set(url, JSON.stringify(m));
    const id = `rel_01J0000000000000000000000${n}`;
    return { id, product: m.id, kind: "app", version: m.version, channel: "stable", manifestDigest: opts.tamperDigest && m.id === "connect" ? `sha256:${"0".repeat(64)}` : v.digest, manifestUrl: url, publishedAt: "2026-10-13T00:00:00.000Z" };
  };
  const body = { schema: "opt2.release-index/v2" as const, generatedAt: "2026-10-13T12:00:00.000Z", releases: [rec(connect, 1), rec(rulesManifest as unknown as Manifest, 2)], harnesses: [], offers: [] };
  files.set(INDEX, JSON.stringify(body));
  files.set(INDEX.replace(/\.json$/, ".jws"), await signReleaseIndex(body, { iat: Math.floor(Date.now() / 1000) }, signer));
  const fetchText = async (url: string) => {
    const t = files.get(url);
    if (t === undefined) throw new Error(`fetch 404 ${url}`);
    return t;
  };
  return { url: INDEX, fetchText, retryMs: 0, keys: { keys: [{ kty: "OKP" as const, crv: "Ed25519" as const, x: key.publicJwk.x }] } };
}

async function withCatalog(): Promise<{ db: Db }> {
  const { db } = migratedDb();
  await syncCatalog(db, await signedIndex());
  assert.equal(catalogState(db).error, null);
  return { db };
}

const dmRule = (ops: string[], extra: Partial<ReturnType<typeof spec>["match"]> = {}) =>
  spec({ title: "hold Connect sends", match: { products: ["connect"], operations: ops, ...extra }, decision: "deny", reason: "sends need the owner" });

test("catalog: the signed index gives each product's declared ops (union, titles, MCP tool names)", async () => {
  const { db } = await withCatalog();
  const cat = catalogOf(db);
  assert.ok(cat);
  assert.deepEqual([...(cat.get("connect")?.ops.keys() ?? [])].sort(), ["buzz_dm", "buzz_dm_first", "buzz_read", "services_search", "tools"]);
  assert.equal(cat.get("connect")?.ops.get("tools")?.title, "Connected service tools");
  assert.equal(cat.get("connect")?.tools.get("tools_call"), "tools");
  assert.equal(cat.get("connect")?.tools.get("connect__tools_search"), "tools");
  assert.ok(cat.get("rules")?.ops.has("rule_draft_submit"));
});

test("catalog: an index not signed by the pinned key, or a manifest whose digest differs, is not used", async () => {
  const { db } = migratedDb();
  await syncCatalog(db, await signedIndex({ otherKey: true }));
  assert.equal(catalogOf(db), null, "no catalog from an unverified index");
  assert.match(catalogState(db).error ?? "", /signature refused/);
  const { db: db2 } = migratedDb();
  await syncCatalog(db2, await signedIndex({ tamperDigest: true }));
  assert.equal(catalogOf(db2)?.has("connect"), false, "manifest with a wrong digest skipped");
  assert.equal(catalogOf(db2)?.has("rules"), true);
});

test("quiet on good: a declared op is accepted by every writer and the rule matches a real hook call", async () => {
  const { db } = await withCatalog();
  const owner = opCtx(db, { type: "person", id: OWNER });
  const agent = opCtx(db, { type: "agent", id: AGENT_A, name: "agent", mode: "free" });
  // Dynamic op `tools`: the bridge sends op "tools" with the RESOLVED effect, so effects outward is fine.
  const created = (await run(OP.rulesSet)({ rule: dmRule(["tools"], { effects: ["outward"] }) }, owner)).rule;
  assert.ok(created.id);
  const listed = await run(OP.rulesList)({}, owner);
  assert.equal(listed.rules[0].problem, null, "no never-matches flag on a good rule");
  assert.equal(listed.catalog.products, 2);
  const sub = await run(OP.ruleDraftSubmit)({ text: "no DMs without me", rules: [dmRule(["buzz_dm", "buzz_dm_first"])] }, agent);
  const drafts = (await run(OP.draftsList)({ status: "pending" }, owner)).drafts;
  assert.deepEqual(drafts[0].problems, [null]);
  assert.equal(drafts[0].opTitles["connect.buzz_dm"], "Direct message a known person", "review UI gets the real title");
  const applied = (await run(OP.draftDecide)({ id: sub.draftId, decision: "approve" }, owner)).draft;
  assert.equal(applied.status, "approved");
  // The real hook call: the bridge sends the MANIFEST op id (bridge calls.ts `op: op.id`).
  const { rules_gate } = makeHooks("rules") as unknown as Record<string, (r: unknown, c: unknown) => Promise<{ allow: boolean; reason?: string }>>;
  const tools = await rules_gate(hookReq("before", { product: "connect", op: "tools", effect: "outward" }), hookCtx(db));
  assert.equal(tools.allow, false);
  assert.match(tools.reason ?? "", /sends need the owner/);
  const dm = await rules_gate(hookReq("before", { product: "connect", op: "buzz_dm", effect: "outward" }), hookCtx(db));
  assert.equal(dm.allow, false);
  const read = await rules_gate(hookReq("before", { product: "connect", op: "buzz_read", effect: "read" }), hookCtx(db));
  assert.equal(read.allow, true, "other ops still pass");
});

test("fire on bad: undeclared ops are refused by every writer; an MCP tool name gets the hint", async () => {
  const { db } = await withCatalog();
  const owner = opCtx(db, { type: "person", id: OWNER });
  const agent = opCtx(db, { type: "agent", id: AGENT_A, name: "agent", mode: "free" });
  for (const name of ["tools_call", "tools_search", "connect__tools_call"]) {
    await assert.rejects(run(OP.ruleDraftSubmit)({ text: "hold gmail sends", rules: [dmRule([name])] }, agent), (e: { code: string; message: string }) => {
      assert.equal(e.code, "input_invalid");
      assert.match(e.message, /^rule 1 \(“hold Connect sends”\): app “connect” has no operation/);
      assert.match(e.message, /MCP tool name.*Did you mean `tools`\?/);
      return true;
    });
  }
  await assert.rejects(run(OP.rulesSet)({ rule: dmRule(["tools_call"]) }, owner), { code: "input_invalid", message: /Did you mean `tools`\?/ });
  await assert.rejects(run(OP.rulesSet)({ rule: dmRule(["gmail_send"]) }, owner), { code: "input_invalid", message: /does not declare operation “gmail_send”.*agent operations: tools.*name the operation `tools` and list the tool in the rule's tools/ });
  await assert.rejects(run(OP.rulesSet)({ rule: dmRule(["services_search"]) }, owner), { code: "input_invalid", message: /owner-only/ });
  await assert.rejects(run(OP.rulesSet)({ rule: dmRule(["buzz_read"], { effects: ["outward"] }) }, owner), { code: "input_invalid", message: /effect read.*never match/ });
  await assert.rejects(run(OP.rulesSet)({ rule: spec({ match: { products: ["conect"] } }) }, owner), { code: "input_invalid", message: /unknown app “conect”/ });
  await assert.rejects(run(OP.rulesSet)({ rule: spec({ match: { products: ["rules"], effects: ["money"] } }) }, owner), { code: "input_invalid", message: /no agent operation with effect money/ });
  // Every named product must declare the op.
  await assert.rejects(run(OP.rulesSet)({ rule: spec({ match: { products: ["connect", "rules"], operations: ["buzz_dm"] } }) }, owner), { code: "input_invalid", message: /“rules” does not declare operation “buzz_dm”/ });
  const call = { caller: { type: "agent", id: AGENT_A, mode: "free" }, target: { product: "connect", op: "tools", effect: "outward" } };
  await assert.rejects(run(OP.rulesPreview)({ call, candidate: dmRule(["tools_call"]) }, owner), { code: "input_invalid" });
});

test("stored rules and drafts with undeclared ops stay, are flagged 'never matches', and such a draft is not applied", async () => {
  const { db, raw } = migratedDb();
  // Written before the catalog check existed (drf_01M4TVY22NP3H5940FCKB1FKDC on qa1 had this shape).
  const bad = dmRule(["tools_call"]);
  raw
    .prepare("INSERT INTO drafts (id, status, text, note, rules, submitted_by_type, submitted_by_id, submitted_by_name, submitted_at) VALUES (?, 'pending', ?, '', ?, 'agent', ?, 'agent', ?)")
    .run("drf_01J000000000000000000000BD", "hold gmail sends", JSON.stringify([bad]), AGENT_A, Date.now());
  raw
    .prepare("INSERT INTO rules (id, rev, spec, priority, active, deleted, source, created_at, updated_at) VALUES (?, 1, ?, 100, 1, 0, 'owner', ?, ?)")
    .run("rul_01J000000000000000000000BD", JSON.stringify(bad), Date.now(), Date.now());
  await syncCatalog(db, await signedIndex());
  const owner = opCtx(db, { type: "person", id: OWNER });
  const rules = (await run(OP.rulesList)({}, owner)).rules;
  assert.equal(rules.length, 1, "never deleted");
  assert.match(rules[0].problem, /Did you mean `tools`\?/);
  const d = (await run(OP.draftsList)({}, owner)).drafts[0];
  assert.match(d.problems[0], /Did you mean `tools`\?/);
  await assert.rejects(run(OP.draftDecide)({ id: d.id, decision: "approve" }, owner), { code: "draft_never_matches", message: /cannot be applied.*Did you mean `tools`/ });
  assert.equal((await run(OP.draftsList)({ status: "pending" }, owner)).drafts.length, 1, "still pending after the refused apply");
  assert.equal((await run(OP.draftDecide)({ id: d.id, decision: "reject" }, owner)).draft.status, "rejected", "the owner can still reject it");
});

test("no catalog yet: specs naming apps are refused (catalog_unavailable), specs without apps pass", async () => {
  const { db } = migratedDb();
  // A failed read (unreachable registry) leaves no catalog.
  await syncCatalog(db, { url: INDEX, fetchText: async () => Promise.reject(new Error("offline")) });
  assert.equal(catalogProblem(dmRule(["tools"]), null), CATALOG_MISSING);
  const owner = opCtx(db, { type: "person", id: OWNER });
  await assert.rejects(run(OP.rulesSet)({ rule: dmRule(["tools"]) }, owner), { code: "catalog_unavailable" });
  const ok = await run(OP.rulesSet)({ rule: spec({ match: { effects: ["money"] }, decision: "hold", reason: "payments wait" }) }, owner);
  assert.ok(ok.rule.id);
});

// C336 RQ-2 (spec 0.1.66): the match field `tools` names a dynamic entry (`target.tool`). Only a dynamic call carries one, so a
// writer refuses `tools` on an op or app that has no dynamic op. Quiet on good AND firing on bad (L34).
test("tools (spec 0.1.66): accepted on a dynamic op, refused on a static op or an app without a dynamic op; the gate matches target.tool", async () => {
  const { db } = await withCatalog();
  const owner = opCtx(db, { type: "person", id: OWNER });
  const good = dmRule(["tools"], { tools: ["gmail_send"], effects: ["outward"] });
  const created = (await run(OP.rulesSet)({ rule: good }, owner)).rule;
  assert.ok(created.id, "quiet on good: a dynamic op with tools is accepted");
  assert.equal((await run(OP.rulesList)({}, owner)).rules[0].problem, null);
  assert.ok((await run(OP.rulesSet)({ rule: spec({ priority: 500, match: { products: ["connect"], tools: ["gmail_send"] }, decision: "hold", reason: "wait" }) }, owner)).rule.id, "products only: connect has a dynamic agent op");
  await assert.rejects(run(OP.rulesSet)({ rule: dmRule(["buzz_dm"], { tools: ["gmail_send"] }) }, owner), { code: "input_invalid", message: /“buzz_dm” is not a dynamic operation.*tools \(gmail_send\) would never match/ });
  await assert.rejects(run(OP.rulesSet)({ rule: spec({ match: { products: ["rules"], tools: ["gmail_send"] } }) }, owner), { code: "input_invalid", message: /“rules” has no dynamic agent operation/ });
  await assert.rejects(run(OP.rulesSet)({ rule: spec({ match: { tools: ["gmail_send"] } }) }, owner), { code: "input_invalid", message: /tools need products/ });
  // The dry run carries the tool through: the candidate matches the named tool only.
  const call = (tool?: string) => ({ caller: { type: "agent", id: AGENT_A, mode: "free" }, target: { product: "connect", op: "tools", effect: "outward", ...(tool ? { tool } : {}) } });
  assert.equal((await run(OP.rulesPreview)({ call: call("gmail_send"), candidate: good }, owner)).decision, "deny", "fire-on-bad: the named tool");
  const other = await run(OP.rulesPreview)({ call: call("gmail_read"), candidate: good }, owner);
  assert.equal(other.decision, "allow", "quiet-on-good: another tool");
  assert.equal(other.ruleId, null);
  const noTool = await run(OP.rulesPreview)({ call: call(), candidate: good }, owner);
  assert.equal(noTool.decision, "deny", "dynamic op without a tool: a deny rule with tools applies (fail closed)");
  assert.deepEqual(noTool.steps.find((x: { ruleId: string }) => x.ruleId === "candidate")?.why, "matches: the call names no tool, so this rule applies (fail closed)");
  // The real hook call: the bridge sends `target.tool` for a dynamic call (BRIDGE v0.1.66).
  const { rules_gate } = makeHooks("rules") as unknown as Record<string, (r: unknown, c: unknown) => Promise<{ allow: boolean; reason?: string }>>;
  const sent = await rules_gate(hookReq("before", { product: "connect", op: "tools", effect: "outward", tool: "gmail_send" }), hookCtx(db));
  assert.equal(sent.allow, false);
  assert.match(sent.reason ?? "", /sends need the owner/);
  assert.equal((await rules_gate(hookReq("before", { product: "connect", op: "tools", effect: "outward", tool: "gmail_read" }), hookCtx(db))).allow, true);
});

// Review of rules#18: with the real catalog the gate knows which ops are dynamic. No target.tool: a static op never matches a
// tools rule; a dynamic op applies deny and hold rules (fail closed) and not allow rules. Quiet AND firing (L34).
test("tools without target.tool through the gate and the catalog: static op quiet, dynamic op fails closed for deny and hold, never for allow", async () => {
  const { db } = await withCatalog();
  const owner = opCtx(db, { type: "person", id: OWNER });
  const { rules_gate } = makeHooks("rules") as unknown as Record<string, (r: unknown, c: unknown) => Promise<{ allow: boolean; reason?: string }>>;
  const gate = (op: string, tool?: string, callId = "cal_01J00000000000000000000001") =>
    rules_gate(hookReq("before", { product: "connect", op, effect: "outward", callId, ...(tool ? { tool } : {}) }), hookCtx(db));
  // products-only rule (no operations): the catalog decides per call whether the op is dynamic
  const mk = (decision: "allow" | "deny" | "hold") => spec({ title: `tools ${decision}`, priority: 10, match: { products: ["connect"], tools: ["gmail_send"] }, decision, reason: `tool ${decision} rule` });
  const saved = (await run(OP.rulesSet)({ rule: mk("deny") }, owner)).rule;
  // static op without a tool: quiet; dynamic op without a tool: fire
  assert.equal((await gate("buzz_dm")).allow, true, "static op without a tool: not matched");
  const closed = await gate("tools");
  assert.equal(closed.allow, false, "dynamic op without a tool: the deny rule applies");
  assert.match(closed.reason ?? "", /tool deny rule/);
  // dynamic op with a tool: normal
  assert.equal((await gate("tools", "gmail_send")).allow, false);
  assert.equal((await gate("tools", "gmail_read")).allow, true);
  // the decision detail says the tool was unknown, and only then
  const detailOf = async (callId: string) => (await run(OP.decisionsList)({ callId }, owner)).items[0]?.detail;
  await gate("tools", undefined, "cal_01J00000000000000000000002");
  await gate("tools", "gmail_send", "cal_01J00000000000000000000003");
  assert.deepEqual(await detailOf("cal_01J00000000000000000000002"), { toolUnknown: true });
  assert.equal((await detailOf("cal_01J00000000000000000000003"))?.toolUnknown, undefined);
  // hold: same
  await run(OP.rulesSet)({ id: saved.id, expectedRev: saved.rev, rule: mk("hold") }, owner);
  const held = await gate("tools") as { allow: boolean; hold?: { family: string } };
  assert.equal(held.allow, false);
  assert.equal(held.hold?.family, "policy", "dynamic op without a tool: the hold rule applies");
  assert.equal((await gate("buzz_dm")).allow, true);
  // allow: never matched without a tool, so it cannot widen anything; it matches with the listed tool
  await run(OP.rulesSet)({ id: saved.id, expectedRev: saved.rev + 1, rule: mk("allow") }, owner);
  const base = (await run(OP.rulesSet)({ rule: spec({ title: "deny all connect", priority: 50, match: { products: ["connect"] }, decision: "deny", reason: "base deny" }) }, owner)).rule;
  assert.ok(base.id);
  assert.match((await gate("tools")).reason ?? "", /base deny/, "an allow rule with tools does not lift the deny when the tool is unknown");
  assert.equal((await gate("tools", "gmail_send")).allow, true, "quiet on good: the listed tool reaches the allow rule");
  assert.match((await gate("tools", "gmail_read")).reason ?? "", /base deny/);
});

// QA-RULES18-4 (C354): Connect resolves `gmail_send` to variants such as `gmail_send__first_contact`, which run the same upstream
// tool. A tools condition naming `x` matches `x` and `x__…`, nothing else (catalog names never hold `__`). Real engine path: the
// owner op rules_preview and the rules_gate hook, as QA ran them. Quiet AND firing, deny and allow.
test("tools: a condition naming gmail_send matches gmail_send__first_contact, not gmail_sendx or gmail_send_bulk; a saved entry with __ is refused", async () => {
  const { db } = await withCatalog();
  const owner = opCtx(db, { type: "person", id: OWNER });
  const agent = opCtx(db, { type: "agent", id: AGENT_A, name: "agent", mode: "free" });
  const { rules_gate } = makeHooks("rules") as unknown as Record<string, (r: unknown, c: unknown) => Promise<{ allow: boolean; reason?: string }>>;
  const gate = (tool: string) => rules_gate(hookReq("before", { product: "connect", op: "tools", effect: "outward", tool, callId: "cal_01J00000000000000000000009" }), hookCtx(db));
  const preview = async (tool: string) =>
    run(OP.rulesPreview)({ call: { caller: { type: "agent", id: AGENT_A, mode: "free" }, target: { product: "connect", op: "tools", effect: "outward", tool } } }, owner);
  const rule = (decision: "allow" | "deny" | "hold", priority: number) => spec({ title: `gmail_send ${decision}`, priority, match: { products: ["connect"], operations: ["tools"], tools: ["gmail_send"] }, decision, reason: `gmail_send ${decision} rule` });

  // deny: the exact tool and its resolved variant fire; look-alikes stay quiet
  const saved = (await run(OP.rulesSet)({ rule: rule("deny", 10) }, owner)).rule;
  for (const tool of ["gmail_send", "gmail_send__first_contact"]) {
    const p = await preview(tool);
    assert.equal(p.decision, "deny", `fire-on-bad: ${tool} (preview)`);
    const g = await gate(tool);
    assert.equal(g.allow, false, `fire-on-bad: ${tool} (gate)`);
    assert.match(g.reason ?? "", /gmail_send deny rule/);
  }
  for (const tool of ["gmail_sendx", "gmail_send_bulk", "gmail_sen", "xgmail_send", "Gmail_Send__first_contact", "gmail_send_"]) {
    assert.equal((await preview(tool)).decision, "allow", `quiet-on-good: ${tool} (preview)`);
    assert.equal((await gate(tool)).allow, true, `quiet-on-good: ${tool} (gate)`);
  }
  // hold fires on the variant as well
  await run(OP.rulesSet)({ id: saved.id, expectedRev: saved.rev, rule: rule("hold", 10) }, owner);
  assert.equal((await preview("gmail_send__first_contact")).decision, "hold");
  assert.equal((await preview("gmail_send_bulk")).decision, "allow");

  // allow: an allow rule on gmail_send admits the variant over a base deny; a look-alike falls to the base deny
  await run(OP.rulesSet)({ id: saved.id, expectedRev: saved.rev + 1, rule: rule("allow", 10) }, owner);
  await run(OP.rulesSet)({ rule: spec({ title: "base deny", priority: 50, match: { products: ["connect"], operations: ["tools"] }, decision: "deny", reason: "base deny" }) }, owner);
  assert.equal((await gate("gmail_send__first_contact")).allow, true, "allow rule admits the resolved variant");
  assert.equal((await gate("gmail_send")).allow, true);
  assert.match((await gate("gmail_send_bulk")).reason ?? "", /base deny/, "a look-alike is not admitted");
  assert.match((await gate("gmail_sendx")).reason ?? "", /base deny/);
  assert.equal((await preview("gmail_send__first_contact")).ruleId, saved.id);

  // absent tool on a dynamic op: unchanged (deny/hold apply, allow does not)
  const noTool = await rules_gate(hookReq("before", { product: "connect", op: "tools", effect: "outward" }), hookCtx(db));
  assert.match(noTool.reason ?? "", /base deny/, "the allow rule with tools does not match without a tool");

  // save: an entry that is itself a variant name is refused, with a clear message, on every writer
  const variant = spec({ title: "variant", match: { products: ["connect"], operations: ["tools"], tools: ["a__b"] }, decision: "deny", reason: "x" });
  const msg = /tools entry “a__b” contains “__”.*not a catalog tool name.*“a”/;
  await assert.rejects(run(OP.rulesSet)({ rule: variant }, owner), { code: "input_invalid", message: msg });
  await assert.rejects(run(OP.ruleDraftSubmit)({ text: "x", rules: [variant] }, agent), { code: "input_invalid", message: msg });
  await assert.rejects(run(OP.rulesPreview)({ call: { caller: { type: "agent", id: AGENT_A, mode: "free" }, target: { product: "connect", op: "tools", effect: "outward" } }, candidate: variant }, owner), { code: "input_invalid", message: msg });
  assert.ok((await run(OP.rulesSet)({ rule: { ...variant, title: "plain", match: { ...variant.match, tools: ["a_b"] } } }, owner)).rule.id, "quiet: a single underscore is a catalog name");
});
