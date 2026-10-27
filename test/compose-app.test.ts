// The owner's English rule box as operations (C373, J3): `rule_compose` (person, read, no state: a proposal from the agent
// directory, the Fleet copy and the app catalog, through the writer checks) and `rule_compose_save` (person, write: a pending
// draft with source `owner`). Nothing applies before `draft_decide` approves it (C84).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { generateKeyPair, type Manifest, signReleaseIndex, validateManifest } from "@opt2-tealbrick/manifest";
import type { Db, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { OP } from "#kit";
import { definition, handlers, manifest } from "../src/app.ts";
import { syncCatalog } from "../src/catalog.ts";
import { knownAgents } from "../src/directory.ts";
import { syncFleet } from "../src/fleet.ts";
import { listDrafts, liveRules } from "../src/store.ts";
import { AGENT_A, AGENT_B, feed, migratedDb, OWNER, opCtx } from "./helpers.ts";

type Run = (input: unknown, ctx: OpContext) => Promise<any>;
const run = (id: keyof typeof handlers) => (handlers[id] as unknown as { run: Run }).run;
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const callApp = (async () => ({ status: "ok" as const, output: feed() })) as unknown as OpContext["callApp"];

/** A database with the Fleet copy (teams tm_x “Team X”, tm_y), the agent directory (Hermes = AGENT_A, CEO = AGENT_B) and, optionally, a signed catalog with Connect. */
async function setup(o: { catalog?: boolean } = {}): Promise<{ db: Db; owner: OpContext }> {
  const { db } = migratedDb();
  await definition.events?.agentsChanged?.(
    [
      { id: AGENT_A, name: "Hermes", mode: "free", status: "active" },
      { id: AGENT_B, name: "CEO", mode: "free", status: "active" },
    ] as never,
    { db, log: quiet, callApp, statusChanged() {} } as never,
  );
  await syncFleet(db, callApp as never);
  if (o.catalog) await syncCatalog(db, await signedIndex());
  return { db, owner: opCtx(db, { type: "person", id: OWNER, name: "Martin" }, callApp) };
}

async function signedIndex() {
  const connect = JSON.parse(readFileSync(new URL("./fixtures/connect.manifest.json", import.meta.url), "utf8")) as Manifest;
  const key = await generateKeyPair({ extractable: true });
  const files = new Map<string, string>();
  const rec = (m: Manifest, n: number) => {
    const url = `https://raw.test/${m.id}/tealbrick.manifest.json`;
    files.set(url, JSON.stringify(m));
    const v = validateManifest(m);
    assert.ok(v.ok);
    return { id: `rel_01J0000000000000000000000${n}`, product: m.id, kind: "app", version: m.version, channel: "stable", manifestDigest: v.digest, manifestUrl: url, publishedAt: "2026-10-27T00:00:00.000Z" };
  };
  const body = {
    schema: "opt2.release-index/v2" as const,
    generatedAt: "2026-10-27T00:00:00.000Z",
    releases: [rec(connect, 1), rec(manifest as unknown as Manifest, 2)],
    harnesses: [],
    offers: [],
  };
  const index = "https://registry.test/index.json";
  files.set(index, JSON.stringify(body));
  files.set(index.replace(/\.json$/, ".jws"), await signReleaseIndex(body, { iat: Math.floor(Date.now() / 1000) }, key));
  const fetchText = async (u: string) => {
    const t = files.get(u);
    if (t === undefined) throw new Error(`fetch 404 ${u}`);
    return t;
  };
  return { url: index, fetchText, retryMs: 0, keys: { keys: [{ kty: "OKP" as const, crv: "Ed25519" as const, x: key.publicJwk.x }] } };
}

test("manifest: rule_compose (person read, no idempotency) and rule_compose_save (person write, idempotency required); owner drafts", () => {
  const byId = Object.fromEntries(manifest.operations.map((o) => [o.id, o]));
  const c = byId.rule_compose as unknown as Record<string, unknown>;
  const s = byId.rule_compose_save as unknown as Record<string, unknown>;
  assert.deepEqual([c.audience, c.effect, c.crud, c.idempotency], ["person", "read", ["read"], "none"]);
  assert.deepEqual([s.audience, s.effect, s.crud, s.idempotency], ["person", "write", ["create"], "required"]);
  const kinds = (id: string) => (byId[id] as unknown as { output: { $defs: { Draft: { properties: { source: { properties: { kind: { enum: string[] } } } } } } } }).output.$defs.Draft.properties.source.properties.kind.enum;
  assert.deepEqual(kinds("drafts_list"), ["agent", "app", "owner"]);
  assert.deepEqual(kinds("draft_decide"), ["agent", "app", "owner"]);
});

test("agentsChanged keeps the agent names for the English box", async () => {
  const { db } = await setup();
  assert.deepEqual(knownAgents(db), [
    { id: AGENT_A, name: "Hermes" },
    { id: AGENT_B, name: "CEO" },
  ]);
});

test("rule_compose: the owner's English → proposed rules with readable lines; nothing is stored; owner only", async () => {
  const { db, owner } = await setup();
  const out = await run(OP.ruleCompose)({ text: "When someone from team X tags the CEO agent: only work-tagged memories, no money. Hold Hermes's outward actions" }, owner);
  assert.equal(out.drafter, "parser");
  assert.deepEqual(
    out.rules.map((r: { outcome: { decision: string }; match: unknown }) => [r.outcome.decision, r.match]),
    [
      ["deny", { agents: [AGENT_B], effects: ["money"], onBehalfOf: { teams: ["tm_x"] } }],
      ["hold", { agents: [AGENT_A], effects: ["outward"] }],
      ["allow", { agents: [AGENT_B], onBehalfOf: { teams: ["tm_x"] } }],
    ],
  );
  assert.deepEqual(out.lines, [
    "Refuse: calls by CEO on behalf of team Team X with effect money. Priority 10: refuse and hold rules run first.",
    "Hold for my review: calls by Hermes with effect outward. Priority 10: refuse and hold rules run first.",
    "Allow: calls by CEO on behalf of team Team X, only memories tagged work. Priority 20: after the refuse and hold rules of this proposal.",
  ]);
  assert.deepEqual(out.unmatched, []);
  assert.deepEqual(liveRules(db), [], "a proposal applies nothing");
  assert.deepEqual(listDrafts(db, undefined, 10), [], "a proposal stores nothing");
  await assert.rejects(run(OP.ruleCompose)({ text: "Block money for all agents" }, opCtx(db, { type: "agent", id: AGENT_A })), { code: "forbidden" });
});

test("rule_compose: names the owner page read (tb.agents_list) resolve after a restart; each line says the priority and why", async () => {
  const { db } = migratedDb();
  await syncFleet(db, callApp as never);
  const owner = opCtx(db, { type: "person", id: OWNER }, callApp);
  await run(OP.rulesSet)({ rule: { title: "no sends", active: true, priority: 100, match: { effects: ["outward"] }, outcome: { decision: "deny", reason: "r" } } }, owner);
  assert.deepEqual(knownAgents(db), [], "no agentsChanged since this start");
  const text = "When someone from team X tags the CEO agent: only work-tagged memories, no money";
  assert.match((await run(OP.ruleCompose)({ text }, owner)).unmatched[0]?.hint ?? "", /No agent named “CEO”/);
  const out = await run(OP.ruleCompose)({ text, agents: [{ id: AGENT_B, name: "CEO" }] }, owner);
  assert.deepEqual(out.unmatched, []);
  assert.deepEqual(
    out.rules.map((r: { priority: number }) => r.priority),
    [10, 110],
  );
  assert.match(out.lines[1], /Priority 110: after your refuse and hold rules \(highest priority 100\), so it never skips them\.$/);
});

test("rule_compose: apps come from the catalog; a rule the writers refuse is unmatched, never proposed", async () => {
  const { owner } = await setup({ catalog: true });
  const ok = await run(OP.ruleCompose)({ text: "Agents in team X may not post in connect" }, owner);
  assert.deepEqual(ok.rules[0]?.match, { products: ["connect"], effects: ["outward"], callerTeams: ["tm_x"] });
  // Rules' own agent operations read and write; none moves money, so such a rule would never match: refused like every writer refuses it
  const refused = await run(OP.ruleCompose)({ text: "Block money in rules" }, owner);
  assert.deepEqual(refused.rules, []);
  assert.match(refused.unmatched[0]?.hint ?? "", /^This rule cannot be saved: app “rules” has no agent operation with effect money/);
  const unknown = await run(OP.ruleCompose)({ text: "Hold Hermez's sends" }, owner);
  assert.equal(unknown.unmatched[0]?.hint, "No agent named “Hermez”. Close names: Hermes.");
});

test("rule_compose_save → pending owner draft; draft_decide approves it (rules apply only then); the writer check refuses a bad rule", async () => {
  const { db, owner } = await setup();
  const text = "When someone from team X tags the CEO agent: only work-tagged memories, no money";
  const proposal = await run(OP.ruleCompose)({ text }, owner);
  await assert.rejects(run(OP.ruleComposeSave)({ text, rules: proposal.rules }, opCtx(db, { type: "agent", id: AGENT_A })), { code: "forbidden" });
  const saved = await run(OP.ruleComposeSave)({ text, rules: proposal.rules }, owner);
  assert.equal(saved.status, "pending");
  assert.match(saved.draftId, /^drf_/);
  assert.deepEqual(liveRules(db), [], "saved for approval: nothing applies yet (C84)");
  const [draft] = (await run(OP.draftsList)({}, owner)).drafts;
  assert.deepEqual(draft.source, { kind: "owner" });
  assert.deepEqual(draft.submittedBy, { type: "person", id: OWNER, name: "Martin" });
  assert.equal(draft.text, text);
  const decided = (await run(OP.draftDecide)({ id: saved.draftId, decision: "approve" }, owner)).draft;
  assert.equal(decided.status, "approved");
  assert.equal(liveRules(db).length, 2, "approved: both rules apply");
  // an agent's draft_status never sees the owner's draft
  await assert.rejects(run(OP.draftStatus)({ draftId: saved.draftId }, opCtx(db, { type: "agent", id: AGENT_A })), { code: "not_found" });
  // the same writer check as every writer
  const bad = { title: "x", active: true, priority: 10, match: {}, outcome: { decision: "deny", reason: "r" }, narrowing: { memoryTags: { anyOf: ["work"] } } };
  await assert.rejects(run(OP.ruleComposeSave)({ text: "x", rules: [bad] }, owner), { code: "input_invalid" });
});
