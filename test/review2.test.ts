// Second review of Rules 0.3.0 (C236: never wider than with the facts): severity under unavailability (fuzzed), gone members
// and trust, shared keys as holder sets, blocked agents, the rule a narrowing comes from, chunked parsing, a sync that
// never rejects. Quiet-on-good and fire-on-bad in every test.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Json } from "@opt2-tealbrick/miniapp-sdk";
import { type CallFacts, dependsOnProduct, evaluate, explain, order, type Rule, TRUSTS, type Trust, tagsPass } from "../src/engine.ts";
import { parseFeed, parseFeedChunked, syncFleet } from "../src/fleet.ts";
import { makeHooks } from "../src/hooks.ts";
import { fleetFacts, fleetState, saveRule } from "../src/store.ts";
import { AGENT_A, AGENT_B, feed, hookCtx, hookReq, migratedDb, OWNER, prng, spec, trustFacts } from "./helpers.ts";

type Db = ReturnType<typeof migratedDb>["db"];
const hooks = makeHooks("rules");
const call = (id: string, ...args: unknown[]) => (hooks[id] as unknown as (...a: unknown[]) => Promise<Record<string, any>>)(...args);
const sync = (db: Db, doc: Record<string, Json> = feed()) => syncFleet(db, async () => ({ status: "ok" as const, output: doc }));
const gate = (db: Db, o: Record<string, unknown> = {}) => call("rules_gate", hookReq("before", { effect: "outward", ...o }), hookCtx(db));
const claimCtx = (kind: string, id: string, extra: Record<string, Json> = {}) => ({ "tb.onBehalfOf": { claim: { kind, id }, verified: true }, ...extra }) as Record<string, Json>;
const allowed = (r: Record<string, any>) => r.allow === true;
const rule = (id: string, s: Rule["spec"]): Rule => ({ id, rev: 1, spec: s, updatedAt: 1 });
const SEV = { allow: 0, hold: 1, deny: 2 } as const;
const facts = (o: Partial<CallFacts> & { claimTrust?: Trust | null } = {}): CallFacts => ({
  caller: { type: "agent", id: AGENT_A, mode: "free" },
  target: { product: "connect", op: "buzz_dm", effect: "outward" },
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

// ── 1. severity under unavailability ──────────────────────────────────────────────────────────────────────────
test("unavailable facts: the HIGHEST severity among the closed deny/hold rules before the first fact-free match decides; a later deny beats an earlier closed hold", () => {
  const holdTeam = rule("rul_h", spec({ priority: 1, match: { callerTeams: ["tm_x"] }, decision: "hold", reason: "hold X" }));
  const denyAll = rule("rul_d", spec({ priority: 2, match: { effects: ["outward"] }, decision: "deny", reason: "deny all" }));
  const allowAll = rule("rul_a", spec({ priority: 2, match: { effects: ["outward"] }, decision: "allow", reason: "allow all" }));
  const pick = (v: ReturnType<typeof evaluate>) => ({ decision: v.decision, rule: v.rule?.id ?? null, closed: v.closedOnFleet });
  // fire: facts available and the caller is not in X → the deny decides; facts unavailable → the deny (not the earlier closed hold)
  assert.deepEqual(pick(evaluate(order([holdTeam, denyAll]), facts({ fleetAvailable: false }))), { decision: "deny", rule: "rul_d", closed: false });
  assert.deepEqual(pick(evaluate(order([holdTeam, denyAll]), facts({ callerTeams: ["tm_x"], callerTeamsAny: ["tm_x"] }))), { decision: "hold", rule: "rul_h", closed: false }, "with the facts the earlier hold decides");
  // a closed hold before a fact-free allow still holds
  assert.deepEqual(pick(evaluate(order([holdTeam, allowAll]), facts({ fleetAvailable: false }))), { decision: "hold", rule: "rul_h", closed: true });
  // two closed rules: the deny wins whatever the order
  const closedDeny = rule("rul_cd", spec({ priority: 3, match: { callerTeams: ["tm_y"] }, decision: "deny", reason: "deny Y" }));
  assert.deepEqual(pick(evaluate(order([holdTeam, closedDeny]), facts({ fleetAvailable: false }))), { decision: "deny", rule: "rul_cd", closed: true });
  // equal severity: the earlier rule is named
  const hold2 = rule("rul_h2", spec({ priority: 2, match: { callerTeams: ["tm_z"] }, decision: "hold", reason: "hold Z" }));
  assert.equal(evaluate(order([holdTeam, hold2]), facts({ fleetAvailable: false })).rule?.id, "rul_h");
  // rules after the first fact-free match never matter (the first fact-free match ends the scan)
  const late = rule("rul_late", spec({ priority: 9, match: { callerTeams: ["tm_x"] }, decision: "deny", reason: "late" }));
  assert.equal(evaluate(order([allowAll, late]), facts({ fleetAvailable: false })).decision, "allow");
});

test("PROPERTY (fuzz): the decision without the facts is never less strict than with them (deny > hold > allow, narrowing included)", () => {
  const rnd = prng(0xc236);
  const pickOne = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const subset = <T,>(xs: readonly T[], min = 0): T[] => {
    for (;;) {
      const s = xs.filter(() => rnd() < 0.5);
      if (s.length >= min) return s;
    }
  };
  const TAGS = ["w", "p", "s"];
  const subsets = Array.from({ length: 8 }, (_, i) => TAGS.filter((_, b) => i & (1 << b)));
  const passes = (v: ReturnType<typeof evaluate>) => subsets.map((tags) => (v.decision !== "allow" ? false : v.narrowing ? tagsPass(tags, v.narrowing) : true));
  const CASES = 40_000;
  let strictlyStricter = 0;
  let namesFleet = 0;
  let equalWhenNoFleet = 0;
  let productOnly = 0;
  let productStricter = 0;
  for (let i = 0; i < CASES; i++) {
    const rules: Rule[] = [];
    for (let r = 0; r < 1 + Math.floor(rnd() * 6); r++) {
      const decision = pickOne(["allow", "deny", "hold"] as const);
      const match: Record<string, unknown> = {};
      if (rnd() < 0.4) match.effects = [pickOne(["outward", "read"])];
      if (rnd() < 0.45) match.callerTeams = subset(["a", "b"], 1);
      if (rnd() < 0.3) match.callerProducts = subset(["a", "b"], 1);
      const obo: Record<string, unknown> = {};
      if (rnd() < 0.3) obo.teams = subset(["a", "b"], 1);
      if (rnd() < 0.3) obo.trust = subset(TRUSTS, 1);
      if (rnd() < 0.15) obo.kinds = [pickOne(["person", "channel_sender"])];
      if (Object.keys(obo).length) match.onBehalfOf = obo;
      const narrowing = decision === "allow" && rnd() < 0.5 ? { memoryTags: rnd() < 0.5 ? { anyOf: subset(TAGS, 1) } : { noneOf: subset(TAGS, 1) } } : undefined;
      rules.push(rule(`rul_${r}`, spec({ priority: Math.floor(rnd() * 4), match: match as never, decision, reason: "r", ...(narrowing ? { narrowing } : {}) })));
    }
    const ordered = order(rules);
    const claim = rnd() < 0.7 ? { kind: pickOne(["person", "channel_sender"] as const), id: "slack:U123" } : null;
    const callerTeams = subset(["a", "b"]);
    const claimTeams = subset(["a", "b"]);
    const claimTrusts = subset(TRUSTS, 1);
    const base = { claim, claimVerified: rnd() < 0.5, effect: pickOne(["outward", "read"]) };
    // C237: the caller is an agent or an app; an app has a verified product (listed, or not) with the facts and none without them
    const isApp = rnd() < 0.5;
    const who = isApp ? { type: "app", id: "ins_01J0000000000000000000APP1", mode: null } : { type: "agent", id: AGENT_A, mode: "free" };
    const withFacts = facts({
      caller: who,
      callerProduct: isApp ? pickOne(["a", "b", "z"]) : null,
      claim: base.claim,
      claimVerified: base.claimVerified,
      target: { product: "connect", op: "buzz_dm", effect: base.effect },
      callerTeams,
      callerTeamsAny: [...new Set([...callerTeams, ...subset(["a", "b"])])],
      claimTeams: claim ? claimTeams : [],
      claimTeamsAny: claim ? [...new Set([...claimTeams, ...subset(["a", "b"])])] : [],
      claimTrusts: claim ? claimTrusts : [],
      claimTrustActive: rnd() < 0.7,
    });
    const without = facts({ caller: who, claim: base.claim, claimVerified: base.claimVerified, target: withFacts.target, fleetAvailable: false, callerProduct: null });
    const a = evaluate(ordered, withFacts);
    const b = evaluate(ordered, without);
    const where = JSON.stringify({ rules: ordered.map((r) => [r.id, r.spec.priority, r.spec.outcome.decision, r.spec.match, r.spec.narrowing]), withFacts, a: [a.decision, a.rule?.id, a.narrowing], b: [b.decision, b.rule?.id, b.narrowing] });
    assert.ok(SEV[b.decision] >= SEV[a.decision], `without facts must not be less strict: ${where}`);
    if (SEV[b.decision] > SEV[a.decision]) strictlyStricter++;
    if (a.decision === "allow" && b.decision === "allow") {
      const pa = passes(a);
      const pb = passes(b);
      assert.ok(pb.every((ok, k) => !ok || pa[k]), `narrowing without facts must pass a subset of what passes with them: ${where}`);
    }
    // quiet-on-good: no rule names a Fleet fact or a product → the facts change nothing
    const fleetNamed = ordered.some((r) => (r.spec.match.callerTeams?.length ?? 0) > 0 || (r.spec.match.onBehalfOf?.teams?.length ?? 0) > 0 || (r.spec.match.onBehalfOf?.trust?.length ?? 0) > 0);
    if (!fleetNamed && !ordered.some((r) => dependsOnProduct(r.spec))) {
      equalWhenNoFleet++;
      assert.deepEqual([b.decision, b.rule?.id, b.narrowing], [a.decision, a.rule?.id, a.narrowing], `no Fleet or product criterion: identical: ${where}`);
    } else if (!fleetNamed) {
      // only the product is missing: an app is never less strictly decided without it, an agent is not affected at all
      productOnly++;
      if (SEV[b.decision] > SEV[a.decision]) productStricter++;
      if (!isApp) assert.deepEqual([b.decision, b.rule?.id, b.narrowing], [a.decision, a.rule?.id, a.narrowing], `an agent has no product to lose: ${where}`);
    } else namesFleet++;
  }
  assert.ok(strictlyStricter > 500 && equalWhenNoFleet > 500 && namesFleet > 500, `the fuzz exercised both sides (stricter ${strictlyStricter}, identical ${equalWhenNoFleet}, fleet ${namesFleet})`);
  assert.ok(productOnly > 500 && productStricter > 100, `the fuzz exercised the product (product-only cases ${productOnly}, stricter without the product ${productStricter})`);
  console.log(`fuzz cases: ${CASES} (strictly stricter without facts: ${strictlyStricter}, identical when no rule names a Fleet fact: ${equalWhenNoFleet})`);
});

// ── 2. gone members and trust ──────────────────────────────────────────────────────────────────────────────────
test("a gone holder (departed contact, removed or blocked agent) never satisfies a trust-based ALLOW; deny/hold keep the raw trust", async () => {
  const doc = feed({
    teams: [],
    contacts: [
      { id: "ct_live", kind: "person", status: "active", trust: "trusted", handles: ["slack:U100"] },
      { id: "ct_gone", kind: "person", status: "departed", trust: "trusted", handles: ["slack:U200"] },
    ],
    agents: [
      { id: AGENT_A, status: "active", trust: "trusted", owner: null },
      { id: AGENT_B, status: "active", trust: "blocked", owner: null },
      { id: "agt_01J0000000000000000000000C", status: "removed", trust: "trusted", owner: null },
    ],
  });
  const allowDb = migratedDb().db;
  saveRule(allowDb, { spec: spec({ priority: 1, match: { effects: ["outward"], onBehalfOf: { trust: ["trusted"] } }, decision: "allow", reason: "trusted may" }), actor: OWNER });
  saveRule(allowDb, { spec: spec({ priority: 9, match: { effects: ["outward"] }, decision: "deny", reason: "default no" }), actor: OWNER });
  await sync(allowDb, doc);
  const via = (db: Db, kind: string, id: string) => gate(db, { context: claimCtx(kind, id) });
  assert.equal(allowed(await via(allowDb, "person", "ct_live")), true, "quiet: active + trusted");
  assert.equal(allowed(await via(allowDb, "channel_sender", "slack:u100")), true);
  assert.equal(allowed(await via(allowDb, "agent", AGENT_A)), true, "quiet: an active trusted agent");
  assert.equal(allowed(await via(allowDb, "person", "ct_gone")), false, "departed + trusted: no allow by trust");
  assert.equal(allowed(await via(allowDb, "channel_sender", "slack:u200")), false);
  assert.equal(allowed(await via(allowDb, "agent", "agt_01J0000000000000000000000C")), false, "removed agent");
  assert.equal(allowed(await via(allowDb, "agent", AGENT_B)), false, "blocked agent (its trust is blocked anyway)");
  // deny/hold: the raw trust of a gone holder still matches
  const holdDb = migratedDb().db;
  saveRule(holdDb, { spec: spec({ match: { effects: ["outward"], onBehalfOf: { trust: ["trusted"] } }, decision: "hold", reason: "review trusted" }), actor: OWNER });
  await sync(holdDb, doc);
  assert.equal((await via(holdDb, "person", "ct_gone")).hold?.family, "policy", "a gone holder with raw trust 'trusted' is held by a hold-on-trusted rule");
  assert.equal((await via(holdDb, "person", "ct_nobody")).allow, true, "quiet: an unknown requester is unreviewed, not trusted");
});

// ── 3. shared keys are holder sets ────────────────────────────────────────────────────────────────────────────
test("shared handle: deny/hold match if ANY holder matches, allow only if EVERY holder is active and matches (trust, then team)", async () => {
  const H = "slack:U300";
  const shared = feed({
    teams: [
      { id: "tm_x", members: [{ kind: "contact", id: "ct_a" }, { kind: "contact", id: "ct_b" }] },
      { id: "tm_y", members: [{ kind: "contact", id: "ct_a" }] },
    ],
    contacts: [
      { id: "ct_a", kind: "person", status: "active", trust: "unreviewed", handles: [H] },
      { id: "ct_b", kind: "person", status: "active", trust: "limited", handles: [H] },
    ],
    agents: [],
  });
  const claim = claimCtx("channel_sender", "slack:u300");
  const mk = async (rules: Parameters<typeof spec>[0][]) => {
    const { db } = migratedDb();
    for (const r of rules) saveRule(db, { spec: spec(r), actor: OWNER });
    await sync(db, shared);
    return db;
  };
  // trust: unreviewed + limited share a handle
  const denyUnreviewed = await mk([{ match: { effects: ["outward"], onBehalfOf: { trust: ["unreviewed"] } }, decision: "deny", reason: "no unreviewed" }]);
  assert.equal(allowed(await gate(denyUnreviewed, { context: claim })), false, "deny: ANY holder is unreviewed");
  const denyLimited = await mk([{ match: { effects: ["outward"], onBehalfOf: { trust: ["limited"] } }, decision: "deny", reason: "no limited" }]);
  assert.equal(allowed(await gate(denyLimited, { context: claim })), false, "deny: ANY holder is limited");
  const denyTrusted = await mk([{ match: { effects: ["outward"], onBehalfOf: { trust: ["trusted"] } }, decision: "deny", reason: "no trusted" }]);
  assert.equal(allowed(await gate(denyTrusted, { context: claim })), true, "quiet: no holder is trusted");
  const base = [{ priority: 9, match: { effects: ["outward" as const] }, decision: "deny" as const, reason: "default no" }];
  const allowOne = await mk([{ priority: 1, match: { effects: ["outward"], onBehalfOf: { trust: ["unreviewed"] } }, decision: "allow", reason: "x" }, ...base]);
  assert.equal(allowed(await gate(allowOne, { context: claim })), false, "allow: EVERY holder must be listed (limited is not)");
  const allowBoth = await mk([{ priority: 1, match: { effects: ["outward"], onBehalfOf: { trust: ["unreviewed", "limited"] } }, decision: "allow", reason: "x" }, ...base]);
  assert.equal(allowed(await gate(allowBoth, { context: claim })), true, "quiet: both holders listed");
  // team: A and B (B is blocked) in the same team share a handle
  const teamShared = feed({
    teams: [{ id: "tm_x", members: [{ kind: "contact", id: "ct_a" }, { kind: "contact", id: "ct_b" }] }],
    contacts: [
      { id: "ct_a", kind: "person", status: "active", trust: "trusted", handles: [H] },
      { id: "ct_b", kind: "person", status: "active", trust: "blocked", handles: [H, "slack:U301"] },
    ],
    agents: [],
  });
  const mkT = async (rules: Parameters<typeof spec>[0][]) => {
    const { db } = migratedDb();
    for (const r of rules) saveRule(db, { spec: spec(r), actor: OWNER });
    await sync(db, teamShared);
    return db;
  };
  const denyTeam = await mkT([{ match: { effects: ["outward"], onBehalfOf: { teams: ["tm_x"] } }, decision: "deny", reason: "no X" }]);
  assert.equal(allowed(await gate(denyTeam, { context: claim })), false, "deny: some holder is in X");
  const allowTeam = await mkT([{ priority: 1, match: { effects: ["outward"], onBehalfOf: { teams: ["tm_x"] } }, decision: "allow", reason: "X may" }, ...base]);
  assert.equal(allowed(await gate(allowTeam, { context: claim })), false, "allow: the blocked holder of the same handle spoils it");
  assert.equal(allowed(await gate(allowTeam, { context: claimCtx("person", "ct_a") })), true, "quiet: A by contact id is a single active holder");
  // holders in DIFFERENT teams: allow needs every holder in the team
  const split = feed({
    teams: [{ id: "tm_x", members: [{ kind: "contact", id: "ct_a" }] }],
    contacts: [
      { id: "ct_a", kind: "person", status: "active", trust: "trusted", handles: [H] },
      { id: "ct_b", kind: "person", status: "active", trust: "trusted", handles: [H] },
    ],
    agents: [],
  });
  const { db: dbSplit } = migratedDb();
  saveRule(dbSplit, { spec: spec({ priority: 1, match: { effects: ["outward"], onBehalfOf: { teams: ["tm_x"] } }, decision: "allow", reason: "X may" }), actor: OWNER });
  saveRule(dbSplit, { spec: spec(base[0] as never), actor: OWNER });
  await sync(dbSplit, split);
  assert.equal(allowed(await gate(dbSplit, { context: claim })), false, "allow: B holds the handle but is not in X");
  assert.deepEqual(fleetFacts(dbSplit).teamsAny.get(`handle:${H}`), ["tm_x"], "deny/hold still see the membership of A");
});

// ── 4. blocked agents, left-out members ──────────────────────────────────────────────────────────────────────
test("a blocked AGENT is gone for allow (callerTeams, agent claims); a member the producer left out never gets live allow teams", async () => {
  const doc = feed({
    teams: [{ id: "tm_x", members: [{ kind: "agent", id: AGENT_A }, { kind: "agent", id: AGENT_B }, { kind: "contact", id: "ct_ghost" }] }],
    contacts: [],
    agents: [
      { id: AGENT_A, status: "active", trust: "trusted", owner: null },
      { id: AGENT_B, status: "active", trust: "blocked", owner: null },
    ],
  });
  const allowDb = migratedDb().db;
  saveRule(allowDb, { spec: spec({ priority: 1, match: { effects: ["outward"], callerTeams: ["tm_x"] }, decision: "allow", reason: "X may" }), actor: OWNER });
  saveRule(allowDb, { spec: spec({ priority: 2, match: { effects: ["outward"], onBehalfOf: { teams: ["tm_live"] } }, decision: "allow", reason: "live may" }), actor: OWNER });
  saveRule(allowDb, { spec: spec({ priority: 9, match: { effects: ["outward"] }, decision: "deny", reason: "default no" }), actor: OWNER });
  await sync(allowDb, doc);
  assert.equal(allowed(await gate(allowDb, { caller: AGENT_A })), true, "quiet: an active agent in X");
  assert.equal(allowed(await gate(allowDb, { caller: AGENT_B })), false, "a blocked agent gets no allow by team");
  const live = { "fleet.requesterTeams": [{ id: "tm_live", name: "L", role: "member" }] } as Record<string, Json>;
  assert.equal(allowed(await gate(allowDb, { caller: AGENT_B, context: claimCtx("person", "ct_new", live) })), true, "quiet: a requester the model has never seen gets its live team");
  assert.equal(allowed(await gate(allowDb, { caller: AGENT_B, context: claimCtx("person", "ct_ghost", live) })), false, "a member the producer left out: live facts cannot open an allow rule");
  assert.equal(allowed(await gate(allowDb, { caller: AGENT_B, context: claimCtx("agent", AGENT_B, live) })), false, "a blocked agent as requester: same");
  // deny rules still see the blocked agent's team
  const denyDb = migratedDb().db;
  saveRule(denyDb, { spec: spec({ match: { effects: ["outward"], callerTeams: ["tm_x"] }, decision: "deny", reason: "no X" }), actor: OWNER });
  await sync(denyDb, doc);
  assert.equal(allowed(await gate(denyDb, { caller: AGENT_B })), false);
});

// ── 5. the rule a narrowing comes from ─────────────────────────────────────────────────────────────────────────
test("rules_context names the rule the narrowing came from: the deciding rule's own, else the skipped allow rule's", async () => {
  const { db } = migratedDb();
  const skipped = saveRule(db, { spec: spec({ title: "work only for X", priority: 1, match: { callerTeams: ["tm_x"], effects: ["read"] }, decision: "allow", reason: "work only", narrowing: { memoryTags: { anyOf: ["work"] } } }), actor: OWNER });
  const plain = saveRule(db, { spec: spec({ title: "plain allow", priority: 2, match: { effects: ["read"] }, decision: "allow", reason: "plain" }), actor: OWNER });
  const ctx = async (callId: string): Promise<Record<string, any> | undefined> => (await call("rules_context", hookReq("context", { effect: "read", product: "knowledge", op: "memory_recall", callId }), hookCtx(db))).add["rules.narrowing"];
  const n1 = (await ctx("c1")) as Record<string, any>;
  assert.equal(n1.ruleId, skipped.id, "the plain rule decided, the narrowing is the skipped rule's");
  assert.match(n1.reason, /Governance data unavailable/);
  assert.deepEqual(n1.memoryTags, { anyOf: ["work"] });
  // quiet: the facts are available and the caller is not in X → nothing from the skipped rule
  await sync(db);
  const n3 = (await call("rules_context", hookReq("context", { effect: "read", product: "knowledge", op: "memory_recall", callId: "c3", caller: AGENT_B }), hookCtx(db))).add["rules.narrowing"];
  assert.equal(n3, undefined, "no narrowing at all: B is in no team and the plain rule has none");
  const n4 = (await ctx("c4")) as Record<string, any>;
  assert.equal(n4.ruleId, skipped.id, "quiet: A is in X, the rule decides with its own narrowing");
  assert.equal(n4.reason, "work only");
  // the deciding rule has its own narrowing: it is named and the skipped rule's is merged in
  const { db: db2 } = migratedDb();
  saveRule(db2, { spec: spec({ title: "work only for X", priority: 1, match: { callerTeams: ["tm_x"], effects: ["read"] }, decision: "allow", reason: "work only", narrowing: { memoryTags: { anyOf: ["work"] } } }), actor: OWNER });
  const own = saveRule(db2, { spec: spec({ title: "no secrets", priority: 2, match: { effects: ["read"] }, decision: "allow", reason: "no secrets", narrowing: { memoryTags: { noneOf: ["secret"] } } }), actor: OWNER });
  const n2 = (await call("rules_context", hookReq("context", { effect: "read", product: "knowledge", op: "memory_recall", callId: "c2" }), hookCtx(db2))).add["rules.narrowing"];
  assert.equal(n2.ruleId, own.id);
  assert.equal(n2.reason, "no secrets");
  assert.deepEqual(n2.memoryTags, { anyOf: ["work"], noneOf: ["secret"] });
  assert.equal(evaluate(order([rule("rul_s", spec({ priority: 1, match: { callerTeams: ["tm_x"] }, decision: "allow", reason: "s", narrowing: { memoryTags: { anyOf: ["w"] } } })), rule("rul_p", spec({ priority: 2, match: {}, decision: "allow", reason: "p" }))]), facts({ fleetAvailable: false })).narrowingRuleId, "rul_s");
  void plain;
});

// ── 6. chunked parsing ─────────────────────────────────────────────────────────────────────────────────────────
test("a big answer is read in slices with a yield between them; no block comes near 50 ms (100 teams x 4000 members)", async () => {
  const agentId = (i: number) => `agt_${"0123456789ABCDEFGHJKMNPQRSTVWXYZ"[i % 32]}${String(i).padStart(25, "0")}`.slice(0, 30);
  const contacts = Array.from({ length: 2000 }, (_, i) => ({ id: `ct_${i}`, kind: "person", status: "active", trust: "trusted", handles: [1, 2, 3, 4].map((h) => `telegram:${1 + i * 4 + h}`) }));
  const agents = Array.from({ length: 2000 }, (_, i) => ({ id: agentId(i), status: "active", trust: "trusted", owner: null }));
  const teams = Array.from({ length: 100 }, (_, t) => ({ id: `tm_${t}`, members: Array.from({ length: 4000 }, (_, m) => (m % 2 === 0 ? { kind: "contact", id: `ct_${m / 2}`, role: "member" } : { kind: "agent", id: agentId((m - 1) / 2), role: "member" })) }));
  const doc = { v: 1, revision: 1, teams, contacts, agents } as unknown as Json;
  let last = performance.now();
  let max = 0;
  let yields = 0;
  const parsed = await parseFeedChunked(doc, async () => {
    max = Math.max(max, performance.now() - last);
    yields++;
    await new Promise((r) => setImmediate(r));
    last = performance.now();
  });
  max = Math.max(max, performance.now() - last);
  assert.ok(yields > 100, `many yields (${yields})`);
  assert.ok(max < 50, `longest block ${max.toFixed(1)} ms`);
  assert.equal(parsed.model.teams.length, 100);
  assert.equal(parsed.model.teams[0]?.keys.length, 2000 * 5 + 2000, "contact + 4 handles each, plus the agents");
  // the sliced read means the same as the one-go read, and a slice with a defect is refused with the schema's message
  assert.deepEqual(parseFeed(feed()).model.teams.map((t) => t.keys.sort()), (await parseFeedChunked(feed())).model.teams.map((t) => t.keys.sort()));
  const bad = structuredClone(doc) as unknown as { teams: { members: { kind: string }[] }[] };
  (bad.teams[57]?.members[3] as { kind: string }).kind = "robot";
  await assert.rejects(parseFeedChunked(bad as unknown as Json), { code: "feed_invalid", message: /fleet\.directory_feed\/1/ });
  const tooMany = { v: 1, revision: 1, teams: Array.from({ length: 501 }, (_, i) => ({ id: `t${i}`, members: [] })), contacts: [], agents: [] };
  await assert.rejects(parseFeedChunked(tooMany), { code: "feed_invalid", message: /501|500|maxItems|more than/ });
});

// ── 7. a sync never rejects ────────────────────────────────────────────────────────────────────────────────────
test("syncFleet never rejects: when the database refuses the clearing write, the copy is dropped in memory and the error recorded", async () => {
  const { db } = migratedDb();
  await sync(db);
  assert.equal(fleetFacts(db).available, true, "quiet: a good copy");
  const orig = db.transaction.bind(db);
  (db as any).transaction = () => {
    throw new Error("disk I/O error");
  };
  // refusal (no grant) → the clear must be written → the database throws
  await assert.doesNotReject(syncFleet(db, async () => Promise.reject(Object.assign(new Error("no grant"), { code: "no_grant" }))));
  assert.equal(fleetFacts(db).available, false, "fail closed: the in-memory copy is gone");
  assert.match(String(fleetState(db).error), /no_grant.*could not be cleared: disk I\/O error/);
  assert.equal(fleetState(db).usable, false);
  // a good answer while the database is still broken cannot be stored either: still unavailable, still no rejection
  await assert.doesNotReject(sync(db));
  assert.equal(fleetFacts(db).available, false);
  // the database recovers: the next sync stores the copy and clears the in-memory error
  (db as any).transaction = orig;
  await sync(db);
  assert.equal(fleetFacts(db).available, true);
  assert.equal(fleetState(db).error, null);
  void explain;
});
