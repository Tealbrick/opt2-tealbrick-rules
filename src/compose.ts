// The owner's English rule box (C373, journey J3): plain English → a PROPOSAL of structured rules. Nothing here applies a
// rule: the proposal is shown to the owner, who saves it as a draft and approves it on the Drafts page (C84).
//
// Drafters. A drafter turns the owner's text into a proposal. The default drafter is the deterministic `parser` below: pure,
// no model, no network, no I/O, so it always works and always gives the same answer. A second drafter (`model`) may plug in
// later through the same `Drafter` interface; whatever drafter made a proposal, `vetProposal` runs the SAME writer checks
// that `rules_set`, `rule_draft_submit` and draft approval use, and the result can only become a draft. Rules never calls a
// model to decide; a model may only help draft.
//
// What the parser reads (one sentence at a time; a sentence that starts with "And" / "Also" keeps the who of the one before):
// - who: agent names from the agent directory (case-insensitive, "Hermes's", "the CEO agent", or an `agt_…` id); "agents in
//   team Dev" (the CALLING agent's team → `callerTeams`); "someone from team X", "members of team X", "team X asks" (who
//   asked → `onBehalfOf.teams`, a claim that can only narrow, C82); "all agents" = any agent.
// - where: "in Connect", "on Knowledge", "the Connect app" (product ids from the app catalog, plus a few display names);
//   the app that MAKES the call: "Evolution's outward actions", "calls from the Evolution app" → `callerProducts`.
// - what: effects by keyword (send/post/publish → outward, money/pay → money, delete/destroy → destructive, write/change →
//   write, read → read), and memory narrowing ("only work-tagged memories", "memories tagged work, non-critical",
//   "talk about work things only").
// - decision: hold ("hold", "wait for me", "ask me", "needs my approval"), refuse ("block", "never", "may not", "no …"),
//   allow ("allow", "may", "can").
// A name that is not found or that two agents (or teams) share is never guessed: the sentence goes to `unmatched` with a
// plain hint. So does anything the parser cannot read ("Ask your agent to draft this rule").
import { normalizeTag } from "@opt2-tealbrick/manifest";
import type { Decision, Effect, RuleSpec } from "./engine.ts";

export interface ComposeEnv {
  /** agents the owner can name (agent directory) */
  agents: readonly { id: string; name: string }[];
  /** Governance teams (the Fleet copy) */
  teams: readonly { id: string; name: string }[];
  /** apps from the catalog: product id plus extra display names */
  apps: readonly { id: string; names?: readonly string[] }[];
  /** THE writer check ("" = fine): the same function the writers use (schema problems, then `ruleProblem`). Never re-implemented here. */
  problem: (spec: RuleSpec) => string;
  /** the owner's ACTIVE rules (priority and decision): composed rules are placed around them (C373 S2), never ahead of a refuse/hold by an allow */
  existing?: readonly { priority: number; decision: Decision }[];
}

/**
 * Where composed rules go (C373 S2, safety): refuse and hold BEFORE every existing allow rule (at most STRICT_PRIORITY), allow
 * AFTER every existing refuse and hold rule (their highest priority + 10, at least ALLOW_PRIORITY), so a composed allow never
 * skips a rule the owner already has. `allow` null = no room after a refuse/hold rule at priority 1000.
 */
export function placement(existing: ComposeEnv["existing"] = []): { strict: number; allow: number | null; strictMax: number | null; allowMin: number | null } {
  const strictOnes = existing.filter((r) => r.decision !== "allow").map((r) => r.priority);
  const allowOnes = existing.filter((r) => r.decision === "allow").map((r) => r.priority);
  const strictMax = strictOnes.length ? Math.max(...strictOnes) : null;
  const allowMin = allowOnes.length ? Math.min(...allowOnes) : null;
  const strict = Math.max(0, Math.min(STRICT_PRIORITY, allowMin === null ? STRICT_PRIORITY : allowMin - 1));
  const after = Math.max(ALLOW_PRIORITY, strict + 1, strictMax === null ? 0 : strictMax + 10);
  const allow = strictMax !== null && strictMax >= 1000 ? null : Math.min(1000, after);
  return { strict, allow, strictMax, allowMin };
}

/** Every drafter's rules get their place from `placement` (a model's own priorities are never kept); an allow with no room goes to unmatched. */
export function placeProposal(p: Proposal, existing: ComposeEnv["existing"] = []): Proposal {
  const place = placement(existing);
  const rules: RuleSpec[] = [];
  const unmatched = [...p.unmatched];
  for (const r of p.rules) {
    if (r.outcome.decision === "allow" && place.allow === null) unmatched.push({ text: r.title, hint: NO_ROOM });
    else rules.push({ ...r, priority: r.outcome.decision === "allow" ? (place.allow as number) : place.strict });
  }
  return { ...p, rules: rules.sort((a, b) => a.priority - b.priority), unmatched };
}
const NO_ROOM = "An allow rule must run after your refuse and hold rules, and one of them already has priority 1000 (the last place). Lower its priority first.";

/** Why a composed rule has its priority, for the proposal line. */
export function priorityWhy(spec: RuleSpec, existing: ComposeEnv["existing"] = []): string {
  const p = placement(existing);
  if (spec.outcome.decision === "allow")
    return p.strictMax === null ? `Priority ${spec.priority}: after the refuse and hold rules of this proposal.` : `Priority ${spec.priority}: after your refuse and hold rules (highest priority ${p.strictMax}), so it never skips them.`;
  return p.allowMin === null ? `Priority ${spec.priority}: refuse and hold rules run first.` : `Priority ${spec.priority}: before your allow rules (lowest priority ${p.allowMin}), so none of them skips it.`;
}

export interface Unmatched {
  /** the owner's words that did not become rules */
  text: string;
  /** what to do instead, in plain words */
  hint: string;
}

export interface Proposal {
  rules: RuleSpec[];
  notes: string[];
  unmatched: Unmatched[];
}

export type DrafterId = "parser" | "model";

/** Turns the owner's text into a proposal. Every drafter's proposal goes through `vetProposal` and can only become a draft. */
export interface Drafter {
  id: DrafterId;
  draft: (text: string, env: ComposeEnv) => Promise<Proposal>;
}

/** The deterministic drafter (default; always available). */
export const parserDrafter: Drafter = { id: "parser", draft: async (text, env) => composeRules(text, env) };

export const ASK_AGENT = "Ask your agent to draft this rule.";
/** A draft holds at most this many rules (manifest `rule_draft_submit.rules.maxItems`). */
export const MAX_COMPOSED_RULES = 10;
/** Priorities of composed rules: refuse and hold first, then allow (the skill's example uses the same order). */
export const STRICT_PRIORITY = 10;
export const ALLOW_PRIORITY = 20;

export const DECISION_WORD: Record<Decision, string> = { allow: "Allow", deny: "Refuse", hold: "Hold for my review" };
const EFFECT_WORD: Record<Effect, string> = { read: "reads", write: "writes", outward: "outward actions", destructive: "destructive actions", money: "money" };

/**
 * A rule that names an agent, team or app the owner's directory does not list ("" = fine). The parser only ever uses listed
 * names; a model drafter could invent one, and a rule about an id nobody has would look like protection and protect nothing.
 */
export function namesProblem(spec: RuleSpec, env: Pick<ComposeEnv, "agents" | "teams" | "apps">): string {
  const m = spec.match;
  const agents = new Set(env.agents.map((a) => a.id));
  const teams = new Set(env.teams.map((t) => t.id));
  const apps = new Set(env.apps.map((a) => a.id));
  const agent = m.agents?.find((a) => !agents.has(a));
  if (agent !== undefined) return `it names an agent Rules does not know (${quote(cap(agent, 64))})`;
  const team = [...(m.callerTeams ?? []), ...(m.onBehalfOf?.teams ?? [])].find((t) => !teams.has(t));
  if (team !== undefined) return `it names a team Rules does not know (${quote(cap(team, 64))})`;
  const app = [...(m.products ?? []), ...(((m as { callerProducts?: string[] }).callerProducts) ?? [])].find((a) => !apps.has(a));
  if (app !== undefined) return `it names an app Rules does not know (${quote(cap(app, 40))})`;
  return "";
}

/**
 * Writer checks on a proposal from ANY drafter: a rule with a problem (the writer check, then, with `env`, unknown names) is
 * taken out and listed in `unmatched` with the problem; at most MAX_COMPOSED_RULES rules stay.
 */
export function vetProposal(p: Proposal, problem: (spec: RuleSpec) => string, env?: Pick<ComposeEnv, "agents" | "teams" | "apps">): Proposal {
  const rules: RuleSpec[] = [];
  const unmatched = [...p.unmatched];
  for (const spec of p.rules) {
    const why = problem(spec) || (env ? namesProblem(spec, env) : "");
    if (why) unmatched.push({ text: typeof spec.title === "string" ? cap(spec.title, 200) : "a rule", hint: `This rule cannot be saved: ${why}` });
    else if (rules.length >= MAX_COMPOSED_RULES) unmatched.push({ text: spec.title, hint: `A draft holds at most ${MAX_COMPOSED_RULES} rules. Write the rest as a second rule.` });
    else rules.push(spec);
  }
  return { rules, notes: [...new Set(p.notes)], unmatched };
}

// ── vocabulary ──────────────────────────────────────────────────────────────

const EFFECT_WORDS: [Effect, RegExp][] = [
  ["outward", /\b(?:outward|send|sends|sending|sent|post|posts|posting|posted|publish|publishes|publishing|published|messages?|messaging|emails?|emailing|dms?|repl(?:y|ies|ying))\b/],
  ["money", /\b(?:money|pay|pays|paying|paid|payments?|spend|spends|spending|purchases?|purchasing|buy|buys|buying|financial|funds)\b/],
  ["destructive", /\b(?:destructive|delete|deletes|deleting|deleted|destroy|destroys|destroying|erase|erases|erasing|wipe|wipes|wiping)\b/],
  ["write", /\b(?:writes?|writing|changes?|changing|edits?|editing|modify|modifies|modifying|updates?|updating)\b/],
  ["read", /\b(?:reads?|reading)\b/],
];
const HOLD = /\b(?:hold|holds|wait for me|ask me|check with me|needs? my (?:approval|ok|okay|review)|requires? my (?:approval|review)|for my (?:approval|review)|with my approval|approve (?:it )?first)\b/;
/** strong refusal verbs (a fragment with only this still makes a rule: "Block Hermes") */
const DENY_STRONG = /\b(?:block|blocks|blocked|never|may not|must not|can ?not|can't|cannot|not allowed|deny|denied|refuse|refuses|refused|forbid|forbids|forbidden|prevent|stop|don't let|do not let)\b/;
const DENY_WEAK = /\bno\b/;
const ALLOW = /\b(?:allow|allows|allowed|may|can|permit|permits|permitted|let)\b/;

/** Words that carry no meaning of their own here (anything else that is left over is reported). */
const FILLER = new Set(
  (
    "a an the to for of in on at by from with about into inside via through using and or but also too plus then all any every each " +
    "agent agents action actions call calls thing things stuff it its it's is are be been being was were they them their he she " +
    "you you're your yours i i'm me my we our us someone anyone everyone somebody anybody people person member members when if " +
    "whenever once that which who whom only involved involving tag tags tagged tagging mention mentions mentioned asks asked request " +
    "requests requested behalf do does doing make makes anything everything something ever always first before approval review ok " +
    "okay let lets without this these those there here have has had get gets go goes kind sort talk talks talking speak about " +
    "own app apps their s should need needs shall will would want wants rule rules set please work-related related"
  ).split(" "),
);
/** Spoken filler removed before reading ("uh", "basically", "like" …). */
const SPOKEN = /\b(?:uh+|um+|erm|basically|clearly|just|like|you know|kind of|sort of|i mean|actually|really)\b/gi;
const POSSESSIVE_STOP = new Set(["it", "that", "there", "what", "let", "he", "she", "who", "one", "everyone", "someone", "anyone", "owner", "team", "agent", "today", "here", "where", "how"]);
const TEAM_STOP = new Set(["members", "member", "mates", "of", "the", "and", "is", "are", "can", "may", "who", "that", "a", "my", "our", "your", "whole", "same", "this", "any", "every", "each", "s"]);

/** typographic single quotes (U+2018, U+2019), built from code points so the source stays ASCII here */
const CURLY_APOSTROPHE = new RegExp(`[${String.fromCharCode(0x2018, 0x2019)}]`, "g");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const quote = (s: string) => `“${s}”`;
const cap = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

// ── names ───────────────────────────────────────────────────────────────────

/** `caller` = an app named as the one that makes the call ("Evolution's outward actions" → `callerProducts`) */
type Kind = "agent" | "team" | "app" | "caller";
interface Mention {
  kind: Kind;
  id: string;
  label: string;
}
interface Form {
  form: string;
  ids: string[];
  label: string;
}

/** Name forms (lower case) → ids; a form two things share keeps every id (ambiguous, never guessed). */
function formsOf(items: readonly { id: string; forms: readonly string[]; label: string }[]): Form[] {
  const map = new Map<string, Form>();
  for (const it of items) {
    for (const f of new Set(it.forms.map((x) => x.trim().toLowerCase()).filter((x) => x.length >= 2))) {
      const prev = map.get(f);
      if (prev) {
        if (!prev.ids.includes(it.id)) prev.ids.push(it.id);
      } else map.set(f, { form: f, ids: [it.id], label: it.label });
    }
  }
  return [...map.values()].sort((a, b) => b.form.length - a.form.length);
}

function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0] as number;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j] as number;
      d[j] = Math.min(cur + 1, (d[j - 1] as number) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return d[b.length] as number;
}

/** Names close to `want` (contains, is contained, or at most 2 edits), else every name; at most 8. */
function closeNames(want: string, names: readonly string[]): { close: boolean; names: string[] } {
  const w = want.toLowerCase();
  const close = names.filter((n) => {
    const l = n.toLowerCase();
    return l.includes(w) || w.includes(l) || levenshtein(l, w) <= Math.max(1, Math.floor(w.length / 4));
  });
  return close.length ? { close: true, names: close.slice(0, 8) } : { close: false, names: names.slice(0, 8) };
}

function notFound(what: "agent" | "team", name: string, names: readonly string[]): string {
  if (names.length === 0) return what === "agent" ? `No agent named ${quote(name)}: no agents are connected yet. ${ASK_AGENT}` : `No team named ${quote(name)}: Rules has no Governance teams yet.`;
  const c = closeNames(name, names);
  return `No ${what} named ${quote(name)}. ${c.close ? "Close names" : what === "agent" ? "Your agents" : "Your teams"}: ${c.names.join(", ")}.`;
}

// ── one sentence ────────────────────────────────────────────────────────────

interface Scope {
  agents: string[];
  /** apps that make the call (`match.callerProducts`, the VERIFIED product of an app caller) */
  callerProducts: string[];
  callerTeams: string[];
  oboTeams: string[];
}
interface Directive {
  decision: Decision;
  effects: Effect[];
  products: string[];
  tags?: { anyOf: string[]; noneOf: string[] };
}

interface SentenceResult {
  ok: boolean;
  rules: RuleSpec[];
  notes: string[];
  hint: string;
  scope: Scope | null;
}

const TOKEN = /@m(\d+)@/g;

/** Tags after "tagged": "work, non-critical and personal" (stops at the first word that is not a tag). */
function tagList(s: string, from: number): { anyOf: string[]; noneOf: string[]; end: number; negated: string[] } {
  const anyOf: string[] = [];
  const noneOf: string[] = [];
  const negated: string[] = [];
  let at = from;
  const stop = (w: string) => FILLER.has(w) || /^(?:no|never|only|not|non)$/.test(w) || EFFECT_WORDS.some(([, re]) => re.test(w)) || HOLD.test(w) || DENY_STRONG.test(w) || /^memor/.test(w);
  for (;;) {
    const m = /^\s*(not\s+|non-)?([a-z0-9][a-z0-9_-]*)/.exec(s.slice(at));
    if (!m || stop(m[2] as string)) break;
    const tag = normalizeTag(m[2] as string);
    if (m[1]) {
      noneOf.push(tag);
      negated.push(`${m[1].trim() === "not" ? "not " : "non-"}${tag}`);
    } else anyOf.push(tag);
    at += m[0].length;
    const sep = /^\s*(?:,|\band\b|\bor\b)\s*/.exec(s.slice(at));
    if (!sep) break;
    const next = /^\s*(not\s+|non-)?([a-z0-9][a-z0-9_-]*)/.exec(s.slice(at + sep[0].length));
    if (!next || stop(next[2] as string)) break;
    at += sep[0].length;
  }
  return { anyOf, noneOf, end: at, negated };
}

/** Memory narrowing in `body`: the tags and the body with those words removed. */
function narrowingOf(body: string): { anyOf: string[]; noneOf: string[]; rest: string; notes: string[] } {
  const anyOf = new Set<string>();
  const noneOf = new Set<string>();
  const notes: string[] = [];
  let rest = body;
  const cut = (start: number, end: number) => {
    rest = `${rest.slice(0, start)}${" ".repeat(end - start)}${rest.slice(end)}`;
  };
  // "only work-tagged memories", "no private-tagged memories"
  for (const m of [...rest.matchAll(/\b(?:(only|no|never|not)\s+)?([a-z0-9][a-z0-9_]*(?:-[a-z0-9_]+)*)-tagged\s+memor(?:y|ies)\b/g)]) {
    const tag = normalizeTag(m[2] as string);
    if (m[1] && m[1] !== "only") noneOf.add(tag);
    else anyOf.add(tag);
    cut(m.index, m.index + m[0].length);
  }
  // "memories (that are) tagged work, non-critical"
  for (;;) {
    const m = /\bmemor(?:y|ies)\s+(?:(?:that|which)\s+(?:are|is)\s+)?(?:tagged|labell?ed|with\s+(?:the\s+)?tags?)\s+(?:as\s+)?/.exec(rest);
    if (!m) break;
    const t = tagList(rest, m.index + m[0].length);
    const before = rest.slice(Math.max(0, m.index - 16), m.index);
    const negative = /\b(?:no|never|not|without)\s+(?:\w+\s+)?$/.test(before);
    for (const x of t.anyOf) (negative ? noneOf : anyOf).add(x);
    for (const x of t.noneOf) noneOf.add(x);
    for (const n of t.negated) notes.push(`${quote(n)} is read as: never memories tagged ${quote(n.replace(/^(?:not |non-)/, ""))}.`);
    const start = negative ? m.index - (before.match(/\b(?:no|never|not|without)\s+(?:\w+\s+)?$/)?.[0].length ?? 0) : m.index;
    cut(start, Math.max(t.end, m.index + m[0].length));
  }
  // "talk about work things only", "talk only about work", "only talk about work"
  const topics = [
    /\b(?:only\s+)?(?:talk|speak|chat)\w*\s+only\s+about\s+([a-z][a-z0-9_-]*)(?:\s+(?:things|topics|stuff|matters|subjects))?/g,
    /\b(?:talk|speak|chat)\w*\s+about\s+([a-z][a-z0-9_-]*)\s+(?:(?:things|topics|stuff|matters|subjects)\s+)?only\b/g,
    /\bonly\s+(?:talk|speak|chat)\w*\s+about\s+([a-z][a-z0-9_-]*)(?:\s+(?:things|topics|stuff|matters|subjects))?/g,
  ];
  for (const re of topics) {
    for (const m of [...rest.matchAll(re)]) {
      const topic = normalizeTag(m[1] as string);
      if (/^memor/.test(topic)) continue;
      anyOf.add(topic);
      notes.push(`${quote(topic)} topics are read as: only memories tagged ${quote(topic)}.`);
      cut(m.index, m.index + m[0].length);
    }
  }
  return { anyOf: [...anyOf], noneOf: [...noneOf], rest, notes };
}

function cueOf(s: string): { decision: Decision; strong: boolean } | null {
  if (HOLD.test(s)) return { decision: "hold", strong: true };
  if (DENY_STRONG.test(s)) return { decision: "deny", strong: true };
  if (DENY_WEAK.test(s)) return { decision: "deny", strong: false };
  if (ALLOW.test(s)) return { decision: "allow", strong: true };
  return null;
}

function effectsOf(s: string): Effect[] {
  return EFFECT_WORDS.filter(([, re]) => re.test(s)).map(([e]) => e);
}

function leftoverWords(s: string): string[] {
  return (s.replace(TOKEN, " ").match(/[a-z][a-z'-]*/g) ?? []).filter((w) => w.length >= 3 && !FILLER.has(w) && !cueOf(w) && effectsOf(w).length === 0 && !/^(?:only|not|non|tagged)$/.test(w));
}

function readSentence(sentence: string, env: ComposeEnv, agentForms: Form[], teamForms: Form[], appForms: Form[], prev: Scope | null): SentenceResult {
  const notes: string[] = [];
  const fail = (hint: string): SentenceResult => ({ ok: false, rules: [], notes: notes.filter((n) => /^TODO/.test(n)), hint, scope: null });
  const mentions: Mention[] = [];
  const errors: string[] = [];
  let s = sentence;
  const mask = (forms: Form[], kind: Kind, pattern: (f: string) => string) => {
    for (const f of forms) {
      s = s.replace(new RegExp(pattern(esc(f.form)), "gi"), () => {
        if (f.ids.length > 1) {
          errors.push(`${f.ids.length} ${kind === "agent" ? "agents" : kind === "team" ? "teams" : "apps"} are named ${quote(f.label)}, so Rules does not guess. Pick one in the editor, or rename one.`);
        }
        mentions.push({ kind, id: f.ids[0] as string, label: f.label });
        return ` @m${mentions.length - 1}@ `;
      });
    }
  };
  // teams first ("team X" may hold a word that is also an agent name), then apps where a place is named, then agents
  mask(teamForms, "team", (f) => `(?<![\\w@-])(?:the\\s+)?${f}(?:'s)?(?![\\w-])`);
  // An app named as the one that acts ("Evolution's outward actions", "calls from the Evolution app") → `callerProducts`.
  mask(appForms, "caller", (f) => `(?:(?<![\\w@-])(?:the\\s+)?${f}(?:\\s+app)?'s|(?<=\\b(?:calls?|actions?|requests?)\\s+(?:made\\s+)?(?:from|by)\\s+)(?:the\\s+)?${f}(?:\\s+app)?)(?![\\w-])`);
  mask(appForms, "app", (f) => `(?:(?<=\\b(?:in|on|via|through|using|with|to|from|into|inside)\\s+(?:the\\s+)?)${f}(?:\\s+app)?|(?<![\\w@-])(?:the\\s+)?${f}\\s+app)(?![\\w-])`);
  mask(agentForms, "agent", (f) => `(?<![\\w@-])(?:the\\s+)?${f}(?:'s|')?(?:\\s+agents?)?(?![\\w-])`);
  // names that look meant but are not known: never guessed
  const agentNames = env.agents.map((a) => a.name);
  for (const m of s.matchAll(/(?<![\w@-])([A-Za-z][\w-]*)'s\b/g)) {
    const w = m[1] as string;
    if (w[0] === (w[0] as string).toUpperCase() && !POSSESSIVE_STOP.has(w.toLowerCase())) errors.push(notFound("agent", w, agentNames));
  }
  for (const m of s.matchAll(/\bthe\s+([A-Za-z][\w-]*)\s+agents?\b/g)) {
    const w = m[1] as string;
    if (w[0] === (w[0] as string).toUpperCase() && w.toLowerCase() !== "same") errors.push(notFound("agent", w, agentNames));
  }
  for (const m of s.matchAll(/\bagent\s+([A-Z][\w-]*)/g)) errors.push(notFound("agent", m[1] as string, agentNames));
  for (const m of s.matchAll(/\b(?:agt|ins)_[A-Za-z0-9]+/g)) errors.push(notFound("agent", m[0], agentNames));
  if (/\bteams?\b/i.test(s)) {
    const teamNames = env.teams.map((t) => t.name);
    const after = /\bteams?\s+([A-Za-z0-9][\w-]*)/i.exec(s)?.[1];
    const before = /\b([A-Za-z0-9][\w-]*)\s+teams?\b/i.exec(s)?.[1];
    const named = [after, before].find((w) => w !== undefined && !TEAM_STOP.has(w.toLowerCase()) && !FILLER.has(w.toLowerCase()));
    errors.push(named ? notFound("team", named, teamNames) : `Which team? Name it, for example ${quote(`members of team ${(env.teams[0]?.name ?? "Sales").replace(/^team\s+|\s+team$/i, "")}`)}.`);
  }
  if (errors.length) return fail([...new Set(errors)].join(" "));
  // an app named without a place ("Block Connect sends") limits nothing: say so (a capitalised word only, so plain words stay quiet)
  for (const f of appForms) {
    for (const m of s.matchAll(new RegExp(`(?<![\\w@-])${esc(f.form)}(?![\\w-])`, "gi"))) {
      if (/^[A-Z]/.test(m[0])) notes.push(`${quote(m[0])} looks like an app. Write ${quote(`in ${m[0]}`)} to limit a rule to it.`);
    }
  }

  const low = s.toLowerCase();
  const kindAt = (i: number) => mentions[i]?.kind;
  // who
  const own: Scope = { agents: [], callerProducts: [], callerTeams: [], oboTeams: [] };
  for (const m of low.matchAll(TOKEN)) {
    const i = Number(m[1]);
    const men = mentions[i] as Mention;
    if (men.kind === "agent") own.agents.push(men.id);
    if (men.kind === "caller") own.callerProducts.push(men.id);
    if (men.kind === "team") {
      const before = low.slice(0, m.index);
      const after = low.slice(m.index + m[0].length);
      if (/\bagents?\s+(?:in|of|from|on)\s+$/.test(before) || /^\s*agents?\b/.test(after)) own.callerTeams.push(men.id);
      else own.oboTeams.push(men.id);
    }
  }
  const hasOwn = own.agents.length + own.callerProducts.length + own.callerTeams.length + own.oboTeams.length > 0;
  const continues = /^\s*(?:and|also|plus)\b/i.test(sentence);
  let scope = own;
  if (continues && !hasOwn) {
    if (prev === null) return fail(`This continues the sentence before, which Rules could not read. ${ASK_AGENT}`);
    scope = prev;
    notes.push(`${quote(cap(sentence.trim(), 60))} uses who from the sentence before.`);
  }

  // condition ("When … :", "If …,") and body
  let cond = "";
  let body = low;
  if (/^\s*(?:(?:and|also)\s+)?(?:when|if|whenever|once|for)\b/.test(low)) {
    const at = low.search(/[:,]|\bthen\b/);
    if (at >= 0) {
      cond = low.slice(0, at);
      body = low.slice(at).replace(/^(?:[:,]|then)/, "");
    }
  }
  const condProducts = [...cond.matchAll(TOKEN)].filter((m) => kindAt(Number(m[1])) === "app").map((m) => (mentions[Number(m[1])] as Mention).id);

  const nar = narrowingOf(body);
  notes.push(...nar.notes);
  const directives: Directive[] = [];
  const leftovers: string[] = [];
  let last: Decision | null = null;
  let missingCue = "";
  for (const frag of nar.rest.split(/\s*[,:]\s*|\s+(?:and|or|but|also|plus|then)\s+/)) {
    const products = [...new Set([...condProducts, ...[...frag.matchAll(TOKEN)].filter((m) => kindAt(Number(m[1])) === "app").map((m) => (mentions[Number(m[1])] as Mention).id)])];
    const effects = effectsOf(frag.replace(TOKEN, " "));
    const cue = cueOf(frag.replace(TOKEN, " "));
    leftovers.push(...leftoverWords(frag));
    const ownProducts = products.length > condProducts.length;
    if (effects.length || ownProducts) {
      const decision: Decision | null = cue?.decision ?? last;
      if (!decision) {
        missingCue = frag.trim();
        continue;
      }
      directives.push({ decision, effects, products });
      last = decision;
    } else if (cue?.strong && !(cue.decision === "allow" && (nar.anyOf.length || nar.noneOf.length))) {
      directives.push({ decision: cue.decision, effects: [], products });
      last = cue.decision;
    } else if (cue) last = cue.decision;
  }
  if (missingCue) return fail(`Say what should happen to ${quote(missingCue.replace(TOKEN, "").replace(/\s+/g, " ").trim())}: hold, refuse or allow.`);
  if (nar.anyOf.length || nar.noneOf.length) directives.push({ decision: "allow", effects: [], products: condProducts, tags: { anyOf: nar.anyOf, noneOf: nar.noneOf } });
  if (directives.length === 0) return fail(`Rules could not find what to do (send, pay, delete …) or a decision (hold, refuse, allow) in it. ${ASK_AGENT}`);
  const appWords = new Set(appForms.map((f) => f.form));
  const unused = [...new Set(leftovers)].filter((w) => !appWords.has(w));
  // An allow rule that missed words could allow more than the owner said: never propose it on a partial reading.
  if (unused.length && directives.some((d) => d.decision === "allow"))
    return fail(`Rules could not read ${unused.map(quote).join(", ")}. An allow rule must say exactly what it allows. ${ASK_AGENT}`);
  if (unused.length) notes.push(`Not used from ${quote(cap(sentence.trim(), 60))}: ${unused.join(", ")}. Check the rules before you save them.`);

  // merge directives with the same decision and place (effects unite; an empty list means every effect)
  const merged: Directive[] = [];
  for (const d of directives) {
    const same = !d.tags && merged.find((x) => !x.tags && x.decision === d.decision && x.products.join() === d.products.join());
    if (same) same.effects = same.effects.length === 0 || d.effects.length === 0 ? [] : [...new Set([...same.effects, ...d.effects])];
    else merged.push({ ...d });
  }
  merged.sort((a, b) => (a.decision === "allow" ? 1 : 0) - (b.decision === "allow" ? 1 : 0));
  const agentLabel = (id: string) => env.agents.find((a) => a.id === id)?.name ?? id;
  const teamLabel = (id: string) => env.teams.find((t) => t.id === id)?.name ?? id;
  const rules = merged.map((d) => buildRule(d, scope, sentence.trim(), agentLabel, teamLabel));
  for (const r of rules) {
    if (r.outcome.decision !== "allow" && !r.match.agents && !r.match.callerProducts && !r.match.callerTeams && !r.match.onBehalfOf && !r.match.effects && !r.match.products)
      notes.push(`${quote(r.title)} matches every call of every agent.`);
  }
  return { ok: true, rules, notes, hint: "", scope: hasOwn ? own : scope };
}

function buildRule(d: Directive, scope: Scope, sentence: string, agentLabel: (id: string) => string, teamLabel: (id: string) => string): RuleSpec {
  const uniq = <T extends string>(xs: T[]): T[] => [...new Set(xs)];
  const match: RuleSpec["match"] = {
    ...(scope.agents.length ? { agents: uniq(scope.agents) } : {}),
    ...(scope.callerProducts.length ? { callerProducts: uniq(scope.callerProducts) } : {}),
    ...(d.products.length ? { products: uniq(d.products) } : {}),
    ...(d.effects.length ? { effects: uniq(d.effects) } : {}),
    ...(scope.callerTeams.length ? { callerTeams: uniq(scope.callerTeams) } : {}),
    ...(scope.oboTeams.length ? { onBehalfOf: { teams: uniq(scope.oboTeams) } } : {}),
  };
  const who = [
    ...(scope.agents.length ? [uniq(scope.agents).map(agentLabel).join(", ")] : []),
    ...(scope.callerProducts.length ? [`calls from ${uniq(scope.callerProducts).join(", ")}`] : []),
    ...(scope.callerTeams.length ? [`agents in ${uniq(scope.callerTeams).map(teamLabel).join(", ")}`] : []),
    ...(scope.oboTeams.length ? [`on behalf of ${uniq(scope.oboTeams).map(teamLabel).join(", ")}`] : []),
  ];
  const what = d.tags
    ? [d.tags.anyOf.length ? `only memories tagged ${d.tags.anyOf.join(", ")}` : "", d.tags.noneOf.length ? `no memories tagged ${d.tags.noneOf.join(", ")}` : ""].filter(Boolean).join(", ")
    : d.effects.length ? d.effects.map((e) => EFFECT_WORD[e]).join(" and ") : "every call";
  const where = d.products.length ? ` in ${d.products.join(", ")}` : "";
  const verb = d.decision === "hold" ? "Hold" : DECISION_WORD[d.decision];
  const title = cap(`${verb} ${what}${where} · ${who.length ? who.join(" · ") : "all agents"}`, 120);
  const reasonHead = "The owner's rule: ";
  const reason = `${reasonHead}${quote(cap(sentence, 280 - reasonHead.length - 2))}`;
  const tags = d.tags;
  return {
    title,
    description: cap(sentence, 2000),
    active: true,
    priority: d.decision === "allow" ? ALLOW_PRIORITY : STRICT_PRIORITY,
    match,
    outcome: { decision: d.decision, reason },
    ...(tags ? { narrowing: { memoryTags: { ...(tags.anyOf.length ? { anyOf: tags.anyOf } : {}), ...(tags.noneOf.length ? { noneOf: tags.noneOf } : {}) } } } : {}),
  };
}

/** Display names of apps whose product id differs from what owners call them (the catalog keeps no display names). */
export const APP_NAMES: Readonly<Record<string, readonly string[]>> = { fleet: ["Governance"], rules: ["Rules & Approvals"] };

/** The parser: owner text → proposal, every rule through the writer check (`env.problem`). Pure and deterministic. */
export function composeRules(text: string, env: ComposeEnv): Proposal {
  const agentForms = formsOf(env.agents.map((a) => ({ id: a.id, label: a.name, forms: [a.name, a.name.replace(/\s+agent$/i, ""), a.id] })));
  const teamForms = formsOf(
    env.teams.map((t) => {
      const core = t.name.replace(/^team\s+|\s+team$/i, "");
      return { id: t.id, label: t.name, forms: [...(/\bteam\b/i.test(t.name) ? [t.name] : []), `team ${core}`, `${core} team`] };
    }),
  );
  const appForms = formsOf(env.apps.map((a) => ({ id: a.id, label: a.names?.[0] ?? a.id, forms: [a.id, ...(a.names ?? []), ...(APP_NAMES[a.id] ?? [])] })));
  const clean = text
    .replace(CURLY_APOSTROPHE, "'")
    .replace(/,?\s*\betc\b(\.?)/gi, "$1")
    .replace(SPOKEN, " ")
    .replace(/[ \t]+/g, " ");
  const sentences = clean
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((x) => x.replace(/[.!?;]+\s*$/, "").trim())
    .filter((x) => /[a-z0-9]/i.test(x));
  const out: Proposal = { rules: [], notes: [], unmatched: [] };
  let prev: Scope | null = null;
  for (const sentence of sentences) {
    const r = readSentence(sentence, env, agentForms, teamForms, appForms, prev);
    if (r.ok) {
      const place = placement(env.existing);
      if (place.allow === null && r.rules.some((x) => x.outcome.decision === "allow")) {
        out.unmatched.push({ text: sentence, hint: NO_ROOM });
        prev = null;
        continue;
      }
      for (const x of r.rules) x.priority = x.outcome.decision === "allow" ? (place.allow as number) : place.strict;
      // the writer check per sentence: if one of its rules cannot be saved, none of them is proposed (a partial set would be weaker than the owner said)
      const problems = r.rules.map((x) => env.problem(x)).filter(Boolean);
      if (problems.length) {
        out.unmatched.push({ text: sentence, hint: `This rule cannot be saved: ${problems[0]}` });
        prev = null;
        continue;
      }
      out.rules.push(...r.rules);
      out.notes.push(...r.notes);
      prev = r.scope;
    } else {
      out.unmatched.push({ text: sentence, hint: r.hint });
      out.notes.push(...r.notes);
      prev = null;
    }
  }
  // refuse and hold rules first, then allow (stable: the owner's order within each)
  out.rules.sort((a, b) => a.priority - b.priority);
  if (out.rules.some((r) => r.outcome.decision === "allow"))
    out.notes.push("An allow rule decides for the calls it matches, so rules after it no longer apply to those calls. Rules puts it after all your refuse and hold rules.");
  if (out.rules.some((r) => r.match.onBehalfOf)) out.notes.push("Who asked is a claim. A rule about who asked can only make a decision stricter, never wider.");
  return vetProposal(out, env.problem);
}

/** One readable line per rule: decision, who, what, narrowing. */
export function describeRule(spec: RuleSpec, agentName: (id: string) => string, teamName: (id: string) => string): string {
  const m = spec.match;
  const who = [
    m.callerProducts?.length ? `calls from app ${m.callerProducts.join(", ")}` : m.agents?.length ? `calls by ${m.agents.map(agentName).join(", ")}` : "calls by any agent",
    m.callerTeams?.length ? `in team ${m.callerTeams.map(teamName).join(", ")}` : "",
    m.onBehalfOf?.teams?.length ? `on behalf of team ${m.onBehalfOf.teams.map(teamName).join(", ")}` : "",
  ].filter(Boolean);
  const what = [m.effects?.length ? `with effect ${m.effects.join(" or ")}` : "", m.products?.length ? `in app ${m.products.join(", ")}` : ""].filter(Boolean);
  const t = spec.narrowing?.memoryTags;
  const narrow = [t?.anyOf?.length ? `only memories tagged ${t.anyOf.join(", ")}` : "", t?.noneOf?.length ? `never memories tagged ${t.noneOf.join(", ")}` : ""].filter(Boolean);
  return `${DECISION_WORD[spec.outcome.decision]}: ${[...who, ...what].join(" ")}${narrow.length ? `, ${narrow.join("; ")}` : ""}.`;
}
