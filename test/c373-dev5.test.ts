// C373 dev.5 fixes, server side: rules_list names the dynamic operations of the catalog (D12), the preview over recent calls (D11),
// control characters in writer text (RU-1), decisions of no-match writes (RU-2) and one bad manifest URL in the catalog (RU-3).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { handlers } from "../src/app.ts";
import { makeHooks } from "../src/hooks.ts";
import { saveRule } from "../src/store.ts";
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
