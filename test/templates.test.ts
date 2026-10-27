// Q-9 (C373): the starter rule templates. Each one is a valid rules_set input (manifest schema), passes the writer, and
// through the engine decides exactly the call it is meant for (and not its neighbours). Nothing is created by a template.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateInput } from "@opt2-tealbrick/manifest";
import type { OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { OP } from "#kit";
import { handlers, manifest } from "../src/app.ts";
import { type CallFacts, evaluate } from "../src/engine.ts";
import { liveRules } from "../src/store.ts";
import { TEMPLATES, templateSpec } from "../src/ui/templates.ts";
import { AGENT_A, AGENT_B, APP_INSTANCE, migratedDb, OWNER, opCtx, seedCatalog } from "./helpers.ts";

type Run = (input: unknown, ctx: OpContext) => Promise<any>;
const run = (id: keyof typeof handlers) => (handlers[id] as unknown as { run: Run }).run;
const rulesSet = manifest.operations.find((o) => o.id === "rules_set") as never;

const facts = (o: { caller?: string; mode?: "free" | "bound"; effect: string; teams?: string[]; fleetAvailable?: boolean; app?: string | null }): CallFacts => ({
  caller: o.app !== undefined ? { type: "app", id: APP_INSTANCE, mode: null } : { type: "agent", id: o.caller ?? AGENT_A, mode: o.mode ?? "free" },
  callerProduct: o.app ?? null,
  target: { product: "connect", op: "buzz_dm", effect: o.effect },
  claim: null,
  claimVerified: false,
  claimTeams: [],
  claimTeamsAny: [],
  callerTeams: o.teams ?? [],
  callerTeamsAny: o.teams ?? [],
  claimTrusts: [],
  claimTrustActive: true,
  fleetAvailable: o.fleetAvailable ?? true,
});

const AGENT = { id: AGENT_A, name: "Henry" };
const TEAM = { id: "tm_x", name: "Team X" };
const APP = { id: "knowledge", name: "knowledge" };
const argFor = (id: (typeof TEMPLATES)[number]["id"]) => (id === "hold-agent-outward" ? AGENT : id === "hold-team-outward" ? TEAM : id === "hold-app-outward" ? APP : undefined);
/** A migrated database whose app catalog lists the calling app (callerProducts is checked against the catalog, C237 S2). */
const dbWithCatalog = () => {
  const { db } = migratedDb();
  return seedCatalog(db, ["knowledge"]);
};

/** Save one template with the writer and return the decision the gate would give for `f`. */
async function decide(id: (typeof TEMPLATES)[number]["id"], calls: CallFacts[]): Promise<string[]> {
  const db = dbWithCatalog();
  await run(OP.rulesSet)({ rule: templateSpec(id, argFor(id)) }, opCtx(db, { type: "person", id: OWNER }));
  return calls.map((f) => evaluate(liveRules(db), f).decision);
}

test("the five templates, their parameters, and the exact specs", () => {
  assert.deepEqual(
    TEMPLATES.map((t) => [t.id, t.param ?? null]),
    [
      ["hold-agent-outward", "agent"],
      ["hold-money", null],
      ["deny-bound-destructive", null],
      ["hold-team-outward", "team"],
      ["hold-app-outward", "app"],
    ],
  );
  const a = templateSpec("hold-agent-outward", AGENT);
  assert.deepEqual(a.match, { agents: [AGENT_A], effects: ["outward"] });
  assert.deepEqual(a.outcome, { decision: "hold", reason: "Henry: outward actions wait for you" });
  assert.deepEqual(templateSpec("hold-money").match, { effects: ["money"] });
  assert.equal(templateSpec("hold-money").outcome.decision, "hold");
  assert.deepEqual(templateSpec("deny-bound-destructive").match, { modes: ["bound"], effects: ["destructive"] });
  assert.equal(templateSpec("deny-bound-destructive").outcome.decision, "deny");
  assert.deepEqual(templateSpec("hold-team-outward", TEAM).match, { callerTeams: ["tm_x"], effects: ["outward"] });
  assert.throws(() => templateSpec("hold-agent-outward"), /needs an agent/);
  assert.throws(() => templateSpec("hold-team-outward"), /needs a team/);
  assert.deepEqual(templateSpec("hold-app-outward", APP).match, { callerProducts: ["knowledge"], effects: ["outward"] });
  assert.throws(() => templateSpec("hold-app-outward"), /needs an app/);
});

test("every template is a valid rules_set input and passes the writer; a long name stays inside the limits", async () => {
  for (const t of TEMPLATES) {
    const rule = templateSpec(t.id, argFor(t.id));
    const v = validateInput(rulesSet, { rule } as never);
    assert.equal(v.ok, true, `${t.id}: ${JSON.stringify(v)}`);
    const db = dbWithCatalog();
    const saved = (await run(OP.rulesSet)({ rule }, opCtx(db, { type: "person", id: OWNER }))).rule;
    assert.equal(saved.rev, 1, t.id);
    assert.equal(saved.spec.active, true);
  }
  const long = templateSpec("hold-agent-outward", { id: AGENT_A, name: "x".repeat(400) });
  assert.equal(validateInput(rulesSet, { rule: long } as never).ok, true, "title ≤ 120 and reason ≤ 280");
});

test("engine: hold an agent's outward actions holds that agent's outward calls only", async () => {
  assert.deepEqual(await decide("hold-agent-outward", [facts({ effect: "outward" }), facts({ effect: "write" }), facts({ caller: AGENT_B, effect: "outward" })]), ["hold", "allow", "allow"]);
});

test("engine: hold all money actions holds every agent's money calls only", async () => {
  assert.deepEqual(await decide("hold-money", [facts({ effect: "money" }), facts({ caller: AGENT_B, mode: "bound", effect: "money" }), facts({ effect: "outward" })]), ["hold", "hold", "allow"]);
});

test("engine: block destructive actions for bound agents refuses bound destructive calls only", async () => {
  assert.deepEqual(await decide("deny-bound-destructive", [facts({ mode: "bound", effect: "destructive" }), facts({ mode: "free", effect: "destructive" }), facts({ mode: "bound", effect: "write" })]), [
    "deny",
    "allow",
    "allow",
  ]);
});

test("engine: hold outward actions of a team holds members' outward calls; fails closed while Governance is unavailable", async () => {
  assert.deepEqual(
    await decide("hold-team-outward", [facts({ effect: "outward", teams: ["tm_x"] }), facts({ effect: "outward", teams: ["tm_y"] }), facts({ effect: "money", teams: ["tm_x"] }), facts({ effect: "outward", fleetAvailable: false })]),
    ["hold", "allow", "allow", "hold"],
  );
});

test("engine: hold an app's outward actions holds outward calls of that verified product only, never an agent's", async () => {
  assert.deepEqual(
    await decide("hold-app-outward", [facts({ app: "knowledge", effect: "outward" }), facts({ app: "notes", effect: "outward" }), facts({ app: "knowledge", effect: "read" }), facts({ effect: "outward" }), facts({ app: null, effect: "outward" })]),
    ["hold", "allow", "allow", "allow", "hold"],
    "an app without a verified product fails closed (C237)",
  );
});

test("writer: the app template names a product of the app catalog; an unknown app is refused like in any rule", async () => {
  const { db } = migratedDb();
  seedCatalog(db, ["notes"]);
  await assert.rejects(run(OP.rulesSet)({ rule: templateSpec("hold-app-outward", APP) }, opCtx(db, { type: "person", id: OWNER })), { code: "input_invalid" });
});
