// C380 A29, found live by QA: the bridge sends no `target.recipients`, so every floor test that set it proved nothing about a real call. These requests have the
// shape the bridge really sends (bridge calls.ts: target without recipients, `input` as the op gets it).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Db, HookContext, HookRequest, Json } from "@opt2-tealbrick/miniapp-sdk";
import { type CallApp, syncFleet } from "../src/fleet.ts";
import { FLOOR_REASON } from "../src/floor.ts";
import { CONNECT_TOOL_RECIPIENT_KEYS, connectInputRecipients, FLOOR_INPUT_VALUES_MAX, makeHooks, recipientsOf } from "../src/hooks.ts";
import { listDecisions } from "../src/store.ts";
import { AGENT_B, cpuNowMs, feed, hookCtx, hookReq, migratedDb, NPUB } from "./helpers.ts";

const hooks = makeHooks("rules") as unknown as Record<string, (r: HookRequest, c: HookContext) => Promise<{ allow: boolean; reason?: string }>>;
const HEX = "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e";
const answer = (out: unknown): CallApp => async () => ({ status: "ok", output: out });

async function firedPerson(): Promise<Db> {
  const { db } = migratedDb();
  await syncFleet(
    db,
    answer(
      feed({
        teams: [],
        contacts: [
          { id: "ct_left", kind: "person", status: "departed", trust: "trusted", handles: [NPUB, "slack:U666", "telegram:111"], lifecycle: "leaving", floor: true },
          { id: "ct_anna", kind: "person", status: "active", trust: "trusted", handles: ["slack:U777", "telegram:222"], lifecycle: "active", floor: false },
        ],
        agents: [{ id: AGENT_B, status: "active", trust: "trusted", owner: "ct_anna", lifecycle: "active", floor: false }],
      }),
    ),
  );
  return db;
}
const send = (db: Db, op: string, input: Record<string, Json>, tool?: string, o: Parameters<typeof hookReq>[1] = { caller: AGENT_B }) => (hooks.rules_gate as NonNullable<(typeof hooks)["rules_gate"]>)(hookReq("before", { product: "connect", op, effect: "outward", input, ...(tool ? { tool } : {}), ...o }), hookCtx(db));
const refused = (a: { allow: boolean; reason?: string }) => a.allow === false && a.reason === FLOOR_REASON;

test("A29: agent B's Buzz DM to the fired person is refused, first contact too, by any spelling Connect accepts; a DM to anyone else runs", async () => {
  const db = await firedPerson();
  for (const op of ["buzz_dm", "buzz_dm_first"]) {
    assert.ok(refused(await send(db, op, { to: NPUB.slice("buzz:".length), content: "the list" })), `${op} npub`);
    assert.ok(refused(await send(db, op, { to: ` ${NPUB.slice("buzz:".length)} `, content: "x" })), `${op} spaces`);
    assert.equal((await send(db, op, { to: HEX, content: "x" })).allow, true, "another key");
  }
  const row = listDecisions(db, { limit: 1, decision: "deny" }).items[0];
  assert.match(row?.reason ?? "", /a recipient is marked as leaving/);
  assert.ok(!JSON.stringify(row).includes("npub"), "a handle never enters a trace");
});

test("A29: the same key as 64 hex is the same person (Connect accepts hex)", async () => {
  const { db } = migratedDb();
  const hexHandle = connectInputRecipients({ product: "connect", op: "buzz_dm" }, { to: HEX })[0] as string;
  assert.match(hexHandle, /^buzz:npub1/);
  await syncFleet(db, answer(feed({ teams: [], agents: [], contacts: [{ id: "c", kind: "person", status: "departed", trust: "trusted", handles: [hexHandle], lifecycle: "leaving", floor: true }] })));
  for (const to of [HEX, HEX.toUpperCase()]) assert.ok(refused(await send(db, "buzz_dm", { to, content: "x" })), to);
});

test("channel ops: person and conversation, with the spellings Connect's bar reads (case, leading zero, space, number); others run", async () => {
  const db = await firedPerson();
  for (const person of ["U666", "u666", " U666", "111", "0111", "00111"]) assert.ok(refused(await send(db, "channel_dm_first", { account: "a", person, text: "x" })), person);
  assert.ok(refused(await send(db, "channel_dm", { person: "111", text: "x" })));
  assert.ok(refused(await send(db, "channel_send", { conversation: "111", text: "x" })));
  assert.equal((await send(db, "channel_dm", { person: "U777", text: "x" })).allow, true);
  assert.equal((await send(db, "channel_send", { conversation: "C0123", text: "x" })).allow, true, "a group: Connect's bar decides");
});

test("connected tools: the arguments that name a chat person, as a string, a number or a list; only a call with a tool reads them", async () => {
  const db = await firedPerson();
  assert.ok(refused(await send(db, "tools", { arguments: { channel: "U666", text: "x" } }, "slack_send_message")));
  assert.ok(refused(await send(db, "tools", { arguments: { channel_id: "u666" } }, "slack_chat_post_message__first_contact")));
  assert.ok(refused(await send(db, "tools", { arguments: { user: "U666" } }, "slack_send_ephemeral_message")));
  assert.ok(refused(await send(db, "tools", { arguments: { chat_id: 111 } }, "telegram_send_message")), "a JSON number");
  assert.ok(refused(await send(db, "tools", { arguments: { users: "U777,U666" } }, "slack_open_conversation")), "a comma list");
  assert.ok(refused(await send(db, "tools", { arguments: { users: ["U777", "U666"] } }, "slack_open_conversation")), "an array");
  assert.equal((await send(db, "tools", { arguments: { chat_id: 222 } }, "telegram_send_message")).allow, true);
  assert.equal((await send(db, "tools", { arguments: { channel: "C0123" } }, "slack_send_message")).allow, true);
});

test("review: tool arguments are read the way Connect's first-contact gate reads them: key spelling, nesting, list separators; a read tool is not", async () => {
  const db = await firedPerson();
  for (const args of [{ user_id: "U666" }, { userId: "U666" }, { Channel: "U666" }, { chatId: 111 }, { to: "U666" }, { recipient: "U666" }, { to: { id: "U666" } }, { users: [["U666"]] }, { users: [{ id: "U666" }] }, { users: "U777;U666" }, { users: "U777\nU666" }] as Record<string, Json>[]) {
    assert.ok(refused(await send(db, "tools", { tool: "x_send", arguments: args }, "x_send")), JSON.stringify(args));
  }
  assert.equal((await send(db, "tools", { tool: "x_send", arguments: { text: "U666", limit: 111 } }, "x_send")).allow, true, "a body is not a recipient");
  assert.equal((await send(db, "tools", { tool: "slack_user_info", arguments: { user: "U666" } }, "slack_user_info", { caller: AGENT_B, effect: "read" })).allow, true, "a read tool answers no test of who is stopped");
});

test("N2-2 note: recipient keys at any depth (a catalog tool names body.to), never a body text", async () => {
  const db = await firedPerson();
  for (const args of [{ body: { to: "U666" } }, { body: { recipient: { id: "U666" } } }, { messages: [{ to: "U666" }] }, { a: { b: { chat_id: 111 } } }] as Record<string, Json>[]) assert.ok(refused(await send(db, "tools", { tool: "x_send", arguments: args }, "x_send")), JSON.stringify(args));
  assert.equal((await send(db, "tools", { tool: "x_send", arguments: { body: { text: "U666" } } }, "x_send")).allow, true);
});

test("review: channel_edit and channel_react by a person's conversation id; channel_reply names nobody here (Connect's bar)", async () => {
  const db = await firedPerson();
  assert.ok(refused(await send(db, "channel_edit", { conversation: "111", messageId: "m", text: "x" })));
  assert.ok(refused(await send(db, "channel_react", { conversation: "111", messageId: "m", emoji: "x" })));
  assert.equal((await send(db, "channel_reply", { account: "a", seq: 5, text: "x" })).allow, true, "stated limit");
});

test("review: too many values in one call are refused inside the time budget, only while the floor holds someone; an op named like an Object member does not throw", async () => {
  const db = await firedPerson();
  const big = "1,".repeat(1_000_000);
  const t0 = cpuNowMs();
  const a = await send(db, "buzz_dm", { to: big });
  assert.equal(a.allow, false);
  assert.ok(cpuNowMs() - t0 < 250, "bounded by the split limit (CPU time: the machine may be loaded)");
  const padded = [...Array.from({ length: FLOOR_INPUT_VALUES_MAX + 5 }, () => "U777"), "U666"];
  assert.equal((await send(db, "tools", { arguments: { users: padded } }, "x_send")).allow, false, "padding does not hide someone");
  const { db: none } = migratedDb();
  assert.equal((await send(none, "buzz_dm", { to: big })).allow, true, "an empty floor reads nothing");
  for (const op of ["constructor", "__proto__"]) assert.equal((await send(db, op, { to: "x" })).allow, true, op);
});

test("an app caller, an unknown op, another product, a malformed input: quiet, and none throws", async () => {
  const db = await firedPerson();
  assert.ok(refused(await send(db, "buzz_dm", { to: NPUB.slice("buzz:".length) }, undefined, { app: { product: "evolution" } })), "an app's send to them is refused too");
  assert.equal((await send(db, "buzz_read", { to: NPUB.slice("buzz:".length) })).allow, true, "not a send op");
  assert.equal((await (hooks.rules_gate as NonNullable<(typeof hooks)["rules_gate"]>)(hookReq("before", { caller: AGENT_B, product: "kanban", op: "buzz_dm", input: { to: NPUB.slice("buzz:".length) } }), hookCtx(db))).allow, true, "only Connect");
  for (const input of [{ to: 7 }, { to: {} }, { to: null }, { arguments: "x" }, {}] as Record<string, Json>[]) assert.equal((await send(db, "buzz_dm", input)).allow, true, JSON.stringify(input));
  assert.deepEqual(connectInputRecipients({ product: "connect", op: "buzz_dm" }, "not an object"), []);
});

test("recipient RULES do not read the input: they stay unknown (fail closed) until the bridge sends the list", () => {
  const req = hookReq("before", { product: "connect", op: "buzz_dm", input: { to: NPUB.slice("buzz:".length) } });
  assert.equal(recipientsOf(req.call.target), null);
});

test("drift: every field of the table exists on Connect's op, and every Connect DM op is in the table", () => {
  const m = JSON.parse(readFileSync(new URL("./fixtures/connect.manifest.0.7.14-dev.1.json", import.meta.url), "utf8")) as { operations: { id: string; effect?: string; input?: { properties?: Record<string, unknown> } }[] };
  const op = (id: string) => m.operations.find((o) => o.id === id);
  for (const [id, field] of [["buzz_dm", "to"], ["buzz_dm_first", "to"], ["channel_dm", "person"], ["channel_dm_first", "person"], ["channel_send", "conversation"]] as const) assert.ok(op(id)?.input?.properties?.[field], `${id}.${field}`);
  // a new op with a direct-message name must be read here first
  const dms = m.operations.filter((o) => /dm/.test(o.id)).map((o) => o.id).sort();
  assert.deepEqual(dms.filter((id) => !connectInputRecipients({ product: "connect", op: id }, { to: "U666", person: "U666" }).length), [], "a DM op the floor does not read");
  assert.ok(CONNECT_TOOL_RECIPIENT_KEYS.has("chatid"));
});
