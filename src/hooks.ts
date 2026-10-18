// Hook handlers (MANIFEST §8, BRIDGE §8.2). The bridge calls them for every agent-audience call in the workspace
// (manifest `match`); the SDK route checks the hook proof and the timeout. Each handler decides from Rules' own
// cached tables only: no app call (G3), no model call, no network. Every error refuses (fail closed).
import { performance } from "node:perf_hooks";
import { hookResponseProblem } from "@opt2-tealbrick/manifest";
import type { Db, HookContext, HookHandler, HookRequest, Json } from "@opt2-tealbrick/miniapp-sdk";
import { type CallFacts, type Claim, claimKey, evaluate, mergeNarrowing, type Narrowing, recorded, redactionsFor, strictestNarrowing, type Verdict, validProduct } from "./engine.ts";
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
 * The VERIFIED product of the caller (spec 0.1.45 `HookCallInfo.caller.product`: the calling instance's product from the bridge's
 * signed config), for an APP caller only. Never read from input, context or a name. Absent (an agent, a bridge older than 0.2.2, a
 * caller the bridge cannot map) or not a product id: null, which callerProducts rules treat as unverified (fail closed).
 */
export function callerProductOf(caller: HookRequest["call"]["caller"]): string | null {
  return caller.type === "app" && validProduct(caller.product) ? caller.product : null;
}

/** Trace detail flags: which unavailable facts made a rule apply (or skipped an allow rule that narrows). */
export function unavailableDetail(v: Pick<Verdict, "closedOnFleet" | "closedOnProduct">): Record<string, boolean> {
  return { ...(v.closedOnFleet ? { fleetUnavailable: true } : {}), ...(v.closedOnProduct ? { callerProductUnavailable: true } : {}) };
}

/** Facts for one hook call: caller (and its teams and verified product), target, claim, and the claim's teams and trust (see `claimFleetFacts`). */
export function factsOf(req: HookRequest, db: Db, now = Date.now()): CallFacts {
  const ctx = (req.context ?? {}) as Record<string, unknown>;
  const { claim, verified } = claimOf(ctx);
  const fx = fleetFacts(db, now);
  const liveRaw = ctx["fleet.requesterTeams"];
  const live = Array.isArray(liveRaw) ? liveRaw.flatMap((t) => (isObj(t) && typeof t.id === "string" ? [t.id] : [])) : [];
  const callerKey = req.call.caller.type === "agent" ? `agent:${req.call.caller.id}` : null;
  return {
    caller: { type: req.call.caller.type, id: req.call.caller.id, mode: req.call.caller.mode ?? null },
    target: { product: req.call.target.product, op: req.call.target.op, effect: req.call.target.effect },
    claim,
    claimVerified: verified,
    ...claimFleetFacts(fx, claim, live),
    callerTeams: callerKey ? (fx.teams.get(callerKey) ?? []) : [],
    callerTeamsAny: callerKey ? (fx.teamsAny.get(callerKey) ?? []) : [],
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
      const facts = factsOf(req, ctx.db);
      const v = evaluate(liveRules(ctx.db), facts);
      const { answer, answered } = gateAnswer(v, opts.holdSupported ?? HOLD_SUPPORTED);
      if (ctx.signal.aborted || clock() - t0 > budget) throw new Error("gate budget exceeded");
      // The after hook redacts by the narrowing decided HERE (read calls only: that is where rules_filter runs).
      if (v.decision === "allow" && facts.target.effect === "read") pinVerdict(ctx.db, req.call.id, v.narrowing);
      if (recorded(facts, v)) {
        const unavailable = unavailableDetail(v);
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
    const v = evaluate(liveRules(ctx.db), facts);
    const add: Record<string, Json> = {};
    if (v.rule) add[`${product}.matched`] = { v: 1, ruleId: v.rule.id, rev: v.rule.rev, decision: v.decision };
    if (facts.claim) add[`${product}.onBehalfOf`] = { claim: { ...facts.claim }, verified: facts.claimVerified, teams: [...facts.claimTeams] };
    const narrowingRuleId = v.narrowingRuleId;
    if (v.decision === "allow" && v.narrowing?.memoryTags && narrowingRuleId) {
      // the reason belongs to the rule that decided; a narrowing that comes from another (skipped) rule says so
      const gaps = [v.closedOnFleet && "Governance data unavailable", v.closedOnProduct && "the calling app's product is unverified"].filter(Boolean).join("; ");
      const reason = v.rule && v.rule.id === narrowingRuleId ? v.reason : `${gaps.charAt(0).toUpperCase()}${gaps.slice(1)}: the narrowing of an allow rule applies`;
      add[`${product}.narrowing`] = { v: 1, ruleId: narrowingRuleId, reason: clamp(reason), memoryTags: v.narrowing.memoryTags as Json };
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
