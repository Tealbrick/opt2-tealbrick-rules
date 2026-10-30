// The company floor (C380 B8a, S1-1, overrides C84; DEV default ON): one line before every rule, in all modes, that the owner
// does not edit. Its data lives in its OWN table, apart from the Fleet read model (src/store.ts), for one reason: that copy is
// cleared by a refusal and given up after 10 minutes, and a stop that opens when Governance is paused or its licence lapses is no
// stop. So:
//  - Only a full valid read of the feed changes these rows, in the same transaction that makes the read the current copy.
//    A refusal, an invalid answer, an expiry, an outage, a crash or an "unchanged" answer never touches them.
//  - A read with no lifecycle facts (a Governance that ignores `accept`, an older release after a rollback, the fallback for one that refuses
//    `accept`, an empty directory) is BLIND: it cannot lift a lifecycle stop, because it does not know about one. It decides only the stops it can
//    see: trust `blocked` and a departed contact. Such a stop on a lifecycle-only entry stays until a read with lifecycle facts, or the owner's Clear.
//  - A read that goes BACK (a lower revision, or another epoch: Governance restored from a backup or installed fresh, N2-2) is no proof that a stop ended: its data
//    is older than the stop. The floor is then REGRESSED: reads only add, nothing is lifted, until the owner's Clear all. The Rules page says why.
//  - The gate reads `floorIndex` and never asks `fleetFacts().available`.
//  - The way out, when Governance is gone or compromised, is the owner's person op `floor_clear`.
// A read of the table that fails throws, and the gate answers FAIL_CLOSED: no copy that can be read means a refusal, never an allow.
import { ulid } from "@opt2-tealbrick/manifest";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";

/** What the caller is told, whoever or whatever the floor refused: one sentence, so a refusal does not say who is not active (S2-8). */
export const FLOOR_REASON = "Refused by company policy";

export type FloorKind = "agent" | "contact" | "handle";
export interface FloorEntry {
  kind: FloorKind;
  id: string;
  code: string;
  /** `agent:<id>` or `contact:<id>`: the entry's owner in the feed */
  holder: string;
}
/**
 * How one valid read changes the floor. `aware`: the answer carried `floor` on at least one row, so it speaks for every kind of stop.
 * `blindHolders`: the rows of an aware answer that carried no `floor` (`agent:<id>`, `contact:<id>`): each of them is blind on its own.
 */
export interface FloorRead {
  entries: readonly FloorEntry[];
  revision: number;
  aware: boolean;
  blindHolders?: ReadonlySet<string>;
  /** the feed's `epoch`: another value than the last one means another origin. Absent on a Governance that sends none */
  epoch?: string;
}
/** The stops a read with no lifecycle facts can see, so it may also lift them. Every other code is a lifecycle stop. */
const VISIBLE_WITHOUT_LIFECYCLE: ReadonlySet<string> = new Set(["blocked", "departed"]);
export const isLifecycleStop = (code: string): boolean => !VISIBLE_WITHOUT_LIFECYCLE.has(code);

const keyOf = (kind: string, id: string): string => `${kind}:${id}`;

/** key (`agent:<id>`, `contact:<id>`, `handle:<canonical>`) → code. Swapped only after the transaction that wrote the rows committed. */
const cache = new WeakMap<Db, Map<string, string>>();

/** The floor the gate reads: cached; loaded from the table after a restart. Throws when the table cannot be read (the gate then refuses). */
export function floorIndex(db: Db): ReadonlyMap<string, string> {
  const hit = cache.get(db);
  if (hit) return hit;
  const map = new Map<string, string>();
  for (const r of db.prepare("SELECT kind, id, code FROM floor_entries").all()) map.set(keyOf(String(r.kind), String(r.id)), String(r.code));
  cache.set(db, map);
  return map;
}

/**
 * Write one valid read. Call it INSIDE the transaction that makes the read current, and hand the answer to `commitFloor` only after that
 * transaction committed. Rows that did not change are left alone, so an entry keeps the revision and the time that first listed it.
 */
export function writeFloor(db: Db, read: FloorRead, now: number): Map<string, string> {
  const state = db.prepare("SELECT high_revision, epoch, regressed_at FROM floor_state WHERE id = 1").get();
  const high = state?.high_revision == null ? null : Number(state.high_revision);
  const epoch = state?.epoch == null ? null : String(state.epoch);
  // another epoch is another origin, also on an empty directory (no row says `floor`). A missing one counts only on an aware read: the fallback read asks for none
  const otherEpoch = epoch !== null && (read.epoch !== undefined ? read.epoch !== epoch : read.aware);
  const why = high !== null && read.revision < high ? "revision" : otherEpoch ? "epoch" : null;
  const regressed = state?.regressed_at != null || why !== null;
  if (state?.regressed_at == null && why !== null) db.prepare("UPDATE floor_state SET regressed_at = ?, regressed_from = ?, regressed_to = ?, regressed_why = ? WHERE id = 1").run(now, high, read.revision, why);
  if (!regressed) db.prepare("UPDATE floor_state SET high_revision = MAX(COALESCE(high_revision, ?), ?), epoch = COALESCE(?, epoch) WHERE id = 1").run(read.revision, read.revision, read.epoch ?? null);

  const current = new Map<string, { code: string; holder: string }>();
  for (const r of db.prepare("SELECT kind, id, code, holder FROM floor_entries").all()) current.set(keyOf(String(r.kind), String(r.id)), { code: String(r.code), holder: String(r.holder) });
  const next = new Map(read.entries.map((e) => [keyOf(e.kind, e.id), e]));
  const out = new Map<string, string>();
  const del = db.prepare("DELETE FROM floor_entries WHERE kind = ? AND id = ?");
  const listed = db.prepare("UPDATE floor_entries SET listed = ? WHERE kind = ? AND id = ?");
  for (const [key, was] of current) {
    const at = key.indexOf(":");
    const [kind, id] = [key.slice(0, at), key.slice(at + 1)];
    if (regressed) {
      // nothing is lifted; the page shows what Governance's list no longer has
      out.set(key, next.get(key)?.code ?? was.code);
      // a row with no `floor` still lists its holder: it just cannot speak for a lifecycle stop
      if (!next.has(key) && !(read.blindHolders?.has(was.holder) && isLifecycleStop(was.code))) listed.run(0, kind, id);
    } else if ((!read.aware || read.blindHolders?.has(was.holder)) && isLifecycleStop(was.code)) {
      // a blind read, or a blind row of an aware read, neither lifts nor rewrites a lifecycle stop
      out.set(key, was.code);
      next.delete(key);
    } else if (!next.has(key)) del.run(kind, id);
  }
  const put = db.prepare("INSERT INTO floor_entries (kind, id, code, holder, revision, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET code = excluded.code, holder = excluded.holder, listed = 1");
  for (const [key, e] of next) {
    out.set(key, e.code);
    const was = current.get(key);
    if (was?.code !== e.code || was.holder !== e.holder) put.run(e.kind, e.id, e.code, e.holder, read.revision, now);
    else if (regressed) listed.run(1, e.kind, e.id);
  }
  // Governance reads this revision before it says "Rules has this change" (S2-9), so a read that could not see lifecycle facts does not move it. Regressed reads move it:
  // they add, so a stop made after the restore really is in the table, and Governance's revisions have started again from the lower number.
  if (read.aware) db.prepare("UPDATE floor_state SET feed_revision = ?, read_at = ? WHERE id = 1").run(read.revision, now);
  return out;
}

/**
 * An `unchanged` answer from another origin: a restored Governance can reach the very revision Rules asked about, with other data. It does not touch the floor; the caller then
 * reads in full, where `writeFloor` marks it. Not while regressed: that state already holds everything, and a full read a minute would add nothing.
 */
export function otherOriginUnchanged(db: Db, epoch: string | undefined): boolean {
  if (epoch === undefined) return false;
  const r = db.prepare("SELECT epoch, regressed_at FROM floor_state WHERE id = 1").get();
  return r?.regressed_at == null && r?.epoch != null && String(r.epoch) !== epoch;
}

export function commitFloor(db: Db, index: Map<string, string>): void {
  cache.set(db, index);
}

// ── lastGateAt ────────────────────────────────────────────────────────────────────────
/** The gate writes its time at most this often (it does no other write but the trace). */
export const GATE_NOTE_MS = 60_000;
const lastGate = new WeakMap<Db, { at: number; written: number }>();

/** Note one run of the gate. Never throws: a failed note must not change a decision. */
export function noteGate(db: Db, now: number): void {
  const mem = lastGate.get(db) ?? { at: 0, written: 0 };
  mem.at = now;
  lastGate.set(db, mem);
  if (now - mem.written < GATE_NOTE_MS) return;
  mem.written = now;
  try {
    db.prepare("UPDATE floor_state SET last_gate_at = ? WHERE id = 1").run(now);
  } catch {
    // shown one minute later than it could be; the decision is not affected
  }
}

/** Why the floor reads only add now. `why`: `revision` = the feed's revision went back; `epoch` = the feed comes from another origin (restored or installed fresh). */
export interface FloorRegressed {
  at: number;
  fromRevision: number | null;
  toRevision: number | null;
  why: "revision" | "epoch";
}

export interface FloorState {
  feedRevision: number | null;
  readAt: number | null;
  /** epoch ms; null = the gate never ran */
  lastGateAt: number | null;
  entries: number;
  /** entries held only because the floor is regressed: Governance's current list does not have them */
  unlisted: number;
  regressed: FloorRegressed | null;
}

export function floorState(db: Db): FloorState {
  const r = db.prepare("SELECT feed_revision, read_at, last_gate_at, regressed_at, regressed_from, regressed_to, regressed_why FROM floor_state WHERE id = 1").get();
  const stored = r?.last_gate_at == null ? null : Number(r.last_gate_at);
  const mem = lastGate.get(db)?.at ?? 0;
  return {
    feedRevision: r?.feed_revision == null ? null : Number(r.feed_revision),
    readAt: r?.read_at == null ? null : Number(r.read_at),
    lastGateAt: mem > (stored ?? 0) ? mem : stored,
    entries: Number(db.prepare("SELECT COUNT(*) AS n FROM floor_entries").get()?.n ?? 0),
    unlisted: Number(db.prepare("SELECT COUNT(*) AS n FROM floor_entries WHERE listed = 0").get()?.n ?? 0),
    regressed: r?.regressed_at == null ? null : { at: Number(r.regressed_at), fromRevision: r.regressed_from == null ? null : Number(r.regressed_from), toRevision: r.regressed_to == null ? null : Number(r.regressed_to), why: r.regressed_why === "epoch" ? "epoch" : "revision" },
  };
}

export interface FloorRow {
  kind: FloorKind;
  id: string;
  code: string;
  holder: string;
  revision: number;
  at: number;
  listed: boolean;
}

/** The rows for the owner's page, newest first. */
export function floorRows(db: Db, limit: number): FloorRow[] {
  return db
    .prepare("SELECT kind, id, code, holder, revision, at, listed FROM floor_entries ORDER BY at DESC, holder, kind, id LIMIT ?")
    .all(limit)
    .map((r) => ({ kind: String(r.kind) as FloorKind, id: String(r.id), code: String(r.code), holder: String(r.holder), revision: Number(r.revision), at: Number(r.at), listed: Number(r.listed) === 1 }));
}

/**
 * The owner's way out: one holder with its handles, or (`holder` null) everything. Recorded in `floor_clears`. Governance is not told: if it still
 * lists the entry, the entry comes back at the next read. The caller marks the copy stale (`markFleetStale`), so that read is a full one, also when a sync
 * is in flight, and what the owner reads on the page is what happens. An owner who no longer trusts Governance also removes it: a refused read then
 * changes nothing here. Clear ALL also ends a regressed floor: the owner has seen why, and Governance's current list decides again from the next read on. `feed_revision` is forgotten until that read (S2-9): Governance must not read "Rules has this change" while the entry is lifted.
 * Answers how many entries were lifted.
 */
export function clearFloor(db: Db, input: { holder: string | null; actor: string }, now = Date.now()): number {
  const n = db.transaction(() => {
    const res = input.holder === null ? db.prepare("DELETE FROM floor_entries").run() : db.prepare("DELETE FROM floor_entries WHERE holder = ?").run(input.holder);
    const count = Number(res.changes ?? 0);
    db.prepare("INSERT INTO floor_clears (id, at, actor, holder, entries) VALUES (?, ?, ?, ?, ?)").run(`flc_${ulid(now)}`, now, input.actor, input.holder, count);
    db.prepare("UPDATE floor_state SET feed_revision = NULL WHERE id = 1").run();
    if (input.holder === null) db.prepare("UPDATE floor_state SET high_revision = NULL, epoch = NULL, regressed_at = NULL, regressed_from = NULL, regressed_to = NULL, regressed_why = NULL WHERE id = 1").run();
    return count;
  });
  cache.delete(db);
  return n;
}
