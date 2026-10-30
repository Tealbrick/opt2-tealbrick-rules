// The company floor (C380 B8a, S1-1, overrides C84; DEV default ON): one line before every rule, in all modes, that the owner
// does not edit. Its data lives in its OWN table, apart from the Fleet read model (src/store.ts), for one reason: that copy is
// cleared by a refusal and given up after 10 minutes, and a stop that opens when Governance is paused or its licence lapses is no
// stop. So:
//  - Only a full valid read of the feed changes these rows, in the same transaction that makes the read the current copy.
//    A refusal, an invalid answer, an expiry, an outage, a crash or an "unchanged" answer never touches them.
//  - A read that could not ask for lifecycle facts (the fallback for a Governance that refuses `accept`) only ADDS: it cannot
//    know who stopped being listed.
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
/** How one valid read changes the floor. `replace`: a read that asked for lifecycle facts. `add`: the fallback read without `accept`. */
export interface FloorRead {
  entries: readonly FloorEntry[];
  revision: number;
  mode: "replace" | "add";
}

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
  const current = new Map<string, { code: string; holder: string }>();
  for (const r of db.prepare("SELECT kind, id, code, holder FROM floor_entries").all()) current.set(keyOf(String(r.kind), String(r.id)), { code: String(r.code), holder: String(r.holder) });
  const next = new Map(read.entries.map((e) => [keyOf(e.kind, e.id), e]));
  const out = new Map<string, string>();
  if (read.mode === "replace") {
    const del = db.prepare("DELETE FROM floor_entries WHERE kind = ? AND id = ?");
    for (const key of current.keys()) {
      if (next.has(key)) continue;
      const at = key.indexOf(":");
      del.run(key.slice(0, at), key.slice(at + 1));
    }
  } else {
    for (const [key, v] of current) out.set(key, v.code);
  }
  const put = db.prepare("INSERT INTO floor_entries (kind, id, code, holder, revision, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (kind, id) DO UPDATE SET code = excluded.code, holder = excluded.holder");
  for (const [key, e] of next) {
    out.set(key, e.code);
    const was = current.get(key);
    if (was?.code !== e.code || was.holder !== e.holder) put.run(e.kind, e.id, e.code, e.holder, read.revision, now);
  }
  // Governance reads this revision before it says "Rules has this change" (S2-9), so a read that could not see lifecycle facts does not move it
  if (read.mode === "replace") db.prepare("UPDATE floor_state SET feed_revision = ?, read_at = ? WHERE id = 1").run(read.revision, now);
  return out;
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

export interface FloorState {
  feedRevision: number | null;
  readAt: number | null;
  /** epoch ms; null = the gate never ran */
  lastGateAt: number | null;
  entries: number;
}

export function floorState(db: Db): FloorState {
  const r = db.prepare("SELECT feed_revision, read_at, last_gate_at FROM floor_state WHERE id = 1").get();
  const stored = r?.last_gate_at == null ? null : Number(r.last_gate_at);
  const mem = lastGate.get(db)?.at ?? 0;
  return {
    feedRevision: r?.feed_revision == null ? null : Number(r.feed_revision),
    readAt: r?.read_at == null ? null : Number(r.read_at),
    lastGateAt: mem > (stored ?? 0) ? mem : stored,
    entries: Number(db.prepare("SELECT COUNT(*) AS n FROM floor_entries").get()?.n ?? 0),
  };
}

export interface FloorRow {
  kind: FloorKind;
  id: string;
  code: string;
  holder: string;
  revision: number;
  at: number;
}

/** The rows for the owner's page, newest first. */
export function floorRows(db: Db, limit: number): FloorRow[] {
  return db
    .prepare("SELECT kind, id, code, holder, revision, at FROM floor_entries ORDER BY at DESC, holder, kind, id LIMIT ?")
    .all(limit)
    .map((r) => ({ kind: String(r.kind) as FloorKind, id: String(r.id), code: String(r.code), holder: String(r.holder), revision: Number(r.revision), at: Number(r.at) }));
}

/**
 * The owner's way out: one holder with its handles, or (`holder` null) everything. Recorded in `floor_clears`. Governance is not told:
 * if it still lists the entry, the entry comes back at the next full read, so an owner who no longer trusts Governance also pauses or
 * removes it (a refused read then changes nothing here). Answers how many entries were lifted.
 */
export function clearFloor(db: Db, input: { holder: string | null; actor: string }, now = Date.now()): number {
  const n = db.transaction(() => {
    const res = input.holder === null ? db.prepare("DELETE FROM floor_entries").run() : db.prepare("DELETE FROM floor_entries WHERE holder = ?").run(input.holder);
    const count = Number(res.changes ?? 0);
    db.prepare("INSERT INTO floor_clears (id, at, actor, holder, entries) VALUES (?, ?, ?, ?, ?)").run(`flc_${ulid(now)}`, now, input.actor, input.holder, count);
    return count;
  });
  cache.delete(db);
  return n;
}
