// The default mode's storage (migrations/0010_default_mode.sql): one row in `settings` and an append-only `mode_changes`
// history. The gate reads the mode from a per-database cache next to the rules cache (no query per call); `setMode`
// refreshes it after its write.
import { type Db, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { type DefaultMode, isMode, looser, MODE_LABEL } from "./mode.ts";

export const MODE_KEY = "default_mode";
/** History rows returned by `mode_get`. */
export const MODE_HISTORY_MAX = 50;

const modeCache = new WeakMap<Db, DefaultMode>();

/**
 * The current mode; cached until the next `setMode`. A missing row or a value that is not a mode (only a damaged database:
 * migration 0010 inserts the row and a CHECK keeps it valid) reads as `closed` (fail closed, like every other gap in Rules).
 */
export function currentMode(db: Db): DefaultMode {
  const hit = modeCache.get(db);
  if (hit) return hit;
  const v = db.prepare("SELECT value FROM settings WHERE key = ?").get(MODE_KEY)?.value;
  const mode = isMode(v) ? v : "closed";
  modeCache.set(db, mode);
  return mode;
}

export function invalidateMode(db: Db): void {
  modeCache.delete(db);
}

export interface ModeState {
  mode: DefaultMode;
  changedAt: string | null;
  changedBy: string | null;
}

const iso = (ms: unknown) => (ms == null ? null : new Date(Number(ms)).toISOString());

export function modeState(db: Db): ModeState {
  const r = db.prepare("SELECT updated_at, updated_by FROM settings WHERE key = ?").get(MODE_KEY);
  return { mode: currentMode(db), changedAt: iso(r?.updated_at), changedBy: r?.updated_by == null ? null : String(r.updated_by) };
}

export interface ModeChange {
  at: string;
  actor: string;
  from: DefaultMode;
  to: DefaultMode;
}

export function modeHistory(db: Db, limit = MODE_HISTORY_MAX): ModeChange[] {
  return db
    .prepare("SELECT at, actor, from_mode, to_mode FROM mode_changes ORDER BY id DESC LIMIT ?")
    .all(limit)
    .map((r) => ({ at: iso(r.at) as string, actor: String(r.actor), from: String(r.from_mode) as DefaultMode, to: String(r.to_mode) as DefaultMode }));
}

/**
 * Change the mode (owner only; the op checks the person). A move to a LOOSER mode (closed → verification → permissive)
 * needs `confirm: true`, else 409 `confirm_required`; a tighter move needs none. Setting the current mode again changes
 * nothing and records nothing (`changed: false`), so a replay is harmless. Every change is one history row (who, when, from → to).
 */
export function setMode(db: Db, input: { mode: DefaultMode; confirm?: boolean; actor: string }, now = Date.now()): ModeState & { previous: DefaultMode; changed: boolean } {
  if (!isMode(input.mode)) throw new TbError("input_invalid", "mode must be permissive, verification or closed", 400);
  const previous = db.transaction(() => {
    const raw = db.prepare("SELECT value FROM settings WHERE key = ?").get(MODE_KEY)?.value;
    const from: DefaultMode = isMode(raw) ? raw : "closed";
    if (from === input.mode) return from;
    if (looser(from, input.mode) && input.confirm !== true)
      throw new TbError(
        "confirm_required",
        `Moving from ${MODE_LABEL[from]} to ${MODE_LABEL[input.mode]} mode lets calls that no rule covers ${input.mode === "permissive" ? "run without your review" : "wait for your review instead of being refused"}. Confirm to change it.`,
        409,
      );
    db.prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by").run(
      MODE_KEY,
      input.mode,
      now,
      input.actor,
    );
    db.prepare("INSERT INTO mode_changes (at, actor, from_mode, to_mode) VALUES (?, ?, ?, ?)").run(now, input.actor, from, input.mode);
    return from;
  });
  invalidateMode(db);
  return { ...modeState(db), previous, changed: previous !== input.mode };
}
