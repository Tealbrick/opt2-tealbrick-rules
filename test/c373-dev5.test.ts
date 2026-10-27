// C373 dev.5 fixes, server side: rules_list names the dynamic operations of the catalog (D12), the preview over recent calls (D11),
// control characters in writer text (RU-1), decisions of no-match writes (RU-2) and one bad manifest URL in the catalog (RU-3).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { generateKeyPair, type Manifest, signReleaseIndex, validateManifest } from "@opt2-tealbrick/manifest";
import type { OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { handlers, manifest as rulesManifest } from "../src/app.ts";
import { catalogOf, catalogState, syncCatalog } from "../src/catalog.ts";
import { makeHooks } from "../src/hooks.ts";
import { setMode } from "../src/mode-store.ts";
import { listDecisions, pruneDecisions, saveRule, TRACE_KEEP } from "../src/store.ts";
import { AGENT_A, AGENT_B, APP_INSTANCE, hookCtx, hookReq, migratedDb, OWNER, opCtx, seedCatalog, spec } from "./helpers.ts";

type Run = (input: unknown, ctx: OpContext) => Promise<any>;
const run = (id: keyof typeof handlers) => (handlers[id] as unknown as { run: Run }).run;
type Db = ReturnType<typeof migratedDb>["db"];
const owner = (db: Db) => opCtx(db, { type: "person", id: OWNER });
const hooks = makeHooks("rules");
const gate = (db: Db, o: Parameters<typeof hookReq>[1]) => (hooks.rules_gate as unknown as (...a: unknown[]) => Promise<Record<string, any>>)(hookReq("before", o), hookCtx(db));
let n = 0;
const callId = () => `cal_01J${String(++n).padStart(23, "0")}`;
const decisionCount = (db: Db) => Number(db.prepare("SELECT COUNT(*) AS n FROM decisions").get()?.n);

/** A catalog stand-in with operations (seedCatalog in helpers has none). */
function seedOps(db: ReturnType<typeof migratedDb>["db"], product: string, ops: { id: string; effect?: string; dynamic?: boolean }[]) {
  const summary = ops.map((o) => ({ id: o.id, title: o.id, effect: o.effect ?? "read", audience: "agent", dynamic: !!o.dynamic, tools: [] }));
  db.prepare("INSERT INTO catalog_manifests (digest, product, version, published_at, ops) VALUES (?, ?, '1.0.0', '2026-10-13T00:00:00.000Z', ?)").run(`sha256:${product}`, product, JSON.stringify(summary));
  const digests = JSON.parse(String(db.prepare("SELECT digests FROM catalog_sync WHERE id = 1").get()?.digests ?? "[]")) as string[];
  db.prepare("UPDATE catalog_sync SET generated_at = '2026-10-13T12:00:00.000Z', synced_at = ?, attempted_at = ?, digests = ?, error = NULL WHERE id = 1").run(Date.now(), Date.now(), JSON.stringify([...digests, `sha256:${product}`]));
}

test("D12: rules_list names the dynamic operations of the catalog as product.op", async () => {
  const { db } = migratedDb();
  seedOps(db, "connect", [{ id: "buzz_dm" }, { id: "tools", effect: "write", dynamic: true }]);
  seedOps(db, "knowledge", [{ id: "memory_recall" }]);
  const out = await run("rules_list")({}, owner(db));
  assert.deepEqual(out.catalog.dynamicOps, ["connect.tools"]);
  assert.deepEqual(out.catalog.productIds, ["connect", "knowledge"]);
});

// ── D11: Check against recent calls ──────────────────────────────────────────
const preview = (db: Db, input: Record<string, unknown>) => run("rules_preview_recent")(input, owner(db));

test("D11: the unsaved rule is run over the last recorded gate decisions: matched calls, before -> after, nothing stored", async () => {
  const db = migratedDb().db;
  seedOps(db, "connect", [{ id: "buzz_dm", effect: "outward" }]);
  await gate(db, { callId: callId(), caller: AGENT_A, op: "buzz_dm", effect: "outward" });
  await gate(db, { callId: callId(), caller: AGENT_B, op: "buzz_dm", effect: "outward" });
  await gate(db, { callId: callId(), caller: AGENT_A, product: "knowledge", op: "memory_recall", effect: "read" }); // a read that matched no rule is not recorded
  const before = decisionCount(db);
  assert.equal(before, 2);
  const rule = spec({ title: "Sends wait", priority: 50, decision: "hold", reason: "check", match: { products: ["connect"], effects: ["outward"] } });
  const out = await preview(db, { rule });
  assert.equal(out.checked, 2);
  assert.equal(out.matched, 2);
  assert.equal(out.changed, 2);
  assert.equal(out.cannotCheck, null);
  assert.match(out.note, /reads that matched no rule are not listed/);
  assert.deepEqual(out.rows.map((r: any) => [r.caller.id, r.target.op, r.before, r.after, r.changed]), [
    [AGENT_B, "buzz_dm", { decision: "allow", by: "Permissive mode" }, { decision: "hold", by: "Sends wait" }, true],
    [AGENT_A, "buzz_dm", { decision: "allow", by: "Permissive mode" }, { decision: "hold", by: "Sends wait" }, true],
  ]);
  // a rule for one agent matches that agent's call only
  const one = await preview(db, { rule: spec({ title: "A only", decision: "deny", reason: "r", match: { agents: [AGENT_A] } }) });
  assert.deepEqual(one.rows.map((r: any) => r.caller.id), [AGENT_A]);
  assert.equal(decisionCount(db), before, "nothing is stored");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM rules").get()?.n), 0);
});

test("D11: after = all live rules with the candidate (a rule that runs first decides); ruleId replaces the stored version; limit", async () => {
  const db = migratedDb().db;
  seedOps(db, "connect", [{ id: "buzz_dm", effect: "outward" }]);
  for (let i = 0; i < 5; i++) await gate(db, { callId: callId(), caller: AGENT_A, op: "buzz_dm", effect: "outward" });
  const live = saveRule(db, { spec: spec({ title: "Never to anyone", priority: 1, decision: "deny", reason: "no", match: { products: ["connect"] } }), actor: OWNER });
  const cand = spec({ title: "Sends wait", priority: 50, decision: "hold", reason: "check", match: { products: ["connect"] } });
  const first = await preview(db, { rule: cand, limit: 2 });
  assert.equal(first.checked, 2, "limit");
  assert.deepEqual(first.rows.map((r: any) => r.after), [{ decision: "deny", by: "Never to anyone" }, { decision: "deny", by: "Never to anyone" }], "the live deny at priority 1 decides first");
  // editing the live rule itself: its stored version is replaced, so the candidate decides
  const edit = await preview(db, { rule: { ...cand, priority: 1 }, ruleId: live.id, limit: 1 });
  assert.deepEqual(edit.rows.map((r: any) => r.after), [{ decision: "hold", by: "Sends wait" }]);
});

test("D11: a rule that names facts the log does not keep cannot be checked (recipients, caller teams, caller trust) and says so", async () => {
  const db = seedCatalog(migratedDb().db, ["connect"]);
  await gate(db, { callId: callId(), caller: AGENT_A, op: "buzz_dm", effect: "outward" });
  const base = { title: "r", decision: "hold" as const, reason: "r" };
  for (const [match, word] of [
    [{ effects: ["outward"], recipients: { known: false } }, /recipients/],
    [{ callerTeams: ["tm_x"] }, /teams or trust/],
    [{ callerTrust: ["blocked"] }, /teams or trust/],
  ] as const) {
    const out = await preview(db, { rule: spec({ ...base, match: match as never }) });
    assert.match(out.cannotCheck, word);
    assert.equal(out.rows.length, 0);
    assert.equal(out.matched, 0);
  }
});

test("D11: tool, verified app product and workflow come from the log; an app caller and an unverified app", async () => {
  const db = seedCatalog(migratedDb().db, ["evolution"]);
  seedOps(db, "connect", [{ id: "tools", effect: "outward", dynamic: true }, { id: "buzz_dm", effect: "outward" }]);
  await gate(db, { callId: callId(), caller: AGENT_A, op: "tools", effect: "outward", tool: "gmail_send" });
  await gate(db, { callId: callId(), caller: AGENT_A, op: "tools", effect: "outward", tool: "calendar_add" });
  await gate(db, { callId: callId(), app: { product: "evolution" }, op: "buzz_dm", effect: "outward" });
  await gate(db, { callId: callId(), app: { id: `${APP_INSTANCE}X` }, op: "buzz_dm", effect: "outward" }); // no verified product
  const tools = await preview(db, { rule: spec({ title: "t", decision: "hold", reason: "r", match: { products: ["connect"], operations: ["tools"], tools: ["gmail_send"] } }) });
  assert.deepEqual(tools.rows.map((r: any) => r.target.tool), ["gmail_send"]);
  const apps = await preview(db, { rule: spec({ title: "a", decision: "hold", reason: "r", match: { callerProducts: ["evolution"] } }) });
  // an agent never matches callerProducts; an app with no verified product is held like the gate holds it (fail closed)
  assert.deepEqual(apps.rows.map((r: any) => [r.caller.type, r.caller.product]), [["app", null], ["app", "evolution"]]);
  const allow = await preview(db, { rule: spec({ title: "a", decision: "allow", reason: "r", match: { callerProducts: ["evolution"] } }) });
  assert.deepEqual(allow.rows.map((r: any) => r.caller.product), ["evolution"], "fire-on-bad: an allow rule never matches an unverified app");
});

test("D11: person only; a rule the writers refuse is refused", async () => {
  const db = seedCatalog(migratedDb().db, ["connect"]);
  await assert.rejects(run("rules_preview_recent")({ rule: spec({}) }, opCtx(db, { type: "agent", id: AGENT_A })), { code: "forbidden" });
  await assert.rejects(preview(db, { rule: spec({ match: { products: ["nosuchapp"] } }) }), { code: "input_invalid" });
});

// ── RU-1: control and invisible characters in writer text ────────────────────
const CP = (n: number) => String.fromCodePoint(n);
const RLO = CP(0x202e);
const ZWJ = CP(0x200d);
const BEL = CP(0x07);
const BOM = CP(0xfeff);
const TAB = CP(9);
const LF = CP(10);
const BAD = [RLO, ZWJ, BEL, BOM, CP(0x0000), CP(0x7f), CP(0x85), CP(0x200b), CP(0x2066)];
const agent = (db: Db) => opCtx(db, { type: "agent", id: AGENT_A });

test("RU-1: rules_set refuses Cc and Cf characters in title, reason and description, naming the field; clean text passes", async () => {
  const db = migratedDb().db;
  for (const bad of BAD) {
    await assert.rejects(run("rules_set")({ rule: spec({ title: `Hold${bad}sends` }) }, owner(db)), { code: "input_invalid", message: /^The title contains a control or invisible character \(U\+[0-9A-F]{4}\) at position 5\./ }, `title ${bad.codePointAt(0)}`);
    await assert.rejects(run("rules_set")({ rule: spec({ reason: `no${bad}way` }) }, owner(db)), { code: "input_invalid", message: /^The reason contains a control or invisible character/ });
    await assert.rejects(run("rules_set")({ rule: spec({ description: `why${bad}` }) }, owner(db)), { code: "input_invalid", message: /^The description contains/ });
  }
  // a TAB or LF is not a single-line character
  await assert.rejects(run("rules_set")({ rule: spec({ title: `a${TAB}b` }) }, owner(db)), { code: "input_invalid", message: /^The title contains .*\(U\+0009\)/ });
  await assert.rejects(run("rules_set")({ rule: spec({ reason: `a${LF}b` }) }, owner(db)), { code: "input_invalid", message: /^The reason contains .*\(U\+000A\)/ });
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM rules").get()?.n), 0, "nothing was saved");
  // quiet on good: accents, CJK, emoji (no joiner), a description with line breaks and tabs
  const ok = await run("rules_set")({ rule: spec({ title: "Café – 日本語 ✅", reason: "Nur für mich", description: `line one${LF}${TAB}line two` }) }, owner(db));
  assert.equal(ok.rule.rev, 1);
  // an update is checked like a create
  await assert.rejects(run("rules_set")({ id: ok.rule.id, expectedRev: 1, rule: spec({ title: `x${RLO}y` }) }, owner(db)), { code: "input_invalid" });
  // the previews refuse the same candidate
  await assert.rejects(run("rules_preview")({ call: { caller: { type: "agent", id: AGENT_A }, target: { product: "connect", op: "buzz_dm", effect: "outward" } }, candidate: spec({ title: `x${RLO}y` }) }, owner(db)), { code: "input_invalid" });
  await assert.rejects(run("rules_preview_recent")({ rule: spec({ reason: `x${BEL}y` }) }, owner(db)), { code: "input_invalid" });
});

test("RU-1: drafts (agent submit and owner compose_save) refuse the characters in text, note and rule text; line breaks stay allowed in text and note", async () => {
  const db = migratedDb().db;
  const draft = (over: Record<string, unknown>) => ({ text: "hold sends", rules: [spec({})], ...over });
  for (const [run1, ctx] of [[run("rule_draft_submit"), agent(db)], [run("rule_compose_save"), owner(db)]] as const) {
    await assert.rejects(run1(draft({ text: `hold${RLO}sends` }), ctx), { code: "input_invalid", message: /^The draft text contains .*\(U\+202E\) at position 5/ });
    await assert.rejects(run1(draft({ note: `n${BEL}` }), ctx), { code: "input_invalid", message: /^The note contains/ });
    await assert.rejects(run1(draft({ note: `n${ZWJ}` }), ctx), { code: "input_invalid", message: /^The note contains/ });
    await assert.rejects(run1(draft({ rules: [spec({ title: `Evil${RLO}title` })] }), ctx), (e: Error) => /^rule 1 \(“Evil⟨U\+202E⟩title”\): The title contains/.test(e.message) && !e.message.includes(RLO));
    await assert.rejects(run1(draft({ rules: [spec({ reason: `r${BOM}` })] }), ctx), { code: "input_invalid", message: /The reason contains/ });
    const ok = await run1(draft({ text: `line one${LF}${TAB}line two`, note: `a${LF}b` }), ctx);
    assert.equal(ok.status, "pending");
  }
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM drafts").get()?.n), 2, "only the two clean drafts exist");
});

test("RU-1: a stored legacy rule stays visible and matching (never flagged \"never matches\"); restoring or approving a value with the characters is refused", async () => {
  const db = migratedDb().db;
  const evil = spec({ title: `Legacy${RLO}rule`, reason: `old${ZWJ}reason`, match: { agents: [AGENT_A] } });
  // as an older release stored it: straight into the tables
  const text = JSON.stringify(evil);
  db.prepare("INSERT INTO rules (id, rev, spec, priority, active, deleted, source, created_at, updated_at) VALUES ('rul_legacy', 1, ?, 100, 1, 0, 'owner', 1, 1)").run(text);
  db.prepare("INSERT INTO rule_revisions (rule_id, rev, change, spec, actor, at) VALUES ('rul_legacy', 1, 'created', ?, 'x', 1)").run(text);
  const list = await run("rules_list")({}, owner(db));
  assert.equal(list.rules[0].problem, null, "it still matches, so it is not flagged");
  assert.equal(list.rules[0].spec.title, `Legacy${RLO}rule`, "the stored value is returned as it is; the UI writes it out");
  // saving it again, or restoring that revision, is refused until the character is removed
  await assert.rejects(run("rules_set")({ id: "rul_legacy", expectedRev: 1, rule: evil }, owner(db)), { code: "input_invalid" });
  await run("rules_set")({ id: "rul_legacy", expectedRev: 1, rule: spec({ title: "Legacy rule", match: { agents: [AGENT_A] } }) }, owner(db));
  await assert.rejects(run("rule_restore")({ ruleId: "rul_legacy", rev: 1, expectedRev: 2 }, owner(db)), { code: "input_invalid", message: /revision 1 can’t be restored: The title contains/ });
  // a pending draft stored before the check cannot be approved
  db.prepare("INSERT INTO drafts (id, status, text, note, rules, submitted_by_type, submitted_by_id, submitted_by_name, submitted_at) VALUES ('drf_legacy', 'pending', 't', '', ?, 'agent', ?, 'a', 1)").run(JSON.stringify([evil]), AGENT_A);
  await assert.rejects(run("draft_decide")({ id: "drf_legacy", decision: "approve" }, owner(db)), (e: Error) => /Legacy⟨U\+202E⟩rule/.test(e.message) && !e.message.includes(RLO));
  // the owner can still reject it
  assert.equal((await run("draft_decide")({ id: "drf_legacy", decision: "reject" }, owner(db))).draft.status, "rejected");
});

test("RU-1: escapeControls writes the characters out and keeps tab and line break only in multi-line text", async () => {
  const { escapeControls, controlProblem } = await import("../src/text-guard.ts");
  assert.equal(escapeControls(`a${RLO}b${ZWJ}c${BEL}d${BOM}`), "a⟨U+202E⟩b⟨U+200D⟩c⟨U+0007⟩d⟨U+FEFF⟩");
  assert.equal(escapeControls(`a${TAB}b${LF}c`), "a⟨U+0009⟩b⟨U+000A⟩c");
  assert.equal(escapeControls(`a${TAB}b${LF}c`, true), `a${TAB}b${LF}c`);
  assert.equal(escapeControls("Café 日本語 ✅ 👨"), "Café 日本語 ✅ 👨");
  assert.equal(controlProblem("The note", "", true), "");
  // the position counts the characters before it (an astral character is one position in the sentence's eyes: UTF-16 units, documented)
  assert.match(controlProblem("The title", `👨${RLO}`), /at position 3\./);
});

// ── RU-2: no-match decisions of every non-read effect are recorded ───────────
test("RU-2: an allowed call that matched no rule is recorded for write, outward, destructive and money with decidedBy mode; reads are not", async () => {
  const db = migratedDb().db;
  for (const effect of ["read", "write", "outward", "destructive", "money"]) await gate(db, { callId: `cal_${effect}`, caller: AGENT_A, product: "knowledge", op: "some_op", effect });
  const rows = listDecisions(db, { limit: 20 }).items;
  assert.deepEqual(rows.map((r) => r.callId).sort(), ["cal_destructive", "cal_money", "cal_outward", "cal_write"], "the read left no row");
  for (const r of rows) assert.deepEqual([r.answered, r.ruleId, r.detail], ["allow", null, { decidedBy: "mode", mode: "permissive" }], r.callId ?? "");
  // an app caller too; and the explain op of the caller reads it back as decided by the mode
  await gate(db, { callId: "cal_app", app: { product: "evolution" }, product: "kanban", op: "issue_create", effect: "write" });
  const explained = await run("rules_explain")({ callId: "cal_write" }, agent(db));
  assert.deepEqual(explained.decisions.map((d: any) => [d.callId, d.decision, d.decidedBy, d.mode, d.ruleId]), [["cal_write", "allow", "mode", "permissive", null]]);
  // the mode that let it through is the mode in force
  setMode(db, { mode: "verification", actor: OWNER });
  await gate(db, { callId: "cal_ver_read", caller: AGENT_A, product: "knowledge", op: "some_op", effect: "read" });
  await gate(db, { callId: "cal_ver_write", caller: AGENT_A, product: "knowledge", op: "some_op", effect: "write" });
  const ver = Object.fromEntries(listDecisions(db, { limit: 50 }).items.map((r) => [r.callId, [r.answered, r.detail]]));
  assert.deepEqual(ver.cal_ver_write, ["hold", { decidedBy: "mode", mode: "verification" }]);
  assert.deepEqual(ver.cal_ver_read, ["hold", { decidedBy: "mode", mode: "verification" }], "a read the mode held is recorded as before");
  // a built-in exemption of a write is recorded as an exemption (Closed mode)
  setMode(db, { mode: "closed", actor: OWNER });
  await gate(db, { callId: "cal_draft", caller: AGENT_A, product: "rules", op: "rule_draft_submit", effect: "write" });
  assert.deepEqual(listDecisions(db, { callId: "cal_draft", limit: 1 }).items[0]?.detail, { decidedBy: "exemption", mode: "closed", exemption: "rules-self-service" });
});

test("RU-2: a rule that decides keeps its trace unchanged (no decidedBy)", async () => {
  const db = migratedDb().db;
  saveRule(db, { spec: spec({ title: "No writes", decision: "deny", reason: "no", match: { effects: ["write"] } }), actor: OWNER });
  await gate(db, { callId: "cal_rule", caller: AGENT_A, product: "knowledge", op: "some_op", effect: "write" });
  assert.deepEqual(listDecisions(db, { callId: "cal_rule", limit: 1 }).items[0]?.detail, null);
});

test("RU-2: the extra rows stay inside the retention (newest TRACE_KEEP, 30 days); the periodic prune runs while writes are recorded", async () => {
  const db = migratedDb().db;
  const now = Date.now();
  // TRACE_KEEP + 500 rows in one statement, the oldest first (ids sort by time), all within the window
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${TRACE_KEEP + 500})
    INSERT INTO decisions (id, call_id, phase, at, caller_type, caller_id, product, op, effect, decision, answered, reason, duration_us)
    SELECT printf('dec_%08d', i), NULL, 'before', ${now - 1000}, 'agent', 'agt_x', 'knowledge', 'some_op', 'write', 'allow', 'allow', 'r', 1 FROM n`);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM decisions").get()?.n), TRACE_KEEP + 500);
  pruneDecisions(db, now);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM decisions").get()?.n), TRACE_KEEP, "the newest TRACE_KEEP stay");
  assert.equal(String(db.prepare("SELECT MIN(id) AS m FROM decisions").get()?.m), `dec_${String(501).padStart(8, "0")}`);
  // old rows go by age
  db.prepare("UPDATE decisions SET at = ? WHERE id <= 'dec_00000600'").run(now - 31 * 24 * 3600 * 1000);
  pruneDecisions(db, now);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM decisions").get()?.n), TRACE_KEEP - 100);
  // recorded writes trigger the prune themselves (every 1000th insert): the log never grows without bound
  db.exec("DELETE FROM decisions");
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${TRACE_KEEP})
    INSERT INTO decisions (id, call_id, phase, at, caller_type, caller_id, product, op, effect, decision, answered, reason, duration_us)
    SELECT printf('dec_%08d', i), NULL, 'before', ${now - 1000}, 'agent', 'agt_x', 'knowledge', 'some_op', 'write', 'allow', 'allow', 'r', 1 FROM n`);
  for (let i = 0; i < 2000; i++) await gate(db, { callId: callId(), caller: AGENT_A, product: "knowledge", op: "some_op", effect: "write" });
  const total = Number(db.prepare("SELECT COUNT(*) AS n FROM decisions").get()?.n);
  assert.ok(total < TRACE_KEEP + 1000, `pruned while recording (${total})`);
});

// ── RU-3: one bad manifest URL does not fail the catalog read ────────────────
const connectManifest = JSON.parse(readFileSync(new URL("./fixtures/connect.manifest.json", import.meta.url), "utf8")) as Manifest;
const INDEX = "https://registry.test/index.json";

/** A signed index (test key) with Connect and Rules; `fail` lists URLs (or index assets) that answer 404; `failOnce` answers 404 on the first fetch only. */
async function fakeIndex(opts: { fail?: string[]; failOnce?: string[] } = {}) {
  const key = await generateKeyPair({ extractable: true });
  const files = new Map<string, string>();
  const rec = (m: Manifest, n: number) => {
    const v = validateManifest(m);
    assert.ok(v.ok, `fixture manifest ${m.id} is valid`);
    const url = `https://raw.test/${m.id}/tealbrick.manifest.json`;
    files.set(url, JSON.stringify(m));
    return { id: `rel_01J0000000000000000000000${n}`, product: m.id, kind: "app", version: m.version, channel: "stable", manifestDigest: v.digest, manifestUrl: url, publishedAt: "2026-10-13T00:00:00.000Z" };
  };
  const body = { schema: "opt2.release-index/v2" as const, generatedAt: "2026-10-13T12:00:00.000Z", releases: [rec(connectManifest, 1), rec(rulesManifest as unknown as Manifest, 2)], harnesses: [], offers: [] };
  files.set(INDEX, JSON.stringify(body));
  files.set(INDEX.replace(/\.json$/, ".jws"), await signReleaseIndex(body, { iat: Math.floor(Date.now() / 1000) }, key));
  const once = new Set(opts.failOnce ?? []);
  const fetches: string[] = [];
  const fetchText = async (url: string) => {
    fetches.push(url);
    if (opts.fail?.includes(url)) throw new Error("fetch 404");
    if (once.delete(url)) throw new Error("fetch 404");
    const t = files.get(url);
    if (t === undefined) throw new Error(`fetch 404 ${url}`);
    return t;
  };
  return { url: INDEX, fetchText, fetches, retryMs: 0, keys: { keys: [{ kty: "OKP" as const, crv: "Ed25519" as const, x: key.publicJwk.x }] }, connectUrl: "https://raw.test/connect/tealbrick.manifest.json" };
}

test("RU-3: one manifest URL that answers 404 skips that release only; the catalog is read, the rest works, the owner is told which", async () => {
  const { db } = migratedDb();
  const idx = await fakeIndex({ fail: ["https://raw.test/connect/tealbrick.manifest.json"] });
  await syncCatalog(db, idx);
  const st = catalogState(db);
  assert.equal(st.error, null, "the catalog read did not fail");
  assert.notEqual(st.syncedAt, null);
  assert.deepEqual(st.skipped, [{ product: "connect", version: connectManifest.version, reason: "fetch 404" }]);
  assert.equal(catalogOf(db)?.has("rules"), true, "the other release is in the catalog");
  assert.equal(catalogOf(db)?.has("connect"), false);
  const listed = await run("rules_list")({}, owner(db));
  assert.equal(listed.catalog.error, null);
  assert.deepEqual(listed.catalog.skipped, [{ product: "connect", version: connectManifest.version, reason: "fetch 404" }]);
  assert.equal(listed.catalog.products, 1);
  // the writer still refuses an operation it cannot place
  await assert.rejects(run("rules_set")({ rule: spec({ title: "t", match: { products: ["connect"], operations: ["buzz_dm"] } }) }, owner(db)), { code: "input_invalid", message: /unknown app “connect”/ });
  // the release is read again by the next sync and the note goes
  await syncCatalog(db, await fakeIndex());
  assert.deepEqual(catalogState(db).skipped, []);
  assert.equal(catalogOf(db)?.has("connect"), true);
  assert.deepEqual((await run("rules_list")({}, owner(db))).catalog.skipped, []);
});

test("RU-3: a failed INDEX read keeps the last catalog and the last skipped note, and says so as the global error; a 404 for a moment is read again", async () => {
  const { db } = migratedDb();
  await syncCatalog(db, await fakeIndex({ fail: ["https://raw.test/connect/tealbrick.manifest.json"] }));
  // the index.jws answers 404 on every try: the read fails as a whole
  await syncCatalog(db, await fakeIndex({ fail: [INDEX.replace(/\.json$/, ".jws")] }));
  const st = catalogState(db);
  assert.equal(st.error, "fetch 404");
  assert.equal(catalogOf(db)?.has("rules"), true, "the last catalog stays");
  assert.equal(st.skipped.length, 1, "the last skipped note stays");
  // index.json answers 404 once (a registry publish replaces its assets): the read tries again and succeeds
  const { db: db2 } = migratedDb();
  const idx = await fakeIndex({ failOnce: [INDEX] });
  await syncCatalog(db2, idx);
  assert.equal(catalogState(db2).error, null);
  assert.equal(catalogOf(db2)?.has("connect"), true);
  assert.ok(idx.fetches.filter((u) => u === INDEX).length >= 2, "the index was read twice");
});
