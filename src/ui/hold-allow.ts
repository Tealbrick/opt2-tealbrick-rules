// D12 (C373, Martin C277 A2): "Allow always" from a hold card. The Inbox "All approvals" page (and later every app's hold card)
// opens Rules at the launch path with a query:
//   /?new=allow&product=<p>&op=<op>&hold=<hld_…>  plus  &agent=<agt_…> (agent caller)  OR  &callerProduct=<verified product> (app caller)
// and optionally &tool=<t> (not sent today). Pure data and builders, no React and no I/O (the UI build serves only src/ui, and the
// tests run the same functions): the link only PREPARES a rule in the editor, the owner saves it with rules_set like any rule.
// Every value is checked with the pattern the writers use; anything else is a plain notice and no prefill.
import type { RuleRow, RuleSpec } from "./api.ts";

export interface AllowQuery {
  product: string;
  op: string;
  hold: string;
  /** agent caller: its `agt_…` id */
  agent?: string;
  /** app caller: its VERIFIED product */
  callerProduct?: string;
  tool?: string;
}

export type AllowRead = { kind: "none" } | { kind: "bad"; notice: string } | { kind: "ok"; query: AllowQuery };

export const BAD_LINK = "This “Allow always” link is not valid, so Rules prepared no rule. Open the hold again from your Inbox and choose Allow always.";

// the same patterns as the manifest (match.products, match.operations, match.agents, match.callerProducts) and the engine (catalog tool name)
const PRODUCT = /^[a-z][a-z0-9-]{1,39}$/;
const OP = /^[a-z][a-z0-9_]{1,39}$/;
const HOLD = /^hld_[0-9A-HJKMNP-TV-Z]{26}$/;
const AGENT = /^agt_[A-Za-z0-9]{1,60}$/;
const CALLER_PRODUCT = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const TOOL = /^(?!.*__)[a-z][a-z0-9_]{0,46}[a-z0-9]$/;

/** Reads `location.search`. No `new` parameter = nothing to do; anything wrong (a repeated key, a missing or malformed value, both callers) = a notice. */
export function readAllowQuery(search: string): AllowRead {
  const p = new URLSearchParams(search);
  if (!p.has("new")) return { kind: "none" };
  const bad: AllowRead = { kind: "bad", notice: BAD_LINK };
  const one = (k: string): string | null | undefined => {
    const all = p.getAll(k);
    return all.length === 0 ? undefined : all.length === 1 ? (all[0] as string) : null;
  };
  if (one("new") !== "allow") return bad;
  const product = one("product");
  const op = one("op");
  const hold = one("hold");
  const agent = one("agent");
  const callerProduct = one("callerProduct");
  const tool = one("tool");
  if (!product || !PRODUCT.test(product) || !op || !OP.test(op) || !hold || !HOLD.test(hold)) return bad;
  // exactly one caller: an agent OR an app
  if ((agent === undefined) === (callerProduct === undefined)) return bad;
  if (agent !== undefined && !(agent && AGENT.test(agent))) return bad;
  if (callerProduct !== undefined && !(callerProduct && CALLER_PRODUCT.test(callerProduct))) return bad;
  if (tool !== undefined && !(tool && TOOL.test(tool))) return bad;
  return {
    kind: "ok",
    query: { product, op, hold, ...(agent ? { agent } : {}), ...(callerProduct ? { callerProduct } : {}), ...(tool ? { tool } : {}) },
  };
}

type Match = RuleSpec["match"];

/**
 * Whether a rule could match this call, judged from the fields the link tells (app, operation, caller, tool). Every other field
 * (effects, teams, trust, recipients, …) is unknown here, so it never excludes: the answer errs towards "could match", which only
 * moves the new allow rule LATER (safe).
 */
export function couldMatch(m: Match, q: AllowQuery): boolean {
  if (m.products?.length && !m.products.includes(q.product)) return false;
  if (m.operations?.length && !m.operations.includes(q.op)) return false;
  if (q.agent) {
    if (m.agents?.length && !m.agents.includes(q.agent)) return false;
    if (m.callerProducts?.length || m.callerWorkflows?.length) return false;
  } else if (m.callerProducts?.length && !m.callerProducts.includes(q.callerProduct as string)) return false;
  // a tool rule matches the named tool and its "x__…" variants; a call without a tool name is not excluded (a dynamic call without one fails closed)
  if (m.tools?.length && q.tool && !m.tools.some((x) => q.tool === x || (q.tool as string).startsWith(`${x}__`))) return false;
  return true;
}

export interface AllowPlan {
  spec: RuleSpec;
  /** one sentence: the priority and why */
  why: string;
  /** things the owner must read (a hold rule that still runs first, …) */
  warnings: string[];
  /** a dynamic operation (many tools) without a tool: Save stays disabled until the owner names ONE tool */
  needTool: boolean;
  /** no place for the rule (a refuse rule that could match sits at priority 1000): Save stays disabled */
  blocked: string | null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const q = (s: string) => `“${clip(s, 60)}”`;
/** The priority of an allow rule that has no hold rule to go before. */
export const FALLBACK_PRIORITY = 20;

/**
 * The allow rule a hold card stands for, and where it goes. The rule is narrow: this app, this operation, this caller (and this
 * tool when given). Priority: BEFORE the lowest hold rule that could have held the call (otherwise the hold still runs first), but
 * never ahead of a refuse rule that could match: it goes after the highest of those, whatever the hold's priority is. The B2
 * placement of the English box (`placement` in src/compose.ts) puts an allow AFTER every hold, which would leave this one without
 * effect, so the rule is placed here from the rules that could match this call. `rules` = the owner's live rules.
 */
export function allowPlan(query: AllowQuery, rules: readonly Pick<RuleRow, "spec">[], who: string, dynamic: boolean): AllowPlan {
  const live = rules.map((r) => r.spec).filter((s) => couldMatch(s.match, query));
  // refuse rules count active OR inactive (review 0.5.0 S3-3: re-activating one later must not be skipped by this allow); holds: active ones
  const denies = live.filter((s) => s.outcome.decision === "deny");
  const holds = live.filter((s) => s.active && s.outcome.decision === "hold");
  const deny = denies.reduce<RuleSpec | null>((a, s) => (a === null || s.priority > a.priority ? s : a), null);
  const hold = holds.reduce<RuleSpec | null>((a, s) => (a === null || s.priority < a.priority ? s : a), null);
  let priority = hold ? hold.priority - 1 : FALLBACK_PRIORITY;
  if (deny && priority <= deny.priority) priority = deny.priority + 1;
  const warnings: string[] = [];
  let blocked: string | null = null;
  if (priority > 1000) {
    blocked = `Your refuse rule ${q((deny as RuleSpec).title)} could match this call and has priority ${(deny as RuleSpec).priority}, the last place, so an allow rule cannot go after it. Lower its priority first.`;
    priority = 1000;
  } else {
    priority = Math.max(0, priority);
    if (hold && priority >= hold.priority) {
      const because = deny
        ? `your refuse rule ${q(deny.title)} (priority ${deny.priority}) could match this call, and an allow rule never goes ahead of a refuse rule`
        : "it has priority 0, the first place, so nothing can go before it";
      warnings.push(`Your hold rule ${q(hold.title)} (priority ${hold.priority}) still runs first: ${because}. The call may still be held. Change those priorities if this is wrong.`);
    }
  }
  const why = [
    `Priority ${priority}:`,
    hold ? `before your hold rule ${q(hold.title)} (priority ${hold.priority}), so the hold no longer catches this call` : "no hold rule of yours covers this call, so it goes in the usual place for an allow rule",
    deny ? `and after your refuse rule ${q(deny.title)} (priority ${deny.priority}), so it never skips a refuse rule.` : "and no refuse rule of yours could match it.",
  ].join(" ");
  const spec: RuleSpec = {
    title: clip(`Allow ${query.op} for ${who}`, 120),
    active: true,
    priority,
    match: {
      products: [query.product],
      operations: [query.op],
      ...(query.agent ? { agents: [query.agent] } : { callerProducts: [query.callerProduct as string] }),
      ...(query.tool ? { tools: [query.tool] } : {}),
    },
    outcome: { decision: "allow", reason: `Always allowed by the owner (from hold ${query.hold})` },
  };
  return { spec, why, warnings, needTool: dynamic && !query.tool, blocked };
}
