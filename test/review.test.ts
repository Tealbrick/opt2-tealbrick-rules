// Independent review of PR #12 (C236 spirit, all fail closed): skipped allow narrowing + pinned verdict, missing trust =
// unreviewed, two membership sets, live facts, write-time index and chunked write, duplicate ids, the dirty flag and the
// trust order. Each test has a quiet-on-good and a fire-on-bad side.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Json } from "@opt2-tealbrick/miniapp-sdk";
import { OP } from "#kit";
import { handlers } from "../src/app.ts";
import { type CallFacts, evaluate, type Narrowing, order, type Rule, type Trust } from "../src/engine.ts";
import { FEED_INVALID, parseFeed, strictest, syncFleet } from "../src/fleet.ts";
import { clearFloor } from "../src/floor.ts";
import { makeHooks, PIN_MAX, PIN_TTL_MS, pinnedNarrowing, pinVerdict } from "../src/hooks.ts";
import { FLEET_WRITE_CHUNK_ROWS, fleetFacts, fleetState, listDecisions, markFleetStale, saveRule, writeFleetChunked } from "../src/store.ts";
import { AGENT_A, AGENT_B, AGENT_R, cpuNowMs, feed, hookCtx, hookReq, migratedDb, NPUB, OWNER, opCtx, spec, trustFacts, WALL_CEILING_MS } from "./helpers.ts";

type Db = ReturnType<typeof migratedDb>["db"];
const hooks = makeHooks("rules");
const call = (id: string, ...args: unknown[]) => (hooks[id] as unknown as (...a: unknown[]) => Promise<Record<string, any>>)(...args);
const claimCtx = (kind: string, id: string, verified = true, extra: Record<string, Json> = {}) => ({ "tb.onBehalfOf": { claim: { kind, id }, verified }, ...extra }) as Record<string, Json>;
const gate = (db: Db, o: Record<string, unknown> = {}) => call("rules_gate", hookReq("before", { effect: "outward", ...o }), hookCtx(db));
const sync = (db: Db, doc: Record<string, Json> = feed()) => syncFleet(db, async () => ({ status: "ok" as const, output: doc }));
const allowed = (r: Record<string, any>) => r.allow === true;
const rule = (id: string, s: Rule["spec"]): Rule => ({ id, rev: 1, spec: s, updatedAt: 1 });
const facts = (o: Partial<CallFacts> & { claimTrust?: Trust | null } = {}): CallFacts => ({
  caller: { type: "agent", id: AGENT_A, mode: "free" },
  target: { product: "knowledge", op: "memory_recall", effect: "read" },
  claim: null,
  claimVerified: false,
  claimTeams: [],
  claimTeamsAny: [],
  callerTeams: [],
  callerTeamsAny: [],
  fleetAvailable: true,
  ...o,
  ...trustFacts(o),
  callerProduct: o.callerProduct ?? null,
});
const shape = (v: ReturnType<typeof evaluate>) => ({ decision: v.decision, rule: v.rule?.id ?? null, narrowing: v.narrowing, closedOnFleet: v.closedOnFleet });
const WORK: Narrowing = { memoryTags: { anyOf: ["work"] } };

// ── 1. a skipped allow rule's narrowing still applies; the after phase uses the pinned verdict ──────────────────
test("skipped allow rule with a narrowing: unavailable facts → its narrowing applies, merged strictly; available → exactly as before", () => {
  const narrowed = rule("rul_n", spec({ priority: 1, match: { callerTeams: ["tm_x"] }, decision: "allow", reason: "work only", narrowing: { memoryTags: { anyOf: ["work"] } } }));
  const later = rule("rul_l", spec({ priority: 2, match: {}, decision: "allow", reason: "no secrets", narrowing: { memoryTags: { noneOf: ["secret"] } } }));
  const plain = rule("rul_p", spec({ priority: 1, match: { callerTeams: ["tm_x"] }, decision: "allow", reason: "plain" }));
  // fire: facts unavailable
  assert.deepEqual(shape(evaluate(order([narrowed]), facts({ fleetAvailable: false }))), { decision: "allow", rule: null, narrowing: WORK, closedOnFleet: true });
  assert.deepEqual(shape(evaluate(order([narrowed, later]), facts({ fleetAvailable: false }))), {
    decision: "allow",
    rule: "rul_l",
    narrowing: { memoryTags: { anyOf: ["work"], noneOf: ["secret"] } },
    closedOnFleet: true,
  });
  const disjoint = rule("rul_d", spec({ priority: 2, match: {}, decision: "allow", reason: "x", narrowing: { memoryTags: { anyOf: ["family"] } } }));
  assert.deepEqual(evaluate(order([narrowed, disjoint]), facts({ fleetAvailable: false })).narrowing, { memoryTags: { anyOf: [] } }, "disjoint lists: nothing passes (C115)");
  // a skipped allow rule WITHOUT a narrowing adds nothing
  assert.deepEqual(shape(evaluate(order([plain]), facts({ fleetAvailable: false }))), { decision: "allow", rule: null, narrowing: null, closedOnFleet: false });
  // a rule that fails another criterion is not "skipped for fleet": its narrowing does not apply
  const other = rule("rul_o", spec({ priority: 1, match: { effects: ["money"], callerTeams: ["tm_x"] }, decision: "allow", reason: "x", narrowing: { memoryTags: { anyOf: ["work"] } } }));
  assert.deepEqual(shape(evaluate(order([other]), facts({ fleetAvailable: false }))), { decision: "allow", rule: null, narrowing: null, closedOnFleet: false });
  // quiet: available — in the team → the rule decides with its narrowing; not in the team → no narrowing
  assert.deepEqual(shape(evaluate(order([narrowed]), facts({ callerTeams: ["tm_x"] }))), { decision: "allow", rule: "rul_n", narrowing: WORK, closedOnFleet: false });
  assert.deepEqual(shape(evaluate(order([narrowed]), facts())), { decision: "allow", rule: null, narrowing: null, closedOnFleet: false });
  // a skipped narrowing is never added to a deny or a hold
  const deny = rule("rul_x", spec({ priority: 2, match: { effects: ["read"] }, decision: "deny", reason: "no" }));
  assert.deepEqual(shape(evaluate(order([narrowed, deny]), facts({ fleetAvailable: false }))), { decision: "deny", rule: "rul_x", narrowing: null, closedOnFleet: false });
});

test("the after hook redacts by the verdict pinned in the before phase; a missing pin applies the strictest narrowing that could apply", async () => {
  const { db } = migratedDb();
  saveRule(db, { spec: spec({ title: "work only for team X", priority: 1, match: { callerTeams: ["tm_x"], effects: ["read"] }, decision: "allow", reason: "work only", narrowing: { memoryTags: { anyOf: ["work"] } } }), actor: OWNER });
  const read = { effect: "read", product: "knowledge", op: "memory_recall", caller: AGENT_B };
  const output = { memories: [{ id: "m1", tags: ["work"] }, { id: "m2", tags: ["private"] }] } as Json;
  const filter = (callId: string, o: Record<string, unknown> = {}) => call("rules_filter", hookReq("after", { ...read, callId, output, ...o }), hookCtx(db));
  // fire: before phase with unavailable facts → allow, narrowing pinned and emitted to the target app
  assert.deepEqual(await gate(db, { ...read, callId: "cal_1" }), { allow: true });
  const ctx = await call("rules_context", hookReq("context", { ...read, callId: "cal_1" }), hookCtx(db));
  assert.deepEqual(ctx.add["rules.narrowing"].memoryTags, { anyOf: ["work"] });
  assert.match(ctx.add["rules.narrowing"].ruleId, /^rul_/, "names the skipped rule");
  // Governance comes back between the phases: B is NOT in team X, so a fresh evaluation has no narrowing …
  await sync(db);
  assert.equal(fleetFacts(db).available, true);
  assert.deepEqual(await call("rules_gate", hookReq("before", { ...read, callId: "cal_fresh" }), hookCtx(db)), { allow: true });
  assert.deepEqual(await filter("cal_fresh"), {}, "quiet: gated with the facts → no narrowing, nothing redacted");
  // … but the call was decided under the narrowing: the pin wins
  assert.deepEqual(await filter("cal_1"), { redactions: ["/memories/1"] }, "pinned verdict redacts, a fresh evaluation would not");
  assert.equal(listDecisions(db, { callId: "cal_1", limit: 5 }).items.find((d) => d.phase === "after")?.detail?.pinMissing, undefined);
  // missing pin: the strictest narrowing that could apply, even though a fresh evaluation says none
  assert.deepEqual(await filter("cal_never_gated"), { redactions: ["/memories/1"] });
  assert.equal(listDecisions(db, { callId: "cal_never_gated", limit: 5 }).items[0]?.detail?.pinMissing, true);
  // quiet: no allow rule with a narrowing → a missing pin redacts nothing
  const { db: db2 } = migratedDb();
  saveRule(db2, { spec: spec({ match: { effects: ["money"] }, decision: "deny" }), actor: OWNER });
  assert.deepEqual(await call("rules_filter", hookReq("after", { ...read, callId: "cal_x", output }), hookCtx(db2)), {});
  // a claim-dependent narrowing cannot apply to a call without a claim
  const { db: db3 } = migratedDb();
  saveRule(db3, { spec: spec({ match: { onBehalfOf: { teams: ["tm_x"] } }, decision: "allow", reason: "x", narrowing: { memoryTags: { anyOf: ["work"] } } }), actor: OWNER });
  assert.deepEqual(await call("rules_filter", hookReq("after", { ...read, callId: "cal_y", output }), hookCtx(db3)), {}, "no claim: that rule cannot apply");
  assert.deepEqual(await call("rules_filter", hookReq("after", { ...read, callId: "cal_z", output, context: claimCtx("person", "ct_anna") }), hookCtx(db3)), { redactions: ["/memories/1"] }, "with a claim it could apply");
});

test("pins are bounded: expire after the TTL (≥ the after hook's timeout plus 60 s), at most PIN_MAX per database", () => {
  assert.ok(PIN_TTL_MS >= 2_000 + 60_000);
  const { db } = migratedDb();
  const t0 = 1_000_000;
  pinVerdict(db, "c1", WORK, t0);
  pinVerdict(db, "c0", null, t0);
  assert.deepEqual(pinnedNarrowing(db, "c1", t0 + PIN_TTL_MS - 1), WORK);
  assert.equal(pinnedNarrowing(db, "c0", t0 + 1), null, "a pinned 'no narrowing' is a pin, not a missing one");
  assert.equal(pinnedNarrowing(db, "c1", t0 + PIN_TTL_MS + 1), undefined, "expired");
  assert.equal(pinnedNarrowing(db, "nope", t0), undefined);
  const { db: db2 } = migratedDb();
  for (let i = 0; i < PIN_MAX + 10; i++) pinVerdict(db2, `c${i}`, null, t0);
  assert.equal(pinnedNarrowing(db2, "c0", t0), undefined, "oldest evicted");
  assert.equal(pinnedNarrowing(db2, `c${PIN_MAX + 9}`, t0), null);
  pinVerdict(db2, "late", WORK, t0 + PIN_TTL_MS + 5);
  assert.equal(pinnedNarrowing(db2, `c${PIN_MAX + 9}`, t0 + PIN_TTL_MS + 5), undefined, "expired pins are dropped on the next pin");
});

// ── 2. missing trust is `unreviewed` ───────────────────────────────────────────────────────────────────────────
test("missing trust = unreviewed: unknown handle, unknown contact id, departed+trusted, left-out agent; an agent claim reads the agent's trust", async () => {
  const { db } = migratedDb();
  saveRule(db, { spec: spec({ title: "unreviewed requesters", match: { effects: ["outward"], onBehalfOf: { trust: ["unreviewed"] } }, decision: "hold", reason: "unknown requester" }), actor: OWNER });
  saveRule(db, { spec: spec({ title: "blocked requesters", priority: 1, match: { onBehalfOf: { trust: ["blocked"] } }, decision: "deny", reason: "blocked" }), actor: OWNER });
  await sync(db);
  clearFloor(db, { holder: null, actor: OWNER }); // the rules' own semantics, with the floor (C380) out of the way
  const via = async (kind: string, id: string) => {
    const r = await gate(db, { context: claimCtx(kind, id, false) });
    return r.allow === true ? "allow" : r.hold ? "hold" : "deny";
  };
  assert.equal(await via("channel_sender", "slack:u777"), "allow", "quiet: a trusted contact by handle");
  assert.equal(await via("person", "ct_anna"), "allow", "quiet: a trusted contact by id");
  assert.equal(await via("agent", AGENT_A), "allow", "quiet: a trusted agent (its trust is read from the feed)");
  assert.equal(await via("channel_sender", "slack:u999"), "hold", "unknown handle");
  assert.equal(await via("person", "ct_nobody"), "hold", "unknown contact id");
  assert.equal(await via("channel_sender", "not-a-handle"), "hold", "an id that is no handle");
  assert.equal(await via("person", "ct_gone"), "allow", "departed + trusted: deny/hold rules keep the RAW trust (trusted), so a hold for unreviewed does not apply");
  assert.equal(await via("agent", AGENT_B), "hold", "an unreviewed agent");
  assert.equal(await via("agent", "agt_01J000000000000000000000ZZ"), "hold", "an agent the producer left out");
  assert.equal(await via("agent", AGENT_R), "deny", "a removed agent keeps a restrictive trust (blocked)");
  assert.equal(await via("channel_sender", "slack:u666"), "deny", "blocked contact");
  const t = parseFeed(feed()).model.trust;
  assert.deepEqual(t.get("contact:ct_gone"), { trusts: ["trusted"], allActive: false });
  assert.deepEqual(t.get(`agent:${AGENT_A}`), { trusts: ["trusted"], allActive: true });
  assert.deepEqual(t.get(`agent:${AGENT_R}`), { trusts: ["blocked"], allActive: false });
  assert.deepEqual(t.get("contact:ct_block"), { trusts: ["blocked"], allActive: false });
  // the dry run says what the gate saw
  const owner = opCtx(db, { type: "person", id: OWNER }, (async () => ({ status: "ok", output: feed() })) as never);
  const p = await (handlers[OP.rulesPreview] as unknown as { run: (i: unknown, c: unknown) => Promise<any> }).run({ call: { caller: { type: "agent", id: AGENT_A }, target: { product: "connect", op: "buzz_dm", effect: "outward" }, onBehalfOf: { kind: "channel_sender", id: "slack:u999" } } }, owner);
  assert.equal(p.trust, "unreviewed");
  assert.equal(p.decision, "hold");
});

// ── 3. two membership sets ─────────────────────────────────────────────────────────────────────────────────────
const SETS = (): Record<string, Json> =>
  feed({
    teams: [
      {
        id: "tm_x",
        members: [
          { kind: "agent", id: AGENT_A },
          { kind: "agent", id: AGENT_R },
          { kind: "contact", id: "ct_anna" },
          { kind: "contact", id: "ct_old" },
          { kind: "contact", id: "ct_block" },
          { kind: "contact", id: "ct_active_same" },
        ],
      },
    ],
    contacts: [
      { id: "ct_anna", kind: "person", status: "active", trust: "trusted", handles: ["slack:U777"] },
      { id: "ct_old", kind: "person", status: "departed", trust: "trusted", handles: ["slack:U555", "slack:U777"] },
      { id: "ct_block", kind: "person", status: "active", trust: "blocked", handles: ["slack:U666"] },
      { id: "ct_active_same", kind: "person", status: "active", trust: "trusted", handles: ["slack:U555", "slack:U556"] },
    ],
    agents: [
      { id: AGENT_A, status: "active", trust: "trusted", owner: null },
      { id: AGENT_R, status: "removed", trust: "trusted", owner: null },
    ],
  });

test("two key sets: deny/hold see every member (blocked, departed, removed); allow sees only members that count; keys drop PER CONTACT", async () => {
  const m = parseFeed(SETS()).model.teams[0];
  assert.ok(m);
  assert.ok(m.keys.includes("contact:ct_old") && m.keys.includes("contact:ct_block") && m.keys.includes(`agent:${AGENT_R}`) && m.keys.includes("handle:slack:U666"));
  assert.ok(!m.activeKeys.includes("contact:ct_old") && !m.activeKeys.includes("contact:ct_block") && !m.activeKeys.includes(`agent:${AGENT_R}`) && !m.activeKeys.includes("handle:slack:U666"));
  // a handle held by an active AND a departed contact is ambiguous: deny/hold see it, allow never does (EVERY holder must be active)
  assert.ok(m.keys.includes("handle:slack:U777") && !m.activeKeys.includes("handle:slack:U777"));
  assert.ok(m.keys.includes("handle:slack:U555") && !m.activeKeys.includes("handle:slack:U555"));
  assert.ok(m.activeKeys.includes("handle:slack:U556") && m.activeKeys.includes("contact:ct_active_same") && m.activeKeys.includes("contact:ct_anna"));
  assert.ok(m.activeKeys.includes(`agent:${AGENT_A}`));
  const { db: dDeny } = migratedDb();
  const { db: dAllow } = migratedDb();
  for (const decision of ["deny", "hold"] as const) {
    saveRule(dDeny, { spec: spec({ priority: decision === "deny" ? 1 : 2, match: { effects: ["outward"], onBehalfOf: { teams: ["tm_x"] } }, decision, reason: `${decision} X` }), actor: OWNER });
  }
  saveRule(dDeny, { spec: spec({ title: "team X caller denied", priority: 0, match: { effects: ["outward"], callerTeams: ["tm_x"] }, decision: "deny", reason: "caller in X" }), actor: OWNER });
  await sync(dDeny, SETS());
  const dn = (db: Db, ctx: Record<string, Json>, caller = AGENT_B) => gate(db, { context: ctx, caller });
  // members that gone still hit the DENY rule
  for (const [kind, id] of [["person", "ct_old"], ["person", "ct_block"], ["channel_sender", "slack:u666"], ["person", "ct_anna"]] as const) assert.equal(allowed(await dn(dDeny, claimCtx(kind, id))), false, `deny applies to ${id}`);
  assert.equal(allowed(await dn(dDeny, {}, AGENT_R)), false, "a removed agent as caller still hits the deny rule");
  assert.equal(allowed(await dn(dDeny, claimCtx("person", "ct_stranger"))), true, "quiet: not in the team");
  assert.equal(allowed(await dn(dDeny, {}, AGENT_B)), true, "quiet: caller B is in no team");
  // allow rules never count them
  saveRule(dAllow, { spec: spec({ priority: 1, match: { effects: ["outward"], onBehalfOf: { teams: ["tm_x"] } }, decision: "allow", reason: "X may" }), actor: OWNER });
  saveRule(dAllow, { spec: spec({ priority: 1, match: { effects: ["outward"], callerTeams: ["tm_x"] }, decision: "allow", reason: "X callers may" }), actor: OWNER });
  saveRule(dAllow, { spec: spec({ priority: 9, match: { effects: ["outward"] }, decision: "deny", reason: "default no" }), actor: OWNER });
  await sync(dAllow, SETS());
  for (const [kind, id] of [["person", "ct_old"], ["person", "ct_block"], ["channel_sender", "slack:u666"], ["channel_sender", "slack:u777"], ["channel_sender", "slack:u555"]] as const) assert.equal(allowed(await dn(dAllow, claimCtx(kind, id))), false, `allow does not widen for ${id}`);
  assert.equal(allowed(await dn(dAllow, {}, AGENT_R)), false, "a removed agent as caller gets no allow");
  for (const [kind, id] of [["person", "ct_anna"], ["channel_sender", "slack:u556"], ["person", "ct_active_same"]] as const) assert.equal(allowed(await dn(dAllow, claimCtx(kind, id))), true, `quiet: ${id} counts`);
  assert.equal(allowed(await dn(dAllow, {}, AGENT_A)), true, "quiet: an active agent");
  // paused agents count
  assert.deepEqual(fleetFacts(dAllow).teams.get(`agent:${AGENT_A}`), ["tm_x"]);
});

// ── 6. live team facts follow the same rule ────────────────────────────────────────────────────────────────────
test("live fleet.requesterTeams: adds deny/hold keys always, allow keys never for a requester the model knows is gone", async () => {
  const live = (id: string): Record<string, Json> => ({ "fleet.requesterTeams": [{ id, name: id, role: "member" }] });
  const mk = async (decision: "allow" | "deny") => {
    const { db } = migratedDb();
    saveRule(db, { spec: spec({ priority: 1, match: { effects: ["outward"], onBehalfOf: { teams: ["tm_live"] } }, decision, reason: decision }), actor: OWNER });
    saveRule(db, { spec: spec({ priority: 9, match: { effects: ["outward"] }, decision: "deny", reason: "default no" }), actor: OWNER });
    await sync(db, SETS());
    return db;
  };
  const allowDb = await mk("allow");
  const denyDb = await mk("deny");
  const as = (kind: string, id: string) => claimCtx(kind, id, true, live("tm_live"));
  assert.equal(allowed(await gate(allowDb, { context: as("person", "ct_anna") })), true, "quiet: an active requester gets its live team for allow rules");
  assert.equal(allowed(await gate(allowDb, { context: as("person", "ct_unknown_yet") })), true, "quiet: a requester the model does not know yet (live fact only)");
  assert.equal(allowed(await gate(allowDb, { context: as("person", "ct_old") })), false, "departed: the live team never opens an allow rule");
  assert.equal(allowed(await gate(allowDb, { context: as("channel_sender", "slack:u666") })), false, "blocked: same");
  assert.equal(allowed(await gate(denyDb, { context: as("person", "ct_old") })), false, "deny rules still see the live team of a gone member");
  assert.equal(allowed(await gate(denyDb, { context: as("person", "ct_block") })), false);
});

// ── 5. the index is built when the sync writes; big directories are written in short transactions ───────────────
test("write-time index: the first fleetFacts after a sync reads nothing from the database", async () => {
  const { db } = migratedDb();
  await sync(db, SETS());
  let prepares = 0;
  const origPrepare = db.prepare.bind(db);
  (db as any).prepare = (sql: string) => {
    prepares++;
    return origPrepare(sql);
  };
  const f = fleetFacts(db);
  assert.equal(f.available, true);
  assert.deepEqual(f.teamsAny.get("contact:ct_old"), ["tm_x"]);
  assert.equal(prepares, 0, "no query: the index came from the write");
  (db as any).prepare = origPrepare;
});

test("200 teams x 350 members: every write transaction stays well under 50 ms and the write yields between them", async () => {
  const { db } = migratedDb();
  const times: number[] = [];
  const cpu: number[] = [];
  const orig = db.transaction.bind(db);
  (db as any).transaction = (fn: () => unknown) => {
    const t = performance.now();
    const c = cpuNowMs();
    try {
      return orig(fn);
    } finally {
      cpu.push(cpuNowMs() - c);
      times.push(performance.now() - t);
    }
  };
  const teams = [];
  const trust = new Map<string, { trusts: Trust[]; allActive: boolean }>();
  for (let t = 0; t < 200; t++) {
    const keys: string[] = [];
    for (let m = 0; m < 350; m++) {
      const n = t * 350 + m;
      keys.push(`contact:ct_${n}`, `handle:slack:U${n}`);
      trust.set(`contact:ct_${n}`, { trusts: ["trusted"], allActive: true });
    }
    teams.push({ id: `tm_${t}`, name: `T${t}`, people: 350, agents: 0, keys, activeKeys: keys });
  }
  let pauses = 0;
  await writeFleetChunked(db, { teams, trust }, { revision: 1, error: null }, Date.now(), async () => {
    pauses++;
    await new Promise((r) => setImmediate(r));
  });
  assert.ok(times.length > 20 && pauses >= times.length - 2, `many short transactions with a yield between each (${times.length} tx, ${pauses} yields)`);
  // ceilings (T-1): CPU longest measured 12 to 14 ms at load 9 to 12 (2026-10-18), ceiling = the 50 ms target; wall clock only loose (see cpuNowMs)
  assert.ok(Math.max(...cpu) < 50, `longest transaction CPU ${Math.max(...cpu).toFixed(1)} ms`);
  assert.ok(Math.max(...times) < WALL_CEILING_MS, `longest transaction wall clock ${Math.max(...times).toFixed(1)} ms`);
  assert.ok(FLEET_WRITE_CHUNK_ROWS <= 5000);
  assert.equal(fleetState(db).usable, true);
  assert.equal(fleetFacts(db).teamsAny.get("handle:slack:U69999")?.[0], "tm_199");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM fleet_members").get()?.n), 200 * 700);
});

test("a write that dies half way leaves the copy unusable (fail closed), never a half copy that decides", async () => {
  const { db } = migratedDb();
  await sync(db, SETS());
  assert.equal(fleetState(db).usable, true);
  const g = writeFleetChunked(db, parseFeed(feed({ revision: 9 })).model, { revision: 9, error: null }, Date.now(), async () => {
    throw new Error("crash");
  });
  await assert.rejects(g, /crash/);
  assert.equal(fleetState(db).usable, false, "marked unusable at the first step");
  assert.equal(fleetState(db).stale, true);
});

// ── 7. duplicates are a contract violation ─────────────────────────────────────────────────────────────────────
test("duplicate team, contact or agent ids → feed_invalid (refusal); distinct ids read fine", async () => {
  const dupTeam = feed({ teams: [{ id: "t", members: [] }, { id: "t", members: [] }] });
  const dupContact = feed({ contacts: [{ id: "c", kind: "person", status: "active", trust: "trusted", handles: [] }, { id: "c", kind: "person", status: "active", trust: "blocked", handles: [] }] });
  const dupAgent = feed({ agents: [{ id: AGENT_A, status: "active", trust: "trusted", owner: null }, { id: AGENT_A, status: "removed", trust: "blocked", owner: null }] });
  for (const [doc, what] of [[dupTeam, "team"], [dupContact, "contact"], [dupAgent, "agent"]] as const) {
    assert.throws(() => parseFeed(doc), { code: FEED_INVALID, message: new RegExp(`${what} id listed twice`) });
    const { db } = migratedDb();
    await sync(db);
    await sync(db, doc);
    assert.equal(fleetFacts(db).available, false, `${what}: refusal clears the copy`);
    assert.match(String(fleetState(db).error), /^Governance feed refused: .*listed twice/);
  }
  assert.doesNotThrow(() => parseFeed(feed()));
});

// ── 8. markFleetStale during a sync ────────────────────────────────────────────────────────────────────────────
test("markFleetStale while a sync is in flight → one more sync (a full read); without it exactly one", async () => {
  const run = async (mark: boolean) => {
    const { db } = migratedDb();
    await sync(db);
    const inputs: unknown[] = [];
    let release: () => void = () => {};
    const gateOpen = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    const callApp = async (_p: string, _o: string, input: unknown) => {
      inputs.push(input);
      if (first) {
        first = false;
        await gateOpen;
      }
      return { status: "ok" as const, output: inputs.length === 1 ? { v: 1, revision: 7, unchanged: true } : feed() };
    };
    markFleetStale(db);
    // a normal (non-stale) first read would send sinceRevision; start from a fresh, non-stale copy
    inputs.length = 0;
    await sync(db);
    inputs.length = 0;
    first = true;
    const p = syncFleet(db, callApp as never);
    await new Promise((r) => setTimeout(r, 5));
    if (mark) markFleetStale(db);
    release();
    await p;
    return { inputs, stale: fleetState(db).stale };
  };
  const plain = await run(false);
  assert.equal(plain.inputs.length, 1);
  assert.deepEqual(plain.inputs[0], { accept: ["agent_handles", "lifecycle", "roles"], sinceRevision: 7 });
  assert.equal(plain.stale, false);
  const marked = await run(true);
  assert.equal(marked.inputs.length, 2, "the mark made during the read triggers one more");
  assert.deepEqual(marked.inputs[1], { accept: ["agent_handles", "lifecycle", "roles"] }, "and it is a full read");
  assert.equal(marked.stale, false);
});

// ── 9. one monotone trust order ────────────────────────────────────────────────────────────────────────────────
test("trust order blocked > limited > unreviewed > trusted (strictest) is monotone and commutative", () => {
  const order4: Trust[] = ["trusted", "unreviewed", "limited", "blocked"];
  for (const [i, a] of order4.entries()) {
    for (const [j, b] of order4.entries()) {
      assert.equal(strictest(a, b), order4[Math.max(i, j)], `${a} vs ${b}`);
      assert.equal(strictest(a, b), strictest(b, a));
    }
  }
  void NPUB;
});
