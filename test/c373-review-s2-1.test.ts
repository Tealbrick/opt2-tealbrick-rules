// Review 0.5.0 S2-1: the English parser dropped negation and proposed an ALLOW for what the owner forbade ("Do not allow Hermes
// to pay" → allow money). A negation or exception word is now read exactly (a refusal, or a refusal of the excepted effects placed
// before the allow) or the sentence goes to `unmatched`; an allow never covers what the text forbids.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCatalog, catalogProblem } from "../src/catalog.ts";
import { type ComposeEnv, composeRules } from "../src/compose.ts";
import { type CallFacts, evaluate, order, type RuleSpec, specProblem } from "../src/engine.ts";

const HERMES = "agt_01J000000000000000000HERMES";
const cat = buildCatalog([{ product: "connect", ops: [{ id: "buzz_dm", title: "Send a DM", effect: "outward", audience: "agent", dynamic: false, tools: [] }] }]);
const env: ComposeEnv = { agents: [{ id: HERMES, name: "Hermes" }], teams: [{ id: "tm_dev", name: "Dev" }], apps: [{ id: "connect" }], problem: (s: RuleSpec) => specProblem(s) || catalogProblem(s, cat) };

/** The decision the proposed rules (alone, Permissive) give a Hermes call with this effect: null = no proposed rule matches. */
function decide(rules: RuleSpec[], effect: string): string | null {
  const facts: CallFacts = { caller: { type: "agent", id: HERMES, mode: "free" }, target: { product: "connect", op: "x", effect }, claim: null, claimVerified: false, claimTeams: [], claimTeamsAny: [], callerTeams: [], callerTeamsAny: [], claimTrusts: [], claimTrustActive: true, fleetAvailable: true, callerProduct: null };
  const v = evaluate(order(rules.map((spec, i) => ({ id: `r${i}`, rev: 1, spec, updatedAt: 1 }))), facts);
  return v.rule ? v.decision : null;
}

/** [owner text, effects the text forbids, effects it allows] */
const MAPPED: [string, string[], string[]][] = [
  ["Do not allow Hermes to pay", ["money"], []],
  ["Hermes may send messages, not pay", ["money"], ["outward"]],
  ["Hermes may send messages but not pay", ["money"], ["outward"]],
  ["Hermes can read but not delete", ["destructive"], ["read"]],
  ["Allow Hermes to send messages without paying", ["money"], ["outward"]],
  ["Hermes may read and write but not delete or pay", ["destructive", "money"], ["read", "write"]],
  ["Hermes is allowed to read, not to delete", ["destructive"], ["read"]],
  ["Never let Hermes pay", ["money"], []],
  ["Hermes may not send email", ["outward"], []],
  ["Allow everything except money", ["money"], ["read", "write", "outward", "destructive"]],
];

for (const [text, forbids, allows] of MAPPED) {
  test(`S2-1 parser: “${text}” refuses ${forbids.join(", ")} and never allows it`, () => {
    const p = composeRules(text, env);
    assert.deepEqual(p.unmatched, [], text);
    for (const e of forbids) assert.equal(decide(p.rules, e), "deny", `${text}: ${e}`);
    for (const e of allows) assert.equal(decide(p.rules, e), "allow", `${text}: ${e}`);
    // every refusal runs before every allow of the proposal
    const denies = p.rules.filter((r) => r.outcome.decision !== "allow").map((r) => r.priority);
    const allowP = p.rules.filter((r) => r.outcome.decision === "allow").map((r) => r.priority);
    if (denies.length && allowP.length) assert.ok(Math.max(...denies) < Math.min(...allowP), text);
    // no allow rule names a forbidden effect, and none matches every effect while something is forbidden
    for (const r of p.rules.filter((x) => x.outcome.decision === "allow")) for (const e of forbids) assert.ok(r.match.effects === undefined || !r.match.effects.includes(e as never), `${text}: allow names ${e}`);
  });
}

/** Sentences whose negation the parser cannot read exactly: no rule at all, the sentence is shown unread. */
const UNREAD = [
  "Do not hold Hermes",
  "Never hold Hermes's sends",
  "Allow everyone except Hermes to pay",
  "All agents except Hermes may pay",
  "Allow Hermes to pay unless it is over 100",
  "Hermes doesn't pay",
  "Block Hermes from paying except for invoices",
  "Hermes may send messages without attachments",
  "Nobody may pay",
  "Hermes may pay, not send messages to team Dev",
  "When someone from team Dev is not there: block money",
];
for (const text of UNREAD) {
  test(`S2-1 parser: “${text}” is not read (unmatched, no rule)`, () => {
    const p = composeRules(text, env);
    assert.deepEqual(p.rules, [], text);
    assert.equal(p.unmatched.length, 1, text);
  });
}

test("S2-1 parser: an unread negated sentence leaves the other sentences intact", () => {
  const p = composeRules("Block Hermes from deleting. Do not hold Hermes.", env);
  assert.deepEqual(p.rules.map((r) => [r.outcome.decision, r.match.effects]), [["deny", ["destructive"]]]);
  assert.equal(p.unmatched[0]?.text, "Do not hold Hermes");
});
