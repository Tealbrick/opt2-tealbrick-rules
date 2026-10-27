// Typed person-op calls (op ids and I/O types from the generated kit; type-only import, erased at build).
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import type { PersonOps } from "#kit";

export type In<K extends keyof PersonOps> = PersonOps[K]["input"];
export type Out<K extends keyof PersonOps> = PersonOps[K]["output"];
export type RuleRow = Out<"rules_list">["rules"][number];
export type RuleSpec = RuleRow["spec"];
export type DraftRow = Out<"drafts_list">["drafts"][number];
export type DecisionRow = Out<"decisions_list">["items"][number];
export type Team = Out<"fleet_status">["teams"][number];

export function run<K extends keyof PersonOps>(op: K, input: In<K>): Promise<Out<K>> {
  return callOp<Out<K>>(op, input as never);
}

/**
 * Same rule as the gate's `validProduct` (src/engine.ts, which the browser build does not load): a product id is `[a-z0-9][a-z0-9_-]*`,
 * at most 40 characters, NOT trimmed. The dry run sends a product only when it passes, like the gate treats a bridge-sent one.
 */
/** Evolution P1 workflow id (same rule as `WORKFLOW_ID` in src/engine.ts, which the browser build does not load). */
export const WORKFLOW_ID = /^[a-z][a-z0-9-]{2,39}$/;

export const verifiableProduct = (p: string): boolean => p.length <= 40 && /^[a-z0-9][a-z0-9_-]*$/.test(p);

export const EFFECTS = ["read", "write", "outward", "destructive", "money"] as const;
/** Status pill of a decision (allow = live, refuse = needs you, hold = busy). */
export const DECISION_STATUS = { allow: "live", deny: "needs-you", hold: "busy", narrow: "live", redact: "live" } as const;
/** What a rule's decision is called in the rule list and the editor. */
export const DECISION_LABEL = { allow: "Allow", deny: "Refuse", hold: "Hold for my review" } as const;

const SIGNED_OUT = "You’re signed out. Open this app from Portal to sign in again.";
const GENERIC = "Something went wrong. Try again in a moment.";
/** The app’s own refusals: their text already says what is wrong and what to do (src/store.ts), so it is shown as it is. */
const OWN_REFUSALS = new Set(["revision_conflict", "input_invalid", "draft_never_matches", "draft_no_room", "draft_decided", "too_many_rules", "too_many_drafts", "catalog_unavailable", "not_found", "forbidden", "confirm_required"]);
/** Plain sentence for a failed call (RUL-01, RUL-14). Anything that is not the app’s own refusal gets a standard sentence, never raw upstream text. */
export function errorText(e: unknown): string {
  const err = (e ?? {}) as { code?: unknown; httpStatus?: unknown; message?: unknown };
  if (err.code === "session_required" || err.code === "csrf_invalid" || err.httpStatus === 401) return SIGNED_OUT;
  if (err.code === "network_error") return "Can’t reach the app. Check your connection and try again.";
  if (typeof err.code === "string" && OWN_REFUSALS.has(err.code) && typeof err.message === "string" && err.message) return err.message;
  return GENERIC;
}
/** Date and time as the approved mockups show it, the same for every owner: "13 Oct 2026, 08:02" (en-GB, 24-hour). */
export function when(isoTime: string | null): string {
  return isoTime ? new Date(isoTime).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : "never";
}
/** Date only, for list rows: "11 Oct 2026". */
export function day(isoTime: string | null): string {
  return isoTime ? new Date(isoTime).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "never";
}
/** A long id shortened for reading ("cal_01J9R4…"); the full id goes in a title. */
export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 10)}…` : id;
}
/**
 * QA-C373-RU-1: a stored value (a legacy rule or draft, or an agent's name) may hold a Unicode control (Cc) or format (Cf)
 * character, such as U+202E (right-to-left override) or U+200D (zero-width joiner). It is shown WRITTEN OUT as ⟨U+202E⟩, never
 * drawn. `multiline` keeps tab and line break. Same answer as `escapeControls` in src/text-guard.ts (a test pins them).
 */
export function safeText(s: string, multiline = false): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    out += /[\p{Cc}\p{Cf}]/u.test(ch) && !(multiline && (cp === 9 || cp === 10)) ? `⟨U+${cp.toString(16).toUpperCase().padStart(4, "0")}⟩` : ch;
  }
  return out;
}

/** "a, b ,c" → ["a","b","c"]; empty → undefined (= any). */
export function list(s: string): string[] | undefined {
  const xs = s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return xs.length ? [...new Set(xs)] : undefined;
}
export const joinList = (xs: readonly string[] | undefined) => (xs ?? []).join(", ");

export function emptySpec(): RuleSpec {
  return { title: "", active: true, priority: 100, match: {}, outcome: { decision: "deny", reason: "" } };
}

/** One line that says what a rule matches, for lists. */
export function matchText(s: RuleSpec, teamName: (id: string) => string, agentName: (id: string) => string, titles?: Record<string, string>): string {
  const m = s.match;
  const parts: string[] = [];
  if (m.agents?.length) parts.push(`callers ${m.agents.map(agentName).join(", ")}`);
  if (m.modes?.length) parts.push(`${m.modes.join("/")} agents`);
  if (m.products?.length) parts.push(`apps ${m.products.join(", ")}`);
  if (m.operations?.length) parts.push(`operations ${m.operations.map((op) => opLabel(op, m.products ?? [], titles)).join(", ")}`);
  if (m.tools?.length) parts.push(`tools ${m.tools.join(", ")}`);
  if (m.effects?.length) parts.push(`effects ${m.effects.join(", ")}`);
  if (m.callerTeams?.length) parts.push(`caller in team ${m.callerTeams.map(teamName).join(", ")}`);
  if (m.callerTrust?.length) parts.push(`calling agent's trust ${m.callerTrust.join(", ")}`);
  if (m.callerProducts?.length) parts.push(`calls from app ${m.callerProducts.join(", ")}`);
  if (m.callerWorkflows?.length) parts.push(`from workflow ${m.callerWorkflows.join(", ")}`);
  const r = m.recipients;
  if (r) {
    const sub = [r.teams?.length ? `in team ${r.teams.map(teamName).join(", ")}` : "", r.trust?.length ? `with trust ${r.trust.join(", ")}` : "", r.known === undefined ? "" : r.known ? "known to Governance" : "unknown to Governance"].filter(Boolean);
    parts.push(`recipients ${sub.join(" and ")}`);
  }
  const o = m.onBehalfOf;
  if (o?.teams?.length) parts.push(`on behalf of team ${o.teams.map(teamName).join(", ")}`);
  if (o?.ids?.length) parts.push(`on behalf of ${o.ids.join(", ")}`);
  if (o?.kinds?.length) parts.push(`requester kind ${o.kinds.join(", ")}`);
  if (o?.trust?.length) parts.push(`requester trust ${o.trust.join(", ")}`);
  return safeText(parts.length ? parts.join("; ") : "every call");
}

/** S2-2 (review 0.5.0): the warning on a refuse/hold rule that can stop Rules' own Governance read (fleet `directory_feed`). */
export const CUTS_OFF_GOVERNANCE = "This rule cuts Rules off from Governance: it can refuse or hold Rules’ own read of teams and trust, and then every rule that names teams or trust works without them (refuse and hold apply, allow does not).";
/**
 * True for a refuse/hold rule that NAMES the feed read (target app `fleet` or calls from app `rules`) and is not ruled out by its
 * effects, operations or callers. Only such an explicit rule can stop that read; the gate keeps every other rule away from it.
 */
export function cutsOffGovernance(s: RuleSpec): boolean {
  const m = s.match;
  if (s.outcome.decision === "allow" || !(m.products?.includes("fleet") || m.callerProducts?.includes("rules"))) return false;
  if (m.products?.length && !m.products.includes("fleet")) return false;
  if (m.callerProducts?.length && !m.callerProducts.includes("rules")) return false;
  if (m.effects?.length && !m.effects.includes("read")) return false;
  if (m.operations?.length && !m.operations.includes("directory_feed")) return false;
  if (m.modes?.length || m.callerTeams?.length || m.callerTrust?.length || m.callerWorkflows?.length || m.recipients || m.tools?.length) return false;
  return !(m.agents?.length && m.agents.every((a) => a.startsWith("agt_")));
}

/** What a rule narrows, as readable parts: ["memories: {...}", "datasets: {...}"]. */
export function narrowingParts(n: { memoryTags?: unknown; deepDatasets?: unknown } | null | undefined): string[] {
  return [n?.memoryTags ? `memories: ${JSON.stringify(n.memoryTags)}` : "", n?.deepDatasets ? `datasets: ${JSON.stringify(n.deepDatasets)}` : ""].filter(Boolean);
}
/** The parts as a list suffix: " · memories: {...} · datasets: {...}" ("" = nothing). */
export const narrowingText = (n: { memoryTags?: unknown; deepDatasets?: unknown } | null | undefined): string => narrowingParts(n).map((x) => ` · ${x}`).join("");

/** "tools (“Connected service tools”)": the op id with its manifest title from the catalog, or "(not declared)". */
export function opLabel(op: string, products: readonly string[], titles: Record<string, string> | undefined): string {
  if (!titles) return op;
  const t = products.map((p) => titles[`${p}.${op}`]).find(Boolean);
  return t ? `${op} (“${t}”)` : `${op} (not declared by the app)`;
}
