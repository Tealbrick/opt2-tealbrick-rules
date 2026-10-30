// C380 T2-a: the words of a rule by role in the lists and the cut-off check of the Rules page (src/ui/api.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { cutsOffGovernance, matchText } from "../src/ui/api.ts";
import { spec } from "./helpers.ts";

const CONTRACTOR = "rol_01J0000000000000000000CON1";

test("the editor shape: the rule list text names the role; a refuse rule by role is not 'every call'; the Governance cut-off check ignores a role rule", () => {
  assert.equal(matchText(spec({ match: { effects: ["outward"], callerRoles: [CONTRACTOR] } }), (t) => t, (a) => a, undefined, () => "Contractor"), "effects outward; caller has role Contractor");
  assert.equal(matchText(spec({ match: { callerRoles: [CONTRACTOR] } }), (t) => t, (a) => a), `caller has role ${CONTRACTOR}`, "the id stands in when the name is not known");
  const cut = spec({ decision: "deny", match: { products: ["fleet"], effects: ["read"] } });
  assert.equal(cutsOffGovernance(cut), true, "the check itself fires");
  assert.equal(cutsOffGovernance(spec({ decision: "deny", match: { ...cut.match, callerRoles: [CONTRACTOR] } })), false, "a role rule cannot stop the feed read");
});
