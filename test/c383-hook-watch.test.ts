// C383 (D13): Rules finds out that its own hook is switched off from its own read of Governance: the bridge sends that read through the hooks, so a hook that did not run during it is off.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Json, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { handlers } from "../src/app.ts";
import { type CallApp, syncFleet } from "../src/fleet.ts";
import { HOOK_STATE_MAX_AGE_MS, hookState } from "../src/hook-watch.ts";
import { makeHooks } from "../src/hooks.ts";
import { feed, hookCtx, hookReq, migratedDb, OWNER, opCtx } from "./helpers.ts";

type Db = ReturnType<typeof migratedDb>["db"];
const hooks = makeHooks("rules") as unknown as Record<string, (r: unknown, c: unknown) => Promise<unknown>>;
const READ = { app: { product: "rules" }, product: "fleet", op: "directory_feed", effect: "read" };

/** A bridge: runs the switched-on hooks of Rules around the read (gate and context before the forward, filter after), as `CallRouter.route` does, then answers. */
function bridge(db: Db, on: { gate?: boolean; context?: boolean; filter?: boolean }, answer: () => Promise<{ status: "ok"; output: Json } | { status: "held"; holdId: string }> = async () => ({ status: "ok", output: feed() as Json })): CallApp {
  return (async () => {
    if (on.gate) await hooks.rules_gate?.(hookReq("before", READ), hookCtx(db));
    if (on.context) await hooks.rules_context?.(hookReq("context", READ), hookCtx(db));
    const r = await answer();
    if (r.status === "ok" && on.filter) await hooks.rules_filter?.(hookReq("after", { ...READ, output: {} }), hookCtx(db));
    return r;
  }) as unknown as CallApp;
}
const ALL_ON = { gate: true, context: true, filter: true };

test("before any read of Governance the state is unknown, never on", () => {
  const { db } = migratedDb();
  assert.deepEqual(hookState(db), { gate: "unknown", context: "unknown", filter: "unknown", checkedAt: null });
});

test("all hooks ran during the read: on", async () => {
  const { db } = migratedDb();
  await syncFleet(db, bridge(db, ALL_ON));
  const s = hookState(db);
  assert.deepEqual([s.gate, s.context, s.filter], ["on", "on", "on"]);
  assert.ok(s.checkedAt);
});

test("the gate did not run during a forwarded read: off (fires), and on again after the owner switches it on (quiet)", async () => {
  const { db } = migratedDb();
  await syncFleet(db, bridge(db, { context: true, filter: true }));
  assert.deepEqual([hookState(db).gate, hookState(db).context, hookState(db).filter], ["off", "on", "on"]);
  await syncFleet(db, bridge(db, ALL_ON));
  assert.equal(hookState(db).gate, "on");
});

test("each hook is judged alone", async () => {
  const { db } = migratedDb();
  await syncFleet(db, bridge(db, { gate: true, filter: true }));
  assert.deepEqual([hookState(db).gate, hookState(db).context, hookState(db).filter], ["on", "off", "on"]);
  await syncFleet(db, bridge(db, { gate: true, context: true }));
  assert.deepEqual([hookState(db).gate, hookState(db).context, hookState(db).filter], ["on", "on", "off"]);
});

test("a read the bridge refused says nothing: no off from a refusal, a hold, or a missing Governance", async () => {
  for (const answer of [
    async () => {
      throw Object.assign(new Error("no grant"), { code: "no_grant" });
    },
    async () => {
      throw Object.assign(new Error("hook failed"), { code: "hook_failed" });
    },
    async () => ({ status: "held" as const, holdId: "hld_1" }),
  ]) {
    const { db } = migratedDb();
    await syncFleet(db, bridge(db, {}, answer));
    assert.equal(hookState(db).gate, "unknown");
  }
});

test("an old answer says nothing: five minutes without one is unknown, also for an off", async () => {
  const { db } = migratedDb();
  await syncFleet(db, bridge(db, {}));
  const at = hookState(db).checkedAt as number;
  assert.equal(hookState(db, at + HOOK_STATE_MAX_AGE_MS).gate, "off");
  assert.equal(hookState(db, at + HOOK_STATE_MAX_AGE_MS + 1).gate, "unknown");
});

test("hook_state is the owner's: it answers the page, and an agent gets no answer", async () => {
  const { db } = migratedDb();
  await syncFleet(db, bridge(db, { context: true, filter: true }));
  const run = (handlers.hook_state as unknown as { run: (i: unknown, c: OpContext) => Promise<Record<string, unknown>> }).run;
  const out = await run({}, opCtx(db, { type: "person", id: OWNER }));
  assert.equal(out.gate, "off");
  assert.equal(typeof out.checkedAt, "string");
  assert.equal(out.lastGateAt, null, "the gate never ran here");
  await assert.rejects(run({}, opCtx(db, { type: "agent", id: "agt_01J0000000000000000000000A" })));
});
