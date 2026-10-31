// C374 (Martin, 2026-10-28: "which agent / app goes how deep, to which specific things / tools"): the Access page model.
// One access setting per caller (an agent or an app): how deep it may go (a level of effects), what happens beyond that
// (hold for the owner or refuse), and optionally which apps and which tools of connected services it may use. A setting is
// stored as ordinary rules (rules_set), so the gate, the writers, the dry run and the Decisions page treat it like any rule.
// Pure data and builders, no React and no I/O (the server tests run the built specs through the writer and the engine). It
// lives in src/ui because the UI build serves only files under src/ui; it imports types only.
import type { RuleRow, RuleSpec } from "./api.ts";

export const ACCESS_EFFECTS = ["read", "write", "outward", "money", "destructive"] as const;
export type AccessEffect = (typeof ACCESS_EFFECTS)[number];

/** The depth levels, each one allows the effects of the level before plus one more (Martin's order: read, change, outward, money, destructive). */
export const LEVELS = [
  { level: 0, title: "Nothing", text: "It may not run anything (it may still ask Rules why)." },
  { level: 1, title: "Read only", text: "It may read. Changes, outward actions, money and deletes are stopped." },
  { level: 2, title: "Read and change", text: "It may read and change things inside the workspace." },
  { level: 3, title: "Also outward", text: "It may also send messages, posts and other actions that leave the workspace." },
  { level: 4, title: "Also money", text: "It may also run payments and other money actions." },
  { level: 5, title: "Everything", text: "It may also delete and overwrite. Your other rules still apply." },
] as const;
export type Level = (typeof LEVELS)[number]["level"];

/** The top level on more than one agent always asks first, whatever the count (C382 batch 3). One agent has its own dialog and its own click. */
export function askBeforeTopLevel(level: Level, changes: number): string | null {
  if (level !== 5 || changes < 2) return null;
  return `This gives ${changes} agents the level Everything. They may read, change things, send messages and posts, run payments, delete and overwrite. Your other rules still apply.`;
}

export const EFFECT_WORD: Record<AccessEffect, string> = { read: "read", write: "change", outward: "outward", money: "money", destructive: "delete" };

export type Caller = { type: "agent"; id: string; name: string } | { type: "app"; product: string; name: string };

export interface AccessSetting {
  level: Level;
  /** what happens to a call beyond the level */
  beyond: "hold" | "deny";
  /** only these apps (product ids); absent = every app */
  apps?: string[];
  /** only these tools of connected services (tool names), for the apps that run such tools; absent = every tool */
  tools?: string[];
}

/** The catalog facts the builder needs: every app id, and `product.op` of every dynamic operation (runs many tools). */
export interface AccessCatalog {
  productIds: readonly string[];
  dynamicOps: readonly string[];
}

/** The first priority of the Access block: after the owner's own rules (default 100), so a rule the owner writes still decides first. */
export const ACCESS_PRIORITY = 900;
export const TOOLS_MAX = 20;
/** The tool-name rule of the writers (catalog names: no `__`). */
export const TOOL_NAME = /^[a-z][a-z0-9_]{1,47}$/;
/** Rules' own agent ops: an agent may always ask why it was stopped and propose a rule (as the mode's exemption, src/mode.ts). */
export const RULES_SELF_SERVICE = ["rules_explain", "rule_draft_submit", "draft_status"] as const;
/** Operator Inbox tells the owner through these Connect ops (as the mode's exemption, src/mode.ts): never held, or a hold DMs again. */
export const INBOX_OWNER_DM = ["buzz_dm", "buzz_dm_first", "channel_dm", "channel_dm_first"] as const;
/** Apps that the Access page does not offer: Rules itself (it must read Governance for team and trust rules). */
export const NOT_OFFERED_APPS: readonly string[] = ["rules"];

const MARK = "access/1 ";
const NOTE = "Managed on the Access page. Change it there; a change here is shown there as edited by hand.";

/** The line that goes with every list of picked apps: on the dialog and on each row of the Access page. */
export const ONLY_APPS_LINE = "Apps you do not pick are refused.";

export const allowedEffects = (level: Level): AccessEffect[] => ACCESS_EFFECTS.slice(0, level);
export const beyondEffects = (level: Level): AccessEffect[] => ACCESS_EFFECTS.slice(level);
export const callerKey = (c: Caller | { type: "agent"; id: string } | { type: "app"; product: string }): string => (c.type === "agent" ? `agent:${c.id}` : `app:${c.product}`);

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const words = (xs: readonly string[]): string => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const effectWords = (xs: readonly AccessEffect[]) => words(xs.map((e) => EFFECT_WORD[e]));

/** "read and change", "nothing". */
export function levelPhrase(level: Level): string {
  const a = allowedEffects(level);
  if (a.length === 0) return "nothing";
  if (a.length === ACCESS_EFFECTS.length) return "everything";
  return effectWords(a);
}

/** The apps of the catalog that run tools of connected services (a dynamic operation), with those operations. */
export function dynamicApps(cat: AccessCatalog): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const po of cat.dynamicOps) {
    const i = po.indexOf(".");
    if (i < 1) continue;
    const p = po.slice(0, i);
    const op = po.slice(i + 1);
    if (!cat.productIds.includes(p)) continue;
    out.set(p, [...(out.get(p) ?? []), op]);
  }
  return out;
}

/** Why the setting cannot be saved ("" = it can). */
export function settingProblem(s: AccessSetting, caller: Caller, cat: AccessCatalog): string {
  if (!LEVELS.some((l) => l.level === s.level)) return "Pick a level.";
  if (s.apps !== undefined) {
    if (s.apps.length === 0) return "Pick at least one app, or let it use every app.";
    const bad = s.apps.find((p) => !cat.productIds.includes(p));
    if (bad) return `The app catalog has no app “${bad}”.`;
    if (caller.type === "app" && s.apps.includes(caller.product)) return "An app does not call itself through Rules; leave it out of the list.";
  }
  if (s.tools !== undefined) {
    if (s.tools.length === 0) return "Name at least one tool, or let it use every tool.";
    if (s.tools.length > TOOLS_MAX) return `At most ${TOOLS_MAX} tools.`;
    const bad = s.tools.find((t) => !TOOL_NAME.test(t) || t.includes("__"));
    if (bad) return `“${bad}” is no tool name: lower-case letters, digits and _, 2 to 48 characters, no __.`;
    if (s.level === 0) return "With level Nothing no tool can run; remove the tools.";
    if (toolApps(s, cat).length === 0) return "None of the picked apps runs tools of connected services, so the tools would limit nothing.";
  }
  return "";
}

/** The apps the tool limit applies to: the picked apps (or every app) that run tools of connected services. */
export function toolApps(s: AccessSetting, cat: AccessCatalog): string[] {
  const dyn = dynamicApps(cat);
  return [...dyn.keys()].filter((p) => (s.apps ? s.apps.includes(p) : true)).sort();
}

/**
 * The rules that stand for one access setting, in the order they decide (priorities ACCESS_PRIORITY and up, first match decides):
 *  1. agents only: Rules' own ops (why was I stopped, propose a rule) are allowed; Inbox only: its owner DMs through Connect are allowed;
 *  2. apps outside the picked apps are refused (every catalog app that is not picked, except Rules);
 *  3. per app with tools of connected services, when tools are picked: a picked tool beyond the level gets the beyond decision,
 *     a picked tool within the level is allowed, every other tool of that operation is refused;
 *  4. every call beyond the level gets the beyond decision (hold for the owner, or refuse);
 *  5. every call within the level is allowed.
 * An app that is added to the catalog after the save is not in rule 2: the level still applies to it (rules 4 and 5).
 */
export function accessSpecs(caller: Caller, s: AccessSetting, cat: AccessCatalog): RuleSpec[] {
  const problem = settingProblem(s, caller, cat);
  if (problem) throw new Error(problem);
  const who: RuleSpec["match"] = caller.type === "agent" ? { agents: [caller.id] } : { callerProducts: [caller.product] };
  const name = clip(caller.name.trim() || (caller.type === "agent" ? caller.id : caller.product), 40);
  const description = `${NOTE}\n${MARK}${JSON.stringify({ caller: caller.type === "agent" ? { type: "agent", id: caller.id } : { type: "app", product: caller.product }, ...s })}`;
  const allowed = allowedEffects(s.level);
  const beyond = beyondEffects(s.level);
  const beyondWord = s.beyond === "hold" ? "wait for your review" : "are refused";
  const out: RuleSpec[] = [];
  const add = (title: string, match: RuleSpec["match"], decision: RuleSpec["outcome"]["decision"], reason: string) =>
    out.push({ title: clip(`Access · ${name} · ${title}`, 120), description, active: true, priority: ACCESS_PRIORITY + out.length, match: { ...who, ...match }, outcome: { decision, reason: clip(reason, 280) } });
  if (caller.type === "agent")
    add("may ask Rules", { products: ["rules"], operations: [...RULES_SELF_SERVICE] }, "allow", `${name} may always ask Rules why it was stopped and propose a rule.`);
  if (caller.type === "app" && caller.product === "inbox" && cat.productIds.includes("connect"))
    add("may tell you", { products: ["connect"], operations: [...INBOX_OWNER_DM] }, "allow", "Operator Inbox may always tell you that something waits for you.");
  if (s.apps) {
    const outside = cat.productIds.filter((p) => !s.apps?.includes(p) && !NOT_OFFERED_APPS.includes(p) && !(caller.type === "app" && p === caller.product));
    if (outside.length) add("only its apps", { products: outside.slice(0, 50) }, "deny", clip(`${name} may only use ${words(s.apps)}.`, 280));
  }
  if (s.tools && allowed.length) {
    const dyn = dynamicApps(cat);
    for (const p of toolApps(s, cat)) {
      const ops = dyn.get(p) ?? [];
      if (beyond.length) add(`${p}: picked tools beyond the level`, { products: [p], operations: ops, tools: s.tools, effects: beyond }, s.beyond, `${name}: ${effectWords(beyond)} actions ${beyondWord}.`);
      add(`${p}: picked tools`, { products: [p], operations: ops, tools: s.tools, effects: allowed }, "allow", `${name} may use ${words(s.tools)} of ${p} up to ${levelPhrase(s.level)}.`);
      add(`${p}: only picked tools`, { products: [p], operations: ops }, "deny", clip(`${name} may only use these tools of ${p}: ${words(s.tools)}.`, 280));
    }
  }
  if (beyond.length)
    add(
      allowed.length ? `${effectWords(beyond)}: ${s.beyond === "hold" ? "hold" : "refuse"}` : `nothing: ${s.beyond === "hold" ? "hold" : "refuse"}`,
      beyond.length === ACCESS_EFFECTS.length ? {} : { effects: beyond },
      s.beyond,
      allowed.length ? `${name} may only ${levelPhrase(s.level)}; ${effectWords(beyond)} actions ${beyondWord}.` : `${name} may not run anything; its calls ${beyondWord}.`,
    );
  if (allowed.length) add(`up to ${levelPhrase(s.level)}`, allowed.length === ACCESS_EFFECTS.length ? {} : { effects: allowed }, "allow", `${name} may ${levelPhrase(s.level)} (Access).`);
  return out;
}

/** The setting a stored Access rule stands for (from its description), or null for any other rule. */
export function readMark(spec: Pick<RuleSpec, "description">): { key: string; setting: AccessSetting } | null {
  const d = spec.description ?? "";
  const i = d.indexOf(MARK);
  if (i < 0) return null;
  try {
    const v = JSON.parse(d.slice(i + MARK.length)) as { caller?: { type?: string; id?: string; product?: string } } & Partial<AccessSetting>;
    const c = v.caller;
    const key = c?.type === "agent" && typeof c.id === "string" ? `agent:${c.id}` : c?.type === "app" && typeof c.product === "string" ? `app:${c.product}` : null;
    if (!key || typeof v.level !== "number" || !LEVELS.some((l) => l.level === v.level) || (v.beyond !== "hold" && v.beyond !== "deny")) return null;
    return { key, setting: { level: v.level as Level, beyond: v.beyond, ...(Array.isArray(v.apps) ? { apps: v.apps.map(String) } : {}), ...(Array.isArray(v.tools) ? { tools: v.tools.map(String) } : {}) } };
  } catch {
    return null;
  }
}

export interface CallerAccess {
  setting: AccessSetting;
  rules: RuleRow[];
  /** the stored rules are not what the setting builds (someone edited one on the Rules page, or the app catalog changed) */
  edited: boolean;
}

/** caller key → its Access setting and rules (live rules only). */
export function accessOf(rows: readonly RuleRow[]): Map<string, { setting: AccessSetting; rules: RuleRow[] }> {
  const out = new Map<string, { setting: AccessSetting; rules: RuleRow[] }>();
  for (const r of rows) {
    if (r.deleted) continue;
    const m = readMark(r.spec);
    if (!m) continue;
    const have = out.get(m.key);
    if (have) have.rules.push(r);
    else out.set(m.key, { setting: m.setting, rules: [r] });
  }
  return out;
}

/** Whether the stored rules are exactly what the setting builds today. */
export function isEdited(caller: Caller, found: { setting: AccessSetting; rules: readonly RuleRow[] }, cat: AccessCatalog): boolean {
  let want: RuleSpec[];
  try {
    want = accessSpecs(caller, found.setting, cat);
  } catch {
    return true;
  }
  const norm = (s: RuleSpec) => JSON.stringify({ a: s.active, p: s.priority, m: s.match, o: s.outcome.decision });
  const have = found.rules.map((r) => norm(r.spec)).sort();
  const need = want.map(norm).sort();
  return have.length !== need.length || have.some((x, i) => x !== need[i]);
}

/** One line for the Access list: "Read and change · beyond: wait for your review · apps: connect, kanban · tools: gmail_send". */
export function settingLine(s: AccessSetting): string {
  const level = LEVELS.find((l) => l.level === s.level)?.title ?? String(s.level);
  const parts = [level];
  if (s.level < ACCESS_EFFECTS.length) parts.push(s.beyond === "hold" ? "beyond that: waits for your review" : "beyond that: refused");
  parts.push(s.apps ? `only ${words(s.apps)}` : "every app");
  if (s.tools) parts.push(`only the tools ${words(s.tools)}`);
  return parts.join(" · ");
}

/** What the setting does per effect (inside the picked apps), before any rule of the owner: the table in the dialog. */
export function effectOutcomes(s: AccessSetting): { effect: AccessEffect; decision: "allow" | "hold" | "deny" }[] {
  const allowed = new Set<string>(allowedEffects(s.level));
  return ACCESS_EFFECTS.map((e) => ({ effect: e, decision: allowed.has(e) ? "allow" : s.beyond }));
}

/**
 * A level set in bulk: the level changes, and nothing else. An agent with a setting keeps what happens beyond the level, its apps and its tools;
 * an agent with none gets `beyond` and every app, as the dialog would start it.
 */
export function bulkSetting(old: AccessSetting | undefined, level: Level, beyond: AccessSetting["beyond"]): AccessSetting {
  return old ? { ...old, level } : { level, beyond };
}

/** The rows of the bulk editor: one per caller with a setting, its level as the value. */
export function accessCells(byCaller: ReadonlyMap<string, { setting: AccessSetting }>, scope: string): { agent: string; scope: string; level: string }[] {
  return [...byCaller].map(([key, f]) => ({ agent: key, scope, level: String(f.setting.level) }));
}
