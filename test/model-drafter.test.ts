// The optional model drafter of the English box (C373 Q-A): it only helps draft. The parser runs first; the model is asked only
// when the parser could not read everything and the owner bound `utility` (else `reasoning`) on a bridge with cap
// `model_roles`. Its rules go through the same writer checks plus a known-names check; any failure falls back to the parser.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResolvedModelRole } from "@opt2-tealbrick/manifest";
import type { OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { OP } from "#kit";
import { definition, handlers, MODEL_DRAFT_NOTE, MODEL_FAILED_NOTE, MODEL_FEWER_NOTE } from "../src/app.ts";
import { namesProblem } from "../src/compose.ts";
import { syncFleet } from "../src/fleet.ts";
import { draftBinding, type FetchFn, modelDrafter, parseAnswer } from "../src/model-drafter.ts";
import { AGENT_A, AGENT_B, feed, migratedDb, OWNER, opCtx } from "./helpers.ts";

type Run = (input: unknown, ctx: OpContext) => Promise<any>;
const run = (id: keyof typeof handlers) => (handlers[id] as unknown as { run: Run }).run;
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const OPENAI: ResolvedModelRole = { role: "utility", provider: "openai", model: "gpt-test", baseUrl: null, key: "placeholder-not-a-key", dataPolicy: "standard", dims: null };
const rule = (over: Record<string, unknown> = {}) => ({ title: "Hold Hermes's sends", active: true, priority: 10, match: { agents: [AGENT_A], effects: ["outward"] }, outcome: { decision: "hold", reason: "The owner's rule" }, ...over });
const answer = (o: unknown) => JSON.stringify({ choices: [{ message: { content: `Here you go:\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\`` } }] });

test("draftBinding: no model_roles cap → none; an undeclared role is skipped; utility first, then reasoning; never throws", async () => {
  const warns: string[] = [];
  const warn = (_m: string, d: Record<string, string>) => warns.push(`${d.role}:${d.code}`);
  assert.equal(await draftBinding({ bridgeCaps: () => [], modelRole: async () => OPENAI }, warn), null);
  assert.equal(await draftBinding({}, warn), null);
  const reasoning = { ...OPENAI, role: "reasoning" as const };
  const asked: string[] = [];
  const got = await draftBinding(
    {
      bridgeCaps: () => ["model_roles"],
      modelRole: async (role) => {
        asked.push(role);
        if (role === "utility") throw Object.assign(new Error("undeclared"), { code: "role_undeclared" });
        return reasoning;
      },
    },
    warn,
  );
  assert.deepEqual(got, reasoning);
  assert.deepEqual(asked, ["utility", "reasoning"]);
  assert.deepEqual(warns, ["utility:role_undeclared"]);
  assert.equal(await draftBinding({ bridgeCaps: () => ["model_roles"], modelRole: async () => null }, warn), null);
});

test("modelDrafter talks to an OpenAI-compatible or the Anthropic API and parses the JSON answer; other providers refuse", async () => {
  const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    seen.push({ url, headers: init.headers, body: init.body });
    const text = url.endsWith("/v1/messages") ? JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ rules: [rule()], notes: ["n"], unmatched: [] }) }] }) : answer({ rules: [rule()], notes: [], unmatched: [{ text: "x", hint: "y" }] });
    return { ok: true, status: 200, text: async () => text };
  };
  const env = { agents: [{ id: AGENT_A, name: "Hermes" }], teams: [], apps: [], problem: () => "" };
  const a = await modelDrafter(OPENAI, { fetch: fetchFn }).draft("Hold Hermez's sends", env);
  assert.equal(seen[0]?.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(seen[0]?.headers.authorization, `Bearer ${OPENAI.key}`);
  assert.match(seen[0]?.body ?? "", /Hermes: agt_/, "the prompt lists the names with their ids");
  assert.equal(JSON.parse(seen[0]?.body ?? "{}").messages[1].content, "Hold Hermez's sends");
  assert.deepEqual(a, { rules: [rule()], notes: [], unmatched: [{ text: "x", hint: "y" }] });
  const b = await modelDrafter({ ...OPENAI, provider: "anthropic", baseUrl: "https://claude.test/" }, { fetch: fetchFn }).draft("t", env);
  assert.equal(seen[1]?.url, "https://claude.test/v1/messages");
  assert.equal(seen[1]?.headers["x-api-key"], OPENAI.key);
  assert.deepEqual(b.notes, ["n"]);
  await assert.rejects(modelDrafter({ ...OPENAI, provider: "google" }, { fetch: fetchFn }).draft("t", env), /not supported for drafting/);
  await assert.rejects(modelDrafter(OPENAI, { fetch: async () => ({ ok: false, status: 429, text: async () => "" }) }).draft("t", env), /HTTP 429/);
  assert.throws(() => parseAnswer("no json here"));
  assert.throws(() => parseAnswer('{"notes": []}'), /no rules list/);
});

test("namesProblem: a rule about an agent, team or app the owner's directory does not list is refused", () => {
  const env = { agents: [{ id: AGENT_A, name: "Hermes" }], teams: [{ id: "tm_x", name: "Team X" }], apps: [{ id: "connect" }] };
  assert.equal(namesProblem(rule() as never, env), "");
  assert.match(namesProblem(rule({ match: { agents: [AGENT_B] } }) as never, env), /agent Rules does not know/);
  assert.match(namesProblem(rule({ match: { onBehalfOf: { teams: ["tm_zz"] } } }) as never, env), /team Rules does not know/);
  assert.match(namesProblem(rule({ match: { products: ["crm"] } }) as never, env), /app Rules does not know/);
});

async function setup(model: { binding?: ResolvedModelRole | null; caps?: string[] } = {}) {
  const { db } = migratedDb();
  const callApp = (async () => ({ status: "ok" as const, output: feed() })) as unknown as OpContext["callApp"];
  await definition.events?.agentsChanged?.([{ id: AGENT_A, name: "Hermes", mode: "free", status: "active" }] as never, { db, log: quiet, callApp, statusChanged() {} } as never);
  await syncFleet(db, callApp as never);
  const ctx = opCtx(db, { type: "person", id: OWNER }, callApp) as OpContext & { bridgeCaps?: () => string[] };
  Object.assign(ctx, { bridgeCaps: () => model.caps ?? ["model_roles"], modelRole: async () => model.binding ?? null });
  return ctx;
}

async function withFetch<T>(fn: FetchFn, body: () => Promise<T>): Promise<{ out: T; calls: number }> {
  const saved = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (url: string, init: Parameters<FetchFn>[1]) => {
    calls++;
    return fn(url, init);
  }) as unknown as typeof fetch;
  try {
    return { out: await body(), calls };
  } finally {
    globalThis.fetch = saved;
  }
}

test("rule_compose: the parser reads it all → no model call; else the bound model drafts and its rules are vetted the same way", async () => {
  const ctx = await setup({ binding: OPENAI });
  const ok = (o: unknown): FetchFn => async () => ({ ok: true, status: 200, text: async () => answer(o) });
  const clean = await withFetch(ok({ rules: [] }), () => run(OP.ruleCompose)({ text: "Hold Hermes's outward actions" }, ctx));
  assert.equal(clean.calls, 0, "the parser read everything: the model is not asked");
  assert.equal(clean.out.drafter, "parser");

  const bad = rule({ title: "bad narrowing", outcome: { decision: "deny", reason: "r" }, narrowing: { memoryTags: { anyOf: ["work"] } } });
  const stranger = rule({ title: "stranger", match: { agents: [AGENT_B] } });
  const notASpec = { title: "no match" };
  const drafted = await withFetch(ok({ rules: [rule(), bad, stranger, notASpec], notes: ["read “Hermez” as Hermes"], unmatched: [] }), () => run(OP.ruleCompose)({ text: "Hold Hermez's sends" }, ctx));
  assert.equal(drafted.calls, 1);
  assert.equal(drafted.out.drafter, "model");
  assert.deepEqual(drafted.out.rules, [rule()], "only the rule that passes every check");
  assert.deepEqual(drafted.out.notes, [MODEL_DRAFT_NOTE, "read “Hermez” as Hermes"]);
  const hints = drafted.out.unmatched.map((u: { text: string; hint: string }) => `${u.text}: ${u.hint}`).join("\n");
  assert.match(hints, /bad narrowing: This rule cannot be saved: narrowing applies only to rules that allow/);
  assert.match(hints, /stranger: This rule cannot be saved: it names an agent Rules does not know/);
  assert.match(hints, /no match: This rule cannot be saved: the rule does not fit the rule schema/);
  assert.doesNotMatch(JSON.stringify(drafted.out), /placeholder-not-a-key/, "the key never leaves");
});

test("rule_compose: model failure, a worse draft, no cap or no binding → the parser's reading", async () => {
  const text = "Block money for all agents. Hold Hermez's sends";
  const failed = await withFetch(async () => ({ ok: false, status: 500, text: async () => "" }), async () => run(OP.ruleCompose)({ text }, await setup({ binding: OPENAI })));
  assert.equal(failed.out.drafter, "parser");
  assert.equal(failed.out.rules.length, 1, "the parser's rule stays");
  assert.ok(failed.out.notes.includes(MODEL_FAILED_NOTE));
  const fewer = await withFetch(async () => ({ ok: true, status: 200, text: async () => answer({ rules: [] }) }), async () => run(OP.ruleCompose)({ text }, await setup({ binding: OPENAI })));
  assert.equal(fewer.out.drafter, "parser");
  assert.ok(fewer.out.notes.includes(MODEL_FEWER_NOTE));
  for (const model of [{ binding: OPENAI, caps: [] }, { binding: null }]) {
    const r = await withFetch(async () => ({ ok: true, status: 200, text: async () => answer({ rules: [rule()] }) }), async () => run(OP.ruleCompose)({ text }, await setup(model)));
    assert.equal(r.calls, 0);
    assert.equal(r.out.drafter, "parser");
  }
});
