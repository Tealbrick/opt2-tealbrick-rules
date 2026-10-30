// The app on the SDK: manifest + kit + boot, person ops (rules with revisions, drafts approved once, preview,
// decisions), the agent ops (draft only; explain own calls only), and the Fleet read model sync.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { manifestDigest, validateManifest } from "@opt2-tealbrick/manifest";
import { defineApp, type OpContext, startApp } from "@opt2-tealbrick/miniapp-sdk";
import { MANIFEST_DIGEST, OP } from "#kit";
import { definition, handlers, manifest } from "../src/app.ts";
import { parseFeed, syncFleet } from "../src/fleet.ts";
import { fleetIndex, fleetState, fleetTeams, liveRules, recordDecision } from "../src/store.ts";
import { AGENT_A, AGENT_B, feed, migratedDb, NPUB, OWNER, opCtx, spec } from "./helpers.ts";

type Run = (input: unknown, ctx: OpContext) => Promise<any>;
const run = (id: keyof typeof handlers) => (handlers[id] as unknown as { run: Run }).run;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => resolve(typeof a === "object" && a ? a.port : 0));
    });
  });
}

test("manifest validates; hooks gate every product within the time limits", () => {
  const v = validateManifest(manifest);
  assert.equal(v.ok, true, v.ok ? "" : JSON.stringify(v.errors));
  const byId = Object.fromEntries((manifest.hooks ?? []).map((h) => [h.id, h]));
  assert.deepEqual(Object.keys(byId).sort(), ["rules_context", "rules_filter", "rules_gate"]);
  assert.deepEqual(byId.rules_gate.match, { products: ["*"] });
  assert.ok((byId.rules_gate.timeoutMs ?? 2000) <= 1000, "gate answers well under 2 s");
  assert.deepEqual(byId.rules_filter.match.effects, ["read"]);
  assert.deepEqual(manifest.companions?.map((c) => [c.product, c.operations]), [["fleet", ["directory_feed"]]]);
});

test("the generated kit matches the manifest and every operation and hook has exactly one handler", () => {
  assert.equal(MANIFEST_DIGEST, manifestDigest(manifest), "kit is stale: run node --run kit");
  const ids = manifest.operations.map((o) => o.id).sort();
  assert.deepEqual(Object.values(OP).sort(), ids);
  assert.deepEqual(Object.keys(handlers).sort(), ids);
  assert.deepEqual(Object.keys(definition.hooks ?? {}).sort(), (manifest.hooks ?? []).map((h) => h.id).sort());
  const agentOps = manifest.operations.filter((o) => o.audience === "agent").map((o) => o.id);
  assert.deepEqual(agentOps.sort(), ["draft_status", "floor_status", "rule_draft_submit", "rules_explain"], "rule editing is person-only");
});

test("boots on the SDK and serves the derived routes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rules-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const port = await freePort();
  const local = { ...manifest, runtime: { ...manifest.runtime, port } };
  const running = await startApp(defineApp({ ...definition, manifest: local }), { TB_DATA_DIR: dir, TB_STANDALONE: "1", TB_LOG_LEVEL: "error" });
  try {
    const base = `http://127.0.0.1:${port}`;
    const health = (await (await fetch(`${base}/tb/v1/health`)).json()) as { status: string; manifestDigest: string };
    assert.equal(health.status, "ok");
    assert.equal(health.manifestDigest, manifestDigest(local));
    const openapi = (await (await fetch(`${base}/tb/v1/openapi.json`)).json()) as { paths: Record<string, unknown> };
    for (const op of manifest.operations.filter((o) => o.audience === "agent")) assert.ok(Object.keys(openapi.paths).some((p) => p.endsWith(`/${op.id}`)), `openapi lists ${op.id}`);
    // hooks need a bridge call proof: an unsigned hook call is refused
    const hook = await fetch(`${base}/tb/v1/hooks/rules_gate`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.ok(hook.status >= 400);
  } finally {
    await running.stop();
  }
});

test("rules: create, update with revision check, history, delete keeps history; person only", async () => {
  const { db } = migratedDb();
  const owner = opCtx(db, { type: "person", id: OWNER });
  const created = (await run(OP.rulesSet)({ rule: spec({ title: "No money", match: { effects: ["money"] } }) }, owner)).rule;
  assert.match(created.id, /^rul_/);
  assert.equal(created.rev, 1);
  const updated = (await run(OP.rulesSet)({ id: created.id, expectedRev: 1, rule: spec({ title: "No money at all", match: { effects: ["money"] } }) }, owner)).rule;
  assert.equal(updated.rev, 2);
  await assert.rejects(run(OP.rulesSet)({ id: created.id, expectedRev: 1, rule: spec({}) }, owner), { code: "revision_conflict" });
  await assert.rejects(run(OP.rulesSet)({ rule: spec({ decision: "deny", narrowing: { memoryTags: { anyOf: ["w"] } } }) }, owner), { code: "input_invalid" });
  await assert.rejects(run(OP.rulesSet)({ rule: spec({ decision: "allow", narrowing: { memoryTags: { anyOf: [] } } }) }, owner), { code: "input_invalid", message: "narrowing.memoryTags.anyOf needs at least one tag" });
  await assert.rejects(run(OP.rulesSet)({ rule: spec({}) }, opCtx(db, { type: "agent", id: AGENT_A })), { code: "forbidden" });
  assert.equal(liveRules(db).length, 1);
  const del = await run(OP.rulesDelete)({ id: created.id, expectedRev: 2 }, owner);
  assert.equal(del.rev, 3);
  assert.equal(liveRules(db).length, 0, "deleted rules leave evaluation at once");
  const got = await run(OP.rulesGet)({ id: created.id }, owner);
  assert.equal(got.deleted, true);
  assert.deepEqual(
    got.revisions.map((r: { change: string }) => r.change),
    ["deleted", "updated", "created"],
  );
  assert.equal((await run(OP.rulesList)({}, owner)).rules.length, 0);
  assert.equal((await run(OP.rulesList)({ includeDeleted: true }, owner)).rules.length, 1);
});

test("English authoring: the agent submits a DRAFT only; the owner approves once; rules then apply", async () => {
  const { db } = migratedDb();
  const agent = opCtx(db, { type: "agent", id: AGENT_A, name: "Owner's agent", mode: "free" });
  const owner = opCtx(db, { type: "person", id: OWNER });
  const text = "When someone from team X tags you: only work topics, only work memories, nothing with money.";
  const sub = await run(OP.ruleDraftSubmit)({ text, rules: [spec({ title: "X money", match: { effects: ["money"], onBehalfOf: { teams: ["tm_x"] } }, decision: "deny", reason: "no money for team X" })] }, agent);
  assert.equal(sub.status, "pending");
  assert.equal(liveRules(db).length, 0, "a draft never applies by itself");
  const drafts = (await run(OP.draftsList)({ status: "pending" }, owner)).drafts;
  assert.equal(drafts[0].text, text);
  assert.equal(drafts[0].submittedBy.id, AGENT_A);
  await assert.rejects(run(OP.draftDecide)({ id: sub.draftId, decision: "approve" }, agent), { code: "forbidden" });
  const decided = (await run(OP.draftDecide)({ id: sub.draftId, decision: "approve" }, owner)).draft;
  assert.equal(decided.status, "approved");
  assert.equal(decided.ruleIds.length, 1);
  assert.equal(liveRules(db)[0]?.id, decided.ruleIds[0]);
  await assert.rejects(run(OP.draftDecide)({ id: sub.draftId, decision: "reject" }, owner), { code: "draft_decided" });
  const bad = run(OP.ruleDraftSubmit)({ text: "x", rules: [spec({ decision: "deny", narrowing: { memoryTags: { noneOf: ["a"] } } })] }, agent);
  await assert.rejects(bad, { code: "input_invalid" });
});

test("preview: dry run with an unsaved candidate and per-rule steps", async () => {
  const { db } = migratedDb();
  const owner = opCtx(db, { type: "person", id: OWNER });
  await run(OP.rulesSet)({ rule: spec({ title: "bound agents read only", priority: 5, match: { modes: ["bound"], effects: ["outward"] }, reason: "bound agents may not send" }) }, owner);
  const call = { caller: { type: "agent", id: AGENT_A, mode: "bound" }, target: { product: "connect", op: "buzz_dm", effect: "outward" } };
  const p = await run(OP.rulesPreview)({ call }, owner);
  assert.equal(p.decision, "deny");
  assert.equal(p.ruleTitle, "bound agents read only");
  const free = await run(OP.rulesPreview)({ call: { ...call, caller: { ...call.caller, mode: "free" } } }, owner);
  assert.equal(free.decision, "allow");
  const cand = await run(OP.rulesPreview)({ call, candidate: spec({ title: "candidate", priority: 1, decision: "hold", reason: "review" }) }, owner);
  assert.equal(cand.ruleId, "candidate");
  assert.equal(cand.answered, "hold", "spec 0.1.13: a hold rule holds");
  assert.equal(cand.steps.length, 2);
});

test("rules_explain: an agent sees only its own calls' decisions", async () => {
  const { db } = migratedDb();
  const f = (caller: string) => ({ caller: { type: "agent", id: caller, mode: "free" }, target: { product: "connect", op: "buzz_dm", effect: "outward" }, claim: null, claimVerified: false, claimTeams: [], claimTeamsAny: [], callerTeams: [], callerTeamsAny: [], claimTrusts: [], claimTrustActive: true, fleetAvailable: true, callerProduct: null });
  recordDecision(db, { callId: "cal_a", phase: "before", facts: f(AGENT_A), decision: "deny", answered: "deny", reason: "no", rule: { id: "rul_1", rev: 1, title: "t" }, durationUs: 10 });
  recordDecision(db, { callId: "cal_b", phase: "before", facts: f(AGENT_B), decision: "allow", answered: "allow", reason: "ok", rule: null, durationUs: 10 });
  const mine = await run(OP.rulesExplain)({}, opCtx(db, { type: "agent", id: AGENT_A }));
  assert.deepEqual(
    mine.decisions.map((d: { callId: string }) => d.callId),
    ["cal_a"],
  );
  assert.deepEqual((await run(OP.rulesExplain)({ callId: "cal_b" }, opCtx(db, { type: "agent", id: AGENT_A }))).decisions, []);
  const all = await run(OP.decisionsList)({}, opCtx(db, { type: "person", id: OWNER }));
  assert.equal(all.items.length, 2);
});

const DIRECTORY = feed({ revision: 7 });

test("Fleet read model: parse, departed contacts dropped, unchanged keeps, refusal empties, transient error keeps", async () => {
  const d = parseFeed(DIRECTORY);
  assert.equal(d.model.teams[0]?.keys.length, 9, "every member, incl. removed, departed and blocked (deny/hold rules)");
  assert.deepEqual(d.model.teams[0]?.activeKeys.sort(), [`agent:${AGENT_A}`, "contact:ct_anna", "handle:slack:U777", `handle:${NPUB}`].sort());
  const { db } = migratedDb();
  let answer: unknown = DIRECTORY;
  let fail: string | null = null;
  const inputs: unknown[] = [];
  const callApp = async (_p: string, _o: string, input: unknown) => {
    inputs.push(input);
    if (fail) throw Object.assign(new Error(fail), { code: fail });
    return { status: "ok" as const, output: answer };
  };
  await syncFleet(db, callApp);
  assert.deepEqual(inputs[0], { accept: ["agent_handles", "lifecycle"] }, "first read is a full one (with agent handles, C373 §3)");
  assert.deepEqual(fleetTeams(db).map((t) => t.id), ["tm_x", "tm_y"]);
  assert.deepEqual(fleetIndex(db).get("handle:slack:U777"), ["tm_x"]);
  answer = { v: 1, revision: 7, unchanged: true };
  await syncFleet(db, callApp);
  assert.deepEqual(inputs.at(-1), { accept: ["agent_handles", "lifecycle"], sinceRevision: 7 });
  assert.equal(fleetTeams(db).length, 2, "unchanged keeps the copy");
  fail = "bridge_unavailable";
  await syncFleet(db, callApp);
  assert.equal(fleetTeams(db).length, 2, "a transient error keeps the last copy");
  assert.match(String(fleetState(db).error), /bridge_unavailable/);
  fail = "not_granted";
  await syncFleet(db, callApp);
  assert.equal(fleetTeams(db).length, 0, "no Governance → teams are empty");
  const st = await run(OP.fleetStatus)({}, opCtx(db, { type: "person", id: OWNER }, callApp as unknown as OpContext["callApp"]));
  assert.equal(st.source, "none");
  assert.equal(st.available, false);
  assert.match(st.error, /^Governance not reachable: not_granted/);
});

test("background: onStart runs the Fleet read model with the app-initiated callApp (C85); agentsChanged refreshes; pending drafts count", async () => {
  const { db } = migratedDb();
  let calls = 0;
  const callApp = async () => {
    calls++;
    return { status: "ok" as const, output: DIRECTORY };
  };
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  // the sync yields between chunks: wait for its result, not for a fixed time (a loaded machine needs more than 20 ms)
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  };
  await definition.onStart?.({ db, log: quiet, callApp, statusChanged() {} } as never);
  await until(() => fleetIndex(db).has(`agent:${AGENT_A}`));
  assert.equal(calls, 1, "onStart syncs at once (then every 60 s)");
  assert.deepEqual(fleetIndex(db).get(`agent:${AGENT_A}`), ["tm_x"]);
  await definition.events?.agentsChanged?.([], { db, log: quiet, callApp, statusChanged() {} } as never);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 2, "a changed agent list refreshes the copy");
  assert.equal(await definition.pendingCount?.(db), 0);
  await run(OP.ruleDraftSubmit)({ text: "x", rules: [spec({})] }, opCtx(db, { type: "agent", id: AGENT_A }));
  assert.equal(await definition.pendingCount?.(db), 1, "a pending draft counts toward pendingHolds (TBD badge)");
});
