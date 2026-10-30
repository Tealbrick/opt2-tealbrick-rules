// C380 T2-a: `match.callerRoles` = the flat roles of Governance (feed `roles`) of the CALLING agent, with the semantics of `callerTeams`:
// deny and hold see every holder, allow only holders that count; an app never matches; acting agents NARROW only; a call with no acting agent is the
// app's own work; unavailable Fleet facts, or a copy read without roles, fail closed. Every check has a quiet-on-good and a fire-on-bad case.
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Db, HookContext, HookRequest, Json } from "@opt2-tealbrick/miniapp-sdk";
import { handlers, manifest } from "../src/app.ts";
import { type ActingFact, type CallFacts, evaluate, explain, NEEDS_FLEET, order, type Rule, specProblem, strictestNarrowing } from "../src/engine.ts";
import { FEED_INVALID, parseFeed, ROLE_CAPS, syncFleet } from "../src/fleet.ts";
import { makeHooks } from "../src/hooks.ts";
import { fleetFacts, fleetRoles, listDecisions, saveRule, writeFleet } from "../src/store.ts";
import { AGENT_A, AGENT_B, AGENT_R, APP_INSTANCE, feed, hookCtx, hookReq, migratedDb, OWNER, opCtx, spec } from "./helpers.ts";

const rule = (id: string, s: Rule["spec"]): Rule => ({ id, rev: 1, spec: s, updatedAt: 1 });
const base: CallFacts = {
  caller: { type: "agent", id: AGENT_A, mode: "free" },
  target: { product: "connect", op: "buzz_dm", effect: "outward" },
  claim: null,
  claimVerified: false,
  claimTeams: [],
  claimTeamsAny: [],
  callerTeams: [],
  callerTeamsAny: [],
  claimTrusts: [],
  claimTrustActive: true,
  fleetAvailable: true,
  callerProduct: null,
};
const agent = (callerRoles: string[], callerRolesAny: string[] = callerRoles, o: Partial<CallFacts> = {}): CallFacts => ({ ...base, callerRoles, callerRolesAny, ...o });
const app = (acting: readonly ActingFact[] = [], o: Partial<CallFacts> = {}): CallFacts => ({ ...base, caller: { type: "app", id: APP_INSTANCE, mode: null }, callerProduct: "evolution", acting, ...o });
const one = (decision: "allow" | "deny" | "hold", callerRoles: string[], extra: Partial<Rule["spec"]> = {}) => order([rule("rul_r", spec({ priority: 10, match: { callerRoles }, decision, reason: `${decision} by role`, ...extra }))]);
const out = (v: ReturnType<typeof evaluate>) => [v.decision, v.rule?.id ?? null, v.closedOnFleet] as const;
const CONTRACTOR = "rol_01J0000000000000000000CON1";
const STAFF = "rol_01J0000000000000000000STF1";

test("deny and hold: the rule matches when the calling agent has a listed role; another role, or none, passes", () => {
  for (const decision of ["deny", "hold"] as const) {
    const r = one(decision, [CONTRACTOR]);
    assert.deepEqual(out(evaluate(r, agent([CONTRACTOR]))), [decision, "rul_r", false], `${decision}: has the role`);
    assert.deepEqual(out(evaluate(r, agent([STAFF]))), ["allow", null, false], `${decision}: another role passes`);
    assert.deepEqual(out(evaluate(r, agent([]))), ["allow", null, false], `${decision}: no role passes`);
    assert.equal(explain(r, agent([STAFF]))[0]?.why, "caller does not have the roles");
  }
});

test("deny and hold see every holder (a blocked or removed agent); allow sees only the holders that count", () => {
  for (const decision of ["deny", "hold"] as const) {
    assert.equal(evaluate(one(decision, [CONTRACTOR]), agent([], [CONTRACTOR])).decision, decision, `${decision}: a holder that does not count still matches`);
  }
  const allow = one("allow", [CONTRACTOR], { narrowing: { memoryTags: { anyOf: ["work"] } } });
  assert.deepEqual(evaluate(allow, agent([CONTRACTOR])).narrowing, { memoryTags: { anyOf: ["work"] } }, "quiet: an active holder gets the allow");
  assert.equal(evaluate(allow, agent([], [CONTRACTOR])).rule, null, "fire: a holder that does not count never gets an allow by role");
});

test("an APP caller never matches a callerRoles rule (deny, hold, allow), also while Governance is unavailable; strictestNarrowing leaves it out", () => {
  for (const decision of ["deny", "hold", "allow"] as const) {
    const r = one(decision, [CONTRACTOR]);
    for (const f of [app(), app([], { fleetAvailable: false }), app([], { rolesKnown: false })]) assert.deepEqual(out(evaluate(r, f)), ["allow", null, false], `${decision}: app`);
    assert.equal(explain(r, app())[0]?.why, "caller is not an agent");
  }
  assert.equal(strictestNarrowing(one("allow", [CONTRACTOR], { narrowing: { memoryTags: { anyOf: ["w"] } } }), app()), null);
  assert.deepEqual(strictestNarrowing(one("allow", [CONTRACTOR], { narrowing: { memoryTags: { anyOf: ["w"] } } }), agent([])), { memoryTags: { anyOf: ["w"] } }, "for an agent the rule could apply: its narrowing counts");
});

test("acting agents NARROW ONLY: a deny or hold by role reaches the agent behind an app call (any of them); an allow never does", () => {
  const holder: ActingFact = { id: AGENT_A, teamsAny: [], rolesAny: [CONTRACTOR], trusts: ["trusted"] };
  const other: ActingFact = { id: AGENT_B, teamsAny: [], rolesAny: [STAFF], trusts: ["trusted"] };
  for (const d of ["deny", "hold"] as const) {
    assert.equal(evaluate(one(d, [CONTRACTOR]), app([holder])).decision, d, `${d}: the acting agent has the role`);
    assert.equal(evaluate(one(d, [CONTRACTOR]), app([other, holder])).decision, d, `${d}: any acting agent is enough`);
    assert.equal(evaluate(one(d, [CONTRACTOR]), app([other])).decision, "allow", `${d}: another role passes`);
  }
  // NARROW ONLY: an allow by role never matches because of an acting agent; the later deny-all decides
  const both = order([rule("allow", spec({ priority: 10, match: { callerRoles: [CONTRACTOR] }, decision: "allow" })), rule("deny-all", spec({ priority: 20, match: { products: ["connect"] }, decision: "deny" }))]);
  assert.equal(evaluate(both, app([holder])).decision, "deny");
  assert.equal(evaluate(both, app([holder]), "closed").decision, "deny", "Closed stays closed");
});

test("a call with NO acting agent is the app's own work: a role rule does not match it, a product rule does; with both named both must match", () => {
  const holder: ActingFact = { id: AGENT_A, teamsAny: [], rolesAny: [CONTRACTOR], trusts: [] };
  assert.equal(evaluate(one("deny", [CONTRACTOR]), app([])).decision, "allow", "no acting agent: no match");
  assert.equal(evaluate(one("deny", [CONTRACTOR]), app(undefined)).decision, "allow", "no acting key at all: no match");
  assert.equal(evaluate([rule("p", spec({ priority: 10, match: { callerProducts: ["evolution"] }, decision: "deny" }))], app([])).decision, "deny");
  // callerProducts + callerRoles cannot be saved (the writer refuses it), but a stored legacy shape must still read as "both must match"
  assert.equal(evaluate([rule("b", spec({ priority: 10, match: { callerProducts: ["evolution"], callerRoles: [CONTRACTOR] }, decision: "hold" }))], app([holder])).decision, "hold");
  assert.equal(evaluate([rule("b", spec({ priority: 10, match: { callerProducts: ["observer"], callerRoles: [CONTRACTOR] }, decision: "hold" }))], app([holder])).decision, "allow");
});

test("an agent caller is unchanged by the acting list", () => {
  const holder: ActingFact = { id: AGENT_B, teamsAny: [], rolesAny: [CONTRACTOR], trusts: [] };
  const f = agent([STAFF], [STAFF], { acting: [holder] });
  assert.equal(evaluate(one("deny", [CONTRACTOR]), f).decision, "allow");
});

test("Governance unavailable, or the copy read WITHOUT roles: deny and hold apply and are flagged, allow is skipped with its narrowing kept", () => {
  const allow = one("allow", [CONTRACTOR], { narrowing: { memoryTags: { anyOf: ["work"] } } });
  for (const down of [agent([], [], { fleetAvailable: false }), agent([], [], { rolesKnown: false })]) {
    assert.deepEqual(out(evaluate(one("deny", [CONTRACTOR]), down)), ["deny", "rul_r", true]);
    assert.deepEqual(out(evaluate(one("hold", [CONTRACTOR]), down)), ["hold", "rul_r", true]);
    const v = evaluate(allow, down);
    assert.deepEqual([v.decision, v.rule, v.narrowing, v.closedOnFleet], ["allow", null, { memoryTags: { anyOf: ["work"] } }, true]);
    assert.equal(explain(allow, down)[0]?.why, NEEDS_FLEET);
  }
  // an app call that acts for an agent: the deny and hold apply too (narrow only); an allow by role never reads the acting agent, so it is not skipped for it either
  const acting = app([{ id: AGENT_A, teamsAny: [], rolesAny: [], trusts: [] }], { rolesKnown: false });
  assert.deepEqual(out(evaluate(one("deny", [CONTRACTOR]), acting)), ["deny", "rul_r", true]);
  assert.deepEqual(out(evaluate(allow, acting)), ["allow", null, false]);
  // quiet: roles known (or the fact absent, as in an older test) and available: the rule reads the roles
  assert.equal(evaluate(one("deny", [CONTRACTOR]), agent([STAFF], [STAFF], { rolesKnown: true })).decision, "allow");
});

test("writers: callerRoles refuses a repeat, an odd name, an app-only caller list and an app product; good shapes pass", () => {
  const p = (match: Rule["spec"]["match"]) => specProblem(spec({ match }));
  assert.equal(p({ callerRoles: [CONTRACTOR, STAFF] }), "", "quiet on good");
  assert.equal(p({ callerRoles: [CONTRACTOR], agents: [AGENT_A] }), "");
  assert.equal(p({ callerRoles: [CONTRACTOR, CONTRACTOR] }), `callerRoles lists “${CONTRACTOR}” twice`);
  assert.match(p({ callerRoles: [` ${CONTRACTOR}`] }), /no space at either end/);
  assert.match(p({ callerRoles: [CONTRACTOR], callerProducts: ["evolution"] }), /callerRoles are roles of agents/);
  assert.match(p({ callerRoles: [CONTRACTOR], agents: [APP_INSTANCE] }), /agents lists only apps/);
});

// ── the feed ────────────────────────────────────────────────────────────────
const ANNA = "ct_anna";
const withRoles = (roles: unknown, over: Record<string, unknown> = {}) => feed({ roles, ...over });
const ROLES = [{ id: CONTRACTOR, name: "Contractor", members: [{ kind: "agent", id: AGENT_A }, { kind: "contact", id: ANNA }, { kind: "agent", id: AGENT_R }, { kind: "contact", id: "ct_unlisted" }] }, { id: STAFF, members: [] }];

test("parseFeed reads roles like teams: every holder for deny and hold, active holders for allow, by agent, contact and handle key; a member the feed does not list counts for deny and hold only", () => {
  const d = parseFeed(withRoles(ROLES));
  assert.equal(d.rolesKnown, true);
  const roles = d.model.roles ?? [];
  assert.deepEqual(roles.map((r) => [r.id, r.name, r.people, r.agents]), [[CONTRACTOR, "Contractor", 2, 2], [STAFF, STAFF, 0, 0]], "a role with no name shows its id");
  const con = roles.find((r) => r.id === CONTRACTOR);
  assert.ok(con?.keys.includes(`agent:${AGENT_A}`) && con.activeKeys.includes(`agent:${AGENT_A}`), "an active agent holder counts for allow");
  assert.ok(con?.keys.includes(`agent:${AGENT_R}`) && !con.activeKeys.includes(`agent:${AGENT_R}`), "a removed (blocked) agent: deny and hold only");
  assert.ok(con?.keys.includes(`contact:${ANNA}`) && con.activeKeys.includes(`contact:${ANNA}`));
  assert.ok(con?.keys.includes("handle:slack:U777") && con.activeKeys.includes("handle:slack:U777"), "a contact's handle holds the role with it");
  assert.ok(con?.keys.includes("contact:ct_unlisted") && !con.activeKeys.includes("contact:ct_unlisted"), "an unlisted member: deny and hold only");
  // the teams are untouched, and a team key never lands in a role
  assert.deepEqual(d.model.teams.map((t) => t.id), ["tm_x", "tm_y"]);
  assert.ok(roles.every((r) => !r.keys.includes(`agent:${AGENT_B}`)));
  // quiet on the old shape: no roles key = nobody is known to hold a role
  const none = parseFeed(feed());
  assert.equal(none.rolesKnown, false);
  assert.deepEqual(none.model.roles, []);
  assert.equal(parseFeed(withRoles([])).rolesKnown, true, "an empty list is a Governance that knows roles and has none");
});

test("parseFeed refuses a roles list that is not valid: the whole answer, never a partial read", () => {
  const bad: [string, unknown][] = [
    ["not a list", { id: "x" }],
    ["no id", [{ members: [] }]],
    ["id too long", [{ id: "r".repeat(65), members: [] }]],
    ["name too long", [{ id: "r1", name: "n".repeat(81), members: [] }]],
    ["id twice", [{ id: "r1", members: [] }, { id: "r1", members: [] }]],
    ["members not a list", [{ id: "r1", members: "x" }]],
    ["member kind", [{ id: "r1", members: [{ kind: "team", id: "x" }] }]],
    ["member id", [{ id: "r1", members: [{ kind: "agent", id: "" }] }]],
    ["member twice", [{ id: "r1", members: [{ kind: "agent", id: AGENT_A }, { kind: "agent", id: AGENT_A }] }]],
    ["too many roles", Array.from({ length: ROLE_CAPS.roles + 1 }, (_, i) => ({ id: `r${i}`, members: [] }))],
    ["too many members", [{ id: "r1", members: Array.from({ length: ROLE_CAPS.membersPerRole + 1 }, (_, i) => ({ kind: "contact", id: `c${i}` })) }]],
  ];
  for (const [why, roles] of bad) assert.throws(() => parseFeed(withRoles(roles)), { code: FEED_INVALID }, why);
  assert.doesNotThrow(() => parseFeed(withRoles(Array.from({ length: ROLE_CAPS.roles }, (_, i) => ({ id: `r${i}`, members: [] })))), "quiet at the cap");
});

// ── the gate, the sync, the restart ─────────────────────────────────────────
const hooks = makeHooks("rules", { holdSupported: true }) as unknown as Record<string, (r: HookRequest, c: HookContext) => Promise<Record<string, any>>>;
const gate = (db: Db, o: Parameters<typeof hookReq>[1] = {}) => (hooks.rules_gate as NonNullable<(typeof hooks)["rules_gate"]>)(hookReq("before", o), hookCtx(db));
const dbOver = (raw: DatabaseSync): Db =>
  ({
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    transaction<T>(fn: () => T): T {
      raw.exec("BEGIN");
      try {
        const o = fn();
        raw.exec("COMMIT");
        return o;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  }) as unknown as Db;
const world = () => {
  const { db, raw } = migratedDb();
  saveRule(db, { spec: spec({ title: "contractors wait", priority: 10, match: { effects: ["outward"], callerRoles: [CONTRACTOR] }, decision: "hold", reason: "contractors need the owner" }), actor: OWNER });
  return { db, raw };
};
const read = (db: Db, doc: Record<string, Json>) => writeFleet(db, parseFeed(doc).model, { revision: Number(doc.revision), error: null, agentHandles: true, rolesKnown: parseFeed(doc).rolesKnown });

test("gate: the role reaches the decision. The holder is held, another agent passes; when the role ends in Governance the next read lets it pass", async () => {
  const { db } = world();
  read(db, withRoles(ROLES));
  assert.equal((await gate(db, { caller: AGENT_A, callId: "cal_1" })).hold?.family, "policy", "fire: the holder is held");
  assert.deepEqual(await gate(db, { caller: AGENT_B, callId: "cal_2" }), { allow: true }, "quiet: an agent without the role passes");
  // the end date passed in Governance: the role leaves the feed with a new revision
  read(db, withRoles([{ id: CONTRACTOR, name: "Contractor", members: [] }], { revision: 8 }));
  assert.deepEqual(await gate(db, { caller: AGENT_A, callId: "cal_3" }), { allow: true }, "the holder passes after expiry");
  assert.deepEqual(fleetRoles(db).map((r) => r.id), [CONTRACTOR], "fleet_status lists the roles of the last read");
});

test("gate: a Governance that sends no roles (older, after a rollback) makes a hold by role APPLY to every agent (fail closed), and a role ending is not a way around a deny", async () => {
  const { db } = world();
  read(db, feed({ revision: 9 }));
  assert.equal(fleetFacts(db).rolesKnown, false);
  assert.equal((await gate(db, { caller: AGENT_B, callId: "cal_a" })).hold?.family, "policy", "no roles known: the hold rule applies");
  assert.deepEqual(listDecisions(db, { callId: "cal_a", limit: 1 }).items[0]?.detail, { fleetUnavailable: true });
  read(db, withRoles(ROLES, { revision: 10 }));
  assert.equal(fleetFacts(db).rolesKnown, true);
  assert.deepEqual(await gate(db, { caller: AGENT_B, callId: "cal_b" }), { allow: true });
});

test("restart: the copy loaded from the database does not say it was read with roles, so a rule by role is closed until the next full read", async () => {
  const { db, raw } = world();
  read(db, withRoles(ROLES));
  assert.equal(fleetFacts(db).rolesKnown, true);
  const again = dbOver(raw);
  assert.deepEqual(fleetRoles(again).map((r) => r.id).sort(), [CONTRACTOR, STAFF].sort(), "the roles are in the tables");
  assert.equal(fleetFacts(again).rolesKnown, false, "after a restart: not known until a full read");
  assert.equal((await gate(again, { caller: AGENT_B, callId: "cal_r" })).hold?.family, "policy", "closed meanwhile");
  // the first sync after the restart is a full read (no sinceRevision) and asks for roles
  const asked: Record<string, unknown>[] = [];
  await syncFleet(again, (async (_p: string, _o: string, input: Record<string, unknown>) => {
    asked.push(input);
    return { status: "ok" as const, output: withRoles(ROLES) };
  }) as never);
  assert.deepEqual(asked, [{ accept: ["agent_handles", "lifecycle", "roles"] }]);
  assert.equal(fleetFacts(again).rolesKnown, true);
  assert.deepEqual(await gate(again, { caller: AGENT_B, callId: "cal_s" }), { allow: true });
});

test("a read through the fallback (a Governance that refuses accept) has no roles: the copy says so", async () => {
  const { db } = world();
  let calls = 0;
  await syncFleet(db, (async (_p: string, _o: string, input: Record<string, unknown>) => {
    calls++;
    if (input.accept) throw Object.assign(new Error("input does not fit"), { code: "input_invalid", httpStatus: 400 });
    return { status: "ok" as const, output: withRoles(ROLES) };
  }) as never);
  assert.equal(calls, 2);
  assert.equal(fleetFacts(db).rolesKnown, false, "the read without accept is read as having no roles even if the answer carried a list");
});

// ── the ops ─────────────────────────────────────────────────────────────────
test("manifest: every rule-shaped input takes callerRoles (unique, 1 to 50 names); rules_explain and fleet_status answer roles", () => {
  const good = { title: "t", active: true, priority: 1, match: { callerRoles: [CONTRACTOR] }, outcome: { decision: "hold", reason: "r" } };
  for (const [id] of [["rules_set"], ["rule_draft_submit"], ["rules_preview"]] as const) {
    const input = manifest.operations.find((o) => o.id === id)?.input as Parameters<typeof validateAgainstSchema>[0];
    const wrap = (r: unknown) => (id === "rule_draft_submit" ? { text: "x", rules: [r] } : id === "rules_preview" ? { call: { caller: { type: "agent", id: AGENT_A }, target: { product: "connect", op: "buzz_dm", effect: "outward" } }, candidate: r } : { rule: r });
    assert.equal(validateAgainstSchema(input, wrap(good) as unknown as Json).ok, true, id);
    for (const badList of [[], [CONTRACTOR, CONTRACTOR], [""], "x", Array.from({ length: 51 }, (_, i) => `r${i}`)]) assert.equal(validateAgainstSchema(input, wrap({ ...good, match: { callerRoles: badList } }) as unknown as Json).ok, false, `${id}: ${JSON.stringify(badList).slice(0, 30)}`);
  }
  const explainOut = manifest.operations.find((o) => o.id === "rules_preview")?.output as unknown as { required: string[] };
  assert.ok(explainOut.required.includes("callerRoles"));
  const status = manifest.operations.find((o) => o.id === "fleet_status")?.output as unknown as { required: string[] };
  assert.ok(status.required.includes("roles"));
});

test("ops: fleet_status lists the roles; the dry run names the roles the caller has; a rule by role is saved and listed; an agent cannot save one", async () => {
  const { db } = world();
  read(db, withRoles(ROLES));
  const run = (id: keyof typeof handlers, input: unknown, ctx = opCtx(db, { type: "person", id: OWNER })) => (handlers[id] as unknown as { run: (i: unknown, c: unknown) => Promise<any> }).run(input, ctx);
  const st = await run("fleet_status", {}, opCtx(db, { type: "person", id: OWNER }, (async () => ({ status: "ok", output: withRoles(ROLES) })) as never));
  assert.deepEqual(st.roles.map((r: { id: string; name: string }) => [r.id, r.name]), [[CONTRACTOR, "Contractor"], [STAFF, STAFF]].sort((a, b) => String(a[1]).localeCompare(String(b[1]))));
  const call = { caller: { type: "agent", id: AGENT_A, mode: "free" }, target: { product: "connect", op: "buzz_dm", effect: "outward" } };
  const dry = await run("rules_preview", { call });
  assert.deepEqual(dry.callerRoles, [CONTRACTOR]);
  assert.equal(dry.decision, "hold");
  assert.equal((await run("rules_preview", { call: { ...call, caller: { type: "agent", id: AGENT_B, mode: "free" } } })).callerRoles.length, 0);
  await assert.rejects(run("rules_set", { rule: spec({ match: { callerRoles: [CONTRACTOR, CONTRACTOR] } }) }), /twice/);
  await assert.rejects(run("rules_set", { rule: spec({ match: { callerRoles: [CONTRACTOR] } }) }, opCtx(db, { type: "agent", id: AGENT_A })), /no_access|only the owner|person/i);
});
