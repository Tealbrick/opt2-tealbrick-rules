// D12 (C373, Martin C277 A2): "Allow always" from a hold card. The Inbox "All approvals" page (and later every app's hold card)
// opens Rules at the launch path with a query:
//   /?new=allow&product=<p>&op=<op>&hold=<hld_…>  plus  &agent=<agt_…> (agent caller)  OR  &callerProduct=<verified product> (app caller)
// and optionally &tool=<t> and &rule=<rul_…> (the hold RULE that held the call; neither is sent today). Pure data and builders, no React and no I/O (the UI build serves only src/ui, and the
// tests run the same functions): the link only PREPARES a rule in the editor, the owner saves it with rules_set like any rule.
// Every value is checked with the pattern the writers use; anything else is a plain notice and no prefill.
import type { RuleSpec } from "./api.ts";

export interface AllowQuery {
  product: string;
  op: string;
  hold: string;
  /** agent caller: its `agt_…` id */
  agent?: string;
  /** app caller: its VERIFIED product */
  callerProduct?: string;
  tool?: string;
  /** the hold rule that held the call (`rul_…`), when the link says so; else Rules assumes the first hold rule that could have held it */
  rule?: string;
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
const RULE = /^rul_[0-9A-HJKMNP-TV-Z]{26}$/;

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
  const rule = one("rule");
  if (!product || !PRODUCT.test(product) || !op || !OP.test(op) || !hold || !HOLD.test(hold)) return bad;
  // exactly one caller: an agent OR an app
  if ((agent === undefined) === (callerProduct === undefined)) return bad;
  if (agent !== undefined && !(agent && AGENT.test(agent))) return bad;
  if (callerProduct !== undefined && !(callerProduct && CALLER_PRODUCT.test(callerProduct))) return bad;
  if (tool !== undefined && !(tool && TOOL.test(tool))) return bad;
  if (rule !== undefined && !(rule && RULE.test(rule))) return bad;
  return {
    kind: "ok",
    query: { product, op, hold, ...(agent ? { agent } : {}), ...(callerProduct ? { callerProduct } : {}), ...(tool ? { tool } : {}), ...(rule ? { rule } : {}) },
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

/** Single-valued facts of a call: two rules that list disjoint values never match the same call (same list as `mayOverlap` in src/placement.ts). */
const SINGLE = ["agents", "modes", "products", "operations", "effects", "callerProducts", "callerWorkflows"] as const;
const onlyAgents = (m: Match) => !!m.agents?.length && m.agents.every((a) => a.startsWith("agt_"));

/**
 * Could one call match both rules? False only when a single-valued criterion both rules list has no common value, two tool lists are
 * disjoint, or one rule names only agents and the other names calling apps (an agent is not an app). Errs towards "could" (safe).
 * The UI build serves only src/ui, so this is a copy of `mayOverlap` (src/placement.ts) with the tool and caller-kind cases; a test
 * keeps them from drifting.
 */
export function overlaps(a: Match, b: Match): boolean {
  for (const k of SINGLE) {
    const x = a[k] as readonly string[] | undefined;
    const y = b[k] as readonly string[] | undefined;
    if (x?.length && y?.length && !x.some((v) => y.includes(v))) return false;
  }
  if (a.tools?.length && b.tools?.length && !a.tools.some((t) => b.tools?.includes(t))) return false;
  if ((onlyAgents(a) && b.callerProducts?.length) || (onlyAgents(b) && a.callerProducts?.length)) return false;
  return true;
}

/** A hold rule the new allow rule runs ahead of. */
export interface SkippedHold {
  title: string;
  priority: number;
}

export interface AllowPlan {
  spec: RuleSpec;
  /** one sentence: the priority and why */
  why: string;
  /** things the owner must read (a hold rule that still runs first, every hold rule this allow skips, …) */
  warnings: string[];
  /** a dynamic operation (many tools) without a tool: Save stays disabled until the owner names ONE tool */
  needTool: boolean;
  /** no place for the rule (a refuse rule that could match sits at priority 1000): Save stays disabled */
  blocked: string | null;
  /** the hold rules, other than the one that held the call, that this allow rule runs ahead of (title and priority) */
  skipped: SkippedHold[];
  /** Save needs the owner's tick "I know this skips these holds" (`skipped` is not empty) */
  needsAck: boolean;
  /** the hold rule the placement is based on (the one in the link, else the first that could have held the call), for a recompute after an edit */
  deciderId?: string;
}

/** What `placeAllow` returns: the priority and the facts the sentences are made from. */
interface Placed {
  priority: number;
  decider: RuleLike | null;
  deny: RuleLike | null;
  skipped: RuleLike[];
  assumed: boolean;
  blocked: string | null;
  holdsSeen: number;
  /** refuse rules at the same priority or later (they run after the allow): only possible when the owner set the priority */
  ahead: RuleLike[];
  fixed: boolean;
}

/** A stored rule as the placement reads it: `id` is optional (tests give only `spec`). */
type RuleLike = { id?: string; spec: RuleSpec };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const q = (s: string) => `“${clip(s, 60)}”`;
/** The priority of an allow rule that has no hold rule to go before. */
export const FALLBACK_PRIORITY = 20;

/**
 * Where an allow rule goes, from the rules that could match its calls (`live`, already filtered). It goes right BEFORE the hold rule
 * that held the call (`preferId`, else the first active hold rule), but never ahead of a refuse rule that could match (inactive ones
 * count: re-activating one later must not be skipped). Every OTHER active hold rule at that priority or later also runs after it, so
 * the allow skips it: those are listed in `skipped`. A hold rule with a lower priority than the allow still runs first.
 */
function placeAllow(live: readonly RuleLike[], preferId: string | undefined, fixed?: number): Placed {
  const denies = live.filter((r) => r.spec.outcome.decision === "deny");
  const holds = live.filter((r) => r.spec.active && r.spec.outcome.decision === "hold").sort((a, b) => a.spec.priority - b.spec.priority);
  const deny = denies.reduce<RuleLike | null>((a, r) => (a === null || r.spec.priority > a.spec.priority ? r : a), null);
  const named = preferId === undefined ? undefined : holds.find((h) => h.id === preferId);
  const decider = named ?? holds[0] ?? null;
  let priority = fixed ?? (decider ? decider.spec.priority - 1 : FALLBACK_PRIORITY);
  let blocked: string | null = null;
  // a priority the owner typed is kept as it is; the plan only says what it skips
  if (fixed === undefined && deny && priority <= deny.spec.priority) priority = deny.spec.priority + 1;
  if (fixed === undefined && priority > 1000) {
    blocked = `Your refuse rule ${q((deny as RuleLike).spec.title)} could match this call and has priority ${(deny as RuleLike).spec.priority}, the last place, so an allow rule cannot go after it. Lower its priority first.`;
    priority = 1000;
  } else priority = Math.max(0, priority);
  const skipped = holds.filter((h) => h !== decider && h.spec.priority >= priority);
  const ahead = fixed === undefined ? [] : denies.filter((d) => d.spec.priority >= priority);
  return { priority, decider, deny, skipped, assumed: named === undefined, blocked, holdsSeen: holds.length, ahead, fixed: fixed !== undefined };
}

/** The sentences for a placement: the one-line `why`, and the warnings (hold that still runs first, every skipped hold, which hold was assumed). */
function sentences(p: Placed): { why: string; warnings: string[] } {
  const { priority, decider, deny } = p;
  const warnings: string[] = [];
  const first = decider !== null && priority >= decider.spec.priority;
  for (const d of p.ahead)
    warnings.push(`This allow rule runs ahead of your refuse rule ${q(d.spec.title)} (priority ${d.spec.priority}). For the calls they share, it decides first, so ${q(d.spec.title)} no longer refuses them. Raise this priority above ${d.spec.priority} if that is wrong.`);
  if (!p.blocked && decider && first && !p.fixed) {
    const because = deny
      ? `your refuse rule ${q(deny.spec.title)} (priority ${deny.spec.priority}) could match this call, and an allow rule never goes ahead of a refuse rule`
      : "it has priority 0, the first place, so nothing can go before it";
    warnings.push(`Your hold rule ${q(decider.spec.title)} (priority ${decider.spec.priority}) still runs first: ${because}. The call may still be held. Change those priorities if this is wrong.`);
  }
  if (p.holdsSeen > 1 && p.assumed) warnings.push(`Rules cannot tell which of your ${p.holdsSeen} hold rules held this call, so it assumed the first one, ${q((decider as RuleLike).spec.title)} (priority ${(decider as RuleLike).spec.priority}).`);
  for (const h of p.skipped)
    warnings.push(`This allow rule also runs ahead of your hold rule ${q(h.spec.title)} (priority ${h.spec.priority}), which could hold other calls of this caller. They will no longer be held either.`);
  const lead = !decider
    ? "no hold rule of yours covers this call, so it goes in the usual place for an allow rule"
    : first
      ? `after your hold rule ${q(decider.spec.title)} (priority ${decider.spec.priority}), so that hold rule still runs first`
      : `before your hold rule ${q(decider.spec.title)} (priority ${decider.spec.priority}), so the hold no longer catches this call`;
  const tail = deny ? `and after your refuse rule ${q(deny.spec.title)} (priority ${deny.spec.priority}), so it never skips a refuse rule.` : "and no refuse rule of yours could match it.";
  if (p.fixed) return { why: `Priority ${priority}: set by you.`, warnings };
  return { why: [`Priority ${priority}:`, lead, tail].join(" "), warnings };
}

const rulesOf = (rules: readonly RuleLike[]) => rules.filter((r) => r.spec);

/**
 * The allow rule a hold card stands for, and where it goes. The rule is narrow: this app, this operation, this caller (and this
 * tool when given). Priority: BEFORE the hold rule that held the call (`query.rule`; without it, the first hold rule that could have
 * held it), but never ahead of a refuse rule that could match: it goes after the highest of those, whatever the hold's priority is.
 * Every other hold rule that could match and runs at that priority or later is skipped by this rule: the plan names each one and Save
 * needs the owner's tick. The B2 placement of the English box (`placement` in src/compose.ts) puts an allow AFTER every hold, which would
 * leave this one without effect, so the rule is placed here from the rules that could match this call. `rules` = the owner's live rules.
 */
export function allowPlan(query: AllowQuery, rules: readonly RuleLike[], who: string, dynamic: boolean): AllowPlan {
  const placed = placeAllow(rulesOf(rules).filter((r) => couldMatch(r.spec.match, query)), query.rule);
  const { why, warnings } = sentences(placed);
  const spec: RuleSpec = {
    title: clip(`Allow ${query.op} for ${who}`, 120),
    active: true,
    priority: placed.priority,
    match: {
      products: [query.product],
      operations: [query.op],
      ...(query.agent ? { agents: [query.agent] } : { callerProducts: [query.callerProduct as string] }),
      ...(query.tool ? { tools: [query.tool] } : {}),
    },
    outcome: { decision: "allow", reason: `Always allowed by the owner (from hold ${query.hold})` },
  };
  return planOf(spec, placed, why, warnings, dynamic && !query.tool);
}

function planOf(spec: RuleSpec, p: Placed, why: string, warnings: string[], needTool: boolean): AllowPlan {
  const skipped = p.skipped.map((h) => ({ title: h.spec.title, priority: h.spec.priority }));
  return { spec, why, warnings, needTool, blocked: p.blocked, skipped, needsAck: skipped.length > 0, ...(p.decider?.id ? { deciderId: p.decider.id } : {}) };
}

/**
 * S4: the owner edited the prefilled rule (its match or tool): place it again from what it matches NOW. `plan` = the plan the rule
 * started from (its `deciderId` stays the hold rule to go before while that rule can still match). Same result shape as `allowPlan`;
 * `spec` is the edited rule with its new priority, every other field as the owner left it. `keepPriority`: the owner typed the
 * priority, so it stays and the plan only says which refuse and hold rules the rule runs ahead of.
 */
export function replanAllow(edited: RuleSpec, rules: readonly RuleLike[], plan: Pick<AllowPlan, "deciderId" | "needTool">, keepPriority = false): AllowPlan {
  const placed = placeAllow(
    rulesOf(rules).filter((r) => overlaps(r.spec.match, edited.match)),
    plan.deciderId,
    keepPriority ? edited.priority : undefined,
  );
  const { why, warnings } = sentences(placed);
  return planOf({ ...edited, priority: placed.priority }, placed, why, warnings, plan.needTool && !edited.match.tools?.length);
}
