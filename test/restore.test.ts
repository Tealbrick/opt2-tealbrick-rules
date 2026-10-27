// Q-7 (C373): restore a rule revision. rule_restore writes the spec of an earlier revision as a NEW revision (change
// 'restored', from_rev), brings a deleted rule back, passes the same writer checks as rules_set (refused with the
// writer's reason), records the actor, and is declared idempotency "required" (the SDK replays a repeated key).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { validateInput } from "@opt2-tealbrick/manifest";
import type { OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { OP } from "#kit";
import { handlers, manifest, migrationsDir } from "../src/app.ts";
import { getRule, liveRules, restoreRule } from "../src/store.ts";
import { AGENT_A, migratedDb, OWNER, opCtx, spec } from "./helpers.ts";

type Run = (input: unknown, ctx: OpContext) => Promise<any>;
const run = (id: keyof typeof handlers) => (handlers[id] as unknown as { run: Run }).run;
const opOf = (id: string) => manifest.operations.find((o) => o.id === id) as (typeof manifest.operations)[number];

async function threeRevisions() {
  const { db, raw } = migratedDb();
  const owner = opCtx(db, { type: "person", id: OWNER });
  const v1 = spec({ title: "No money", match: { effects: ["money"] }, decision: "deny", reason: "no money" });
  const v2 = spec({ title: "Money waits", match: { effects: ["money"] }, decision: "hold", reason: "money waits" });
  const created = (await run(OP.rulesSet)({ rule: v1 }, owner)).rule;
  await run(OP.rulesSet)({ id: created.id, expectedRev: 1, rule: v2 }, owner);
  return { db, raw, owner, id: created.id as string, v1, v2 };
}

test("manifest: rule_restore is a person write with idempotency required; rules_get lists restored revisions", () => {
  const op = opOf("rule_restore");
  assert.equal(op.audience, "person");
  assert.equal(op.effect, "write");
  assert.equal(op.idempotency, "required");
  assert.deepEqual(op.crud, ["update"]);
  assert.equal(validateInput(op as never, { ruleId: "rul_1", rev: 2 }).ok, true);
  assert.equal(validateInput(op as never, { ruleId: "rul_1", rev: 0 }).ok, false, "rev starts at 1");
  assert.equal(validateInput(op as never, { ruleId: "rul_1" }).ok, false, "rev is required");
  const change = (opOf("rules_get").output as any).properties.revisions.items.properties.change.enum;
  assert.ok(change.includes("restored"));
});

test("restore an updated rule: the old spec becomes current as a NEW revision with from, actor recorded, gate sees it", async () => {
  const { db, raw, owner, id, v1 } = await threeRevisions();
  assert.equal(liveRules(db)[0]?.spec.outcome.decision, "hold");
  const out = await run(OP.ruleRestore)({ ruleId: id, rev: 1, expectedRev: 2 }, owner);
  assert.deepEqual(out, { id, rev: 3, restoredFrom: 1 });
  assert.deepEqual(liveRules(db)[0]?.spec, v1, "the gate's cache was invalidated");
  const got = await run(OP.rulesGet)({ id }, owner);
  assert.equal(got.deleted, false);
  assert.equal(got.rule.rev, 3);
  assert.deepEqual(got.rule.spec, v1);
  assert.deepEqual(
    got.revisions.map((r: any) => [r.rev, r.change, r.from]),
    [
      [3, "restored", 1],
      [2, "updated", undefined],
      [1, "created", undefined],
    ],
  );
  assert.equal(got.revisions[0].actor, OWNER);
  const rows = raw.prepare("SELECT rev, change, from_rev, actor FROM rule_revisions WHERE rule_id = ? ORDER BY rev").all(id);
  assert.equal(rows.length, 3, "history is added to, never rewritten");
  assert.deepEqual({ ...rows[2] }, { rev: 3, change: "restored", from_rev: 1, actor: OWNER });
});

test("restore a deleted rule: it comes back into evaluation; the deleted revision's spec can be restored", async () => {
  const { db, owner, id, v2 } = await threeRevisions();
  await run(OP.rulesDelete)({ id, expectedRev: 2 }, owner);
  assert.equal(liveRules(db).length, 0);
  const listed = (await run(OP.rulesList)({ includeDeleted: true }, owner)).rules;
  assert.deepEqual(
    listed.map((r: any) => [r.id, r.deleted]),
    [[id, true]],
    "rules_list says which rules are deleted",
  );
  const out = await run(OP.ruleRestore)({ ruleId: id, rev: 3, expectedRev: 3 }, owner);
  assert.deepEqual(out, { id, rev: 4, restoredFrom: 3 });
  assert.equal(liveRules(db).length, 1);
  assert.deepEqual(liveRules(db)[0]?.spec, v2);
  const got = await run(OP.rulesGet)({ id }, owner);
  assert.equal(got.deleted, false);
  assert.deepEqual(
    got.revisions.map((r: any) => r.change),
    ["restored", "deleted", "updated", "created"],
  );
  assert.equal((await run(OP.rulesList)({}, owner)).rules[0].deleted, false);
});

test("writer refusal: a revision that today's writer refuses is refused with the writer's reason, nothing written", async () => {
  const { db, raw, owner, id } = await threeRevisions();
  // a revision stored before a writer check tightened (0.4.1: a tools entry with "__" is a resolved variant, not a catalog name)
  const stale = spec({ title: "old", match: { products: ["connect"], tools: ["gmail_send__first_contact"] } });
  raw.prepare("UPDATE rule_revisions SET spec = ? WHERE rule_id = ? AND rev = 1").run(JSON.stringify(stale), id);
  const viaSet = await run(OP.rulesSet)({ rule: stale }, owner).then(
    () => null,
    (e: any) => e,
  );
  assert.equal(viaSet?.code, "input_invalid");
  await assert.rejects(run(OP.ruleRestore)({ ruleId: id, rev: 1, expectedRev: 2 }, owner), (e: any) => {
    assert.equal(e.code, "input_invalid");
    assert.equal(e.message, `revision 1 can’t be restored: ${viaSet.message}`, "the same writer, its reason named");
    return true;
  });
  // a revision that names an app the app catalog does not list (gone since): refused by the catalog check, as rules_set does
  const named = spec({ title: "crm", match: { products: ["crm"], operations: ["export_all"] } });
  raw.prepare("UPDATE rule_revisions SET spec = ? WHERE rule_id = ? AND rev = 1").run(JSON.stringify(named), id);
  const setErr = await run(OP.rulesSet)({ rule: named }, owner).then(
    () => null,
    (e: any) => e,
  );
  assert.match(setErr?.message ?? "", /crm/);
  await assert.rejects(run(OP.ruleRestore)({ ruleId: id, rev: 1 }, owner), (e: any) => {
    assert.equal(e.code, setErr.code);
    assert.equal(e.message, `revision 1 can’t be restored: ${setErr.message}`);
    return true;
  });
  assert.equal(Number(raw.prepare("SELECT COUNT(*) AS n FROM rule_revisions WHERE rule_id = ?").get(id)?.n), 2, "no revision row added");
  assert.equal(liveRules(db)[0]?.rev, 2);
});

test("refusals: unknown rule or revision, the current revision of a live rule, a stale expectedRev, an agent caller", async () => {
  const { owner, id, db } = await threeRevisions();
  await assert.rejects(run(OP.ruleRestore)({ ruleId: "rul_missing", rev: 1 }, owner), { code: "not_found" });
  await assert.rejects(run(OP.ruleRestore)({ ruleId: id, rev: 9 }, owner), { code: "not_found" });
  await assert.rejects(run(OP.ruleRestore)({ ruleId: id, rev: 2 }, owner), { code: "input_invalid", message: "revision 2 is already the current version" });
  await assert.rejects(run(OP.ruleRestore)({ ruleId: id, rev: 1, expectedRev: 1 }, owner), { code: "revision_conflict" });
  await assert.rejects(run(OP.ruleRestore)({ ruleId: id, rev: 1 }, opCtx(db, { type: "agent", id: AGENT_A })), { code: "forbidden" });
});

test("idempotency: a repeated restore of the same version (same expectedRev) writes once and the repeat is refused", async () => {
  // The SDK replays a repeated Idempotency-Key (manifest idempotency "required", conformance checks it); the op itself also
  // never writes twice for one owner action: the second call carries the revision the owner saw, which is no longer current.
  const { raw, owner, id } = await threeRevisions();
  await run(OP.ruleRestore)({ ruleId: id, rev: 1, expectedRev: 2 }, owner);
  await assert.rejects(run(OP.ruleRestore)({ ruleId: id, rev: 1, expectedRev: 2 }, owner), { code: "revision_conflict" });
  const rows = raw.prepare("SELECT rev, change FROM rule_revisions WHERE rule_id = ? ORDER BY rev").all(id);
  assert.deepEqual(
    rows.map((r) => r.change),
    ["created", "updated", "restored"],
  );
});

test("upgrade from a 0.4.1 database: 0007 adds from_rev; old revisions read without from and can be restored", () => {
  const raw = new DatabaseSync(":memory:");
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files.filter((x) => x < "0007")) raw.exec(readFileSync(join(migrationsDir, f), "utf8"));
  const v1 = JSON.stringify(spec({ title: "old v1", match: { effects: ["money"] } }));
  const v2 = JSON.stringify(spec({ title: "old v2", match: { effects: ["money"] }, decision: "hold" }));
  raw.prepare("INSERT INTO rules (id, rev, spec, priority, active, deleted, source, created_at, updated_at) VALUES ('rul_old', 3, ?, 100, 0, 1, 'owner', 1, 3)").run(v2);
  const rev = raw.prepare("INSERT INTO rule_revisions (rule_id, rev, change, spec, actor, at) VALUES ('rul_old', ?, ?, ?, ?, ?)");
  rev.run(1, "created", v1, OWNER, 1);
  rev.run(2, "updated", v2, OWNER, 2);
  rev.run(3, "deleted", v2, OWNER, 3);
  for (const f of files.filter((x) => x >= "0007")) raw.exec(readFileSync(join(migrationsDir, f), "utf8"));
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
  const before = getRule(db, "rul_old");
  assert.equal(before.revisions.length, 3, "history stays");
  assert.ok(before.revisions.every((r) => !("from" in r)), "old rows have no from");
  assert.deepEqual(restoreRule(db, { id: "rul_old", rev: 1, expectedRev: 3, actor: OWNER }), { id: "rul_old", rev: 4, restoredFrom: 1 });
  assert.equal(getRule(db, "rul_old").deleted, false);
  assert.equal(liveRules(db)[0]?.spec.title, "old v1");
});
