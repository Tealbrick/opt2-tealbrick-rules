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
export const verifiableProduct = (p: string): boolean => p.length <= 40 && /^[a-z0-9][a-z0-9_-]*$/.test(p);

export const EFFECTS = ["read", "write", "outward", "destructive", "money"] as const;
/** Status pill of a decision (allow = live, refuse = needs you, hold = busy). */
export const DECISION_STATUS = { allow: "live", deny: "needs-you", hold: "busy", narrow: "live", redact: "live" } as const;
/** What a rule's decision is called in the rule list and the editor. */
export const DECISION_LABEL = { allow: "Allow", deny: "Refuse", hold: "Hold for my review" } as const;

const SIGNED_OUT = "You’re signed out. Open this app from Portal to sign in again.";
const GENERIC = "Something went wrong. Try again in a moment.";
/** The app’s own refusals: their text already says what is wrong and what to do (src/store.ts), so it is shown as it is. */
const OWN_REFUSALS = new Set(["revision_conflict", "input_invalid", "draft_never_matches", "draft_decided", "too_many_rules", "too_many_drafts", "catalog_unavailable", "not_found", "forbidden"]);
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
  const o = m.onBehalfOf;
  if (o?.teams?.length) parts.push(`on behalf of team ${o.teams.map(teamName).join(", ")}`);
  if (o?.ids?.length) parts.push(`on behalf of ${o.ids.join(", ")}`);
  if (o?.kinds?.length) parts.push(`requester kind ${o.kinds.join(", ")}`);
  if (o?.trust?.length) parts.push(`requester trust ${o.trust.join(", ")}`);
  return parts.length ? parts.join("; ") : "every call";
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
