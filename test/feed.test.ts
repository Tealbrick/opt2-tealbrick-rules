// Contract fleet.directory_feed/1 (C230, G-3, RUL-02): the frozen files, every fixture through the REAL reader (parseFeed:
// vendored schema + normalizeHandle), the refusal path (error recorded, copy cleared, never a partial read) and the
// quiet-on-good counterparts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { normalizeHandle } from "@opt2-tealbrick/manifest";
import type { Json } from "@opt2-tealbrick/miniapp-sdk";
import { OP } from "#kit";
import { handlers } from "../src/app.ts";
import { FEED_INVALID, parseFeed, syncFleet } from "../src/fleet.ts";
import { fleetFacts, fleetState, fleetTeams, writeFleet } from "../src/store.ts";
import { AGENT_A, AGENT_R, feed, migratedDb, OWNER, opCtx } from "./helpers.ts";

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const file = (rel: string) => readFileSync(new URL(rel, import.meta.url));
const FIXTURES = JSON.parse(file("./contracts/fleet.directory_feed.1.json").toString()) as {
  valid: Json[];
  invalid: { why: string; doc: Json }[];
  invalidByNormalizeHandle: { why: string; doc: Json }[];
};

const DERIVED = "./contracts/fleet.directory_feed.1.agent_handles.schema.json";
const LIFECYCLE = "./contracts/fleet.directory_feed.1.lifecycle.schema.json";
const RUNTIME = "../src/contracts/fleet.directory_feed.1.lifecycle.schema.json";
const LIFECYCLE_FIXTURES = "./contracts/fleet.directory_feed.1.lifecycle.json";

test("contract files are the byte copies named in PROVENANCE.md (quiet on good, fires on a changed byte); the runtime schema is the same bytes as Governance's derived file", () => {
  const prov = file("./contracts/PROVENANCE.md").toString();
  for (const f of ["./contracts/fleet.directory_feed.1.schema.json", "./contracts/fleet.directory_feed.1.json", DERIVED, LIFECYCLE, LIFECYCLE_FIXTURES, RUNTIME]) {
    const bytes = file(f);
    assert.ok(prov.includes(sha256(bytes)), `${f} does not match the sha256 in PROVENANCE.md`);
    assert.ok(!prov.includes(sha256(Buffer.concat([bytes, Buffer.from(" ")]))), "a changed file would not match");
  }
  assert.ok(file(LIFECYCLE).equals(file(RUNTIME)));
  assert.ok(prov.includes("spec-v0.1.42") && prov.includes("7067eab") && prov.includes("spec-v0.1.89"));
});

test("spec 0.1.89 lifecycle fixtures through the real reader: every valid answer reads, every invalid one is refused (quiet and fire)", () => {
  const fx = JSON.parse(file(LIFECYCLE_FIXTURES).toString()) as { valid: Json[]; invalid: { why: string; doc: Json }[] };
  assert.ok(fx.valid.length >= 3 && fx.invalid.length >= 3);
  for (const doc of fx.valid) assert.doesNotThrow(() => parseFeed(doc), JSON.stringify(doc).slice(0, 80));
  for (const { why, doc } of fx.invalid) assert.throws(() => parseFeed(doc), { code: FEED_INVALID }, why);
  const first = parseFeed(fx.valid[0] as Json);
  assert.deepEqual(first.floor.filter((e) => e.kind !== "handle").map((e) => [e.id, e.code]), [["ct_anna", "leaving"], ["ct_bot", "blocked"], ["agt_01M4TNVDHPXJGTHATZV5SVJHX9", "suspended"], ["agt_01M4TWGYN437B0W62JBV36HQT5", "not_started"]], "archived with floor false (no card) is not listed");
  assert.equal(first.floor.filter((e) => e.kind === "handle").length, 2, "a handle two stopped holders share is one entry");
});

test("the derived schema is the spec byte copy plus ONE optional property: agents[].handles (canonical handles, unique, at most 16)", () => {
  type S = { $defs: { full: { properties: { agents: { items: { properties: Record<string, unknown>; required: string[] } } } } } };
  const spec = JSON.parse(file("./contracts/fleet.directory_feed.1.schema.json").toString()) as S;
  const derived = JSON.parse(file(DERIVED).toString()) as S;
  const agent = derived.$defs.full.properties.agents.items;
  assert.deepEqual({ ...(agent.properties.handles as Record<string, unknown>), description: undefined }, { type: "array", maxItems: 16, uniqueItems: true, items: { $ref: "#/$defs/handle" }, description: undefined });
  assert.ok(!agent.required.includes("handles"), "optional: an older Governance never sends it");
  delete agent.properties.handles;
  assert.deepEqual(derived, spec, "nothing else differs");
});

test("agents[].handles: read when sent (the agent holds each handle:<h> key), refused when not canonical, absent = the old shape", () => {
  const withHandles = feed({ agents: [{ id: AGENT_A, status: "active", trust: "trusted", owner: "ct_anna", handles: ["slack:U900", "telegram:77"] }, { id: AGENT_R, status: "removed", trust: "blocked", owner: null, handles: ["slack:U777"] }] });
  const d = parseFeed(withHandles);
  assert.deepEqual(d.model.trust.get("handle:slack:U900"), { trusts: ["trusted"], allActive: true }, "the agent is the handle's holder");
  assert.deepEqual(d.model.trust.get("handle:slack:U777"), { trusts: ["trusted", "blocked"], allActive: false }, "a handle held by a contact AND a removed agent: both holders count");
  const team = d.model.teams.find((t) => t.id === "tm_x");
  assert.ok(team?.keys.includes("handle:slack:U900") && team.activeKeys.includes("handle:slack:U900"), "the agent's team reaches its handle");
  assert.ok(team?.keys.includes("handle:slack:U777") && !team.activeKeys.includes("handle:slack:U777"), "a gone holder: deny/hold only");
  // quiet on the old shape: no handles, no handle keys from agents
  assert.equal(parseFeed(feed()).model.trust.has("handle:slack:U900"), false);
  // fire: a handle that is not canonical refuses the whole answer (the schema's handle pattern already catches this one)
  assert.throws(() => parseFeed(feed({ agents: [{ id: AGENT_A, status: "active", trust: "trusted", owner: null, handles: ["slack:u900"] }] })), { code: FEED_INVALID });
  assert.throws(() => parseFeed(feed({ agents: [{ id: AGENT_A, status: "active", trust: "trusted", owner: null, handles: Array.from({ length: 17 }, (_, i) => `telegram:${i + 1}`) }] })), { code: FEED_INVALID });
});

test("upgrade: a stored copy read WITHOUT accept (Rules 0.3.x, or before this process) is never delta-read with accept: the first accept read is FULL", async () => {
  // Governance answers {unchanged} for sinceRevision === its revision BEFORE it looks at accept (Governance 0.3.0, QA S3), so a
  // delta read would keep a copy without agent handles until the revision moves.
  const { db } = migratedDb();
  writeFleet(db, parseFeed(feed({ revision: 5 })).model, { revision: 5, error: null });
  assert.equal(fleetState(db).stale, false, "a usable, fresh stored copy that would allow a delta read");
  const seen: Record<string, unknown>[] = [];
  const handles = feed({ revision: 5, agents: [{ id: AGENT_A, status: "active", trust: "trusted", owner: null, handles: ["slack:U900"] }] });
  await syncFleet(db, (async (_p: string, _o: string, input: Record<string, unknown>) => {
    seen.push(input);
    return { status: "ok" as const, output: input.sinceRevision === 5 ? { v: 1, revision: 5, unchanged: true } : handles };
  }) as never);
  assert.deepEqual([...seen], [{ accept: ["agent_handles", "lifecycle", "roles"] }], "no sinceRevision on the first read with accept");
  assert.equal(fleetFacts(db).trust.has("handle:slack:U900"), true, "the agent handles arrive at once, not when the revision moves");
  // quiet: the next read is a delta read again (the copy now has the shape asked for)
  seen.length = 0;
  await syncFleet(db, (async (_p: string, _o: string, input: Record<string, unknown>) => {
    seen.push(input);
    return { status: "ok" as const, output: { v: 1, revision: 5, unchanged: true } };
  }) as never);
  assert.deepEqual(seen, [{ accept: ["agent_handles", "lifecycle", "roles"], sinceRevision: 5 }]);
});

test("an older Governance that refuses accept (400 input_invalid) is read without it at once, asked again after 10 min; delta reads only onto a copy of the same shape", async () => {
  const { db } = migratedDb();
  const T = 1_000_000_000_000;
  let t = T;
  let knowsAccept = false;
  let answer: unknown = feed({ revision: 3 });
  const seen: Record<string, unknown>[] = [];
  const callApp = async (_p: string, _o: string, input: Record<string, unknown>) => {
    seen.push(input);
    if (input.accept && !knowsAccept) throw Object.assign(new Error("input does not fit the schema"), { code: "input_invalid", httpStatus: 400 });
    return { status: "ok" as const, output: answer };
  };
  await syncFleet(db, callApp as never, () => t);
  assert.deepEqual(seen, [{ accept: ["agent_handles", "lifecycle", "roles"] }, {}], "refused, then read the old way in the same sync");
  assert.equal(fleetFacts(db, t).available, true, "quiet: Governance 0.2.3 is read correctly");
  assert.equal(fleetState(db).error, null);
  // within 10 min: no accept, delta read onto the copy without handles
  seen.length = 0;
  answer = { v: 1, revision: 3, unchanged: true };
  t += 60_000;
  await syncFleet(db, callApp as never, () => t);
  assert.deepEqual(seen, [{ sinceRevision: 3 }]);
  // Governance updated; after 10 min Rules asks again: a FULL read (the copy has no handles), never a delta onto it
  knowsAccept = true;
  answer = feed({ revision: 4, agents: [{ id: AGENT_A, status: "active", trust: "trusted", owner: null, handles: ["slack:U900"] }] });
  seen.length = 0;
  t += 10 * 60_000;
  await syncFleet(db, callApp as never, () => t);
  assert.deepEqual(seen, [{ accept: ["agent_handles", "lifecycle", "roles"] }]);
  assert.equal(fleetFacts(db, t).trust.has("handle:slack:U900"), true);
  // then deltas with accept
  seen.length = 0;
  answer = { v: 1, revision: 4, unchanged: true };
  t += 60_000;
  await syncFleet(db, callApp as never, () => t);
  assert.deepEqual(seen, [{ accept: ["agent_handles", "lifecycle", "roles"], sinceRevision: 4 }]);
  // Governance rolled back to 0.2.3 while Rules holds a copy WITH handles: the fallback read is a FULL one (never "unchanged" onto it)
  knowsAccept = false;
  answer = feed({ revision: 4 });
  seen.length = 0;
  t += 60_000;
  await syncFleet(db, callApp as never, () => t);
  assert.deepEqual(seen, [{ accept: ["agent_handles", "lifecycle", "roles"], sinceRevision: 4 }, {}]);
  assert.equal(fleetFacts(db, t).trust.has("handle:slack:U900"), false, "the agent handles of the old answer are gone");
  // fire: a 403 is a refusal whatever was asked (no fallback, the copy goes)
  const refusing = async () => Promise.reject(Object.assign(new Error("no"), { code: "not_granted", httpStatus: 403 }));
  await syncFleet(db, refusing as never, () => t + 1);
  assert.equal(fleetFacts(db, t + 1).available, false);
});

test("fixtures: every valid doc is read, every invalid doc is refused, invalidByNormalizeHandle fails ONLY by the handle rule", () => {
  assert.ok(FIXTURES.valid.length >= 3 && FIXTURES.invalid.length >= 7 && FIXTURES.invalidByNormalizeHandle.length >= 1);
  for (const doc of FIXTURES.valid) assert.doesNotThrow(() => parseFeed(doc), JSON.stringify(doc).slice(0, 80));
  for (const { why, doc } of FIXTURES.invalid) assert.throws(() => parseFeed(doc), { code: FEED_INVALID, message: /fleet\.directory_feed\/1/ }, why);
  for (const { why, doc } of FIXTURES.invalidByNormalizeHandle) {
    const handles = ((doc as { contacts: { handles: string[] }[] }).contacts ?? []).flatMap((c) => c.handles);
    assert.ok(handles.some((h) => normalizeHandle(h) !== h), "the fixture breaks the normalizeHandle rule");
    // the schema alone accepts it: the refusal comes from the handle rule and says so
    assert.throws(() => parseFeed(doc), { code: FEED_INVALID, message: /not canonical/ }, why);
  }
});

test("the first fixture maps as the contract says", () => {
  const d = parseFeed(FIXTURES.valid[0]);
  assert.equal(d.revision, 42);
  const [team] = d.model.teams;
  assert.deepEqual(team?.keys.sort(), [
    "agent:agt_01M4TNVDHPXJGTHATZV5SVJHX9",
    "contact:ct_anna",
    "handle:buzz:npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6",
    "handle:slack:U012ABCDEF",
  ]);
  assert.equal(team?.name, "Sales");
  assert.deepEqual(d.model.trust.get("contact:ct_anna"), { trusts: ["trusted"], allActive: true });
  assert.equal(parseFeed(FIXTURES.valid[1]).unchanged, true);
});

test("a feed answer that breaks the contract is a REFUSAL: error recorded, copy cleared, nothing partial read (RUL-02)", async () => {
  const { db } = migratedDb();
  let answer: unknown = feed();
  const callApp = async () => ({ status: "ok" as const, output: answer });
  await syncFleet(db, callApp);
  assert.equal(fleetFacts(db).available, true);
  assert.equal(fleetTeams(db).length, 2);
  for (const { why, doc } of [...FIXTURES.invalid, ...FIXTURES.invalidByNormalizeHandle]) {
    // a good copy first, then the broken answer
    answer = feed();
    await syncFleet(db, callApp);
    assert.equal(fleetFacts(db).available, true, `quiet on good before: ${why}`);
    answer = doc;
    await syncFleet(db, callApp);
    assert.equal(fleetFacts(db).available, false, `refusal: ${why}`);
    assert.equal(fleetTeams(db).length, 0, "nothing of the broken answer, and nothing of the old copy, is read");
    assert.equal(fleetFacts(db).trust.size, 0);
    assert.match(String(fleetState(db).error), /^Governance feed refused: /);
    assert.equal(fleetState(db).revision, null, "the next read is a full one");
  }
  // fleet_status shows it
  const st = await run("fleetStatus", db, callApp as never);
  assert.equal(st.available, false);
  assert.match(st.error, /^Governance feed refused: /);
  assert.deepEqual(st.teams, []);
  // an answer with a good part and a bad handle is not read at all
  answer = feed({ contacts: [{ id: "c1", kind: "person", status: "active", trust: "trusted", handles: ["slack:u012abcdef"] }] });
  await syncFleet(db, callApp);
  assert.equal(fleetTeams(db).length, 0);
  // and a later good answer recovers
  answer = feed();
  await syncFleet(db, callApp);
  assert.equal(fleetFacts(db).available, true);
  assert.equal(fleetState(db).error, null);
});

test("'unchanged' is only believed for the revision that was asked about", async () => {
  const { db } = migratedDb();
  let answer: unknown = feed({ revision: 5 });
  const callApp = async () => ({ status: "ok" as const, output: answer });
  await syncFleet(db, callApp);
  answer = { v: 1, revision: 5, unchanged: true };
  await syncFleet(db, callApp);
  assert.equal(fleetFacts(db).available, true, "quiet on good: asked 5, unchanged 5");
  answer = { v: 1, revision: 9, unchanged: true };
  await syncFleet(db, callApp);
  assert.equal(fleetFacts(db).available, false, "asked 5, 'unchanged' for 9 is a broken answer");
  assert.match(String(fleetState(db).error), /unchanged answered for revision 9, asked 5/);
  // after the clear the next read is full: an 'unchanged' there has nothing to refer to
  answer = { v: 1, revision: 9, unchanged: true };
  await syncFleet(db, callApp);
  assert.match(String(fleetState(db).error), /asked none/);
});

test("the feed's 503 feed_too_large is transient (the copy stays), a 403 is a refusal (the copy goes)", async () => {
  const { db } = migratedDb();
  let err: Record<string, unknown> | null = null;
  const callApp = async () => {
    if (err) throw Object.assign(new Error("x"), err);
    return { status: "ok" as const, output: feed() };
  };
  await syncFleet(db, callApp);
  err = { code: "feed_too_large", httpStatus: 503 };
  await syncFleet(db, callApp);
  assert.equal(fleetFacts(db).available, true);
  assert.equal(fleetTeams(db).length, 2);
  assert.match(String(fleetState(db).error), /feed_too_large/);
  err = { code: "no_access", httpStatus: 403 };
  await syncFleet(db, callApp);
  assert.equal(fleetFacts(db).available, false);
  assert.equal(fleetTeams(db).length, 0);
});

test("the companion op is called with sinceRevision once a read exists (and never an agent id)", async () => {
  const { db } = migratedDb();
  const seen: unknown[][] = [];
  const callApp = async (...a: unknown[]) => {
    seen.push(a);
    return { status: "ok" as const, output: feed({ revision: 3 }) };
  };
  await syncFleet(db, callApp as never);
  await syncFleet(db, async (...a: unknown[]) => {
    seen.push(a);
    return { status: "ok" as const, output: { v: 1, revision: 3, unchanged: true } };
  });
  assert.deepEqual(seen, [["fleet", "directory_feed", { accept: ["agent_handles", "lifecycle", "roles"] }], ["fleet", "directory_feed", { accept: ["agent_handles", "lifecycle", "roles"], sinceRevision: 3 }]]);
});

async function run(id: "fleetStatus", db: ReturnType<typeof migratedDb>["db"], callApp: never) {
  const h = handlers[OP[id]] as unknown as { run: (i: unknown, c: unknown) => Promise<any> };
  return h.run({}, opCtx(db, { type: "person", id: OWNER }, callApp));
}
