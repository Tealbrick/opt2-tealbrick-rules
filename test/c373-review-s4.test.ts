// Review 0.5.0 S4 (cheap hardening): handles never in the Governance sync error (S4-3), the Inbox exemption is exactly the four
// owner-DM ops of the VERIFIED product inbox (S4-2 scope lock). The tool-name (S4-1), trace (S4-3) and log (S4-4) items have their
// tests next to the code they changed (c336-dataset-narrowing, hooks, c373-review-s3-4).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CallFacts } from "../src/engine.ts";
import { syncFleet } from "../src/fleet.ts";
import { exemptionOf } from "../src/mode.ts";
import { fleetState } from "../src/store.ts";
import { feed, migratedDb } from "./helpers.ts";

test("S4-3: a feed with a non-canonical handle is refused and the stored error names the contact, never the handle", async () => {
  const { db } = migratedDb();
  // fits the schema pattern, but the bech32 checksum is wrong, so normalizeHandle refuses it
  const handle = `buzz:npub1${"q".repeat(58)}`;
  const bad = feed({ contacts: [{ id: "ct_anna", kind: "person", status: "active", trust: "trusted", handles: [handle] }] });
  await syncFleet(db, async () => ({ status: "ok" as const, output: bad }));
  const err = fleetState(db).error ?? "";
  assert.match(err, /a handle of contact ct_anna is not canonical/);
  assert.equal(err.includes("npub1"), false);
});

const facts = (caller: CallFacts["caller"], callerProduct: string | null, product: string, op: string): CallFacts => ({
  caller,
  target: { product, op, effect: "outward" },
  claim: null,
  claimVerified: false,
  claimTeams: [],
  claimTeamsAny: [],
  callerTeams: [],
  callerTeamsAny: [],
  claimTrusts: [],
  claimTrustActive: true,
  fleetAvailable: true,
  callerProduct,
});

test("S4-2: the Inbox exemption covers exactly the four owner-DM ops of Connect, for an app whose VERIFIED product is inbox", () => {
  const app = { type: "app", id: "ins_01J0000000000000000000INBX", mode: null };
  for (const op of ["buzz_dm", "buzz_dm_first", "channel_dm", "channel_dm_first"]) assert.equal(exemptionOf(facts(app, "inbox", "connect", op)), "inbox-owner-alerts", op);
  for (const op of ["buzz_post", "channel_post", "gmail_send", "buzz_dm_bulk"]) assert.equal(exemptionOf(facts(app, "inbox", "connect", op)), null, op);
  assert.equal(exemptionOf(facts(app, null, "connect", "buzz_dm")), null, "no verified product");
  assert.equal(exemptionOf(facts(app, "kanban", "connect", "buzz_dm")), null, "another product");
  assert.equal(exemptionOf(facts(app, "inbox", "knowledge", "buzz_dm")), null, "another target app");
  assert.equal(exemptionOf(facts({ type: "agent", id: "agt_01J0000000000000000000000A", mode: "free" }, "inbox", "connect", "buzz_dm")), null, "an agent");
});
