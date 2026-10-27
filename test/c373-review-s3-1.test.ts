// Review 0.5.0 S3-1: after a 400 to `accept`, Rules read the feed WITHOUT agent handles and believed the copy complete, so a deny by
// recipient trust missed a handle held only by a blocked agent. Such a copy is now INCOMPLETE for recipients: every recipient is
// unknown (deny/hold recipient rules apply, allow ones do not); teams and trust of callers stay usable.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db, Json } from "@opt2-tealbrick/miniapp-sdk";
import { ACCEPT_RETRY_MS, syncFleet } from "../src/fleet.ts";
import { makeHooks } from "../src/hooks.ts";
import { fleetFacts, saveRule } from "../src/store.ts";
import { AGENT_A, AGENT_R, feed, hookCtx, hookReq, migratedDb, OWNER, spec } from "./helpers.ts";

const H = "slack:U999"; // a handle Connect issued to the blocked agent AGENT_R
type Gate = (r: unknown, c: unknown) => Promise<{ allow: boolean; reason?: string }>;
const gate = (makeHooks("rules") as unknown as Record<string, Gate>).rules_gate as Gate;
const withHandles = feed({ agents: [{ id: AGENT_A, status: "active", trust: "trusted", owner: "ct_anna" }, { id: AGENT_R, status: "removed", trust: "blocked", owner: null, handles: [H] }] });

async function send(db: Db, recipients: string[], caller = AGENT_A) {
  const req = hookReq("before", { effect: "outward", op: "buzz_dm", caller });
  (req as unknown as { call: { target: Record<string, unknown> } }).call.target.recipients = recipients;
  return gate(req, hookCtx(db));
}

/** A Governance that answers the first read WITH `accept` with a 400 (any reason), then answers plain reads without handles. */
function governance(opts: { refuseFirst: boolean }) {
  let calls = 0;
  return async (_p: string, _o: string, input: Json) => {
    calls++;
    const accept = (input as { accept?: unknown }).accept !== undefined;
    if (opts.refuseFirst && calls === 1 && accept) throw Object.assign(new Error("bad sinceRevision"), { code: "input_invalid", httpStatus: 400 });
    return { status: "ok" as const, output: accept ? withHandles : feed() };
  };
}

test("S3-1: a copy read without agent handles makes recipients unknown: deny by recipient trust applies, the Fleet stays available", async () => {
  const { db } = migratedDb();
  saveRule(db, { spec: spec({ title: "never message blocked", priority: 10, match: { effects: ["outward"], recipients: { trust: ["blocked"] } }, decision: "deny" }), actor: OWNER });
  let t = 1_000_000;
  const now = () => t;
  await syncFleet(db, governance({ refuseFirst: true }), now);
  assert.equal(fleetFacts(db, t).available, true, "teams and trust stay usable");
  assert.equal(fleetFacts(db, t).agentHandles, false);
  assert.equal((await send(db, [H])).allow, false, "the blocked agent's handle is not believed unknown-to-nobody");
  assert.equal((await send(db, ["slack:U777"])).allow, false, "any recipient is unknown while the copy has no agent handles");
  // a call that names no recipient is unaffected
  const read = hookReq("before", { effect: "read", op: "buzz_read" });
  assert.equal((await gate(read, hookCtx(db))).allow, true);
  // after ACCEPT_RETRY_MS Rules asks with `accept` again, gets the handles, and the copy is complete
  t += ACCEPT_RETRY_MS + 1;
  await syncFleet(db, governance({ refuseFirst: false }), now);
  assert.equal(fleetFacts(db, t).agentHandles, true);
});

test("S3-1: allow by recipient does not match while the copy has no agent handles; with the handles it does", async () => {
  const { db } = migratedDb();
  saveRule(db, { spec: spec({ title: "trusted recipients ok", priority: 10, match: { effects: ["outward"], recipients: { trust: ["trusted"] } }, decision: "allow" }), actor: OWNER });
  saveRule(db, { spec: spec({ title: "hold sends", priority: 20, match: { effects: ["outward"] }, decision: "hold" }), actor: OWNER });
  await syncFleet(db, governance({ refuseFirst: true }));
  assert.equal((await send(db, ["slack:U777"])).allow, false, "Anna's handle: the allow by trust is skipped (unknown), the hold applies");
  const { db: db2 } = migratedDb();
  saveRule(db2, { spec: spec({ title: "trusted recipients ok", priority: 10, match: { effects: ["outward"], recipients: { trust: ["trusted"] } }, decision: "allow" }), actor: OWNER });
  saveRule(db2, { spec: spec({ title: "hold sends", priority: 20, match: { effects: ["outward"] }, decision: "hold" }), actor: OWNER });
  await syncFleet(db2, governance({ refuseFirst: false }));
  assert.deepEqual(await send(db2, ["slack:U777"]), { allow: true }, "with agent handles the copy is complete");
});

test("S3-1: a copy loaded after a restart counts as without agent handles until the next full read", async () => {
  const { db, raw } = migratedDb();
  await syncFleet(db, governance({ refuseFirst: false }));
  assert.equal(fleetFacts(db).agentHandles, true);
  // a restart: a new Db over the same tables (the in-memory caches are per Db)
  const again = { exec: (q: string) => raw.exec(q), prepare: (q: string) => raw.prepare(q), transaction: <T>(fn: () => T) => fn() } as unknown as Db;
  assert.equal(fleetFacts(again).available, true);
  assert.equal(fleetFacts(again).agentHandles, false);
  assert.equal((await send(again, ["slack:U777"])).allow, true, "no recipient rule: unknown recipients change nothing");
});
