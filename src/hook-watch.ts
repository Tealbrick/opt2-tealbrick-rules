// Is Rules' own hook on? (C383, D13.) Portal holds the owner's per-hook switch and the bridge skips a switched-off hook, so Rules gets no call and no signal. But Rules' own read
// of Governance's feed goes through the bridge's hooks like any other call, so that read is a probe: when the bridge answered it and a hook of Rules did not run during it, that
// hook is off. Memory only: a restart reads "unknown" until the next feed read (at start, then every 60 s). No Governance, no read, no answer here: "unknown", never "on".
import type { Db } from "@opt2-tealbrick/miniapp-sdk";

export const WATCHED_HOOKS = ["gate", "context", "filter"] as const;
export type WatchedHook = (typeof WATCHED_HOOKS)[number];
export type HookSeen = "on" | "off" | "unknown";
export interface HookState {
  gate: HookSeen;
  context: HookSeen;
  filter: HookSeen;
  /** epoch ms of the feed read that said so; null = no answer yet */
  checkedAt: number | null;
}

/** An answer older than this says nothing: Governance may be gone, and the switch may have moved. Five missed reads of the 60 s timer. */
export const HOOK_STATE_MAX_AGE_MS = 5 * 60_000;

type Runs = Record<WatchedHook, number>;
const runs = new WeakMap<Db, Runs>();
const last = new WeakMap<Db, { off: readonly WatchedHook[]; at: number }>();

/** One run of a hook. Never throws: a hook's answer must not depend on this. */
export function noteHookRun(db: Db, hook: WatchedHook): void {
  const r = runs.get(db) ?? { gate: 0, context: 0, filter: 0 };
  r[hook] += 1;
  runs.set(db, r);
}

/** Before a feed read. */
export function hookRunsNow(db: Db): Readonly<Runs> {
  return { gate: 0, context: 0, filter: 0, ...runs.get(db) };
}

/** After the bridge forwarded a feed read and the answer came back: every hook that matches it ran before that, so one that did not run is switched off. */
export function judgeHooks(db: Db, before: Readonly<Runs>, now: number): void {
  const after = hookRunsNow(db);
  last.set(db, { off: WATCHED_HOOKS.filter((h) => after[h] === before[h]), at: now });
}

export function hookState(db: Db, now = Date.now()): HookState {
  const l = last.get(db);
  if (!l || now - l.at > HOOK_STATE_MAX_AGE_MS) return { gate: "unknown", context: "unknown", filter: "unknown", checkedAt: l?.at ?? null };
  const seen = (h: WatchedHook): HookSeen => (l.off.includes(h) ? "off" : "on");
  return { gate: seen("gate"), context: seen("context"), filter: seen("filter"), checkedAt: l.at };
}
