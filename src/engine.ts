// The rule engine: pure functions, no I/O, no model call. The gate hook calls `evaluate` on every call it sees,
// so everything here is synchronous and linear in the number of active rules.
//
// Semantics (harvested from the v1 policy engine, new structure):
// - A rule matches when every criterion it names matches (an absent or empty list = any).
// - Rules are ordered by priority (lower first), then newest update, then id. The FIRST matching rule decides.
// - No matching rule = the workspace default mode decides (C373c, src/mode.ts): Permissive allow (C84, the default),
//   Verification hold, Closed refuse. Free/Bound caps and held families stay the floor in the target app.
// - An `onBehalfOf` claim that is not verified may only NARROW (C82): the decision is the stricter of the
//   evaluation with the claim and the evaluation without any claim-dependent rule; narrowing lists are merged.
// - Fleet facts (teams of the caller or of the claimed requester, trust of the claimed requester) come from the local
//   Fleet read model. When that copy is unavailable (never read, refused, too old) a DENY or HOLD rule that names Fleet
//   facts APPLIES (the criterion counts as met) and an ALLOW rule that names them does NOT apply: the gap can only make
//   a decision stricter (C230, G-3, fail closed). A skipped allow rule's NARROWING still applies (merged strictly), so the call
//   never gets a wider result than it would with the facts.
// - Two membership sets (C236 review): deny/hold rules see EVERY member of a team, including blocked, departed and removed
//   ones (`*Any` fields); allow rules see only the members that count (`callerTeams`, `claimTeams`).
// - Caller teams are AGENT facts: an app caller never matches a `callerTeams` rule, known facts or not (review 0.5.0 S2-2). Rules'
//   own Governance read (exemption `rules-governance-feed`) is never refused or held by a rule that applies to it only because
//   the Governance facts are missing (else they could never come back).
// - A requester the directory does not know has trust `unreviewed`.
// - Dataset narrowing (spec 0.1.66, C336 RQ-2): `narrowing.deepDatasets {anyOf, noneOf}` limits the datasets a data app (Knowledge
//   deep knowledge) may read for the call. It merges like `memoryTags` (per key: anyOf intersects, noneOf unites, disjoint anyOf
//   gives [] = nothing passes, a list present on either side survives; absent is not "all"). Dataset ids are the data app's
//   canonical ids: EXACT and CASE-SENSITIVE, never trimmed or case-folded. The context hook emits `v: 2` exactly when the merged
//   narrowing has deepDatasets (spec 0.1.68), so a reader without dataset narrowing refuses it.
// - Match field `tools` (spec 0.1.68): the dynamic entry name the bridge sends as `target.tool`. Without `target.tool`: a STATIC op
//   never matches a `tools` rule. A DYNAMIC op (or one the catalog cannot place) fails CLOSED like the Fleet facts do: a DENY or HOLD
//   rule with `tools` applies (the tool is unknown, an older bridge or a bridge bug must not switch it off), an ALLOW rule with
//   `tools` does not. With `target.tool` the match is exact. The verdict says so in `toolUnknown`.
// - Calls from product X (`callerProducts`, 0.5.0): only an APP caller whose VERIFIED product (the bridge's signed
//   `caller.product`, never a name, input or context) is listed matches. An AGENT never matches a rule that names it
//   (an agent is not a product), whatever the decision. An app caller with no valid product is handled like unavailable
//   Fleet facts: a deny or hold rule APPLIES (its own flag, `closedOnProduct`) and an allow rule does NOT (its narrowing still
//   applies). Both gaps share the closed/skipped machinery and the severity order below.
// - Calling agent's trust (`callerTrust`, 0.5.0, C373 D4b): the trust of the CALLING agent from the Fleet read model (feed
//   agents[].trust, key `agent:<id>`). A Fleet fact like `callerTeams`: unavailable → deny/hold apply, allow does not. An allow
//   needs the agent active (not blocked, not removed). An agent the directory does not know is `unreviewed` (and not known to be
//   gone). An APP caller has no agent trust: a rule with `callerTrust` never matches an app, whatever the decision.
// - Recipients ("who may talk to whom", 0.5.0, C373 D5, CONTRACT-RECIPIENTS): `match.recipients {teams?, trust?, known?}` matches
//   the recipients of an outward call (bridge `target.recipients`, canonical handles). Each handle maps to its HOLDERS in the Fleet
//   read model (contacts by handle, agents by handle): their teams, their trust set, known = at least one holder. Deny/hold:
//   ANY recipient matches ALL the given sub-criteria. Allow: at least one recipient, and EVERY recipient matches them with every
//   holder active. Unknown recipients (absent, or `recipientsIncomplete`) fail CLOSED: deny/hold apply (`recipientsUnknown`),
//   allow never. `[]` (known: no recipients) matches no recipient rule. The facts are Fleet facts (C236 strict path). Handles never
//   enter CallFacts: only the per-recipient facts do, so a decision or trace can hold the COUNT and never a handle.
// - Calls from workflows (`callerWorkflows`, 0.5.0, C373 D2c, Evolution P1): the VERIFIED workflow id of an APP caller (bridge
//   `caller.workflow` = the grant's `wfl`). Agents never match. A rule needs `callerProducts` with `evolution` (the writer refuses it
//   otherwise; only Evolving Workflows runs workflows), so an unverified product is the product gap above. A call WITHOUT a workflow
//   (agreed with Evolution): when the bridge cap `app_workflow_grants` is visible, it is not a workflow call (no match); when it is
//   not visible (caps never read count as not visible), a deny or hold rule APPLIES to an `evolution` caller (`closedOnWorkflow`)
//   and an allow rule never matches. A call from another verified product without a workflow never matches.
import { normalizeTag, normalizeHandle as sharedNormalizeHandle, tagsMatch } from "@opt2-tealbrick/manifest";
import type { RulesSetInputRuleSpec } from "#kit";
import { type DefaultMode, type ExemptionId, exemptionOf, modeVerdict } from "./mode.ts";

export type RuleSpec = RulesSetInputRuleSpec;
export type Decision = RuleSpec["outcome"]["decision"];
export type Effect = "read" | "write" | "outward" | "destructive" | "money";

/** Effects Rules always gates and records, even when no rule names the call (brief C81: outward/destructive/money). */
export const GATED_EFFECTS: ReadonlySet<string> = new Set(["outward", "destructive", "money"]);
/** Evolution P1 workflow id (`wfl` claim, `caller.workflow`): `^[a-z][a-z0-9-]{2,39}$`. */
export const WORKFLOW_ID = /^[a-z][a-z0-9-]{2,39}$/;
/** The product that runs workflows (Evolving Workflows); a `callerWorkflows` rule must name it in `callerProducts`. */
export const WORKFLOW_PRODUCT = "evolution";
/** The bridge capability that carries verified workflow ids (Evolution P1). */
export const WORKFLOW_CAP = "app_workflow_grants";
/** A product id is `[a-z0-9][a-z0-9_-]*`, at most 40 characters (manifest ProductId). Anything else is no verified product (defence in depth). */
const PRODUCT_ID = /^[a-z0-9][a-z0-9_-]*$/;
export function validProduct(p: unknown): p is string {
  return typeof p === "string" && p.length <= 40 && PRODUCT_ID.test(p);
}

/** Strictness order: a later entry wins when two evaluations disagree. */
const SEVERITY: Record<Decision, number> = { allow: 0, hold: 1, deny: 2 };
export const NO_MATCH_REASON = "No rule matched; the default is allow.";

export interface Rule {
  id: string;
  rev: number;
  spec: RuleSpec;
  /** epoch ms */
  updatedAt: number;
}

/** Trust states of a contact (contract fleet.directory_feed/1). */
export const TRUSTS = ["unreviewed", "trusted", "limited", "blocked"] as const;
export type Trust = (typeof TRUSTS)[number];

/** What the Fleet read model says about ONE recipient handle (`handle:<canonical>` key); never the handle itself. */
export interface RecipientFact {
  /** team ids where EVERY holder is an active member (allow rules) */
  teams: readonly string[];
  /** team ids where ANY holder is a member, incl. blocked, departed, removed (deny and hold rules) */
  teamsAny: readonly string[];
  /** the holders' raw trust set; a handle with no holder is `["unreviewed"]` */
  trusts: readonly Trust[];
  /** false when any holder is blocked, departed or removed */
  allActive: boolean;
  /** at least one holder (a contact or an agent) has this handle */
  known: boolean;
}

export interface Claim {
  kind: "person" | "agent" | "channel_sender";
  id: string;
}

/** What Rules knows about one call at decision time. */
export interface CallFacts {
  caller: { type: string; id: string; mode: string | null };
  target: {
    product: string;
    op: string;
    effect: string;
    /** spec 0.1.68: the dynamic catalog entry name of a dynamic call; absent for static ops and dynamic search */
    tool?: string;
    /**
     * Whether the target op is dynamic, from the app catalog (a local cached table). `undefined` = the catalog cannot place the
     * op (no catalog, or the app/op is not in it): treated as dynamic for a `tools` rule, so a deny or hold rule applies (fail closed).
     */
    dynamic?: boolean;
  };
  /** `tb.onBehalfOf` claim (bridge-copied, spec 0.1.13), or null */
  claim: Claim | null;
  claimVerified: boolean;
  /** team ids the claim resolves to, ACTIVE members only (used by allow rules; Fleet read model plus live Fleet facts of a member that counts) */
  claimTeams: readonly string[];
  /** team ids the claim resolves to, EVERY membership incl. blocked, departed, removed (used by deny and hold rules) */
  claimTeamsAny: readonly string[];
  /** team ids of the CALLER agent, active membership (allow rules) */
  callerTeams: readonly string[];
  /** team ids of the CALLER agent, every membership (deny and hold rules) */
  callerTeamsAny: readonly string[];
  /**
   * The trust of the CALLING agent (feed agents[].trust, key `agent:<id>`), as a set. Absent = an agent the directory does not
   * know (`unreviewed`); ignored for an app caller (a `callerTrust` rule never matches an app) and while the Fleet facts are unavailable.
   */
  callerTrusts?: readonly Trust[];
  /** false when the calling agent is blocked or removed (an allow rule by `callerTrust` never matches it); absent = active */
  callerTrustActive?: boolean;
  /**
   * The recipients of the call (C373 D5), one fact per canonical handle of `target.recipients`. `null` or absent = UNKNOWN (the
   * bridge sent none: no cap `hook_recipients`, a read, an op that declares none; or `recipientsIncomplete`; or a value that is not
   * canonical): deny/hold recipient rules apply, allow rules do not. `[]` = known: the call names no recipient.
   */
  recipients?: readonly RecipientFact[] | null;
  /** The VERIFIED workflow id of an APP caller (bridge `caller.workflow`, Evolution P1, a valid id), else null/absent. */
  callerWorkflow?: string | null;
  /** The bridge cap `app_workflow_grants` is visible to Rules (slice `bridge.caps`); absent or false = not visible (the strict path). */
  workflowCapVisible?: boolean;
  /**
   * The raw trust values of everyone who holds the claimed requester's key (contact id, canonical handle or agent id), as a
   * set. `[]` = no claim or facts unavailable. A requester the directory does not know is `["unreviewed"]`.
   * Deny/hold rules match when ANY holder's trust is listed; allow rules need EVERY holder active and listed.
   */
  claimTrusts: readonly Trust[];
  /** false when any holder of the key is blocked, departed or removed (a gone holder never satisfies an allow rule by trust) */
  claimTrustActive: boolean;
  /** false = the Fleet read model cannot be relied on (never read, refused, too old): see the header */
  fleetAvailable: boolean;
  /**
   * The VERIFIED product of an APP caller (bridge `caller.product`, spec 0.1.45, a valid product id), else null: an agent, an
   * app the bridge could not map (or a bridge older than 0.2.2), or a value that is no product id. Null for an app = unavailable (fail closed).
   */
  callerProduct: string | null;
}

export interface Narrowing {
  memoryTags?: { anyOf?: string[]; noneOf?: string[] };
  /** spec 0.1.68 (SDK-API §18.5): canonical dataset ids a data app may read for this call (exact, case-sensitive); `anyOf` PRESENT but EMPTY = nothing passes */
  deepDatasets?: { anyOf?: string[]; noneOf?: string[] };
}

export interface Verdict {
  decision: Decision;
  reason: string;
  rule: { id: string; rev: number; title: string } | null;
  /** only on allow */
  narrowing: Narrowing | null;
  /** true when the decisive rule matched through the onBehalfOf claim */
  viaClaim: boolean;
  /** true when the decisive deny/hold rule applied only because the Fleet facts it names were unavailable */
  closedOnFleet: boolean;
  /** true when the decisive deny/hold rule applied only because the calling app's verified product was unavailable */
  closedOnProduct: boolean;
  /** true when the decisive deny/hold rule applied only because the call of a dynamic op carried no `target.tool` (fail closed) */
  toolUnknown: boolean;
  /** true when the decisive deny/hold rule applied only because the call's recipients were unknown (or an allow rule that narrows was skipped for it) */
  recipientsUnknown: boolean;
  /** true when the decisive deny/hold rule applied only because the bridge cannot confirm the calling workflow (or an allow rule that narrows was skipped for it) */
  closedOnWorkflow: boolean;
  /** the rule `narrowing` comes from: the deciding allow rule when it has one, else the first skipped allow rule that contributed */
  narrowingRuleId: string | null;
  /** C373c: set when NO rule matched: the default mode that decided, or the built-in exemption that kept the mode out (src/mode.ts) */
  byMode?: { mode: DefaultMode; exemption: ExemptionId | null };
}

export interface Step {
  ruleId: string;
  title: string;
  matched: boolean;
  why: string;
}

const anyOf = (list: readonly string[] | undefined, value: string | null | undefined): boolean => !list || list.length === 0 || (value != null && list.includes(value));

/** Fleet facts a rule names: caller teams or trust, claimed requester's teams or trust, recipients (their holders). */
export function dependsOnFleet(spec: RuleSpec): boolean {
  const m = spec.match;
  return (m.callerTeams?.length ?? 0) > 0 || (m.callerTrust?.length ?? 0) > 0 || m.recipients !== undefined || (m.onBehalfOf?.teams?.length ?? 0) > 0 || (m.onBehalfOf?.trust?.length ?? 0) > 0;
}

export function dependsOnClaim(spec: RuleSpec): boolean {
  const o = spec.match.onBehalfOf;
  return !!o && ((o.teams?.length ?? 0) > 0 || (o.ids?.length ?? 0) > 0 || (o.kinds?.length ?? 0) > 0 || (o.trust?.length ?? 0) > 0);
}

/** Spec 0.1.74 `DYNAMIC_CATALOG_NAME_RE` (LOCAL COPY: the pinned manifest 0.1.31 carries spec 0.1.64, without it): no `__`, no trailing `_`, 2 to 48 characters. */
const CATALOG_TOOL_NAME = /^(?!.*__)[a-z][a-z0-9_]{0,46}[a-z0-9]$/;

/**
 * A `tools` condition naming `x` matches `target.tool === x` OR `target.tool` starting with `x__` (QA-RULES18-4, C354, BRIDGE v0.1.68):
 * Connect resolves a catalog tool to variants such as `gmail_send__first_contact` that run the same upstream tool. Catalog names never
 * contain `__` (the writer refuses an entry that does), so this is not a general prefix wildcard: `gmail_sendx` and `gmail_send_bulk`
 * do not match `gmail_send`. Case-sensitive. Used for allow, deny and hold rules alike.
 */
export function toolListed(tools: readonly string[], tool: string): boolean {
  return tools.some((x) => tool === x || tool.startsWith(`${x}__`));
}

export function dependsOnProduct(spec: RuleSpec): boolean {
  return (spec.match.callerProducts?.length ?? 0) > 0;
}

export const NEEDS_FLEET = "needs Fleet facts, which are unavailable (allow rules do not apply without them)";
export const NEEDS_PRODUCT = "needs the calling app's verified product, which is unavailable (allow rules do not apply without it)";
export const NEEDS_RECIPIENTS = "needs the call's recipients, which are unknown (allow rules do not apply without them)";
export const NEEDS_WORKFLOW = "needs the calling workflow, which this bridge cannot confirm (allow rules do not apply without it)";

export function dependsOnWorkflow(spec: RuleSpec): boolean {
  return (spec.match.callerWorkflows?.length ?? 0) > 0;
}

/** One recipient against the sub-criteria: deny/hold see every membership and ANY holder's trust; allow needs every holder active and listed. */
function recipientMatches(c: NonNullable<RuleSpec["match"]["recipients"]>, r: RecipientFact, strict: boolean): boolean {
  if (c.known !== undefined && r.known !== c.known) return false;
  if (strict) {
    if (c.teams?.length && !c.teams.some((t) => r.teamsAny.includes(t))) return false;
    if (c.trust?.length && !r.trusts.some((t) => (c.trust as readonly string[]).includes(t))) return false;
    return true;
  }
  if (!r.allActive) return false;
  if (c.teams?.length && !c.teams.some((t) => r.teams.includes(t))) return false;
  if (c.trust?.length && !(r.trusts.length > 0 && r.trusts.every((t) => (c.trust as readonly string[]).includes(t)))) return false;
  return true;
}

export interface Judged {
  why: string;
  closed: boolean;
  skipped: boolean;
  /** the closed or skipped outcome rests on unavailable Fleet facts */
  onFleet: boolean;
  /** the closed or skipped outcome rests on the calling app's unavailable verified product */
  onProduct: boolean;
  /** the closed outcome rests on a dynamic call without `target.tool` (deny and hold rules with `tools` only) */
  onTool: boolean;
  /** the closed or skipped outcome rests on unknown recipients */
  onRecipients: boolean;
  /** the closed or skipped outcome rests on a workflow the bridge cannot confirm */
  onWorkflow: boolean;
}

/**
 * Why `rule` does not match `facts` ("" = it matches), whether it matches only because facts it names are unavailable
 * (`closed`, deny and hold rules only; `onFleet` / `onProduct` say which), and whether an ALLOW rule that matches on everything
 * else was skipped because they are unavailable (`skipped`; its narrowing still applies). `useClaim = false` makes every claim criterion fail.
 */
export function judge(spec: RuleSpec, facts: CallFacts, useClaim = true): Judged {
  const no = (why: string): Judged => ({ why, closed: false, skipped: false, onFleet: false, onProduct: false, onTool: false, onRecipients: false, onWorkflow: false });
  if (!spec.active) return no("inactive");
  const m = spec.match;
  if (!anyOf(m.agents, facts.caller.id)) return no("caller is not listed");
  if (!anyOf(m.modes, facts.caller.mode)) return no("caller mode differs");
  if (!anyOf(m.products, facts.target.product)) return no("target product differs");
  if (!anyOf(m.operations, facts.target.op)) return no("target operation differs");
  if (!anyOf(m.effects, facts.target.effect)) return no("effect differs");
  const strict = spec.outcome.decision !== "allow";
  let closed = false;
  let toolClosed = false;
  // spec 0.1.68: a rule that names tools matches a call that carries one of them. A call WITHOUT `target.tool`: a static op never
  // matches; a dynamic op (or one the catalog cannot place) is fail closed: deny and hold rules apply, allow rules do not.
  if (m.tools?.length) {
    const tool = facts.target.tool;
    if (tool !== undefined) {
      if (!toolListed(m.tools, tool)) return no("target tool differs");
    } else if (strict && facts.target.dynamic !== false) toolClosed = true;
    else return no(facts.target.dynamic === false ? "call has no tool name (static operation)" : "call has no tool name");
  }
  let skipped = false;
  let onFleet = false;
  let onProduct = false;
  let onRecipients = false;
  let onWorkflow = false;
  // A fact that may be unavailable: met for a deny/hold rule and never met for an allow rule.
  const gap = (): void => {
    if (strict) closed = true;
    else skipped = true;
  };
  // A Fleet criterion: met, not met, or (copy unavailable) a gap.
  const fleet = (met: boolean, why: string): string => {
    if (facts.fleetAvailable) return met ? "" : why;
    gap();
    onFleet = true;
    return "";
  };
  if (m.callerProducts?.length) {
    // Only an app has a product; an agent never matches (it is not a product). An app without a valid one is a gap (fail closed).
    if (facts.caller.type !== "app") return no("caller is not an app");
    if (facts.callerProduct === null) {
      gap();
      onProduct = true;
    } else if (!m.callerProducts.includes(facts.callerProduct)) return no("calling app is not listed");
  }
  if (m.callerWorkflows?.length) {
    // C373 D2c: a workflow is an APP caller's verified id; an agent never matches
    if (facts.caller.type !== "app") return no("caller is not an app");
    const w = facts.callerWorkflow ?? null;
    if (w !== null) {
      if (!m.callerWorkflows.includes(w)) return no("calling workflow is not listed");
    } else if (facts.workflowCapVisible === true) return no("not a workflow call");
    else if (facts.callerProduct !== null && facts.callerProduct !== WORKFLOW_PRODUCT) return no("not a workflow call");
    else {
      // no cap: Evolution (or an app whose product is unverified, a gap above) may be calling from a workflow the bridge cannot name
      gap();
      onWorkflow = true;
    }
  }
  if (m.callerTeams?.length) {
    // teams are AGENT facts (an app is in no team): an app caller never matches, known facts or not (S2-2 review 0.5.0: else a
    // deny/hold by team refused Rules' own Governance read while the facts were missing, so they never came back)
    if (facts.caller.type !== "agent") return no("caller is not an agent");
    const have = strict ? facts.callerTeamsAny : facts.callerTeams;
    const why = fleet(m.callerTeams.some((t) => have.includes(t)), "caller is not in the teams");
    if (why) return no(why);
  }
  if (m.callerTrust?.length) {
    // the CALLING agent's trust (C373 D4b): an app has none, so it never matches; unknown agent = unreviewed
    if (facts.caller.type !== "agent") return no("caller is not an agent");
    const list = m.callerTrust;
    const trusts = facts.callerTrusts ?? ["unreviewed"];
    const met = strict ? trusts.some((t) => list.includes(t)) : facts.callerTrustActive !== false && trusts.length > 0 && trusts.every((t) => list.includes(t));
    const why = fleet(met, "caller's trust is not listed");
    if (why) return no(why);
  }
  if (m.recipients) {
    // C373 D5: unknown recipients fail closed; [] = known none; else ANY (deny/hold) or EVERY (allow) recipient, a Fleet fact
    const c = m.recipients;
    const list = facts.recipients;
    if (list == null) {
      gap();
      onRecipients = true;
    } else if (list.length === 0) return no("call has no recipients");
    else {
      const met = strict ? list.some((r) => recipientMatches(c, r, true)) : list.every((r) => recipientMatches(c, r, false));
      const why = fleet(met, strict ? "no recipient matches" : "not every recipient matches");
      if (why) return no(why);
    }
  }
  if (dependsOnClaim(spec)) {
    const obo = m.onBehalfOf as NonNullable<RuleSpec["match"]["onBehalfOf"]>;
    if (!useClaim) return no("needs an on-behalf-of claim (claims only narrow)");
    const c = facts.claim;
    if (!c) return no("no on-behalf-of claim");
    if (!anyOf(obo.kinds, c.kind)) return no("claim kind differs");
    if (obo.ids?.length && !obo.ids.includes(c.id) && !obo.ids.includes(handleOf(c.id) ?? "")) return no("claimed requester is not listed");
    if (obo.teams?.length) {
      const have = strict ? facts.claimTeamsAny : facts.claimTeams;
      const why = fleet(obo.teams.some((t) => have.includes(t)), "claimed requester is not in the teams");
      if (why) return no(why);
    }
    if (obo.trust?.length) {
      const list = obo.trust;
      const trusts = facts.claimTrusts;
      // deny/hold: ANY holder of the key has a listed trust; allow: EVERY holder is active and has a listed trust
      const met = strict ? trusts.some((t) => list.includes(t)) : facts.claimTrustActive && trusts.length > 0 && trusts.every((t) => list.includes(t));
      const why = fleet(met, "claimed requester's trust is not listed");
      if (why) return no(why);
    }
  }
  if (skipped) return { why: [onFleet && NEEDS_FLEET, onProduct && NEEDS_PRODUCT, onRecipients && NEEDS_RECIPIENTS, onWorkflow && NEEDS_WORKFLOW].filter(Boolean).join("; "), closed: false, skipped: true, onFleet, onProduct, onTool: false, onRecipients, onWorkflow };
  return { why: "", closed: closed || toolClosed, skipped: false, onFleet, onProduct, onTool: toolClosed, onRecipients, onWorkflow };
}

export function mismatch(spec: RuleSpec, facts: CallFacts, useClaim = true): string {
  return judge(spec, facts, useClaim).why;
}

/** Evaluation order: priority ascending, then newest update, then id. */
export function order(rules: readonly Rule[]): Rule[] {
  return [...rules].sort((a, b) => a.spec.priority - b.spec.priority || b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

interface Hit {
  rule: Rule | null;
  closed: boolean;
  /** what the closed decisive rule rests on: the Fleet facts, the calling app's product and/or an unknown tool */
  onFleet: boolean;
  onProduct: boolean;
  onTool: boolean;
  onRecipients: boolean;
  onWorkflow: boolean;
  /** merged narrowing of the allow rules skipped for unavailable facts (Fleet or product) that precede the decisive rule */
  skippedNarrowing: Narrowing | null;
  skippedRuleId: string | null;
  /** which unavailable facts the skipped allow rules that contributed that narrowing rest on */
  skipFleet: boolean;
  skipProduct: boolean;
  skipRecipients: boolean;
  skipWorkflow: boolean;
  /** the scan ended without a rule that matches on known facts: what follows the closed rules is the no-match path (the mode) */
  exhausted: boolean;
}

/**
 * The deciding rule. With the facts: the first rule that matches. WITHOUT them (unavailable Fleet facts or an unverified app
 * product): the HIGHEST severity (deny > hold > allow) among the closed deny/hold rules that precede the first rule that
 * matches without any unavailable fact, together with that rule; ties go to the earlier rule. A later deny therefore always
 * beats an earlier closed hold, so the result is never less strict than with the facts.
 */
function firstMatch(ordered: readonly Rule[], facts: CallFacts, useClaim: boolean): Hit {
  let skippedNarrowing: Narrowing | null = null;
  let skippedRuleId: string | null = null;
  let skipFleet = false;
  let skipProduct = false;
  let skipRecipients = false;
  let skipWorkflow = false;
  let worst: Rule | null = null;
  let worstJ: Judged | null = null;
  // Rules' own Governance read (exemption `rules-governance-feed`): a rule that matches it ONLY because the Governance facts are
  // missing never applies to it, else the read that brings them back is refused and they never come back (S2-2, defence in depth)
  const ownFeedRead = exemptionOf(facts) === "rules-governance-feed";
  for (const r of ordered) {
    const j = judge(r.spec, facts, useClaim);
    if (ownFeedRead && j.why === "" && j.closed && j.onFleet && !j.onProduct && !j.onTool && !j.onRecipients && !j.onWorkflow) continue;
    if (j.skipped) {
      const n = normNarrowing(r.spec.narrowing);
      if (n) {
        skippedNarrowing = mergeNarrowing(skippedNarrowing, n);
        skippedRuleId ??= r.id;
        skipFleet ||= j.onFleet;
        skipProduct ||= j.onProduct;
        skipRecipients ||= j.onRecipients;
        skipWorkflow ||= j.onWorkflow;
      }
    }
    if (j.why !== "") continue;
    if (j.closed) {
      if (!worst || SEVERITY[r.spec.outcome.decision] > SEVERITY[worst.spec.outcome.decision]) {
        worst = r;
        worstJ = j;
      }
      continue;
    }
    const decisive = worst && SEVERITY[worst.spec.outcome.decision] >= SEVERITY[r.spec.outcome.decision] ? worst : r;
    const closed = decisive === worst;
    return { rule: decisive, closed, onFleet: closed && !!worstJ?.onFleet, onProduct: closed && !!worstJ?.onProduct, onTool: closed && !!worstJ?.onTool, onRecipients: closed && !!worstJ?.onRecipients, onWorkflow: closed && !!worstJ?.onWorkflow, skippedNarrowing, skippedRuleId, skipFleet, skipProduct, skipRecipients, skipWorkflow, exhausted: false };
  }
  return { rule: worst, closed: worst !== null, onFleet: !!worstJ?.onFleet, onProduct: !!worstJ?.onProduct, onTool: !!worstJ?.onTool, onRecipients: !!worstJ?.onRecipients, onWorkflow: !!worstJ?.onWorkflow, skippedNarrowing, skippedRuleId, skipFleet, skipProduct, skipRecipients, skipWorkflow, exhausted: true };
}

function verdictOf(hit: Hit, facts: CallFacts, mode: DefaultMode): Verdict {
  const v = ruleVerdictOf(hit, facts, mode);
  // C236 with the default mode (C373c): closed rules that only apply because facts are missing, and NO rule that matches on known
  // facts after them. With the facts those rules might not match, and then the MODE decides; so the stricter of the closed rule
  // and the mode decides (ties: the rule). Without this, Closed mode would answer a hold where the known facts get a refusal.
  if (hit.rule && hit.closed && hit.exhausted && mode !== "permissive") {
    const m = ruleVerdictOf({ ...hit, rule: null }, facts, mode);
    if (SEVERITY[m.decision] > SEVERITY[v.decision]) return m;
  }
  return v;
}

function ruleVerdictOf(hit: Hit, facts: CallFacts, mode: DefaultMode): Verdict {
  const rule = hit.rule;
  // No rule matched: the workspace default mode decides (C373c, src/mode.ts); Permissive keeps this allow.
  if (!rule) return modeVerdict({ decision: "allow", reason: NO_MATCH_REASON, rule: null, narrowing: hit.skippedNarrowing, viaClaim: false, closedOnFleet: hit.skipFleet, closedOnProduct: hit.skipProduct, toolUnknown: false, recipientsUnknown: hit.skipRecipients, closedOnWorkflow: hit.skipWorkflow, narrowingRuleId: hit.skippedRuleId }, facts, mode);
  const own = rule.spec.outcome.decision === "allow" ? normNarrowing(rule.spec.narrowing) : null;
  const allow = rule.spec.outcome.decision === "allow";
  return {
    decision: rule.spec.outcome.decision,
    reason: rule.spec.outcome.reason,
    rule: { id: rule.id, rev: rule.rev, title: rule.spec.title },
    narrowing: allow ? mergeNarrowing(own, hit.skippedNarrowing) : null,
    viaClaim: dependsOnClaim(rule.spec),
    closedOnFleet: (hit.closed && hit.onFleet) || (allow && hit.skipFleet),
    closedOnProduct: (hit.closed && hit.onProduct) || (allow && hit.skipProduct),
    toolUnknown: hit.closed && hit.onTool,
    recipientsUnknown: (hit.closed && hit.onRecipients) || (allow && hit.skipRecipients),
    closedOnWorkflow: (hit.closed && hit.onWorkflow) || (allow && hit.skipWorkflow),
    narrowingRuleId: allow ? (own ? rule.id : hit.skippedRuleId) : null,
  };
}

type Lists = { anyOf?: string[]; noneOf?: string[] };

/** A narrowing list kept as the rule has it: `anyOf` present (even empty) stays, an empty `noneOf` is no constraint. */
function keepLists(t: Lists | undefined): Lists | null {
  if (!t || (t.anyOf === undefined && !t.noneOf?.length)) return null;
  return { ...(t.anyOf ? { anyOf: [...t.anyOf] } : {}), ...(t.noneOf?.length ? { noneOf: [...t.noneOf] } : {}) };
}

function normNarrowing(n: RuleSpec["narrowing"]): Narrowing | null {
  const tags = keepLists(n?.memoryTags);
  const sets = keepLists(n?.deepDatasets);
  if (!tags && !sets) return null;
  return { ...(tags ? { memoryTags: tags } : {}), ...(sets ? { deepDatasets: sets } : {}) };
}

/**
 * Local copy of the shared dataset comparison (spec 0.1.68 at specs#47 bd00164, SDK-API 18.5 rules 3 and 4). Dataset ids are the
 * data app's canonical ids: EXACT and CASE-SENSITIVE, no trimming, no case folding, no Unicode normalisation. Key absent → pass.
 * Key present → `ids` must be non-empty (an empty list means "every dataset", rule 4, so it FAILS under `noneOf` as under `anyOf`);
 * then `anyOf` present → every id is in it (`anyOf: []` passes nothing) and `noneOf` present → no id is in it. How the data app
 * restricts a call that names no dataset is its own job (rule 4); there is no lineage (rule 4a).
 * TODO(C336 RQ-2): LOCAL COPY of the shared `datasetsMatch` (spec 0.1.68 contract). The newest released @opt2-tealbrick/manifest
 * (0.1.31, spec 0.1.64; pinned in 0.5.0) does not export it yet. One mechanism (L1): delete this copy and import the helper when a
 * released manifest package carries it and Rules pins that release.
 */
export function datasetsMatch(deepDatasets: Lists | undefined, ids: readonly string[]): boolean {
  if (!deepDatasets) return true;
  if (ids.length === 0) return false;
  if (deepDatasets.anyOf !== undefined) {
    const allowed = new Set(deepDatasets.anyOf);
    if (!ids.every((n) => allowed.has(n))) return false;
  }
  const denied = new Set(deepDatasets.noneOf ?? []);
  return !ids.some((n) => denied.has(n));
}

/** Merge two optional narrowing lists: anyOf intersect, noneOf unite, items compared through `norm`; a list on either side survives. */
function mergeLists(x: Lists | undefined, y: Lists | undefined, norm: (s: string) => string): Lists | undefined {
  if (!x && !y) return undefined;
  const nl = (list: readonly string[] | undefined) => (list ? [...new Set(list.map(norm))] : undefined);
  const xa = nl(x?.anyOf);
  const ya = nl(y?.anyOf);
  const any = xa && ya ? xa.filter((t) => ya.includes(t)) : (xa ?? ya);
  const none = [...new Set([...(nl(x?.noneOf) ?? []), ...(nl(y?.noneOf) ?? [])])];
  return { ...(any ? { anyOf: any } : {}), ...(none.length ? { noneOf: none } : {}) };
}

/**
 * Both narrowings apply: anyOf lists intersect, noneOf lists unite (v1 capabilityNarrowing merge), for memory tags and for
 * datasets alike. Tags are compared after the shared `normalizeTag` (SDK-API §18.1), datasets EXACTLY (case-sensitive, spec 0.1.68). Disjoint
 * anyOf lists give `anyOf: []` = nothing passes (C115). A key that neither side has stays absent.
 */
export function mergeNarrowing(a: Narrowing | null, b: Narrowing | null): Narrowing | null {
  if (!a) return b;
  if (!b) return a;
  const tags = mergeLists(a.memoryTags, b.memoryTags, normalizeTag);
  const sets = mergeLists(a.deepDatasets, b.deepDatasets, (id) => id);
  return { ...(tags ? { memoryTags: tags } : {}), ...(sets ? { deepDatasets: sets } : {}) };
}

/** The decision for one call. `rules` must already be in evaluation order (see `order`). `mode` decides a call no rule matches (C373c). */
export function evaluate(ordered: readonly Rule[], facts: CallFacts, mode: DefaultMode = "permissive"): Verdict {
  const withClaim = verdictOf(firstMatch(ordered, facts, true), facts, mode);
  if (!facts.claim || facts.claimVerified) return withClaim;
  // Unverified claim: never wider than the decision without claim-dependent rules (C82). Always compare, also when the
  // decisive rule does not name the claim: a claim rule that matches ends the scan early, so an earlier closed hold
  // (Fleet facts unavailable) could decide where the scan without the claim reaches a later deny.
  const base = verdictOf(firstMatch(ordered, facts, false), facts, mode);
  const strict = SEVERITY[withClaim.decision] >= SEVERITY[base.decision] ? withClaim : base;
  if (strict.decision !== "allow") return strict;
  return { ...strict, narrowing: mergeNarrowing(withClaim.narrowing, base.narrowing), narrowingRuleId: strict.narrowingRuleId ?? (strict === withClaim ? base : withClaim).narrowingRuleId, closedOnFleet: withClaim.closedOnFleet || base.closedOnFleet, closedOnProduct: withClaim.closedOnProduct || base.closedOnProduct, recipientsUnknown: withClaim.recipientsUnknown || base.recipientsUnknown, closedOnWorkflow: withClaim.closedOnWorkflow || base.closedOnWorkflow };
}

/** "matches", or what a closed match rests on: unavailable Fleet facts or app product, and/or a call that names no tool. */
function closedWhy(j: Judged): string {
  if (!j.closed) return "matches";
  const names = [j.onFleet && "Fleet facts", j.onProduct && "the calling app's verified product"].filter(Boolean).join(" and ");
  const gaps = [names && `${names} ${j.onProduct && !j.onFleet ? "is" : "are"} unavailable`, j.onTool && "the call names no tool", j.onRecipients && "the call's recipients are unknown", j.onWorkflow && "the bridge cannot confirm the calling workflow"].filter(Boolean).join(" and ");
  return `matches: ${gaps}, so this rule applies (fail closed)`;
}

/** Per-rule explanation for the dry run. */
export function explain(ordered: readonly Rule[], facts: CallFacts): Step[] {
  return ordered.map((r) => {
    const j = judge(r.spec, facts, true);
    return { ruleId: r.id, title: r.spec.title, matched: j.why === "", why: j.why || closedWhy(j) };
  });
}

/** True when Rules must record this call's decision: a default-gated effect, or a rule decided it. */
export function recorded(facts: CallFacts, v: Verdict): boolean {
  return GATED_EFFECTS.has(facts.target.effect) || v.rule !== null || v.closedOnFleet || v.closedOnProduct || v.toolUnknown || v.recipientsUnknown || v.closedOnWorkflow || v.decision !== "allow";
}

/** Datasets pass the narrowing: `datasetsMatch` (local copy until the manifest package carries it, see its TODO). */
export function datasetsPass(names: readonly string[], n: Narrowing): boolean {
  return datasetsMatch(n.deepDatasets, names);
}

/** Tags pass the narrowing: THE G5 comparison, the manifest package's `tagsMatch` (Knowledge uses the same function, L1). */
export function tagsPass(tags: readonly string[], n: Narrowing): boolean {
  return tagsMatch(n.memoryTags, tags);
}

const MAX_NODES = 20_000;
const MAX_DEPTH = 32;

/**
 * JSON pointers of every object in `output` that carries `tags: string[]` failing the narrowing (results carry tags[],
 * spec 0.1.13 G5). Throws on outputs too large or deep to scan, so the after hook fails and the output is withheld.
 */
export function redactionsFor(output: unknown, n: Narrowing): string[] {
  const out: string[] = [];
  let nodes = 0;
  const esc = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");
  const walk = (v: unknown, ptr: string, depth: number): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error("output too large to filter");
    if (Array.isArray(v)) {
      v.forEach((x, i) => {
        walk(x, `${ptr}/${i}`, depth + 1);
      });
      return;
    }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.tags) && o.tags.every((t) => typeof t === "string") && ptr !== "" && !tagsPass(o.tags as string[], n)) {
      out.push(ptr);
      return;
    }
    for (const [k, x] of Object.entries(o)) walk(x, `${ptr}/${esc(k)}`, depth + 1);
  };
  walk(output, "", 0);
  // Remove array items from the end first so earlier pointers stay valid if the consumer applies them in order.
  return out.reverse();
}

/**
 * The canonical handle of a claim id, or null (G-4: the ONE shared `normalizeHandle` of @opt2-tealbrick/manifest; null
 * means "no match", never the raw input).
 */
export function handleOf(id: string): string | null {
  return sharedNormalizeHandle(id);
}

/**
 * Fleet member key for a claim: `contact:<id>` (a person claim names a directory contact), `agent:<id>`,
 * `handle:<canonical handle>`. A channel sender whose id is not a valid handle has no key (null).
 */
export function claimKey(c: Claim): string | null {
  if (c.kind === "channel_sender") {
    const h = handleOf(c.id);
    return h ? `handle:${h}` : null;
  }
  return c.kind === "person" ? `contact:${c.id}` : `agent:${c.id}`;
}

/** Problems a JSON schema cannot express. "" = fine. */
export function specProblem(spec: RuleSpec): string {
  if (spec.narrowing && spec.outcome.decision !== "allow") return "narrowing applies only to rules that allow";
  const t = spec.narrowing?.memoryTags;
  if (t && !t.anyOf && !(t.noneOf?.length)) return "narrowing.memoryTags needs anyOf or noneOf";
  // Writer strict (L24, C115): an owner-written empty anyOf would hide every memory; name at least one tag.
  if (t?.anyOf && !t.anyOf.some((tag) => normalizeTag(tag))) return "narrowing.memoryTags.anyOf needs at least one tag";
  const d = spec.narrowing?.deepDatasets;
  if (d && d.anyOf === undefined && !d.noneOf?.length) return "narrowing.deepDatasets needs anyOf or noneOf";
  // Writer strict (L24, C115): an owner-written empty anyOf would hide every dataset; name at least one.
  if (d?.anyOf?.length === 0) return "narrowing.deepDatasets.anyOf needs at least one dataset";
  // SDK-API 18.5 rule 1 (well-formed only): each list 0-64 strings of 1-128 chars. Ids compare EXACTLY, so a name with a space at
  // either end can never equal a canonical id: in anyOf it hides everything, in noneOf it blocks nothing (open), so refuse it.
  for (const list of [d?.anyOf, d?.noneOf]) {
    if (!list) continue;
    if (list.length > 64) return "narrowing.deepDatasets lists hold at most 64 names";
    if (list.some((name) => typeof name !== "string" || name.length < 1 || name.length > 128)) return "narrowing.deepDatasets names are 1 to 128 characters";
    if (list.some((name) => name !== name.trim())) return "narrowing.deepDatasets names are exact and case-sensitive: no space at either end";
  }
  const m = spec.match;
  if (m.operations?.length && !m.products?.length) return "operations need products (an operation id is unique only within one app)";
  if (m.tools?.length && !m.products?.length) return "tools need products (a tool name is unique only within one app)";
  const variant = m.tools?.find((t) => t.includes("__"));
  if (variant !== undefined) return `tools entry “${variant}” contains “__”: that is a resolved variant name, not a catalog tool name. Name the catalog tool (for example “${variant.split("__")[0] || "gmail_send"}”); it also covers its “__” variants`;
  if (m.tools?.some((t) => !t || t !== t.trim())) return "tools must not be blank or have a space at either end (tool names are exact and case-sensitive)";
  // QA-C354-3 (spec 0.1.74 DYNAMIC_CATALOG_NAME_RE): a tools entry is a catalog tool name, so a rule never names something no catalog can list.
  const malformed = m.tools?.find((t) => !CATALOG_TOOL_NAME.test(t));
  if (malformed !== undefined) return `tools entry “${malformed}” is not a catalog tool name: lower case letters, digits and single “_”, 2 to 48 characters, starting with a letter and not ending in “_”`;
  const cp = m.callerProducts ?? [];
  if (cp.length) {
    const bad = cp.find((p) => !validProduct(p));
    if (bad !== undefined) return `callerProducts has “${String(bad).slice(0, 40)}”, which is not a product id (lower-case letters, digits, - and _; at most 40 characters)`;
    const twice = cp.find((p, i) => cp.indexOf(p) !== i);
    if (twice !== undefined) return `callerProducts lists “${twice}” twice`;
    // Agent-only criteria: an app call has an instance id (ins_…), no mode and no teams, so the rule could never match one.
    if (m.agents?.length && m.agents.every((a) => a.startsWith("agt_"))) return "callerProducts names apps, but agents lists only agents (agt_…), so the rule would never match an app call (an app is listed by its instance id, ins_…)";
    if (m.modes?.length) return "callerProducts names apps, but modes (free, bound) apply to agents only, so the rule would never match an app call";
    if (m.callerTeams?.length) return "callerProducts names apps, but callerTeams are teams of agents (an app is in none), so the rule would never match an app call";
    if (m.callerTrust?.length) return "callerProducts names apps, but callerTrust is the trust of a calling agent (an app has none), so the rule would never match";
  }
  const ct = m.callerTrust ?? [];
  if (ct.length) {
    const twice = ct.find((t, i) => ct.indexOf(t) !== i);
    if (twice !== undefined) return `callerTrust lists “${twice}” twice`;
    if (ct.some((t) => !(TRUSTS as readonly string[]).includes(t))) return "callerTrust values are unreviewed, trusted, limited or blocked";
    // an app caller has no agent trust: agents that lists only app instances (ins_…) could never match
    if (m.agents?.length && m.agents.every((a) => a.startsWith("ins_"))) return "callerTrust is the trust of a calling agent, but agents lists only apps (ins_…), so the rule would never match";
  }
  const cw = m.callerWorkflows ?? [];
  if (cw.length) {
    const bad = cw.find((w) => typeof w !== "string" || !WORKFLOW_ID.test(w));
    if (bad !== undefined) return `callerWorkflows has “${String(bad).slice(0, 40)}”, which is not a workflow id (a lower-case letter, then 2 to 39 lower-case letters, digits or -)`;
    const twice = cw.find((w, i) => cw.indexOf(w) !== i);
    if (twice !== undefined) return `callerWorkflows lists “${twice}” twice`;
    // only Evolving Workflows runs workflows: say so in callerProducts (the rule is then never read as "any app")
    if (!m.callerProducts?.includes(WORKFLOW_PRODUCT)) return `callerWorkflows are workflows of Evolving Workflows: add “${WORKFLOW_PRODUCT}” to callerProducts`;
  }
  const rc = m.recipients;
  if (rc !== undefined) {
    // C373 D5 (S2): recipients exist only on outward calls, and unknown recipients make a deny/hold APPLY. So a recipients rule
    // must name `effects` EXACTLY ["outward"]: with no effects, products only, or another effect next to outward it would hold or
    // refuse every read and write (their recipients are always unknown).
    if (!rc || typeof rc !== "object" || (rc.teams === undefined && rc.trust === undefined && rc.known === undefined)) return "recipients needs teams, trust or known (an empty object would name nobody)";
    if (rc.teams !== undefined && rc.teams.length === 0) return "recipients.teams needs at least one team";
    if (rc.trust !== undefined && rc.trust.length === 0) return "recipients.trust needs at least one trust value";
    if (rc.trust?.some((t) => !(TRUSTS as readonly string[]).includes(t))) return "recipients.trust values are unreviewed, trusted, limited or blocked";
    if (rc.known !== undefined && typeof rc.known !== "boolean") return "recipients.known is true or false";
    if (m.effects?.length !== 1 || m.effects[0] !== "outward") return "recipients need effects exactly [outward]: only outward calls have recipients, and any other call’s recipients are unknown, so a refuse or hold rule would apply to every one of them";
  }
  return "";
}

/**
 * The strictest narrowing that could apply to a call: every active allow rule that has a narrowing and matches on the
 * criteria that need no Fleet fact (caller, mode, product, operation, effect, the calling app's product when it is verified, and for claim rules: a claim of a listed kind and id), merged (and, for a rule that names tools, a call that carries one of them). Used when the verdict pinned by the
 * before phase is missing (fail closed). `null` = no allow rule could narrow it.
 */
export function strictestNarrowing(ordered: readonly Rule[], facts: CallFacts): Narrowing | null {
  let n: Narrowing | null = null;
  for (const r of ordered) {
    const sp = r.spec;
    if (!sp.active || sp.outcome.decision !== "allow") continue;
    const m = sp.match;
    if (!anyOf(m.agents, facts.caller.id) || !anyOf(m.modes, facts.caller.mode) || !anyOf(m.products, facts.target.product) || !anyOf(m.operations, facts.target.op) || !anyOf(m.effects, facts.target.effect)) continue;
    if (m.tools?.length && !(facts.target.tool !== undefined && toolListed(m.tools, facts.target.tool))) continue;
    // a product rule can apply to an app only: with the verified product it must list it; without one it could apply (fail closed)
    // a callerTrust rule can apply to an agent only (its trust is a Fleet fact: could apply)
    if (m.callerTrust?.length && facts.caller.type !== "agent") continue;
    // a callerTeams rule can apply to an agent only (an app is in no team)
    if (m.callerTeams?.length && facts.caller.type !== "agent") continue;
    // a recipients rule cannot apply to a call known to name no recipient; unknown recipients and their facts could apply
    if (m.recipients && facts.recipients?.length === 0) continue;
    // a workflow rule applies to an app only; a verified workflow must be listed; without one it could apply only on the strict path
    if (m.callerWorkflows?.length) {
      if (facts.caller.type !== "app") continue;
      const w = facts.callerWorkflow ?? null;
      if (w !== null ? !m.callerWorkflows.includes(w) : facts.workflowCapVisible === true || (facts.callerProduct !== null && facts.callerProduct !== WORKFLOW_PRODUCT)) continue;
    }
    if (m.callerProducts?.length && (facts.caller.type !== "app" || (facts.callerProduct !== null && !m.callerProducts.includes(facts.callerProduct)))) continue;
    if (dependsOnClaim(sp)) {
      // a claim-dependent rule can apply only with a claim of a listed kind and id; teams and trust are Fleet facts (could apply)
      const c = facts.claim;
      const o = m.onBehalfOf as NonNullable<typeof m.onBehalfOf>;
      if (!c || !anyOf(o.kinds, c.kind) || (o.ids?.length && !o.ids.includes(c.id) && !o.ids.includes(handleOf(c.id) ?? ""))) continue;
    }
    n = mergeNarrowing(n, normNarrowing(sp.narrowing));
  }
  return n;
}
