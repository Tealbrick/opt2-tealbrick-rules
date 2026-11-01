// C383, audit hole 7: "in Verification, does a timer flood the owner with holds?" The table is every app-to-app call of the released apps (their manifests' `companions`), by who starts
// it. A call a timer starts must be exempt, or the caller must stop asking after one hold. A hold has no dedupe in the SDK, so a timer that keeps asking makes one hold per tick. The live window is in VERDICTS.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CallFacts } from "../src/engine.ts";
import { evaluate } from "../src/engine.ts";
import { EXEMPTIONS, exemptionOf } from "../src/mode.ts";
import { APP_INSTANCE, spec } from "./helpers.ts";

const facts = (callerProduct: string | null, product: string, op: string, forWork = false, effect = "read"): CallFacts => ({
  caller: { type: "app", id: APP_INSTANCE, mode: null },
  target: { product, op, effect },
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
  forWork,
});

/** Timers and pages of the released apps. `file` names the caller's code that makes the call. */
const PLUMBING: readonly [caller: string, product: string, op: string, why: string][] = [
  ["rules", "fleet", "directory_feed", "src/fleet.ts 60 s timer"],
  ["knowledge", "fleet", "directory_feed", "src/directory-feed.ts 60 s timer"],
  ["fleet", "connect", "identities_list", "src/agent-handles.ts timer"],
  ["fleet", "connect", "contacts_list", "src/contacts.ts page"],
  ["fleet", "connect", "access_list", "src/access/client.ts sweep"],
  ["fleet", "knowledge", "access_list", "src/access/client.ts sweep"],
  ["fleet", "kanban", "access_list", "src/access/client.ts sweep"],
  ["fleet", "evolution", "access_list", "src/access/client.ts sweep"],
  ["fleet", "rules", "floor_status", "src/access sweep"],
  ["fleet", "rules", "rule_draft_submit", "src/app.ts proposal timer"],
  ["fleet", "rules", "draft_status", "src/app.ts proposal timer"],
  ["fleet", "inbox", "inbox_ask", "stop request alert"],
  ["inbox", "connect", "buzz_dm", "src/alerts.ts retry timer"],
  ["inbox", "connect", "buzz_dm_first", "src/alerts.ts"],
  ["inbox", "connect", "channel_dm", "src/alerts.ts"],
  ["inbox", "connect", "channel_dm_first", "src/alerts.ts"],
  ["connect", "inbox", "item_decide_dm", "src/app.ts 15 s tick"],
  ["observer", "inbox", "inbox_ask", "src/app.ts job"],
  ["observer", "inbox", "inbox_status", "src/app.ts job"],
  ["observer", "connect", "data_accounts_list", "src/connect.ts page and job"],
  ["observer", "connect", "data_catalog", "src/connect.ts page and job"],
  ["observer", "knowledge", "areas_list", "src/deliver.ts"],
  ["observer", "kanban", "projects_list", "owner page"],
  ["evolution", "kanban", "issues_list", "src/scan.ts 15 min timer"],
  ["evolution", "connect", "tool_shares_mine", "src/engine/ops.ts page"],
  ["evolution", "inbox", "inbox_status", "src/engine/activities.ts wait"],
];

for (const mode of ["verification", "closed"] as const) {
  test(`${mode}: internal plumbing is neither held nor refused`, () => {
    for (const [caller, product, op, why] of PLUMBING) {
      const v = evaluate([], facts(caller, product, op), mode);
      assert.equal(v.decision, "allow", `${caller} -> ${product}.${op} (${why})`);
      assert.ok(v.byMode?.exemption, `${caller} -> ${product}.${op} names its exemption`);
    }
  });
}

test("work stays under the mode: moving content, writing, ending access, and any workflow step (fires when an exemption grows)", () => {
  const work: readonly [string, string, string, string][] = [
    ["observer", "connect", "data_pull", "read"], // one hold, then Observer waits for the owner: live, VERDICTS C378, no repeat
    ["observer", "knowledge", "document_create", "write"],
    ["observer", "knowledge", "document_update", "write"],
    ["observer", "kanban", "issue_create", "write"],
    ["evolution", "kanban", "issue_create", "write"],
    ["evolution", "kanban", "projects_list", "read"],
    ["evolution", "connect", "tools", "outward"],
    ["evolution", "connect", "data_pull", "read"],
    ["evolution", "knowledge", "recall", "read"],
    ["fleet", "connect", "access_revoke", "write"],
    ["fleet", "knowledge", "access_revoke", "write"],
    ["fleet", "evolution", "access_revoke", "write"],
    ["knowledge", "connect", "identities_list", "read"],
    ["connect", "fleet", "directory_feed", "read"],
    ["kanban", "kanban", "issues_list", "read"],
    ["observer", "kanban", "issues_list", "read"],
  ];
  for (const [caller, product, op, effect] of work) {
    assert.equal(exemptionOf(facts(caller, product, op, false, effect)), null, `${caller} -> ${product}.${op}`);
    assert.equal(evaluate([], facts(caller, product, op, false, effect), "verification").decision, "hold", `${caller} -> ${product}.${op}`);
    assert.equal(evaluate([], facts(caller, product, op, false, effect), "closed").decision, "deny", `${caller} -> ${product}.${op}`);
  }
});

test("the new read exemptions drop for a workflow step or a call for an agent, and for a caller with no verified product", () => {
  for (const [caller, product, op] of [
    ["evolution", "kanban", "issues_list"],
    ["evolution", "connect", "tool_shares_mine"],
    ["observer", "connect", "data_catalog"],
  ] as const) {
    assert.ok(exemptionOf(facts(caller, product, op)), `${caller} ${op} quiet`);
    assert.equal(exemptionOf(facts(caller, product, op, true)), null, `${caller} ${op} as work`);
    assert.equal(exemptionOf(facts(null, product, op)), null, `${op} unverified`);
    assert.equal(exemptionOf({ ...facts(caller, product, op), caller: { type: "agent", id: "agt_01J0000000000000000000000A", mode: "free" } }), null, `${op} from an agent`);
  }
});

test("an owner rule still decides an exempt call, and a line on the page exists for every exemption", () => {
  const deny = { id: "rul_1", rev: 1, updatedAt: 1, spec: spec({ title: "no scan", priority: 1, match: { callerProducts: ["evolution"], products: ["kanban"], operations: ["issues_list"] }, decision: "deny", reason: "no" }) };
  assert.equal(evaluate([deny], facts("evolution", "kanban", "issues_list"), "closed").decision, "deny");
  for (const [caller, product, op] of PLUMBING) {
    const id = exemptionOf(facts(caller, product, op));
    assert.ok(EXEMPTIONS.some((e) => e.id === id), `${id}`);
  }
});
