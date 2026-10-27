// Priorities re-checked when a draft is approved (review 0.5.0 S3-3, delta D-1/D-2). A draft keeps the priorities it was written with (the
// English box placed them against the rules of THAT moment; an agent or app picks its own). By the time the owner approves, other rules may
// exist, so `draft_decide` approve places every draft rule again against the CURRENT rules, active AND inactive (re-activating a
// rule later must not be weakened silently), with the draft's own rules counted as they are placed:
// - an ALLOW goes after every refuse or hold rule it could overlap (their highest priority + 1), so it never skips one;
// - a HOLD goes after every refuse rule it could overlap, so it never turns one into a hold;
// - a REFUSE keeps its priority (it can only make calls stricter); an allow rule that runs before it is noted.
// Moving a rule must not change what it does for the calls it was written for (D-1, D-2):
// - a HOLD that has to move behind a refuse rule must still run BEFORE every overlapping allow rule that it was ahead of as written,
//   else that allow would now decide first and the hold would do less than written;
// - an ALLOW WITH A NARROWING must not end up behind an overlapping allow rule that it was ahead of and that has no narrowing or a
//   wider one, else that allow would decide first and the narrowing would be lost.
// When no priority keeps both promises, the approval stops with a plain message (409 `draft_no_room`). A rule with no room (it would
// need priority > 1000) stops the approval too. Pure: no I/O.
import { type Decision, mergeNarrowing, normNarrowing, type RuleSpec } from "./engine.ts";

export interface DraftPlace {
  /** the priority the rule gets when the draft is approved */
  priority: number;
  /** the priority the draft has */
  from: number;
  /** why it moved, or what runs before it; null = nothing to say */
  why: string | null;
}

/** Single-valued facts of a call: a call has ONE value for each, so two rules that list disjoint values never match the same call. */
const SINGLE = ["agents", "modes", "products", "operations", "effects", "callerProducts", "callerWorkflows"] as const;

/** Could one call match both rules? False only when a single-valued criterion both rules list has no common value (conservative). */
export function mayOverlap(a: RuleSpec["match"], b: RuleSpec["match"]): boolean {
  for (const k of SINGLE) {
    const x = a[k] as readonly string[] | undefined;
    const y = b[k] as readonly string[] | undefined;
    if (x?.length && y?.length && !x.some((v) => y.includes(v))) return false;
  }
  return true;
}

/**
 * Whether a rule's narrowing `e` is at least as strict as the narrowing `s` of another rule: when `e` decides first, the call is
 * narrowed at least as much as `s` would have. No `s` narrowing = true; `s` narrows and `e` does not = false.
 */
export function narrowsAtLeast(e: RuleSpec["narrowing"], s: RuleSpec["narrowing"]): boolean {
  const sn = normNarrowing(s);
  if (!sn) return true;
  const en = normNarrowing(e);
  if (!en) return false;
  return JSON.stringify(mergeNarrowing(en, sn)) === JSON.stringify(mergeNarrowing(en, en));
}

const ORDER: Record<Decision, number> = { deny: 0, hold: 1, allow: 2 };
const cap = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const q = (s: string) => `“${cap(s, 80)}”`;

/**
 * The draft's rules with their approval priorities (same order as given), one place per rule, and a problem ("" = none) when a rule
 * has no room. `current` = every live rule (not deleted), active or not.
 */
export function placeDraft(specs: readonly RuleSpec[], current: readonly RuleSpec[]): { specs: RuleSpec[]; places: DraftPlace[]; problem: string } {
  const out: RuleSpec[] = specs.map((s) => ({ ...s }));
  const places: DraftPlace[] = specs.map((s) => ({ priority: s.priority, from: s.priority, why: null }));
  const done: RuleSpec[] = [];
  const turn = [...specs.keys()].sort((i, j) => ORDER[(specs[i] as RuleSpec).outcome.decision] - ORDER[(specs[j] as RuleSpec).outcome.decision] || i - j);
  for (const i of turn) {
    const s = out[i] as RuleSpec;
    const others = [...current, ...done];
    const d = s.outcome.decision;
    const kind = d === "allow" ? "an allow" : "a hold";
    const stop = (problem: string) => ({ specs: out, places, problem: `This draft cannot be applied: rule ${i + 1} (${q(s.title)}) is ${kind} rule. ${problem}` });
    // the rules this one must run after: refuse and hold for an allow, refuse for a hold
    const blockers = others.filter((o) => (d === "allow" ? o.outcome.decision !== "allow" : d === "hold" && o.outcome.decision === "deny") && mayOverlap(o.match, s.match));
    const last = blockers.reduce<RuleSpec | null>((m, o) => (!m || o.priority > m.priority ? o : m), null);
    if (last && s.priority <= last.priority) {
      const to = last.priority + 1;
      if (to > 1000) return stop(`It must run after ${q(last.title)} (priority ${last.priority}), which it could overlap, and there is no priority after 1000. Lower that rule's priority first.`);
      // D-1 / D-2: allow rules the draft rule was ahead of (as written) and that would run before it at `to`
      const passed = others.filter((o) => o.outcome.decision === "allow" && o.priority >= s.priority && o.priority <= to && mayOverlap(o.match, s.match));
      const lost = d === "hold" ? passed : d === "allow" && s.narrowing ? passed.filter((o) => !narrowsAtLeast(o.narrowing, s.narrowing)) : [];
      const culprit = lost.reduce<RuleSpec | null>((m, o) => (!m || o.priority < m.priority ? o : m), null);
      if (culprit)
        return stop(
          d === "hold"
            ? `It must run after ${q(last.title)} (priority ${last.priority}), so it never weakens it, but then your allow rule ${q(culprit.title)} (priority ${culprit.priority}) would decide first for the calls they share and the hold would not hold them. Change the priority of one of these rules first.`
            : `It must run after ${q(last.title)} (priority ${last.priority}), so it never skips it, but then your allow rule ${q(culprit.title)} (priority ${culprit.priority}) would decide first for the calls they share and this rule's limits (what the agent may read) would not apply. Change the priority of one of these rules first.`,
        );
      places[i] = { priority: to, from: s.priority, why: `Moved from priority ${s.priority} to ${to}: after ${q(last.title)} (priority ${last.priority}), so it never ${d === "allow" ? "skips" : "weakens"} it.` };
      s.priority = to;
    } else if (d !== "allow") {
      // nothing moves a refuse or hold earlier (that could override an owner's exception), but say what runs before it
      const first = others.filter((o) => o.outcome.decision === "allow" && o.priority <= s.priority && mayOverlap(o.match, s.match)).sort((x, y) => x.priority - y.priority)[0];
      if (first) places[i] = { ...(places[i] as DraftPlace), why: `The allow rule ${q(first.title)} (priority ${first.priority}) runs before it for the calls they share.` };
    }
    done.push(s);
  }
  return { specs: out, places, problem: "" };
}
