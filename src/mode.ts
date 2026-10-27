// The workspace DEFAULT MODE (C373c): what the gate answers for a call that matches NO rule. Pure functions, no I/O: the
// gate reads the mode from the per-database cache in `mode-store.ts` (no query per call) and `evaluate` applies it here.
//
// - `permissive`: allow (the behaviour of every Rules release before 0.5.0, and the mode of a fresh or upgraded install).
// - `verification`: HOLD (family `policy`), "Needs owner review: no rule covers this call (Verification mode)". The target
//   app holds the call like any Rules hold; the owner decides it in that app or in the operator Inbox.
// - `closed`: refuse, "Rules: no rule allows this call (Closed mode)".
//
// The mode decides ONLY the no-match path. A call that matches an allow rule is allowed in every mode, and deny and hold
// rules decide as before (narrowing, C373c (c)). The Fleet, product and tool fail-closed machinery is unchanged: an allow
// rule skipped for unavailable facts leaves the call unmatched, so the mode decides it.
//
// Built-in exemptions (ARCHITECTURE "Default mode"): calls that the platform needs and that the mode must never hold or
// refuse. They apply ONLY on the no-match path; an owner rule that matches such a call still decides it.
import type { CallFacts, Verdict } from "./engine.ts";

export const MODES = ["permissive", "verification", "closed"] as const;
export type DefaultMode = (typeof MODES)[number];
/** Strictness: a move to a lower number is a move to a LOOSER mode (needs `confirm: true`). */
export const MODE_STRICTNESS: Record<DefaultMode, number> = { permissive: 0, verification: 1, closed: 2 };
export const isMode = (v: unknown): v is DefaultMode => typeof v === "string" && (MODES as readonly string[]).includes(v);
export const looser = (from: DefaultMode, to: DefaultMode): boolean => MODE_STRICTNESS[to] < MODE_STRICTNESS[from];

export const MODE_LABEL: Record<DefaultMode, string> = { permissive: "Permissive", verification: "Verification", closed: "Closed" };
/** The verdict reasons; the gate prefixes them ("Needs owner review: …" for a hold, "Rules: …" for a refusal). */
export const VERIFICATION_REASON = "no rule covers this call (Verification mode)";
export const CLOSED_REASON = "no rule allows this call (Closed mode)";

export type ExemptionId = "rules-governance-feed" | "inbox-owner-alerts" | "rules-self-service" | "platform-standard-ops";

export interface Exemption {
  id: ExemptionId;
  title: string;
  text: string;
}

/** The read-only "system" lines of the Rules page (rules_list `system`, mode_get `exemptions`). */
export const EXEMPTIONS: readonly Exemption[] = [
  {
    id: "rules-governance-feed",
    title: "Rules reads Governance",
    text: "Calls from the Rules app itself (verified product rules) to Governance directory_feed are never held or refused by the mode. Rules needs them for team and trust rules.",
  },
  {
    id: "inbox-owner-alerts",
    title: "Inbox tells you",
    text: "Calls from Operator Inbox (verified product inbox) to Connect buzz_dm, buzz_dm_first, channel_dm and channel_dm_first are never held or refused by the mode. Inbox uses them to tell you that something waits for you.",
  },
  {
    id: "rules-self-service",
    title: "Agents ask Rules",
    text: "Calls to Rules’ own rules_explain, rule_draft_submit and draft_status are never held or refused by the mode, so an agent can see why it was stopped and draft a rule for you to approve.",
  },
  {
    id: "platform-standard-ops",
    title: "Platform hold checks",
    text: "Standard platform operations (tb.…, such as an agent checking its own hold or Inbox listing pending holds) are never held or refused by the mode.",
  },
];

/**
 * The Connect ops Operator Inbox uses to DM the owner about a new item (opt2-tealbrick-inbox `src/alerts.ts`: `buzz_dm`,
 * `channel_dm`, and on Connect's first-contact refusal `buzz_dm_first`, `channel_dm_first`; its manifest companion lists exactly these).
 */
const INBOX_OWNER_DM: ReadonlySet<string> = new Set(["buzz_dm", "buzz_dm_first", "channel_dm", "channel_dm_first"]);
/** Rules' own agent-audience operations: explain own decisions, submit a DRAFT (the owner approves it, C84), read own draft. */
const RULES_SELF_SERVICE: ReadonlySet<string> = new Set(["rules_explain", "rule_draft_submit", "draft_status"]);

/**
 * The built-in exemption a no-match call falls under, or null.
 * (a) The Rules instance reading Governance: caller is an APP whose VERIFIED product is `rules` (the bridge's signed
 *     `caller.product`; an `ins_` caller without a verified product is NOT exempt), target product `fleet`, op
 *     `directory_feed` only. Without it Closed/Verification would cut Rules off from Governance (fail-closed loop).
 * (a2) Operator Inbox's owner DM: caller an APP with VERIFIED product `inbox`, target product `connect`, the four owner-DM ops
 *     only. In Verification a mode hold makes Inbox DM the owner; that DM matching no rule would itself be held → a new hold →
 *     another DM → … (the hold-notification loop). Closed would silence every owner alert.
 * (b) Rules' own self-service ops (target product `rules`): an agent must be able to ask why and to propose a draft.
 * (c) Standard `tb.*` ops: hooks must never see them (MANIFEST §8); a bridge that still sends them must not get Inbox's
 *     `tb.holds_pending` or an agent's `tb.hold_status` held or refused by the mode.
 */
export function exemptionOf(facts: CallFacts): ExemptionId | null {
  const t = facts.target;
  if (facts.caller.type === "app" && facts.callerProduct === "rules" && t.product === "fleet" && t.op === "directory_feed") return "rules-governance-feed";
  if (facts.caller.type === "app" && facts.callerProduct === "inbox" && t.product === "connect" && INBOX_OWNER_DM.has(t.op)) return "inbox-owner-alerts";
  if (t.product === "rules" && RULES_SELF_SERVICE.has(t.op)) return "rules-self-service";
  if (t.op.startsWith("tb.")) return "platform-standard-ops";
  return null;
}

/**
 * The verdict of a call that matched no rule (`base` is the permissive no-match verdict that `evaluate` built: allow, with
 * the narrowing of skipped allow rules). Permissive and exempt calls keep it; Verification holds and Closed refuses.
 */
export function modeVerdict(base: Verdict, facts: CallFacts, mode: DefaultMode): Verdict {
  const exemption = mode === "permissive" ? null : exemptionOf(facts);
  if (mode === "permissive" || exemption) return { ...base, byMode: { mode, exemption } };
  return { ...base, decision: mode === "closed" ? "deny" : "hold", reason: mode === "closed" ? CLOSED_REASON : VERIFICATION_REASON, narrowing: null, narrowingRuleId: null, byMode: { mode, exemption: null } };
}

/** What decided a verdict: a rule, the default mode, or a built-in exemption of the mode. */
export type DecidedBy = "rule" | "mode" | "exemption";
export function decidedBy(v: Pick<Verdict, "rule" | "byMode">): DecidedBy {
  return v.rule ? "rule" : v.byMode?.exemption ? "exemption" : "mode";
}

/**
 * Trace detail of a mode decision: `{decidedBy: "mode", mode}` or `{decidedBy: "exemption", mode, exemption}`. Empty for a
 * rule decision. A call that matched no rule names the mode that let it through, also Permissive (QA-C373-RU-2: the no-match
 * write rows). Rows recorded before this release have no `decidedBy`; a row with no rule and no `decidedBy` still reads as
 * Permissive (`traceDecidedBy`).
 */
export function modeDetail(v: Pick<Verdict, "rule" | "byMode">): Record<string, string> {
  const b = v.byMode;
  if (v.rule || !b) return {};
  return b.exemption ? { decidedBy: "exemption", mode: b.mode, exemption: b.exemption } : { decidedBy: "mode", mode: b.mode };
}

/** A stored trace read back: what decided it (rows without `decidedBy` and without a rule are Permissive no-match rows). */
export function traceDecidedBy(ruleId: string | null, detail: Record<string, unknown> | null): { decidedBy: DecidedBy; mode: DefaultMode | null } {
  if (ruleId) return { decidedBy: "rule", mode: null };
  const mode = isMode(detail?.mode) ? detail.mode : "permissive";
  return { decidedBy: detail?.decidedBy === "exemption" ? "exemption" : "mode", mode };
}

/** One line for the dry run: "No rule matches → Verification mode would HOLD this call". Null when a rule decided. */
export function modeNote(v: Pick<Verdict, "rule" | "byMode" | "decision">): string | null {
  const b = v.byMode;
  if (v.rule || !b) return null;
  if (b.exemption) return `No rule matches → ${MODE_LABEL[b.mode]} mode does not apply to this call (system exemption: ${EXEMPTIONS.find((e) => e.id === b.exemption)?.title ?? b.exemption}), so it is ALLOWED`;
  const word = v.decision === "allow" ? "ALLOW" : v.decision === "hold" ? "HOLD" : "REFUSE";
  return `No rule matches → ${MODE_LABEL[b.mode]} mode would ${word} this call`;
}

/**
 * The English box (rule_compose) note for a proposal with an ALLOW rule: what the default mode does with every call the
 * proposed allow rules do not cover (C373c), so the owner reads the allow rule against the mode. [] when nothing allows.
 */
export function composeModeNotes(rules: readonly { outcome: { decision: string } }[], mode: DefaultMode): string[] {
  if (!rules.some((r) => r.outcome.decision === "allow")) return [];
  if (mode === "closed") return ["In Closed mode, calls outside your allow rules are refused."];
  if (mode === "verification") return ["In Verification mode, calls outside your rules wait for your review."];
  return ["In Permissive mode, calls outside your rules are allowed anyway: an allow rule matters for its narrowing and because it decides before rules with a higher priority number."];
}
