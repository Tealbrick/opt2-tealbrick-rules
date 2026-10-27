// C373 dev.5 fixes, server side: rules_list names the dynamic operations of the catalog (D12), the preview over recent calls (D11),
// control characters in writer text (RU-1), decisions of no-match writes (RU-2) and one bad manifest URL in the catalog (RU-3).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { handlers } from "../src/app.ts";
import { migratedDb, OWNER, opCtx } from "./helpers.ts";

type Run = (input: unknown, ctx: OpContext) => Promise<any>;
const run = (id: keyof typeof handlers) => (handlers[id] as unknown as { run: Run }).run;
const owner = (db: ReturnType<typeof migratedDb>["db"]) => opCtx(db, { type: "person", id: OWNER });

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
