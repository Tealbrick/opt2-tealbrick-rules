// C380 B8a, S1-1: the company floor must not fail open. Each test ends with the same question: is the stopped agent still refused?
// Written to break the floor: every refusal of the feed read, an outage, a restart, a crash at every write, bad rows, a fallback read,
// and a fuzz over all of them. Then who it reaches (caller, acting agent, requester, recipient), what the caller learns, and who gets out.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Db, HookContext, HookRequest, Json, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { OP } from "#kit";
import { handlers, manifest } from "../src/app.ts";
import { type CallApp, FEED_INVALID, parseFeed, syncFleet } from "../src/fleet.ts";
import { FLOOR_REASON, floorIndex, floorRows, floorState, GATE_NOTE_MS, noteGate } from "../src/floor.ts";
import { FAIL_CLOSED, makeHooks } from "../src/hooks.ts";
import { EXEMPTIONS, exemptionOf } from "../src/mode.ts";
import { setMode } from "../src/mode-store.ts";
import { previewRecent } from "../src/recent.ts";
import { FLEET_MAX_STALE_MS, fleetFacts, listDecisions, saveRule, writeFleet } from "../src/store.ts";
import { AGENT_A, AGENT_B, APP_INSTANCE, feed, hookCtx, hookReq, migratedDb, NPUB, OWNER, opCtx, prng, seedCatalog, spec } from "./helpers.ts";

type GateAnswer = { allow: boolean; reason?: string; hold?: unknown };
const hooks = makeHooks("rules") as unknown as Record<string, (r: HookRequest, c: HookContext) => Promise<GateAnswer>>;
const gate = (db: Db, o: Parameters<typeof hookReq>[1] = {}) => (hooks.rules_gate as NonNullable<(typeof hooks)["rules_gate"]>)(hookReq("before", o), hookCtx(db));
type Run = (input: unknown, ctx: OpContext) => Promise<any>;
const run = (id: keyof typeof handlers) => (handlers[id] as unknown as { run: Run }).run;
const ownerCtx = (db: Db) => opCtx(db, { type: "person", id: OWNER });
/** An op context whose caller is exactly this object (`opCtx` keeps only some caller fields). */
const callerCtx = (db: Db, caller: Record<string, unknown>) => ({ ...opCtx(db, { type: "person", id: OWNER }), caller }) as unknown as OpContext;

/** A feed in which AGENT_A is leaving, and AGENT_B, and ct_anna active; ct_left has left and holds a handle. */
function floorFeed(over: Record<string, unknown> = {}): Record<string, Json> {
  return feed({
    teams: [],
    contacts: [
      { id: "ct_anna", kind: "person", status: "active", trust: "trusted", handles: ["slack:U777"], lifecycle: "active", floor: false },
      { id: "ct_left", kind: "person", status: "departed", trust: "trusted", handles: ["telegram:9", NPUB], lifecycle: "leaving", floor: true },
    ],
    agents: [
      { id: AGENT_A, status: "active", trust: "trusted", owner: "ct_left", lifecycle: "leaving", floor: true },
      { id: AGENT_B, status: "active", trust: "trusted", owner: "ct_anna", lifecycle: "active", floor: false },
    ],
    ...over,
  });
}
const answer = (out: unknown): CallApp => async () => ({ status: "ok", output: out });
const failing = (code: string, httpStatus?: number): CallApp => async () => {
  throw Object.assign(new Error(code), { code, ...(httpStatus !== undefined ? { httpStatus } : {}) });
};

async function stopped(now?: () => number) {
  const { db, raw } = migratedDb();
  await syncFleet(db, answer(floorFeed()), now);
  const a = await gate(db);
  assert.equal(a.allow, false, "the read listed AGENT_A");
  assert.equal(a.reason, FLOOR_REASON);
  return { db, raw };
}

/** The same database as after a restart: a new `Db` object, so every in-memory copy is gone. */
function restarted(db: Db): Db {
  return { exec: (s: string) => db.exec(s), prepare: (s: string) => db.prepare(s), transaction: <T>(f: () => T) => db.transaction(f) } as unknown as Db;
}

const refusedAsFloor = (a: GateAnswer) => a.allow === false && a.reason === FLOOR_REASON;

// ── S1-1: survival ───────────────────────────────────────────────────────────────────────
for (const code of [FEED_INVALID, "no_grant", "not_granted", "grant_missing", "grant_invalid", "grant_stale", "not_found", "unknown_product", "unknown_tool", "app_not_found", "unlicensed", "not_licensed", "forbidden", "scope_denied", "paused", "held"]) {
  test(`S1-1: refusal ${code}: Fleet facts gone, agent still refused`, async () => {
    const { db } = await stopped();
    await syncFleet(db, failing(code));
    assert.equal(fleetFacts(db).available, false, "this read clears the copy");
    assert.ok(refusedAsFloor(await gate(db)));
    assert.ok(refusedAsFloor(await gate(restarted(db))), "and after a restart");
  });
}

for (const [code, status] of [["hook_denied", 403], ["input_invalid", 400], ["gone", 410], ["internal_error", 500], ["feed_too_large", 503], ["bad_gateway", 502], ["timeout", 408], ["rate_limited", 429], ["ECONNRESET", undefined]] as const) {
  test(`S1-1: failed read ${code} ${status ?? ""}: agent still refused`, async () => {
    const { db } = await stopped();
    await syncFleet(db, failing(code, status));
    assert.ok(refusedAsFloor(await gate(db)));
  });
}

test("S1-1: a held answer does not touch it", async () => {
  const { db } = await stopped();
  await syncFleet(db, async () => ({ status: "held", holdId: "hld_1" }));
  assert.ok(refusedAsFloor(await gate(db)));
});

test("S1-1: an outage past the 10 minutes, then a restart: Fleet facts gone, agent still refused, and no rule can open it", async () => {
  let t = Date.now();
  const clock = () => t;
  const { db } = await stopped(clock);
  saveRule(db, { spec: spec({ title: "allow all", priority: 0, outcome: { decision: "allow", reason: "open" } }), actor: OWNER });
  t += FLEET_MAX_STALE_MS + 60_000;
  await syncFleet(db, failing("internal_error", 500), clock);
  assert.equal(fleetFacts(db, t).available, false);
  assert.ok(refusedAsFloor(await gate(db)));
  assert.ok(refusedAsFloor(await gate(restarted(db))));
});

test("S1-1: one bad row refuses the whole answer: a compromised Governance cannot open every stop that way", async () => {
  for (const bad of [
    { agents: [{ id: AGENT_B, status: "nonsense", trust: "trusted", owner: null }] },
    { contacts: [{ id: "ct", kind: "person", status: "active", trust: "trusted", handles: ["SLACK:U1"] }] },
    { agents: [{ id: AGENT_A, status: "active", trust: "trusted", owner: null, floor: "no" }] },
    { agents: [{ id: AGENT_A, status: "active", trust: "trusted", owner: null, floor: 0 }] },
    { agents: [{ id: AGENT_A, status: "active", trust: "trusted", owner: null, floor: null }] },
    { contacts: [{ id: "ct", kind: "person", status: "active", trust: "trusted", handles: [], lifecycle: 7 }] },
    { contacts: [{ id: "ct", kind: "person", status: "active", trust: "trusted", handles: [], lifecycle: "departed" }] },
    { contacts: [{ id: "ct", kind: "person", status: "active", trust: "trusted", handles: [], lifecycle: "NOT A STATE" }] },
    { revision: "8" },
    { v: 2 },
    { agents: [] , contacts: "x" },
  ]) {
    const { db } = await stopped();
    await syncFleet(db, answer(floorFeed({ revision: 8, ...bad })));
    assert.ok(refusedAsFloor(await gate(db)), JSON.stringify(bad));
    assert.equal(floorState(db).feedRevision, 7, "the revision does not move");
  }
});

test("S1-1: unchanged keeps it; an unchanged for a revision nobody asked about is refused and keeps it", async () => {
  const { db } = await stopped();
  await syncFleet(db, answer({ v: 1, revision: 7, unchanged: true }));
  assert.ok(refusedAsFloor(await gate(db)));
  await syncFleet(db, answer({ v: 1, revision: 9, unchanged: true }));
  assert.ok(refusedAsFloor(await gate(db)));
  assert.equal(floorState(db).feedRevision, 7);
});

test("S1-1: crash at EVERY statement of a replacing write: the old floor stays whole, and a later read still works", async () => {
  const { db, raw } = migratedDb();
  await syncFleet(db, answer(floorFeed()));
  // count the statements of one replacing write, then fail each of them in turn
  let total = 0;
  const counted = (limit: number) => {
    let n = 0;
    return {
      exec: (s: string) => {
        if (++n === limit) throw new Error("crash");
        raw.exec(s);
      },
      prepare: (s: string) => {
        const st = raw.prepare(s);
        return {
          run: (...a: unknown[]) => {
            if (++n === limit) throw new Error("crash");
            return (st.run as (...x: unknown[]) => unknown)(...a);
          },
          get: (...a: unknown[]) => (st.get as (...x: unknown[]) => unknown)(...a),
          all: (...a: unknown[]) => (st.all as (...x: unknown[]) => unknown)(...a),
        };
      },
      transaction<T>(fn: () => T): T {
        raw.exec("BEGIN");
        try {
          const out = fn();
          raw.exec("COMMIT");
          return out;
        } catch (e) {
          raw.exec("ROLLBACK");
          throw e;
        }
      },
      get count() {
        return n;
      },
    };
  };
  const opened = floorFeed({ revision: 8, agents: [{ id: AGENT_A, status: "active", trust: "trusted", owner: null, lifecycle: "active", floor: false }], contacts: [] });
  const probe = counted(Number.MAX_SAFE_INTEGER);
  await syncFleet(probe as unknown as Db, answer(opened));
  total = probe.count;
  assert.ok(total > 3, `the write ran ${total} statements`);
  // back to the stopped state
  const reset = restarted(db);
  await syncFleet(reset, answer(floorFeed({ revision: 9 })));
  for (let i = 1; i <= total; i++) {
    const crashing = counted(i) as unknown as Db;
    await syncFleet(crashing, answer(opened));
    const after = restarted(db);
    const state = raw.prepare("SELECT revision, usable FROM fleet_sync WHERE id = 1").get() as { revision: number | null; usable: number };
    const committed = state.usable === 1 && state.revision === 8;
    assert.ok(refusedAsFloor(await gate(after)) || committed, `crash at statement ${i}: ${JSON.stringify(state)}`);
    if (committed) {
      // that statement was after the commit point; put the stop back for the next round
      await syncFleet(restarted(db), answer(floorFeed({ revision: 9 })));
    }
  }
  const last = restarted(db);
  await syncFleet(last, answer(opened));
  assert.equal((await gate(last)).allow, true, "the next good read lifts it");
});

test("S1-1: the database refuses the write that clears the copy: still refused", async () => {
  const { db } = await stopped();
  const broken = {
    exec: () => {
      throw new Error("disk");
    },
    prepare: (s: string) => {
      if (/^(UPDATE|DELETE|INSERT)/.test(s)) throw new Error("disk");
      return db.prepare(s);
    },
    transaction: <T>(f: () => T) => f(),
  } as unknown as Db;
  await syncFleet(broken, failing("no_grant"));
  assert.ok(refusedAsFloor(await gate(db)));
  assert.equal((await gate(broken)).allow, false, "the broken handle refuses too (it cannot even write the Decisions row)");
});

test("S1-1: the floor table cannot be read: the gate refuses, it does not pass", async () => {
  const { db } = migratedDb();
  const broken = {
    exec: (s: string) => db.exec(s),
    prepare: (s: string) => {
      if (s.includes("floor_entries")) throw new Error("no such table");
      return db.prepare(s);
    },
    transaction: <T>(f: () => T) => db.transaction(f),
  } as unknown as Db;
  assert.deepEqual(await gate(broken, { caller: AGENT_B }), { allow: false, reason: FAIL_CLOSED });
});

test("review #34: a full valid read with no lifecycle facts (rollback, Governance ignores accept, empty directory) cannot lift a lifecycle stop, and confirms no revision", async () => {
  const blind = (over: Record<string, unknown>) => answer(floorFeed({ revision: 6, contacts: [], agents: [{ id: AGENT_A, status: "active", trust: "trusted", owner: null }], ...over }));
  const { db } = await stopped();
  await syncFleet(db, blind({}));
  assert.ok(refusedAsFloor(await gate(db)), "A stays");
  assert.equal(floorState(db).feedRevision, 7);
  await syncFleet(db, blind({ revision: 8, agents: [] }));
  assert.ok(refusedAsFloor(await gate(db)), "an empty directory does not lift it either");
  assert.ok(refusedAsFloor(await gate(restarted(db))));
  // the next read with lifecycle facts does
  await syncFleet(db, answer(floorFeed({ revision: 9, contacts: [], agents: [{ id: AGENT_A, status: "active", trust: "trusted", owner: null, lifecycle: "active", floor: false }] })));
  assert.equal((await gate(db)).allow, true);
  assert.equal(floorState(db).feedRevision, 9);
});

test("review #34: a read with no lifecycle facts still decides what it can see: an unblocked agent and a returned contact are lifted (Rules dev on Governance 0.3.2)", async () => {
  const { db } = migratedDb();
  const row = (trust: string) => ({ id: AGENT_B, status: "active", trust, owner: null });
  const contact = (status: string) => ({ id: "ct_x", kind: "person", status, trust: "trusted", handles: ["slack:U12"] });
  await syncFleet(db, answer(feed({ teams: [], contacts: [contact("departed")], agents: [row("blocked")] })));
  assert.ok(refusedAsFloor(await gate(db, { caller: AGENT_B })));
  assert.ok(refusedAsFloor(await withTarget(db, TO(["slack:U12"]), { caller: AGENT_A })));
  assert.equal(floorState(db).feedRevision, null, "nothing to confirm");
  await syncFleet(db, answer(feed({ revision: 8, teams: [], contacts: [contact("active")], agents: [row("trusted")] })));
  assert.equal((await gate(db, { caller: AGENT_B })).allow, true);
  assert.equal((await withTarget(db, TO(["slack:U12"]), { caller: AGENT_A })).allow, true);
});

test("review #34: a blocked entry that a blind read made a lifecycle stop keeps the lifecycle stop", async () => {
  const { db } = await stopped();
  await syncFleet(db, answer(floorFeed({ revision: 8, contacts: [], agents: [{ id: AGENT_A, status: "active", trust: "blocked", owner: null }] })));
  await syncFleet(db, answer(floorFeed({ revision: 9, contacts: [], agents: [{ id: AGENT_A, status: "active", trust: "trusted", owner: null }] })));
  assert.ok(refusedAsFloor(await gate(db)), "it was leaving, and no read with lifecycle facts said otherwise");
});

test("delta review #34: a blocked and suspended row keeps its lifecycle stop through a blind read that says trusted", async () => {
  const { db } = migratedDb();
  await syncFleet(db, answer(floorFeed({ contacts: [], agents: [{ id: AGENT_A, status: "active", trust: "blocked", owner: null, lifecycle: "suspended", floor: true }] })));
  assert.equal(floorRows(db, 5)[0]?.code, "suspended", "the lifecycle stop names the entry");
  await syncFleet(db, answer(floorFeed({ revision: 8, contacts: [], agents: [{ id: AGENT_A, status: "active", trust: "trusted", owner: null }] })));
  assert.ok(refusedAsFloor(await gate(db)));
});

test("delta review #34: one blind row in an aware answer does not lift that holder; the aware rows beside it decide; an omitted row is lifted", async () => {
  const { db } = migratedDb();
  const stop = (id: string) => ({ id, status: "active", trust: "trusted", owner: null, lifecycle: "suspended", floor: true });
  const AGENT_C = "agt_01J0000000000000000000000C";
  await syncFleet(db, answer(floorFeed({ contacts: [], agents: [stop(AGENT_A), stop(AGENT_B), stop(AGENT_C)] })));
  await syncFleet(db, answer(floorFeed({ revision: 8, contacts: [], agents: [{ id: AGENT_A, status: "active", trust: "trusted", owner: null }, { id: AGENT_B, status: "active", trust: "trusted", owner: null, lifecycle: "active", floor: false }] })));
  assert.ok(refusedAsFloor(await gate(db)), "A: blind row");
  assert.equal((await gate(db, { caller: AGENT_B })).allow, true, "B: aware row");
  assert.equal((await gate(db, { caller: AGENT_C })).allow, true, "C: a row that left a read with lifecycle facts");
  assert.equal(floorState(db).feedRevision, 8);
});

test("delta review #34: a handle a blocked holder and a leaving holder share stays through a blind read", async () => {
  const { db } = migratedDb();
  await syncFleet(db, answer(floorFeed({ agents: [], contacts: [{ id: "ct_b", kind: "person", status: "active", trust: "blocked", handles: ["slack:U12"], floor: true }, { id: "ct_l", kind: "person", status: "departed", trust: "trusted", handles: ["slack:U12"], lifecycle: "leaving", floor: true }] })));
  await syncFleet(db, answer(floorFeed({ revision: 8, agents: [], contacts: [{ id: "ct_b", kind: "person", status: "active", trust: "trusted", handles: ["slack:U12"] }, { id: "ct_l", kind: "person", status: "active", trust: "trusted", handles: ["slack:U12"] }] })));
  assert.ok(refusedAsFloor(await withTarget(db, TO(["slack:U12"]))));
});

test("fallback read (Governance refuses accept with 400): adds a stop, never lifts a lifecycle stop, and does not confirm a revision", async () => {
  const { db } = await stopped();
  const calls: Json[] = [];
  let n = 0;
  const twice: CallApp = async (_p, _o, input) => {
    calls.push(input);
    if (n++ === 0) throw Object.assign(new Error("bad"), { code: "input_invalid", httpStatus: 400 });
    return { status: "ok", output: floorFeed({ revision: 8, contacts: [], agents: [{ id: AGENT_A, status: "active", trust: "trusted", owner: null }, { id: AGENT_B, status: "active", trust: "blocked", owner: null }] }) };
  };
  await syncFleet(db, twice);
  assert.deepEqual(calls[1], {}, "the second read asks for nothing extra");
  assert.ok(refusedAsFloor(await gate(db)), "A stays");
  assert.ok(refusedAsFloor(await gate(db, { caller: AGENT_B })), "B added");
  assert.equal(floorState(db).feedRevision, 7);
});

test("asks for lifecycle on every read that asks for anything; Governance 0.3.x ignores it: blocked and departed still stop", async () => {
  const { db } = migratedDb();
  const asked: Json[] = [];
  await syncFleet(db, async (_p, _o, input) => {
    asked.push(input);
    return { status: "ok", output: feed() };
  });
  assert.deepEqual(asked[0], { accept: ["agent_handles", "lifecycle", "roles"] });
  const keys = [...floorIndex(db).keys()].sort();
  assert.deepEqual(keys, ["agent:agt_01J0000000000000000000000R", "contact:ct_block", "contact:ct_gone", "handle:slack:U666", "handle:telegram:9"]);
  assert.equal((await gate(db)).allow, true, "an active agent runs");
  assert.ok(refusedAsFloor(await gate(db, { context: { "tb.onBehalfOf": { claim: { kind: "person", id: "ct_gone" }, verified: false } } })));
});

test("a removed agent with no card on a lifecycle feed (floor false) is not listed; a stopping lifecycle stops whatever floor says", () => {
  const p = parseFeed(floorFeed({ contacts: [], agents: [{ id: AGENT_A, status: "removed", trust: "trusted", owner: null, lifecycle: "archived", floor: false }, { id: AGENT_B, status: "active", trust: "trusted", owner: null, lifecycle: "suspended", floor: false }] }));
  assert.deepEqual(p.floor.map((e) => [e.id, e.code]), [[AGENT_B, "suspended"]]);
});

test("floor false cannot lift trust blocked; a handle two holders share stays listed when one is stopped", () => {
  const p = parseFeed(
    floorFeed({
      contacts: [
        { id: "ct_a", kind: "person", status: "active", trust: "trusted", handles: ["slack:U12"], floor: false },
        { id: "ct_b", kind: "person", status: "active", trust: "blocked", handles: ["slack:U12"], floor: false },
      ],
      agents: [],
    }),
  );
  assert.deepEqual(p.floor.map((e) => `${e.kind}:${e.id}:${e.code}`).sort(), ["contact:ct_b:blocked", "handle:slack:U12:blocked"]);
});

test("replace: a valid read lifts what it no longer lists and keeps the first revision of what it does", async () => {
  const { db } = await stopped();
  await syncFleet(db, answer(floorFeed({ revision: 8 })));
  assert.equal(floorRows(db, 10).find((r) => r.id === AGENT_A)?.revision, 7);
  assert.equal(floorState(db).feedRevision, 8);
  await syncFleet(db, answer(floorFeed({ revision: 9, contacts: [], agents: [{ id: AGENT_A, status: "active", trust: "trusted", owner: null, lifecycle: "active", floor: false }] })));
  assert.equal((await gate(db)).allow, true);
  assert.equal((await gate(restarted(db))).allow, true);
  assert.equal(floorState(db).feedRevision, 9);
  assert.equal(floorState(db).entries, 0);
});

test("upgrade from 0.6.0 data: the copy says usable at revision 7, and the first read is still a full one that fills the floor", async () => {
  const { db } = migratedDb();
  writeFleet(db, parseFeed(feed()).model, { revision: 7, error: null });
  assert.equal(floorState(db).entries, 0, "the migration starts empty");
  const asked: Json[] = [];
  const fresh = restarted(db);
  await syncFleet(fresh, async (_p, _o, input) => {
    asked.push(input);
    return { status: "ok", output: floorFeed() };
  });
  assert.deepEqual(asked[0], { accept: ["agent_handles", "lifecycle", "roles"] }, "no sinceRevision");
  assert.ok(refusedAsFloor(await gate(fresh)));
});

test("fuzz: over any sequence of reads, an agent is refused exactly when the last full valid read that asked listed it", async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = prng(seed);
    let t = Date.now();
    const clock = () => t;
    const { db } = migratedDb();
    let live = restarted(db);
    let listed = false;
    let revision = 1;
    for (let i = 0; i < 30; i++) {
      const pick = r();
      t += Math.floor(r() * 4 * 60_000);
      if (pick < 0.2) {
        listed = r() < 0.5;
        revision++;
        await syncFleet(live, answer(floorFeed({ revision, contacts: [], agents: [{ id: AGENT_A, status: "active", trust: "trusted", owner: null, lifecycle: listed ? "leaving" : "active", floor: listed }] })), clock);
      } else if (pick < 0.35) {
        await syncFleet(live, answer(floorFeed({ revision: revision + 1, agents: [{ id: AGENT_A, status: "bad", trust: "trusted", owner: null }] })), clock);
      } else if (pick < 0.5) {
        await syncFleet(live, failing(["no_grant", "paused", "grant_stale", "unlicensed", "hook_denied"][Math.floor(r() * 5)] as string, 403), clock);
      } else if (pick < 0.65) {
        await syncFleet(live, failing("internal_error", 500), clock);
      } else if (pick < 0.75) {
        await syncFleet(live, answer({ v: 1, revision, unchanged: true }), clock);
      } else if (pick < 0.85) {
        live = restarted(db);
      } else {
        t += FLEET_MAX_STALE_MS;
      }
      const a = await gate(live);
      assert.equal(a.allow, !listed, `seed ${seed} step ${i}: listed ${listed}, answered ${JSON.stringify(a)}`);
    }
  }
});

// ── who it reaches ───────────────────────────────────────────────────────────────────────
const ACTING = (id: string): Record<string, Json> => ({ "tb.acting": { v: 1, agents: [{ id, via: "parent_call" }] } });
const CLAIM = (kind: string, id: string, verified = false): Record<string, Json> => ({ "tb.onBehalfOf": { claim: { kind, id }, verified, via: "meta" } });
const TO = (recipients: unknown, incomplete?: boolean): Record<string, unknown> => ({ recipients, ...(incomplete ? { recipientsIncomplete: true } : {}) });

async function withTarget(db: Db, target: Record<string, unknown>, o: Parameters<typeof hookReq>[1] = { caller: AGENT_B }) {
  const req = hookReq("before", o);
  Object.assign(req.call.target as object, target);
  return (hooks.rules_gate as NonNullable<(typeof hooks)["rules_gate"]>)(req, hookCtx(db));
}

test("reach: acting agent (A3), any acting position, on an app call", async () => {
  const { db } = await stopped();
  assert.ok(refusedAsFloor(await gate(db, { app: { product: "evolution" }, context: ACTING(AGENT_A) })));
  assert.ok(refusedAsFloor(await gate(db, { app: { product: "evolution" }, context: { "tb.acting": { v: 1, agents: [{ id: AGENT_B, via: "ticket" }, { id: AGENT_A, via: "ticket" }] } } })));
  assert.equal((await gate(db, { app: { product: "evolution" }, context: ACTING(AGENT_B) })).allow, true);
  assert.equal((await gate(db, { app: { product: "evolution" } })).allow, true, "the app's own work runs");
  const row = listDecisions(db, { caller: APP_INSTANCE, limit: 5 }).items.find((d) => d.answered === "deny");
  assert.deepEqual(row?.detail?.acting, [AGENT_B, AGENT_A], "Decisions names them");
});

test("reach: a malformed tb.acting is refused, not read as none", async () => {
  const { db } = await stopped();
  assert.deepEqual(await gate(db, { app: { product: "evolution" }, context: { "tb.acting": { v: 1, agents: [] } } }), { allow: false, reason: FAIL_CLOSED });
  assert.deepEqual(await gate(db, { caller: AGENT_B, context: { "tb.acting": "x" } }), { allow: false, reason: FAIL_CLOSED });
});

test("reach: acting on an AGENT caller still counts: only the bridge writes it, and it can only refuse", async () => {
  const { db } = await stopped();
  assert.ok(refusedAsFloor(await gate(db, { caller: AGENT_B, context: ACTING(AGENT_A) })));
});

test("reach (A21): a forged claim from a stopped agent; a claim of a stopped person from an active agent, verified or not, by id or handle", async () => {
  const { db } = await stopped();
  assert.ok(refusedAsFloor(await gate(db, { context: CLAIM("person", "ct_anna", true) })), "stopped caller, trusted claim");
  for (const c of [CLAIM("person", "ct_left"), CLAIM("person", "ct_left", true), CLAIM("agent", AGENT_A), CLAIM("channel_sender", "telegram:9"), CLAIM("channel_sender", NPUB), CLAIM("person", "telegram:9")]) assert.ok(refusedAsFloor(await gate(db, { caller: AGENT_B, context: c })), JSON.stringify(c));
  assert.equal((await gate(db, { caller: AGENT_B, context: CLAIM("person", "ct_anna") })).allow, true);
  assert.equal((await gate(db, { caller: AGENT_B, context: CLAIM("channel_sender", "not a handle") })).allow, true, "no key: nothing to refuse");
});

test("reach (A29): a known recipient, also from a list the rules call unknown, also for an app caller", async () => {
  const { db } = await stopped();
  assert.ok(refusedAsFloor(await withTarget(db, TO(["telegram:9"]))));
  assert.ok(refusedAsFloor(await withTarget(db, TO(["slack:U777", NPUB]))));
  assert.ok(refusedAsFloor(await withTarget(db, TO(["telegram:9"], true))), "recipientsIncomplete hides nobody");
  assert.ok(refusedAsFloor(await withTarget(db, TO([...Array.from({ length: 70 }, (_, i) => `slack:U${1000 + i}`), "telegram:9"]))), "over the cap hides nobody");
  assert.ok(refusedAsFloor(await withTarget(db, TO(["not a handle", 7, "telegram:9"]))), "a bad value hides nobody");
  assert.ok(refusedAsFloor(await withTarget(db, TO(["telegram:9"]), { app: { product: "inbox" } })));
  assert.equal((await withTarget(db, TO(["slack:U777"]))).allow, true);
  assert.equal((await withTarget(db, {})).allow, true, "no list: unknown recipients do not refuse");
});

test("all three modes, and an allow rule at priority 0: refused, never held", async () => {
  const { db } = await stopped();
  seedCatalog(db, ["connect"]);
  saveRule(db, { spec: spec({ title: "allow A", priority: 0, match: { agents: [AGENT_A] }, outcome: { decision: "allow", reason: "yes" } }), actor: OWNER });
  for (const mode of ["permissive", "verification", "closed"] as const) {
    setMode(db, { mode, confirm: true, actor: OWNER });
    const a = await gate(db);
    assert.deepEqual(a, { allow: false, reason: FLOOR_REASON }, mode);
  }
});

// ── what the caller learns ───────────────────────────────────────────────────────────────
test("S2-8: every role gets the same bytes; Decisions has the full reason and no handle; rules_explain reads the one sentence", async () => {
  const { db } = await stopped();
  const answers = [await gate(db), await gate(db, { caller: AGENT_B, context: ACTING(AGENT_A), callId: "cal_acting" }), await gate(db, { caller: AGENT_B, context: CLAIM("channel_sender", "telegram:9"), callId: "cal_claim" }), await withTarget(db, TO(["telegram:9"]), { caller: AGENT_B, callId: "cal_to" })];
  for (const a of answers) assert.deepEqual(a, { allow: false, reason: "Refused by company policy" });
  const rows = listDecisions(db, { limit: 10 }).items;
  assert.ok(rows.every((r) => r.answered === "deny" && r.reason.startsWith("Company floor:")));
  assert.match(rows.find((r) => r.callId === "cal_to")?.reason ?? "", /a recipient is marked as leaving/);
  const text = JSON.stringify(rows);
  assert.ok(!text.includes("telegram:9"), "a handle never enters a trace");
  const explained = await run(OP.rulesExplain)({ limit: 10 }, opCtx(db, { type: "agent", id: AGENT_B, name: "B" }));
  assert.ok(explained.decisions.length >= 3);
  for (const d of explained.decisions) {
    assert.equal(d.reason, FLOOR_REASON);
    assert.equal(d.decidedBy, "floor");
    assert.equal(d.ruleId, null);
  }
});

test("rules_preview and the dry run over recent calls: the owner sees the floor decide, and a rule is never credited with it", async () => {
  const { db } = await stopped();
  seedCatalog(db, ["connect"]);
  const out = await run(OP.rulesPreview)({ call: { caller: { type: "agent", id: AGENT_A, mode: "free" }, target: { product: "connect", op: "buzz_dm", effect: "outward" } } }, ownerCtx(db));
  assert.equal(out.decision, "deny");
  assert.equal(out.decidedBy, "floor");
  assert.deepEqual(out.floor, { role: "caller", code: "leaving" });
  const clean = await run(OP.rulesPreview)({ call: { caller: { type: "agent", id: AGENT_B, mode: "free" }, target: { product: "connect", op: "buzz_dm", effect: "outward" } } }, ownerCtx(db));
  assert.equal(clean.floor, null);
  await gate(db);
  const recent = previewRecent(db, { candidate: spec({ title: "x", priority: 1, outcome: { decision: "allow", reason: "x" } }) }, "permissive");
  assert.equal(recent.rows.length, 0);
});

// ── exemptions and the way out ───────────────────────────────────────────────────────────
test("exempt: only Rules' own rules_explain, draft_status, floor_status; rule_draft_submit is not; another app's same name is not", async () => {
  const { db } = await stopped();
  for (const op of ["rules_explain", "draft_status", "floor_status"]) assert.equal((await gate(db, { product: "rules", op, effect: "read" })).allow, true, op);
  assert.ok(refusedAsFloor(await gate(db, { product: "rules", op: "rule_draft_submit", effect: "write" })));
  assert.ok(refusedAsFloor(await gate(db, { product: "connect", op: "rules_explain", effect: "read" })));
  assert.ok(refusedAsFloor(await gate(db, { product: "connect", op: "floor_status", effect: "read" })));
});

test("Rules' own feed read is never refused by the floor, also if it carried a stopped acting agent; another product's is", async () => {
  const { db } = await stopped();
  assert.equal((await gate(db, { app: { product: "rules" }, product: "fleet", op: "directory_feed", effect: "read", context: ACTING(AGENT_A) })).allow, true);
  assert.ok(refusedAsFloor(await gate(db, { app: { product: "knowledge" }, product: "fleet", op: "directory_feed", effect: "read", context: ACTING(AGENT_A) })));
  assert.ok(refusedAsFloor(await gate(db, { app: {}, product: "fleet", op: "directory_feed", effect: "read", context: ACTING(AGENT_A) })), "no verified product");
});

test("the context and after hooks do not read the floor: a stop that lands mid-call does not drop a narrowing", async () => {
  const { db } = migratedDb();
  seedCatalog(db, ["knowledge"]);
  saveRule(db, { spec: spec({ title: "narrow", priority: 1, match: { products: ["knowledge"] }, outcome: { decision: "allow", reason: "tags" }, narrowing: { memoryTags: { anyOf: ["a"] } } }), actor: OWNER });
  await syncFleet(db, answer(floorFeed()));
  const out = await (hooks.rules_context as never as (r: HookRequest, c: HookContext) => Promise<{ add: Record<string, unknown> }>)(hookReq("context", { product: "knowledge", op: "search", effect: "read" }), hookCtx(db));
  assert.ok(out.add["rules.narrowing"]);
});

test("floor_status: Governance only, six caller cases", async () => {
  const { db } = await stopped();
  const ask = (caller: Record<string, unknown>) => run(OP.floorStatus)({}, callerCtx(db, caller));
  const code = async (caller: Record<string, unknown>) => ask(caller).then(() => "ok", (e: { code: string }) => e.code);
  assert.equal(await code({ type: "app", id: APP_INSTANCE, name: "Governance", product: "fleet", listed: true }), "ok");
  assert.equal(await code({ type: "agent", id: AGENT_A, name: "A" }), "no_access");
  assert.equal(await code({ type: "person", id: OWNER, name: "O" }), "no_access");
  assert.equal(await code({ type: "app", id: APP_INSTANCE, name: "Governance" }), "caller_unverified");
  assert.equal(await code({ type: "app", id: APP_INSTANCE, name: "Governance", product: "knowledge", listed: true }), "no_access");
  assert.equal(await code({ type: "app", id: APP_INSTANCE, name: "Governance", product: "fleet", listed: false }), "caller_unverified");
  const op = manifest.operations.find((o) => o.id === "floor_status") as { listing?: string; audience: string };
  assert.equal(op.listing, "workflow");
  assert.equal(manifest.operations.at(-1)?.id, "floor_status", "last in the manifest");
});

test("floor_status (S2-9): feedRevision does not move on a refusal; it says what the floor holds", async () => {
  const { db } = await stopped();
  const ask = () => run(OP.floorStatus)({}, callerCtx(db, { type: "app", id: APP_INSTANCE, name: "G", product: "fleet", listed: true }));
  const a = await ask();
  assert.equal(a.version, manifest.version);
  assert.equal(a.feedRevision, 7);
  assert.equal(a.entries, 4, "agent, contact, two handles");
  assert.ok(a.lastGateAt);
  await syncFleet(db, failing("paused"));
  const b = await ask();
  assert.equal(b.feedRevision, 7);
  assert.equal(b.entries, 4);
});

test("lastGateAt: written at most once a minute, survives a restart, and a failed write changes no decision", async () => {
  const { db } = migratedDb();
  const t = 1_800_000_000_000;
  noteGate(db, t);
  noteGate(db, t + 1000);
  assert.equal(floorState(db).lastGateAt, t + 1000, "memory is newest");
  assert.equal(floorState(restarted(db)).lastGateAt, t, "the table is at most a minute behind");
  noteGate(db, t + GATE_NOTE_MS + 1);
  assert.equal(floorState(restarted(db)).lastGateAt, t + GATE_NOTE_MS + 1);
  const broken = { prepare: () => { throw new Error("disk"); } } as unknown as Db;
  noteGate(broken, t);
});

test("floor_clear (A31): owner only; one holder with its handles, or all; recorded; survives a refused read; a full read that still lists it brings it back", async () => {
  const { db, raw } = await stopped();
  const owner = ownerCtx(db);
  await assert.rejects(run(OP.floorClear)({ confirm: true }, opCtx(db, { type: "agent", id: AGENT_A, name: "A" })), /only the owner/);
  assert.deepEqual(await run(OP.floorClear)({ confirm: true, holder: "contact:ct_left" }, owner), { cleared: 3 });
  assert.equal((await gate(db, { caller: AGENT_B, context: CLAIM("channel_sender", "telegram:9") })).allow, true);
  assert.ok(refusedAsFloor(await gate(db)), "the agent is another holder");
  assert.deepEqual(await run(OP.floorClear)({ confirm: true }, owner), { cleared: 1 });
  assert.equal((await gate(db)).allow, true);
  await syncFleet(db, failing("paused"));
  assert.equal((await gate(db)).allow, true, "Governance paused: it stays cleared");
  await syncFleet(db, answer(floorFeed({ revision: 8 })));
  assert.ok(refusedAsFloor(await gate(db)), "Governance still lists it");
  const rows = raw.prepare("SELECT actor, holder, entries FROM floor_clears ORDER BY id").all();
  assert.deepEqual(rows.map((r) => [r.actor, r.holder, r.entries]), [[OWNER, "contact:ct_left", 3], [OWNER, null, 1]]);
  const person = manifest.operations.find((o) => o.id === "floor_clear") as { audience: string };
  assert.equal(person.audience, "person");
});

test("review #34: after floor_clear Governance does not read a confirmed revision, and the next read is a full one, so a listed entry comes back whatever the revision", async () => {
  const { db } = await stopped();
  const asked: Json[] = [];
  const listing: CallApp = async (_p, _o, input) => {
    asked.push(input);
    const since = (input as { sinceRevision?: number }).sinceRevision;
    return { status: "ok", output: since === 7 ? { v: 1, revision: 7, unchanged: true } : floorFeed() };
  };
  await syncFleet(db, listing);
  assert.equal(asked.at(-1) && (asked.at(-1) as { sinceRevision?: number }).sinceRevision, 7, "the normal read is a delta read");
  await run(OP.floorClear)({ confirm: true }, ownerCtx(db));
  const st = await run(OP.floorStatus)({}, callerCtx(db, { type: "app", id: APP_INSTANCE, name: "G", product: "fleet", listed: true }));
  assert.equal(st.feedRevision, null, "not a claim that Rules has this change");
  assert.equal(st.entries, 0);
  assert.equal((await gate(db)).allow, true);
  await syncFleet(db, listing);
  assert.equal((asked.at(-1) as { sinceRevision?: number }).sinceRevision, undefined, "a full read");
  assert.ok(refusedAsFloor(await gate(db)), "comes back");
  assert.equal(floorState(db).feedRevision, 7);
});

test("delta review #34: floor_clear while a delta read is in flight: that read answers unchanged, and one more full read brings the entry back", async () => {
  const { db } = await stopped();
  await syncFleet(db, answer({ v: 1, revision: 7, unchanged: true })); // copy is current; the next read is a delta read
  const asked: Json[] = [];
  let release: () => void = () => {};
  const gateOpen = new Promise<void>((r) => {
    release = r;
  });
  const listing: CallApp = async (_p, _o, input) => {
    asked.push(input);
    if (asked.length === 1) await gateOpen;
    return { status: "ok", output: (input as { sinceRevision?: number }).sinceRevision === 7 ? { v: 1, revision: 7, unchanged: true } : floorFeed() };
  };
  const running = syncFleet(db, listing);
  await new Promise((r) => setImmediate(r));
  await run(OP.floorClear)({ confirm: true }, ownerCtx(db));
  release();
  await running;
  assert.equal((asked[0] as { sinceRevision?: number }).sinceRevision, 7);
  assert.equal((asked.at(-1) as { sinceRevision?: number }).sinceRevision, undefined, "one more read, a full one");
  assert.ok(refusedAsFloor(await gate(db)));
});

test("floor_list: the owner reads the entries while Governance is gone", async () => {
  const { db } = await stopped();
  await syncFleet(db, failing("no_grant"));
  const out = await run(OP.floorList)({}, ownerCtx(db));
  assert.equal(out.total, 4);
  assert.equal(out.governanceReadable, false);
  assert.ok(out.entries.some((e: { id: string; code: string }) => e.id === AGENT_A && e.code === "leaving"));
  await assert.rejects(run(OP.floorList)({}, opCtx(db, { type: "agent", id: AGENT_A, name: "A" })), /only the owner/);
});

// ── the mode's system line ──────────────────────────────────────────────────────────────
test("mode: Governance's access_list and floor_status are system lines; access_revoke never is (quiet and fire)", () => {
  const facts = (product: string | null, target: string, op: string, type = "app") => ({ caller: { type, id: "x", mode: null }, callerProduct: product, target: { product: target, op, effect: "read" } }) as never;
  for (const t of ["connect", "knowledge", "kanban", "evolution"]) {
    assert.equal(exemptionOf(facts("fleet", t, "access_list")), "governance-reads-access", t);
    assert.equal(exemptionOf(facts("fleet", t, "access_revoke")), null, `${t} revoke`);
    assert.equal(exemptionOf(facts("inbox", t, "access_list")), null, "another app");
    assert.equal(exemptionOf(facts(null, t, "access_list")), null, "no verified product");
    assert.equal(exemptionOf(facts("fleet", t, "access_list", "agent")), null, "an agent");
  }
  assert.equal(exemptionOf(facts("fleet", "rules", "floor_status")), "governance-reads-access");
  assert.equal(exemptionOf(facts("inbox", "rules", "floor_status")), null);
  assert.equal(exemptionOf(facts("fleet", "observer", "access_list")), null, "a target not named");
  assert.equal(exemptionOf(facts("fleet", "rules", "access_list")), null);
  assert.ok(EXEMPTIONS.some((e) => e.id === "governance-reads-access"));
});

test("Closed mode: Governance's read runs; its revoke is refused; with a stopped agent nothing about the mode changes the floor", async () => {
  const { db } = await stopped();
  setMode(db, { mode: "closed", confirm: true, actor: OWNER });
  assert.equal((await gate(db, { app: { product: "fleet" }, product: "connect", op: "access_list", effect: "read" })).allow, true);
  assert.equal((await gate(db, { app: { product: "fleet" }, product: "rules", op: "floor_status", effect: "read" })).allow, true);
  const revoke = await gate(db, { app: { product: "fleet" }, product: "connect", op: "access_revoke", effect: "write" });
  assert.equal(revoke.allow, false);
  assert.match(revoke.reason ?? "", /Closed mode/);
});
