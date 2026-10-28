// C374 Access page (src/ui/access-model.ts): an access setting per agent or app becomes ordinary rules. Every built rule is a valid
// rules_set input and passes the writer against a catalog with operations; through the engine the set decides each effect,
// app and tool as the setting says; the setting reads back from the stored rules; the exemptions it repeats match src/mode.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateInput } from "@opt2-tealbrick/manifest";
import type { OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { OP } from "#kit";
import { handlers, manifest } from "../src/app.ts";
import { type CallFacts, evaluate } from "../src/engine.ts";
import { EXEMPTIONS } from "../src/mode.ts";
import { liveRules } from "../src/store.ts";
import { type AccessCatalog, type AccessSetting, accessOf, accessSpecs, type Caller, INBOX_OWNER_DM, isEdited, RULES_SELF_SERVICE, readMark, settingProblem } from "../src/ui/access-model.ts";
import type { RuleRow } from "../src/ui/api.ts";
import { AGENT_A, AGENT_B, APP_INSTANCE, migratedDb, OWNER, opCtx } from "./helpers.ts";

type Run = (input: unknown, ctx: OpContext) => Promise<any>;
const run = (id: keyof typeof handlers) => (handlers[id] as unknown as { run: Run }).run;
const rulesSet = manifest.operations.find((o) => o.id === "rules_set") as never;
type Db = ReturnType<typeof migratedDb>["db"];

const CATALOG: Record<string, { id: string; effect?: string; dynamic?: boolean }[]> = {
  rules: [{ id: "rules_explain" }, { id: "rule_draft_submit", effect: "write" }, { id: "draft_status" }],
  connect: [{ id: "buzz_dm", effect: "outward" }, { id: "buzz_dm_first", effect: "outward" }, { id: "channel_dm", effect: "outward" }, { id: "channel_dm_first", effect: "outward" }, { id: "tools", effect: "write", dynamic: true }],
  kanban: [{ id: "issue_list" }, { id: "issue_create", effect: "write" }, { id: "issue_delete", effect: "destructive" }],
  "sample-pay": [{ id: "charge", effect: "money" }],
  inbox: [{ id: "items_list" }],
  evolution: [{ id: "run_now", effect: "write" }],
};
const CAT: AccessCatalog = { productIds: Object.keys(CATALOG).sort(), dynamicOps: ["connect.tools"] };

function seeded(): Db {
  const { db } = migratedDb();
  const digests: string[] = [];
  for (const [product, ops] of Object.entries(CATALOG)) {
    const summary = ops.map((o) => ({ id: o.id, title: o.id, effect: o.effect ?? "read", audience: "agent", dynamic: !!o.dynamic, tools: [] }));
    db.prepare("INSERT INTO catalog_manifests (digest, product, version, published_at, ops) VALUES (?, ?, '1.0.0', '2026-10-13T00:00:00.000Z', ?)").run(`sha256:${product}`, product, JSON.stringify(summary));
    digests.push(`sha256:${product}`);
  }
  db.prepare("UPDATE catalog_sync SET generated_at = '2026-10-13T12:00:00.000Z', synced_at = ?, attempted_at = ?, digests = ?, error = NULL WHERE id = 1").run(Date.now(), Date.now(), JSON.stringify(digests));
  return db;
}

const JARVIS: Caller = { type: "agent", id: AGENT_A, name: "Jarvis" };
const EVOLUTION: Caller = { type: "app", product: "evolution", name: "evolution" };
const INBOX: Caller = { type: "app", product: "inbox", name: "inbox" };

const facts = (o: { app?: string; agent?: string; product: string; op: string; effect: string; tool?: string; dynamic?: boolean }): CallFacts =>
  ({
    caller: o.app ? { type: "app", id: APP_INSTANCE, mode: null } : { type: "agent", id: o.agent ?? AGENT_A, mode: "free" },
    callerProduct: o.app ?? null,
    target: { product: o.product, op: o.op, effect: o.effect, ...(o.tool ? { tool: o.tool } : {}), dynamic: o.dynamic ?? false },
    claim: null,
    claimVerified: false,
    claimTeams: [],
    claimTeamsAny: [],
    callerTeams: [],
    callerTeamsAny: [],
    claimTrusts: [],
    claimTrustActive: true,
    fleetAvailable: true,
  }) as CallFacts;

async function save(db: Db, caller: Caller, s: AccessSetting): Promise<void> {
  for (const rule of accessSpecs(caller, s, CAT)) {
    const v = validateInput(rulesSet, { rule } as never);
    assert.equal(v.ok, true, `${rule.title}: ${JSON.stringify(v)}`);
    await run(OP.rulesSet)({ rule }, opCtx(db, { type: "person", id: OWNER }));
  }
}
const decide = (db: Db, calls: CallFacts[], mode: "permissive" | "verification" | "closed" = "permissive") => calls.map((f) => evaluate(liveRules(db), f, mode).decision);

test("level Read and change, beyond = hold: read and write run, outward/money/destructive wait; other agents untouched; every mode alike", async () => {
  const db = seeded();
  await save(db, JARVIS, { level: 2, beyond: "hold" });
  const calls = [
    facts({ product: "kanban", op: "issue_list", effect: "read" }),
    facts({ product: "kanban", op: "issue_create", effect: "write" }),
    facts({ product: "connect", op: "buzz_dm", effect: "outward" }),
    facts({ product: "sample-pay", op: "charge", effect: "money" }),
    facts({ product: "kanban", op: "issue_delete", effect: "destructive" }),
  ];
  for (const mode of ["permissive", "verification", "closed"] as const) assert.deepEqual(decide(db, calls, mode), ["allow", "allow", "hold", "hold", "hold"], mode);
  assert.deepEqual(decide(db, [facts({ agent: AGENT_B, product: "connect", op: "buzz_dm", effect: "outward" })], "closed"), ["deny"], "another agent: the mode decides");
  // Rules' own agent ops always run, even at level Nothing
  const db0 = seeded();
  await save(db0, JARVIS, { level: 0, beyond: "deny" });
  assert.deepEqual(decide(db0, [facts({ product: "rules", op: "rule_draft_submit", effect: "write" }), facts({ product: "kanban", op: "issue_list", effect: "read" })]), ["allow", "deny"]);
});

test("only these apps: other apps are refused (before the beyond hold), picked apps follow the level", async () => {
  const db = seeded();
  await save(db, JARVIS, { level: 1, beyond: "hold", apps: ["kanban"] });
  assert.deepEqual(
    decide(db, [
      facts({ product: "kanban", op: "issue_list", effect: "read" }),
      facts({ product: "kanban", op: "issue_create", effect: "write" }),
      facts({ product: "connect", op: "buzz_dm", effect: "outward" }),
      facts({ product: "sample-pay", op: "charge", effect: "money" }),
      facts({ product: "rules", op: "rules_explain", effect: "read" }),
    ]),
    ["allow", "hold", "deny", "deny", "allow"],
  );
});

test("only these tools: a picked tool within the level runs, beyond the level waits, any other tool (or no tool) is refused; static ops follow the level", async () => {
  const db = seeded();
  await save(db, JARVIS, { level: 2, beyond: "hold", apps: ["connect", "kanban"], tools: ["gmail_read", "gmail_send"] });
  assert.deepEqual(
    decide(db, [
      facts({ product: "connect", op: "tools", effect: "read", tool: "gmail_read", dynamic: true }),
      facts({ product: "connect", op: "tools", effect: "outward", tool: "gmail_send", dynamic: true }),
      facts({ product: "connect", op: "tools", effect: "outward", tool: "gmail_send__first_contact", dynamic: true }),
      facts({ product: "connect", op: "tools", effect: "read", tool: "drive_list", dynamic: true }),
      facts({ product: "connect", op: "tools", effect: "read", dynamic: true }),
      facts({ product: "connect", op: "buzz_dm", effect: "outward" }),
      facts({ product: "kanban", op: "issue_create", effect: "write" }),
    ]),
    ["allow", "hold", "hold", "deny", "deny", "hold", "allow"],
  );
});

test("an app caller: Evolving Workflows at Read and change, refuse beyond; agents never match; Inbox keeps its owner DMs", async () => {
  const db = seeded();
  await save(db, EVOLUTION, { level: 2, beyond: "deny" });
  assert.deepEqual(
    decide(db, [
      facts({ app: "evolution", product: "kanban", op: "issue_create", effect: "write" }),
      facts({ app: "evolution", product: "connect", op: "buzz_dm", effect: "outward" }),
      facts({ product: "connect", op: "buzz_dm", effect: "outward" }),
    ]),
    ["allow", "deny", "allow"],
  );
  await save(db, INBOX, { level: 1, beyond: "hold" });
  assert.deepEqual(decide(db, [facts({ app: "inbox", product: "connect", op: "buzz_dm_first", effect: "outward" }), facts({ app: "inbox", product: "kanban", op: "issue_create", effect: "write" })]), ["allow", "hold"]);
});

test("the setting reads back from the stored rules; a hand edit is seen; the repeated exemptions equal src/mode.ts", async () => {
  const db = seeded();
  const s: AccessSetting = { level: 3, beyond: "hold", apps: ["connect", "kanban"], tools: ["gmail_send"] };
  await save(db, JARVIS, s);
  const rows = (await run(OP.rulesList)({}, opCtx(db, { type: "person", id: OWNER }))).rules as RuleRow[];
  const found = accessOf(rows).get(`agent:${AGENT_A}`);
  assert.ok(found);
  assert.deepEqual(found.setting, s);
  assert.equal(found.rules.length, rows.length);
  assert.equal(isEdited(JARVIS, found, CAT), false);
  const first = found.rules[0] as RuleRow;
  assert.equal(isEdited(JARVIS, { ...found, rules: [{ ...first, spec: { ...first.spec, outcome: { ...first.spec.outcome, decision: "deny" } } }, ...found.rules.slice(1)] }, CAT), true);
  assert.equal(readMark({ description: "a normal rule" }), null);
  const text = EXEMPTIONS.map((e) => e.text).join(" ");
  for (const op of [...INBOX_OWNER_DM, ...RULES_SELF_SERVICE]) assert.match(text, new RegExp(op));
});

test("settingProblem: no apps, an unknown app, bad or too many tools, tools without a tool app, an app naming itself", () => {
  assert.match(settingProblem({ level: 2, beyond: "hold", apps: [] }, JARVIS, CAT), /at least one app/);
  assert.match(settingProblem({ level: 2, beyond: "hold", apps: ["nope"] }, JARVIS, CAT), /no app/);
  assert.match(settingProblem({ level: 2, beyond: "hold", tools: ["Bad Tool"] }, JARVIS, CAT), /no tool name/);
  assert.match(settingProblem({ level: 2, beyond: "hold", tools: ["a__b"] }, JARVIS, CAT), /no tool name/);
  assert.match(settingProblem({ level: 2, beyond: "hold", tools: Array.from({ length: 21 }, (_, i) => `t${i}x`) }, JARVIS, CAT), /At most/);
  assert.match(settingProblem({ level: 2, beyond: "hold", apps: ["kanban"], tools: ["gmail_send"] }, JARVIS, CAT), /limit nothing/);
  assert.match(settingProblem({ level: 0, beyond: "hold", tools: ["gmail_send"] }, JARVIS, CAT), /Nothing/);
  assert.match(settingProblem({ level: 2, beyond: "hold", apps: ["evolution"] }, EVOLUTION, CAT), /itself/);
  assert.equal(settingProblem({ level: 5, beyond: "deny" }, JARVIS, CAT), "");
  assert.throws(() => accessSpecs(JARVIS, { level: 2, beyond: "hold", apps: [] }, CAT));
  // a long agent name stays inside the title and reason limits
  for (const rule of accessSpecs({ ...JARVIS, name: "x".repeat(300) }, { level: 3, beyond: "hold", apps: ["connect"], tools: ["gmail_send"] }, CAT)) assert.equal(validateInput(rulesSet, { rule } as never).ok, true);
});
