// D11 (C373, QA RU-03): "Check against recent calls". A rule that is NOT saved yet runs over the last recorded gate decisions
// (phase `before`) and the answer says which of those calls it would have matched and how the decision would change. Nothing is
// stored. Only what the decisions table keeps is used: caller, app, operation, effect, tool, the verified product and workflow,
// the claim (kind, id, teams, trust). The recipients are a COUNT, never a handle, and the calling agent's teams and trust of that
// time are not kept, so a rule that names them cannot be checked and the answer says so (it never guesses).
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { isDynamicOp } from "./catalog.ts";
import { type CallFacts, type Claim, evaluate, order, type Rule, type RuleSpec } from "./engine.ts";
import { gateAnswer, workflowCapVisible } from "./hooks.ts";
import { type DefaultMode, MODE_LABEL, traceDecidedBy } from "./mode.ts";
import { type DecisionView, listDecisions, liveRules } from "./store.ts";

export const RECENT_DEFAULT = 100;
export const RECENT_MAX = 200;
export const RECENT_NOTE = "Only calls Rules recorded are checked (reads that matched no rule are not listed). Governance facts of the past are not kept, so rules that name teams or trust are read strictly.";

export interface RecentRow {
  id: string;
  at: string;
  caller: { type: string; id: string; product: string | null };
  target: { product: string; op: string; effect: string; tool?: string };
  before: { decision: "allow" | "deny" | "hold"; by: string };
  after: { decision: "allow" | "deny" | "hold"; by: string };
  changed: boolean;
}

export interface RecentResult {
  checked: number;
  matched: number;
  changed: number;
  cannotCheck: string | null;
  note: string;
  rows: RecentRow[];
}

/** Why the rule cannot be checked against past calls (null = it can): it names a fact the decision log does not keep. */
export function cannotCheck(spec: RuleSpec): string | null {
  const m = spec.match;
  if (m.recipients) return "This rule names recipients. The decision log keeps only how many recipients a call had, never who, so it can’t be checked against past calls.";
  if (m.callerTeams?.length || m.callerTrust?.length) return "This rule names the calling agent’s teams or trust. The decision log does not keep what they were at the time of a call, so it can’t be checked against past calls.";
  return null;
}

const asDecision = (v: string): "allow" | "deny" | "hold" => (v === "deny" || v === "hold" ? v : "allow");

/** The facts of a past call, from the decision row only. Fleet facts are unavailable (fail closed), recipients unknown. */
export function factsOfRow(db: Db, d: DecisionView): CallFacts {
  const obo = d.onBehalfOf as { kind?: unknown; id?: unknown; verified?: unknown; teams?: unknown; trust?: unknown } | null;
  const claim: Claim | null = obo && (obo.kind === "person" || obo.kind === "agent" || obo.kind === "channel_sender") && typeof obo.id === "string" ? { kind: obo.kind, id: obo.id } : null;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const teams = claim ? strings(obo?.teams) : [];
  const workflow = typeof d.detail?.workflow === "string" ? d.detail.workflow : null;
  let dynamic: boolean | undefined;
  try {
    dynamic = isDynamicOp(db, d.target.product, d.target.op);
  } catch {
    dynamic = undefined;
  }
  return {
    caller: { type: d.caller.type, id: d.caller.id, mode: d.caller.mode },
    target: { product: d.target.product, op: d.target.op, effect: d.target.effect, ...(d.target.tool !== undefined ? { tool: d.target.tool } : {}), ...(dynamic !== undefined ? { dynamic } : {}) },
    claim,
    claimVerified: obo?.verified === true,
    claimTeams: teams,
    claimTeamsAny: teams,
    callerTeams: [],
    callerTeamsAny: [],
    callerTrusts: [],
    callerTrustActive: true,
    recipients: null,
    callerWorkflow: workflow,
    workflowCapVisible: workflowCapVisible(db),
    claimTrusts: claim && Array.isArray(obo?.trust) ? (strings(obo.trust) as CallFacts["claimTrusts"]) : [],
    claimTrustActive: true,
    fleetAvailable: false,
    callerProduct: d.caller.product,
  };
}

/** Which decision the log kept for the call: what the gate answered, and by what. */
function beforeOf(d: DecisionView): RecentRow["before"] {
  const by = traceDecidedBy(d.ruleId, d.detail);
  return { decision: asDecision(d.answered), by: d.ruleTitle ?? `${MODE_LABEL[by.mode ?? "permissive"]} mode` };
}

/**
 * `candidate` replaces the stored rule `replaces` (when editing) in the "after" column. A call is MATCHED when the candidate
 * decides it on its own; `after` is what all live rules with the candidate (and the current default mode) decide.
 */
export function previewRecent(db: Db, input: { candidate: RuleSpec; replaces?: string; limit?: number }, mode: DefaultMode): RecentResult {
  const limit = Math.max(1, Math.min(RECENT_MAX, input.limit ?? RECENT_DEFAULT));
  const unchecked = cannotCheck(input.candidate);
  if (unchecked) return { checked: 0, matched: 0, changed: 0, cannotCheck: unchecked, note: RECENT_NOTE, rows: [] };
  const alone: Rule[] = [{ id: "candidate", rev: 0, spec: input.candidate, updatedAt: Date.now() }];
  const all: Rule[] = order([...liveRules(db).filter((r) => r.id !== input.replaces), ...alone]);
  const { items } = listDecisions(db, { phase: "before", limit });
  const rows: RecentRow[] = [];
  for (const d of items) {
    // the company floor decided this call before any rule ran: no rule would have changed it
    if (d.detail?.decidedBy === "floor") continue;
    const facts = factsOfRow(db, d);
    if (evaluate(alone, facts).rule?.id !== "candidate") continue;
    const after = evaluate(all, facts, mode);
    const before = beforeOf(d);
    const now = gateAnswer(after).answered;
    rows.push({
      id: d.id,
      at: d.at,
      caller: { type: d.caller.type, id: d.caller.id, product: d.caller.product },
      target: d.target,
      before,
      after: { decision: asDecision(now), by: after.rule?.id === "candidate" ? input.candidate.title : (after.rule?.title ?? `${MODE_LABEL[mode]} mode`) },
      changed: before.decision !== now,
    });
  }
  return { checked: items.length, matched: rows.length, changed: rows.filter((r) => r.changed).length, cannotCheck: null, note: RECENT_NOTE, rows };
}
