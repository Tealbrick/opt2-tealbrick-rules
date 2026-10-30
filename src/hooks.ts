// Hook handlers (MANIFEST §8, BRIDGE §8.2). The bridge calls them for every agent-audience call in the workspace
// (manifest `match`); the SDK route checks the hook proof and the timeout. Each handler decides from Rules' own
// cached tables only: no app call (G3), no model call, no network. Every error refuses (fail closed).
import { performance } from "node:perf_hooks";
import { hookResponseProblem, normalizeHandle } from "@opt2-tealbrick/manifest";
import type { Db, HookContext, HookHandler, HookRequest, Json } from "@opt2-tealbrick/miniapp-sdk";
import { isDynamicOp } from "./catalog.ts";
import { type ActingFact, type CallFacts, type Claim, claimKey, evaluate, type FloorSubjects, floorHit, floorVerdict, mergeNarrowing, type Narrowing, type RecipientFact, recorded, redactionsFor, strictestNarrowing, type Verdict, validProduct, WORKFLOW_CAP, WORKFLOW_ID, wellFormedTool } from "./engine.ts";
import { FLOOR_REASON, floorIndex, noteGate } from "./floor.ts";
import { modeDetail } from "./mode.ts";
import { currentMode } from "./mode-store.ts";
import { type FleetFacts, fleetFacts, liveRules, recordDecision } from "./store.ts";

/** Rules' own answer budget, far below the bridge's 2 s hook limit: slower → refuse. */
export const GATE_BUDGET_MS = 250;
/**
 * Spec 0.1.13 (G1): a before hook may answer hold with family `policy`. Feature check with the ONE hook-answer
 * validator (manifest 0.1.8, the same the SDK route and the bridge use): if it refused a policy hold, Rules would
 * fall back to refusing (fail closed) instead of sending an answer the SDK would turn into hook_failed.
 */
export const HOLD_SUPPORTED = hookResponseProblem("before", { allow: false, reason: "probe", hold: { family: "policy", reason: "probe" } }, "rules") === null;
export const REASON_MAX = 280;
export const FAIL_CLOSED = "Rules could not decide this call in time, so it is refused (fail closed).";

const clamp = (s: string) => (s.length <= REASON_MAX ? s : `${s.slice(0, REASON_MAX - 1)}…`);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** `tb.onBehalfOf` (bridge, spec 0.1.13 G4b): `{ claim: {kind, id, display?}, verified, via }`. Malformed → no claim. */
export function claimOf(context: Record<string, unknown>): { claim: Claim | null; verified: boolean } {
  const o = context["tb.onBehalfOf"];
  if (!isObj(o) || !isObj(o.claim)) return { claim: null, verified: false };
  const { kind, id } = o.claim;
  if ((kind !== "person" && kind !== "agent" && kind !== "channel_sender") || typeof id !== "string" || id.length === 0 || id.length > 256) return { claim: null, verified: false };
  return { claim: { kind, id }, verified: o.verified === true };
}

/**
 * What the Fleet read model says about the claimed requester. Two team sets: `claimTeamsAny` = every membership (deny/hold
 * rules), `claimTeams` = memberships that count (allow rules). Live facts of Governance's context hook add teams to the
 * `Any` set always, and to the allow set only when the read model does not know the requester to be gone: the key has a
 * blocked/departed/removed holder, or it is a member somewhere but counts nowhere (a member the producer left out). Trust is
 * the holders' trust SET and whether all are active; a requester the directory does not know is `unreviewed` and active.
 */
export function claimFleetFacts(fx: FleetFacts, claim: Claim | null, live: readonly string[] = []): Pick<CallFacts, "claimTeams" | "claimTeamsAny" | "claimTrusts" | "claimTrustActive"> {
  if (!claim) return { claimTeams: [], claimTeamsAny: [], claimTrusts: [], claimTrustActive: true };
  const key = claimKey(claim);
  const teams = new Set<string>(key ? (fx.teams.get(key) ?? []) : []);
  const teamsAny = new Set<string>(key ? (fx.teamsAny.get(key) ?? []) : []);
  const knownGone = key !== null && (fx.gone.has(key) || (fx.teamsAny.has(key) && !fx.teams.has(key)));
  for (const t of live) {
    teamsAny.add(t);
    if (!knownGone) teams.add(t);
  }
  const entry = key ? fx.trust.get(key) : undefined;
  return {
    claimTeams: [...teams],
    claimTeamsAny: [...teamsAny],
    claimTrusts: fx.available ? (entry?.trusts ?? ["unreviewed"]) : [],
    claimTrustActive: entry?.allActive ?? true,
  };
}

/**
 * Spec 0.1.68 (C336 RQ-2, bridge cap `hook_tool`): `call.target.tool` = the dynamic catalog entry name of a dynamic call. The pinned SDK types
 * (miniapp-sdk 0.1.40, spec 0.1.64) do not carry it yet, so read it structurally. Anything but a catalog tool name (with at most one `__` variant suffix, ≤ 128 chars) = absent (S4-1).
 */
export function toolOf(req: HookRequest): string | undefined {
  const t = (req.call.target as { tool?: unknown }).tool;
  // S4-1: a value that is no catalog tool name (`Gmail_Send`, `gmail_send `) would match no tools rule: it counts as ABSENT, so a
  // deny or hold tools rule on a dynamic op applies (fail closed) and an allow tools rule does not
  return typeof t === "string" && t.length > 0 && t.length <= 128 && wellFormedTool(t) ? t : undefined;
}

/**
 * The tool facts of a call: `tool` (when sent) and `dynamic` (from the local app catalog, a cached table: no network). A
 * `tools` rule needs both to fail closed on a dynamic op that arrives without a tool (see engine.ts); `dynamic` is absent when
 * the catalog cannot place the op, which counts as dynamic there. Never throws: a catalog read that fails leaves `dynamic` unknown.
 */
export function toolFacts(req: HookRequest, db: Db): { tool?: string; dynamic?: boolean } {
  const tool = toolOf(req);
  let dynamic: boolean | undefined;
  try {
    dynamic = isDynamicOp(db, req.call.target.product, req.call.target.op);
  } catch {
    dynamic = undefined;
  }
  return { ...(tool !== undefined ? { tool } : {}), ...(dynamic !== undefined ? { dynamic } : {}) };
}

/**
 * The VERIFIED product of the caller (spec 0.1.45 `HookCallInfo.caller.product`: the calling instance's product from the bridge's
 * signed config), for an APP caller only. Never read from input, context or a name. Absent (an agent, a bridge older than 0.2.2, a
 * caller the bridge cannot map) or not a product id: null, which callerProducts rules treat as unverified (fail closed).
 */
export function callerProductOf(caller: HookRequest["call"]["caller"]): string | null {
  return caller.type === "app" && validProduct(caller.product) ? caller.product : null;
}

/** The reason of a narrowing that comes from another (skipped or earlier) allow rule: with the unavailable facts when there are some, neutral when there are none. */
export function otherRuleNarrowing(gaps: string): string {
  return gaps ? `${gaps.charAt(0).toUpperCase()}${gaps.slice(1)}: the narrowing of an allow rule applies` : "The narrowing of an allow rule applies";
}

/** Trace detail flags: which unavailable facts made a rule apply (or skipped an allow rule that narrows), and a dynamic call without a tool name. */
export function unavailableDetail(v: Pick<Verdict, "closedOnFleet" | "closedOnProduct" | "toolUnknown" | "recipientsUnknown" | "closedOnWorkflow">): Record<string, boolean> {
  return { ...(v.closedOnFleet ? { fleetUnavailable: true } : {}), ...(v.closedOnProduct ? { callerProductUnavailable: true } : {}), ...(v.toolUnknown ? { toolUnknown: true } : {}), ...(v.recipientsUnknown ? { recipientsUnknown: true } : {}), ...(v.closedOnWorkflow ? { workflowUnavailable: true } : {}) };
}

/**
 * The CALLING agent's trust (C373 D4b) from the Fleet read model (key `agent:<id>`, feed agents[].trust): the trust set and
 * whether it is active (not blocked, not removed). An agent the directory does not know is `unreviewed` and active. An app
 * caller has no agent trust ([]; a `callerTrust` rule never matches it). While the facts are unavailable: [] (the engine fails closed).
 */
export function callerTrustFacts(fx: FleetFacts, caller: { type: string; id: string }): Pick<CallFacts, "callerTrusts" | "callerTrustActive"> {
  if (caller.type !== "agent" || !fx.available) return { callerTrusts: [], callerTrustActive: true };
  const entry = fx.trust.get(`agent:${caller.id}`);
  return { callerTrusts: entry?.trusts ?? ["unreviewed"], callerTrustActive: entry?.allActive ?? true };
}

const ACTING_ID = /^agt_[0-9A-HJKMNP-TV-Z]{26}$/;
/**
 * C378 (spec 0.1.88, cap `acting_agents`): the agent ids of `tb.acting`, which only the bridge writes and the proof covers. The pinned SDK types do not
 * carry it, so it is read structurally. Absent = none. Present but malformed throws: the gate answers FAIL_CLOSED (only a bridge bug gets here).
 */
export function actingIdsOf(context: Record<string, unknown>): string[] {
  const o = context["tb.acting"];
  if (o === undefined) return [];
  const agents = isObj(o) ? o.agents : undefined;
  if (!Array.isArray(agents) || agents.length === 0 || agents.length > 4) throw new Error("tb.acting malformed");
  return agents.map((a) => {
    const id = isObj(a) ? a.id : undefined;
    if (typeof id !== "string" || !ACTING_ID.test(id)) throw new Error("tb.acting malformed");
    return id;
  });
}

/** The Fleet facts of the acting agents (key `agent:<id>`): every membership and the trust set; an agent the directory does not know is `unreviewed`. */
export function actingFacts(fx: FleetFacts, ids: readonly string[]): ActingFact[] {
  return ids.map((id) => ({ id, teamsAny: fx.teamsAny.get(`agent:${id}`) ?? [], rolesAny: fx.rolesAny?.get(`agent:${id}`) ?? [], trusts: fx.available ? (fx.trust.get(`agent:${id}`)?.trusts ?? ["unreviewed"]) : [] }));
}

/**
 * C373 D2c (Evolution P1): the VERIFIED workflow id of an APP caller (`HookCallInfo.caller.workflow` = the grant's `wfl`), or null.
 * The pinned SDK types (spec 0.1.64) do not carry it yet, so it is read structurally (TODO(C373 D2c): use the typed field when the
 * spec pin has P1). An agent, an absent value or one that is not a workflow id: null.
 */
export function workflowOf(caller: HookRequest["call"]["caller"]): string | null {
  const w = (caller as { workflow?: unknown }).workflow;
  return caller.type === "app" && typeof w === "string" && WORKFLOW_ID.test(w) ? w : null;
}

/**
 * The bridge capabilities (`ctx.bridgeCaps()`, SDK 0.1.37+: the CURRENT verified slice's `bridge.caps`). The SDK hands it to the
 * start, event, job and op contexts but NOT to the hook context (SDK 0.1.40), so `onStart` registers it per database here and
 * the hooks read it from memory (no network). Never registered (before the claim, a test, an older SDK) or a throwing reader =
 * no caps: the strict path.
 */
const capsReaders = new WeakMap<Db, () => readonly string[]>();
export function registerBridgeCaps(db: Db, read: (() => readonly string[]) | undefined): void {
  if (typeof read === "function") capsReaders.set(db, read);
}
export function bridgeCapsOf(db: Db): readonly string[] {
  try {
    const caps = capsReaders.get(db)?.();
    return Array.isArray(caps) ? caps : [];
  } catch {
    return [];
  }
}
/** Whether the bridge cap `app_workflow_grants` is visible (C373 D2c): then a call without a workflow is not a workflow call. */
export const workflowCapVisible = (db: Db): boolean => bridgeCapsOf(db).includes(WORKFLOW_CAP);

/** At most this many recipients per call (CONTRACT-RECIPIENTS: the bridge caps `target.recipients` at 64 and sets `recipientsIncomplete` above). */
export const MAX_RECIPIENTS = 64;

/**
 * C373 D5 (CONTRACT-RECIPIENTS, spec 0.1.81, bridge cap `hook_recipients`): the canonical recipient handles of the call, or null =
 * UNKNOWN. The pinned SDK types (spec 0.1.64) do not carry `target.recipients` / `target.recipientsIncomplete` yet, so they are read
 * structurally (TODO(C373 D5): use the typed fields when Rules pins the spec release that has them). Unknown: absent, not an array,
 * `recipientsIncomplete: true`, more than 64, or any value that is not a string with `normalizeHandle(h) === h` (the bridge sends
 * canonical handles only; anything else means the list cannot be trusted to be complete).
 */
export function recipientsOf(target: unknown): string[] | null {
  const t = (isObj(target) ? target : {}) as { recipients?: unknown; recipientsIncomplete?: unknown };
  if (t.recipientsIncomplete === true || !Array.isArray(t.recipients) || t.recipients.length > MAX_RECIPIENTS) return null;
  const out = new Set<string>();
  for (const h of t.recipients) {
    if (typeof h !== "string" || normalizeHandle(h) !== h) return null;
    out.add(h);
  }
  return [...out];
}

/**
 * The Fleet facts of each recipient handle (`handle:<h>` and its holders); never the handle itself. Unknown stays null. A copy read
 * WITHOUT agent handles (S3-1: older Governance, the window after a 400 to `accept`, a restart) may miss an agent holder of any
 * handle, so a call that names recipients has UNKNOWN recipients then (deny/hold recipient rules apply, allow ones do not).
 */
export function recipientFacts(fx: FleetFacts, handles: readonly string[] | null): RecipientFact[] | null {
  if (handles === null) return null;
  if (fx.available && !fx.agentHandles && handles.length > 0) return null;
  return handles.map((h) => {
    const key = `handle:${h}`;
    const entry = fx.trust.get(key);
    return { teams: fx.teams.get(key) ?? [], teamsAny: fx.teamsAny.get(key) ?? [], trusts: entry?.trusts ?? ["unreviewed"], allActive: entry?.allActive ?? true, known: entry !== undefined };
  });
}

/**
 * C380: every well-formed recipient of the call, also from a list `recipientsOf` calls unknown. A partial list still names the people it names, so
 * `recipientsIncomplete`, a list over the cap or one bad value never hides a stopped recipient. A value that reads as no handle is skipped.
 */
export function floorRecipients(target: unknown): string[] {
  const raw = isObj(target) ? target.recipients : undefined;
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const v of raw) {
    const h = typeof v === "string" ? normalizeHandle(v) : null;
    if (h) out.add(h);
  }
  return [...out];
}

/** Rules' own ops the floor never refuses: an agent can read why it was stopped, and Governance can read the floor. `rule_draft_submit` is NOT here. */
export const FLOOR_EXEMPT_OPS: ReadonlySet<string> = new Set(["rules_explain", "draft_status", "floor_status"]);

/**
 * Who the floor checks on this call, or null when it does not apply: the exempt ops of Rules itself (by product AND op, another app's op of the same name is not exempt) and Rules'
 * own read of the feed, which is the only thing that can bring a change back. A malformed `tb.acting` throws: the gate refuses.
 */
export function floorSubjectsOf(req: HookRequest): FloorSubjects | null {
  const { caller, target } = req.call;
  if (target.product === "rules" && FLOOR_EXEMPT_OPS.has(target.op)) return null;
  if (callerProductOf(caller) === "rules" && target.product === "fleet" && target.op === "directory_feed") return null;
  const ctx = (req.context ?? {}) as Record<string, unknown>;
  return { callerAgent: caller.type === "agent" ? caller.id : null, acting: actingIdsOf(ctx), claim: claimOf(ctx).claim, recipients: floorRecipients(target) };
}

/** Facts for one hook call: caller (and its teams, trust and verified product), target, claim, and the claim's teams and trust (see `claimFleetFacts`). */
export function factsOf(req: HookRequest, db: Db, now = Date.now()): CallFacts {
  const ctx = (req.context ?? {}) as Record<string, unknown>;
  const { claim, verified } = claimOf(ctx);
  const fx = fleetFacts(db, now);
  const liveRaw = ctx["fleet.requesterTeams"];
  const live = Array.isArray(liveRaw) ? liveRaw.flatMap((t) => (isObj(t) && typeof t.id === "string" ? [t.id] : [])) : [];
  const callerKey = req.call.caller.type === "agent" ? `agent:${req.call.caller.id}` : null;
  return {
    caller: { type: req.call.caller.type, id: req.call.caller.id, mode: req.call.caller.mode ?? null },
    target: { product: req.call.target.product, op: req.call.target.op, effect: req.call.target.effect, ...toolFacts(req, db) },
    claim,
    claimVerified: verified,
    ...claimFleetFacts(fx, claim, live),
    callerTeams: callerKey ? (fx.teams.get(callerKey) ?? []) : [],
    callerTeamsAny: callerKey ? (fx.teamsAny.get(callerKey) ?? []) : [],
    callerRoles: callerKey ? (fx.roles?.get(callerKey) ?? []) : [],
    callerRolesAny: callerKey ? (fx.rolesAny?.get(callerKey) ?? []) : [],
    rolesKnown: fx.rolesKnown,
    ...callerTrustFacts(fx, req.call.caller),
    acting: req.call.caller.type === "app" ? actingFacts(fx, actingIdsOf(ctx)) : [],
    recipients: recipientFacts(fx, recipientsOf(req.call.target)),
    callerWorkflow: workflowOf(req.call.caller),
    workflowCapVisible: workflowCapVisible(db),
    fleetAvailable: fx.available,
    callerProduct: callerProductOf(req.call.caller),
  };
}

// ── pinned verdicts: the before phase decides, the after phase redacts by THAT narrowing ────────────────────
/** A pin lives at least the after hook's timeout plus the op timeout plus 60 s. */
export const PIN_TTL_MS = 2_000 + 30_000 + 60_000;
/** At most this many pins per database (oldest first out); an evicted or expired pin means "missing" (fail closed). */
export const PIN_MAX = 20_000;
const pins = new WeakMap<Db, Map<string, { narrowing: Narrowing | null; exp: number }>>();

export function pinVerdict(db: Db, callId: string, narrowing: Narrowing | null, now = Date.now()): void {
  let m = pins.get(db);
  if (!m) {
    m = new Map();
    pins.set(db, m);
  }
  m.delete(callId);
  // insertion order = expiry order (one TTL), so expired pins are at the front
  for (const [k, v] of m) {
    if (v.exp > now && m.size < PIN_MAX) break;
    m.delete(k);
  }
  m.set(callId, { narrowing, exp: now + PIN_TTL_MS });
}

/** The pinned narrowing of a call: `undefined` = no pin (never pinned, expired, evicted, or the app restarted). */
export function pinnedNarrowing(db: Db, callId: string, now = Date.now()): Narrowing | null | undefined {
  const p = pins.get(db)?.get(callId);
  return p && p.exp > now ? p.narrowing : undefined;
}

/**
 * A hold also carries `reason`: a bridge with the hold verdict (≥ 0.1.16) keeps the hold and ignores it (manifest
 * reduceBeforeChain); an older bridge sees `{allow: false, reason}` and refuses the call with that reason (fail closed).
 */
export type GateAnswer = { allow: true } | { allow: false; reason: string } | { allow: false; reason: string; hold: { family: "policy"; reason: string } };

/** The before-hook answer for a verdict. Hold without spec 0.1.13 → refuse with the reason (fail closed). */
export function gateAnswer(v: Verdict, holdSupported = HOLD_SUPPORTED): { answer: GateAnswer; answered: "allow" | "deny" | "hold" } {
  // C380 S2-8: one sentence for every floor refusal. The full reason is in Decisions; the caller cannot tell who was not active from the words.
  if (v.floor) return { answer: { allow: false, reason: FLOOR_REASON }, answered: "deny" };
  const tag = v.rule ? ` (rule ${v.rule.id})` : "";
  if (v.decision === "allow") return { answer: { allow: true }, answered: "allow" };
  if (v.decision === "hold" && holdSupported) {
    const reason = clamp(`Needs owner review: ${v.reason}${tag}`);
    return { answer: { allow: false, reason, hold: { family: "policy", reason } }, answered: "hold" };
  }
  if (v.decision === "hold")
    return { answer: { allow: false, reason: clamp(`Rules: ${v.reason}${tag}. This needs owner review, which this workspace cannot hold yet, so the call is refused.`) }, answered: "deny" };
  return { answer: { allow: false, reason: clamp(`Rules: ${v.reason}${tag}`) }, answered: "deny" };
}

function elapsedUs(t0: number): number {
  return (performance.now() - t0) * 1000;
}

/** Builds the three handlers. `product` (the manifest id) prefixes context keys; `now` and `budgetMs` are test seams. */
export function makeHooks(product: string, opts: { budgetMs?: number; holdSupported?: boolean; clock?: () => number } = {}): Record<string, HookHandler> {
  const budget = opts.budgetMs ?? GATE_BUDGET_MS;
  const clock = opts.clock ?? (() => performance.now());

  async function rules_gate(req: HookRequest, ctx: HookContext): Promise<GateAnswer> {
    const t0 = clock();
    try {
      noteGate(ctx.db, Date.now());
      const facts = factsOf(req, ctx.db);
      // C380 S1-1: the company floor, before every rule, in all modes. It reads its own table, never `fleetFacts().available`.
      const subjects = floorSubjectsOf(req);
      const hit = subjects ? floorHit(floorIndex(ctx.db), subjects) : null;
      // the default mode decides a call no rule matches (C373c); cached like the rules, no query per call
      const v = hit ? floorVerdict(hit) : evaluate(liveRules(ctx.db), facts, currentMode(ctx.db));
      const { answer, answered } = gateAnswer(v, opts.holdSupported ?? HOLD_SUPPORTED);
      if (ctx.signal.aborted || clock() - t0 > budget) throw new Error("gate budget exceeded");
      // The after hook redacts by the narrowing decided HERE (read calls only: that is where rules_filter runs).
      if (v.decision === "allow" && facts.target.effect === "read") pinVerdict(ctx.db, req.call.id, v.narrowing);
      if (recorded(facts, v)) {
        // C378: the Decisions row names the acting agents and a send-time check; never a ticket or a job's content
        const acting = facts.acting?.length ? { acting: facts.acting.map((a) => a.id) } : {};
        const recheck = (req.context as Record<string, unknown> | undefined)?.["tb.recheck"] === true ? { atSendTime: true } : {};
        const floor = v.floor ? { decidedBy: "floor", floor: v.floor } : {};
        const unavailable = { ...unavailableDetail(v), ...modeDetail(v), ...acting, ...recheck, ...floor };
        recordDecision(ctx.db, { callId: req.call.id, phase: "before", facts, decision: v.decision, answered, reason: v.reason, rule: v.rule, ...(Object.keys(unavailable).length ? { detail: unavailable } : {}), durationUs: elapsedUs(t0) });
      }
      return answer;
    } catch (e) {
      ctx.log.warn("rules_gate refused (fail closed)", { error: e instanceof Error ? e.message : "unknown", call: req.call.id });
      return { allow: false, reason: FAIL_CLOSED };
    }
  }

  async function rules_context(req: HookRequest, ctx: HookContext): Promise<{ add: Record<string, Json> }> {
    const t0 = clock();
    const facts = factsOf(req, ctx.db);
    // No default mode here (C373c): a call reaches this phase only when the gate allowed it or the owner approved its hold,
    // and it must carry the same narrowing it would carry in Permissive mode (skipped allow rules' narrowing included).
    const v = evaluate(liveRules(ctx.db), facts);
    const add: Record<string, Json> = {};
    if (v.rule) add[`${product}.matched`] = { v: 1, ruleId: v.rule.id, rev: v.rule.rev, decision: v.decision };
    if (facts.claim) add[`${product}.onBehalfOf`] = { claim: { ...facts.claim }, verified: facts.claimVerified, teams: [...facts.claimTeams] };
    const narrowingRuleId = v.narrowingRuleId;
    if (v.decision === "allow" && (v.narrowing?.memoryTags || v.narrowing?.deepDatasets) && narrowingRuleId) {
      // the reason belongs to the rule that decided; a narrowing that comes from another (skipped) rule says so
      const gaps = [v.closedOnFleet && "Governance data unavailable", v.closedOnProduct && "the calling app's product is unverified", v.recipientsUnknown && "the recipients are unknown", v.closedOnWorkflow && "the calling workflow is unconfirmed"].filter(Boolean).join("; ");
      const reason = v.rule && v.rule.id === narrowingRuleId ? v.reason : otherRuleNarrowing(gaps);
      // `deepDatasets` (spec 0.1.68, SDK-API §18.5) rides next to `memoryTags`; a key no rule set stays absent. `v: 2` EXACTLY
      // when deepDatasets is present, else `v: 1`: a reader without dataset narrowing refuses v 2 (narrowing_unsupported) instead of
      // answering unfiltered, so deepDatasets is never put under v 1.
      add[`${product}.narrowing`] = {
        v: v.narrowing.deepDatasets ? 2 : 1,
        ruleId: narrowingRuleId,
        reason: clamp(reason),
        ...(v.narrowing.memoryTags ? { memoryTags: v.narrowing.memoryTags as Json } : {}),
        ...(v.narrowing.deepDatasets ? { deepDatasets: v.narrowing.deepDatasets as Json } : {}),
      };
      recordDecision(ctx.db, { callId: req.call.id, phase: "context", facts, decision: v.decision, answered: "narrow", reason: v.reason, rule: v.rule, detail: { narrowing: v.narrowing as Record<string, unknown>, ...unavailableDetail(v) }, durationUs: elapsedUs(t0) });
    }
    if (clock() - t0 > budget) throw new Error("context budget exceeded");
    return { add };
  }

  async function rules_filter(req: HookRequest, ctx: HookContext): Promise<{ redactions?: string[] }> {
    if (req.phase !== "after") return {};
    const t0 = clock();
    const facts = factsOf(req, ctx.db);
    const rules = liveRules(ctx.db);
    const v = evaluate(rules, facts);
    // The before phase's verdict, kept per call. No pin (restart, expiry, eviction): the strictest narrowing that could
    // apply, together with the current verdict's (fail closed).
    const pin = pinnedNarrowing(ctx.db, req.call.id);
    const narrowing = pin !== undefined ? pin : mergeNarrowing(v.decision === "allow" ? v.narrowing : null, strictestNarrowing(rules, facts));
    if (!narrowing) return {};
    const redactions = redactionsFor(req.output, narrowing);
    if (redactions.length === 0) return {};
    recordDecision(ctx.db, {
      callId: req.call.id,
      phase: "after",
      facts,
      decision: "allow",
      answered: "redact",
      reason: v.reason,
      rule: v.rule,
      detail: { redacted: redactions.length, ...(pin === undefined ? { pinMissing: true } : {}) },
      durationUs: elapsedUs(t0),
    });
    return { redactions };
  }

  return { rules_gate, rules_context, rules_filter } as unknown as Record<string, HookHandler>;
}
