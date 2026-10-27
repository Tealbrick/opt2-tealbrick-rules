// Replicated Fleet read model (C81 G2). Rules never calls Governance (product id `fleet`) inside a hook (G3, no re-entry):
// it reads `directory_feed` (contract fleet.directory_feed/1) through its companion grant OUTSIDE calls, keeps teams and
// trust in its own tables, and the gate reads only that local copy. Refresh points: every 60 s from a timer once the SDK
// offers `callApp` outside op handlers (C85, spec 0.1.13; feature-checked), agent events, and person ops when the copy is
// older than 60 s.
// Every answer is validated against the vendored schema (src/contracts: Governance's `fleet.directory_feed/1` schema with the
// optional agents[].handles, C373 RULES-INTERFACE §3, byte copy, see test/contracts/PROVENANCE.md) and every handle must be
// canonical (normalizeHandle(h) === h). Rules asks for agent handles (`accept: ["agent_handles"]`); a Governance that does not
// know `accept` (0.2.x, its input schema refuses unknown fields) answers 400 and Rules reads it again without it (see AGENT_HANDLES). A mismatch is a REFUSAL:
// the error is recorded (fleet_status shows it), the copy is cleared, nothing of the answer is read (never a partial read).
// No Governance (no grant, not deployed) or a refused answer → the Fleet facts are UNAVAILABLE: the engine applies deny
// and hold rules that name Fleet facts and skips allow rules that name them (fail closed, C230).

import { normalizeHandle, validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Db, Json } from "@opt2-tealbrick/miniapp-sdk";
import feedSchema from "./contracts/fleet.directory_feed.1.agent_handles.schema.json" with { type: "json" };
import type { Trust } from "./engine.ts";
import { dropFleetCopy, emptyFleet, FLEET_MAX_STALE_MS, type FleetModel, type FleetTeam, fleetState, setFleetStale, staleMarksOf, type TrustEntry, writeFleetChunked } from "./store.ts";

export const FLEET_PRODUCT = "fleet";
export const FLEET_OP = "directory_feed";
export const REFRESH_MS = 60_000;
/** The feed extra Rules reads (C373 RULES-INTERFACE §3): agents[].handles, the canonical handles Connect issued to each agent. */
export const AGENT_HANDLES = "agent_handles";
/** After a Governance refused `accept` (older than 0.3.0), Rules asks for it again after this long (a Governance update shows within it). */
export const ACCEPT_RETRY_MS = 10 * 60 * 1000;
/** The error code of an answer that does not fit the contract (a refusal). */
export const FEED_INVALID = "feed_invalid";
/**
 * Refusals: Governance is not there for us (no grant, not deployed, unlicensed, paused, ...) or its answer breaks the
 * contract. The copy is CLEARED at once (the Fleet facts become unavailable, A2A-9 / C230). Any 4xx except 408/429 is a
 * refusal too; everything else (5xx incl. the feed's 503 `feed_too_large`, timeout, network, rate limit) is transient:
 * the copy is kept while its last successful read is ≤ FLEET_MAX_STALE_MS old.
 */
const REFUSALS = new Set([
  FEED_INVALID,
  "no_grant",
  "not_granted",
  "grant_missing",
  "grant_invalid",
  "grant_stale",
  "not_found",
  "unknown_product",
  "unknown_tool",
  "app_not_found",
  "unlicensed",
  "not_licensed",
  "forbidden",
  "scope_denied",
  "paused",
  "held",
]);

export function isRefusal(e: unknown): boolean {
  const code = isObj(e) && typeof e.code === "string" ? e.code : "";
  if (REFUSALS.has(code)) return true;
  const status = isObj(e) && typeof e.httpStatus === "number" ? e.httpStatus : null;
  return status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export type CallApp = (product: string, op: string, input: Json) => Promise<{ status: "ok"; output: unknown } | { status: "held"; holdId: string }>;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const feedInvalid = (why: string): Error => Object.assign(new Error(why.slice(0, 240)), { code: FEED_INVALID });

/** Least permissive last: the stricter of two trust values (a monotone order: blocked > limited > unreviewed > trusted). */
const STRICTNESS: readonly Trust[] = ["trusted", "unreviewed", "limited", "blocked"];
export const strictest = (a: Trust, b: Trust): Trust => (STRICTNESS.indexOf(a) >= STRICTNESS.indexOf(b) ? a : b);

export interface ParsedFeed {
  revision: number;
  unchanged: boolean;
  model: FleetModel;
}

/** Work units between two yields to the event loop while an answer is read (about 2 to 5 ms of work). */
export const PARSE_YIELD_UNITS = 4_000;
type FullSchema = { $defs: { full: { properties: Record<"teams" | "contacts" | "agents", { maxItems: number }> } } };
const CAPS = (feedSchema as unknown as FullSchema).$defs.full.properties;

/**
 * The model from a `directory_feed` answer, as steps (a generator yields every PARSE_YIELD_UNITS units of work so a big
 * answer never blocks the event loop; `parseFeed` runs it to the end). Throws (code `feed_invalid`) unless the answer
 * passes the vendored schema (validated in slices, the array caps read from the schema), every handle is canonical and no
 * team, contact or agent id is listed twice. Mapping, per KEY (`agent:<id>`, `contact:<id>`, `handle:<canonical>`; a handle
 * can have several HOLDERS):
 * - a holder is ACTIVE when it is not blocked, departed (contact) or removed (agent); a paused agent is active;
 * - deny/hold rules: a key is in team T if ANY holder is a member of T (so blocked, departed and removed members count);
 *   allow rules: only if EVERY holder is active and a member of T;
 * - trust: the SET of the holders' raw trust values, and whether every holder is active. Deny/hold match if ANY holder's
 *   trust is listed; allow needs every holder active and listed (a gone holder never satisfies an allow by trust);
 * - a member the producer left out of `contacts`/`agents` has a team key for deny/hold only and no trust (unknown =
 *   `unreviewed` at lookup);
 * - an agent's `handles` (C373 §3, optional) make the agent a holder of each `handle:<h>` key, exactly like a contact's.
 */
function* parseSteps(out: unknown): Generator<void, ParsedFeed, void> {
  if (!isObj(out)) throw feedInvalid("directory_feed answered no object");
  const schema = feedSchema as unknown as Parameters<typeof validateAgainstSchema>[0];
  const check = (doc: Json) => {
    const v = validateAgainstSchema(schema, doc);
    if (!v.ok) throw feedInvalid(`the answer does not fit fleet.directory_feed/1: ${v.errors.slice(0, 3).map((e) => `${e.path || "/"} ${e.message}`).join("; ")}`);
  };
  if (out.unchanged === true) {
    check(out as Json);
    return { revision: out.revision as number, unchanged: true, model: emptyFleet() };
  }
  // Validate in slices (the same schema, each slice a full document with the other arrays empty), then the array caps.
  const teamsIn = Array.isArray(out.teams) ? (out.teams as { id: string; name?: string; members: { kind: string; id: string }[] }[]) : null;
  const contacts = Array.isArray(out.contacts) ? (out.contacts as { id: string; kind: string; status: string; trust: Trust; handles: string[] }[]) : null;
  const agents = Array.isArray(out.agents) ? (out.agents as { id: string; status: string; trust: Trust; handles?: string[] }[]) : null;
  // the document without its three big arrays (a missing or non-array member stays as it is, so the schema refuses it)
  const shell = { ...out, ...Object.fromEntries((["teams", "contacts", "agents"] as const).filter((k) => Array.isArray(out[k])).map((k) => [k, []])) } as Json;
  check(shell);
  if (!teamsIn || !contacts || !agents) throw feedInvalid("teams, contacts and agents must be arrays");
  for (const [name, list] of [["teams", teamsIn], ["contacts", contacts], ["agents", agents]] as const) {
    if (list.length > CAPS[name].maxItems) throw feedInvalid(`more than ${CAPS[name].maxItems} ${name}`);
  }
  const slices: [keyof typeof CAPS, unknown[]][] = [];
  for (let i = 0, n = 0, from = 0; i < teamsIn.length; i++) {
    n += (Array.isArray(teamsIn[i]?.members) ? (teamsIn[i] as { members: unknown[] }).members.length : 0) + 1;
    if (n >= PARSE_YIELD_UNITS || i === teamsIn.length - 1) {
      slices.push(["teams", teamsIn.slice(from, i + 1)]);
      from = i + 1;
      n = 0;
    }
  }
  for (let i = 0; i < contacts.length; i += 1000) slices.push(["contacts", contacts.slice(i, i + 1000)]);
  for (let i = 0; i < agents.length; i += 4000) slices.push(["agents", agents.slice(i, i + 4000)]);
  for (const [name, part] of slices) {
    check({ ...(shell as Record<string, Json>), [name]: part } as Json);
    yield;
  }

  let work = 0;
  const tick = (n = 1): boolean => {
    work += n;
    if (work < PARSE_YIELD_UNITS) return false;
    work = 0;
    return true;
  };
  for (const c of contacts) {
    for (const h of c.handles) {
      // S4-3: the error is shown by fleet_status and kept in fleet_sync: it names the contact, never the handle
      if (normalizeHandle(h) !== h) throw feedInvalid(`a handle of contact ${c.id.slice(0, 64)} is not canonical (normalizeHandle)`);
      if (tick(40)) yield;
    }
  }
  // C373 §3: agents[].handles (only when Rules asked for them; an older Governance never sends them) follow the same rule
  for (const a of agents) {
    for (const h of a.handles ?? []) {
      if (normalizeHandle(h) !== h) throw feedInvalid(`a handle of agent ${a.id.slice(0, 64)} is not canonical (normalizeHandle)`);
      if (tick(40)) yield;
    }
  }
  for (const [what, ids] of [["team", teamsIn.map((t) => t.id)], ["contact", contacts.map((c) => c.id)], ["agent", agents.map((a) => a.id)]] as const) {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) throw feedInvalid(`${what} id listed twice: ${id.slice(0, 40)}`);
      seen.add(id);
    }
    yield;
  }

  // teams of each contact / agent (every membership, regardless of status)
  const contactTeams = new Map<string, Set<string>>();
  const agentTeams = new Map<string, Set<string>>();
  const out2 = teamsIn.map((t): FleetTeam => ({ id: t.id, name: t.name ?? t.id, people: 0, agents: 0, keys: [], activeKeys: [] }));
  for (const [i, t] of teamsIn.entries()) {
    const team = out2[i] as FleetTeam;
    for (const m of t.members) {
      const map = m.kind === "agent" ? agentTeams : contactTeams;
      if (m.kind === "agent") team.agents++;
      else team.people++;
      const set = map.get(m.id);
      if (set) set.add(t.id);
      else map.set(m.id, new Set([t.id]));
      if (tick() ) yield;
    }
  }

  interface Holder {
    trust: Trust;
    active: boolean;
    teams: ReadonlySet<string>;
  }
  const none: ReadonlySet<string> = new Set();
  const holders = new Map<string, Holder[]>();
  const hold = (key: string, h: Holder) => {
    const list = holders.get(key);
    if (list) list.push(h);
    else holders.set(key, [h]);
  };
  const known = { contact: new Set<string>(), agent: new Set<string>() };
  for (const c of contacts) {
    known.contact.add(c.id);
    const h: Holder = { trust: c.trust, active: c.status === "active" && c.trust !== "blocked", teams: contactTeams.get(c.id) ?? none };
    hold(`contact:${c.id}`, h);
    for (const handle of c.handles) hold(`handle:${handle}`, h);
    if (tick(1 + c.handles.length)) yield;
  }
  for (const a of agents) {
    known.agent.add(a.id);
    const h: Holder = { trust: a.trust, active: a.status !== "removed" && a.trust !== "blocked", teams: agentTeams.get(a.id) ?? none };
    hold(`agent:${a.id}`, h);
    // C373 D5: an agent that holds a handle is a holder of `handle:<h>` like a contact (recipients, channel-sender claims)
    for (const handle of a.handles ?? []) hold(`handle:${handle}`, h);
    if (tick(1 + (a.handles?.length ?? 0))) yield;
  }

  const byId = new Map(out2.map((t) => [t.id, t]));
  const trust = new Map<string, TrustEntry>();
  const place = (key: string, any: ReadonlySet<string>, act: ReadonlySet<string>) => {
    for (const tid of any) {
      const team = byId.get(tid) as FleetTeam;
      team.keys.push(key);
      if (act.has(tid)) team.activeKeys.push(key);
    }
  };
  for (const [key, hs] of holders) {
    const allActive = hs.every((h) => h.active);
    const any = new Set<string>();
    for (const h of hs) for (const t of h.teams) any.add(t);
    // allow: the team must hold EVERY holder, and every holder must be active
    let act: ReadonlySet<string> = none;
    if (allActive) {
      const first = hs[0] as Holder;
      act = new Set([...first.teams].filter((t) => hs.every((h) => h.teams.has(t))));
    }
    trust.set(key, { trusts: [...new Set(hs.map((h) => h.trust))], allActive });
    place(key, any, act);
    if (tick(1 + any.size)) yield;
  }
  // members the producer left out of contacts/agents: deny/hold only
  for (const [id, ts] of contactTeams) if (!known.contact.has(id)) place(`contact:${id}`, ts, none);
  for (const [id, ts] of agentTeams) if (!known.agent.has(id)) place(`agent:${id}`, ts, none);
  return { revision: out.revision as number, unchanged: false, model: { teams: out2, trust } };
}

/** Read an answer in one go (small answers, tests). */
export function parseFeed(out: unknown): ParsedFeed {
  const g = parseSteps(out);
  for (let r = g.next(); ; r = g.next()) if (r.done) return r.value;
}

/** Read an answer, yielding to the event loop between slices of work. */
export async function parseFeedChunked(out: unknown, pause: () => Promise<void> = () => new Promise((r) => setImmediate(r))): Promise<ParsedFeed> {
  const g = parseSteps(out);
  for (let r = g.next(); ; r = g.next()) {
    if (r.done) return r.value;
    await pause();
  }
}

const inflight = new WeakMap<Db, Promise<void>>();
/** When this Governance last refused `accept` (epoch ms; in memory, so a restart asks again). */
const acceptRefusedAt = new WeakMap<Db, number>();
/**
 * Whether the stored copy was read WITH agent handles (in memory). A delta read (`sinceRevision`) is only asked for when the
 * copy has the shape this read asks for: after a restart, or when `accept` is switched on or off, the next read is a full one
 * (Governance 0.3.0 answers "unchanged" for `sinceRevision` = its revision BEFORE it looks at `accept`, so a delta read would keep
 * a copy without the handles until the revision moves). In memory, so an upgrade or restart costs one full read; no column, no migration.
 */
const copyWithHandles = new WeakMap<Db, boolean>();

/** A 400 to the read with `accept`: a Governance whose input schema does not know it (0.2.x refuses unknown fields). */
const refusesAccept = (e: unknown): boolean => isObj(e) && (e.code === "input_invalid" || e.httpStatus === 400);

/**
 * One sync (plus at most two more when `markFleetStale` was called while it ran: the flag the first write cleared is set
 * again and the agent-list change is read). Never throws: errors are recorded in fleet_sync.error and the last good copy is
 * kept (unless refused).
 */
export function syncFleet(db: Db, callApp: CallApp, now: () => number = Date.now): Promise<void> {
  const running = inflight.get(db);
  if (running) return running;
  const p = (async () => {
    try {
      for (let round = 0; round < 3; round++) {
        const marks = staleMarksOf(db);
        await syncOnce(db, callApp, now);
        if (staleMarksOf(db) === marks) break;
        setFleetStale(db);
      }
    } catch (e) {
      // syncOnce handles its own failures; this is the net under it: a sync never rejects, and the copy is dropped
      dropFleetCopy(db, `Governance sync failed: ${e instanceof Error ? e.message : "unknown"}`);
    }
  })().finally(() => inflight.delete(db));
  inflight.set(db, p);
  return p;
}

async function syncOnce(db: Db, callApp: CallApp, now: () => number): Promise<void> {
  const st = fleetState(db);
  try {
    const refused = acceptRefusedAt.get(db);
    const accept = refused === undefined || now() - refused > ACCEPT_RETRY_MS;
    // a delta read only onto a copy of the same shape (with or without agent handles); else a full read
    let since = st.revision != null && !st.stale && st.usable && copyWithHandles.get(db) === accept ? st.revision : null;
    const ask = (withHandles: boolean) => callApp(FLEET_PRODUCT, FLEET_OP, { ...(withHandles ? { accept: [AGENT_HANDLES] } : {}), ...(since !== null ? { sinceRevision: since } : {}) });
    let withHandles = accept;
    let res: Awaited<ReturnType<CallApp>>;
    try {
      res = await ask(accept);
      if (accept) acceptRefusedAt.delete(db);
    } catch (e) {
      // An older Governance (0.2.x: no `accept` in its input schema, so a 400): read it the old way NOW and ask again after
      // ACCEPT_RETRY_MS. That read is a FULL one: the stored copy (if any) was read with handles, and an "unchanged" answer to a
      // delta read would keep agent handles this Governance no longer vouches for.
      if (!accept || !refusesAccept(e)) throw e;
      acceptRefusedAt.set(db, now());
      withHandles = false;
      since = null;
      res = await ask(false);
    }
    if (res.status !== "ok") throw Object.assign(new Error("Governance held the directory read"), { code: "held" });
    const d = await parseFeedChunked(res.output);
    // "unchanged" is only valid for the revision we asked about; anything else is a broken answer, not a no-op.
    if (d.unchanged && d.revision !== since) throw feedInvalid(`unchanged answered for revision ${d.revision}, asked ${since ?? "none"}`);
    // S3-1: the copy says whether it lists agent handles (a read without them makes every recipient unknown at the gate)
    await writeFleetChunked(db, d.unchanged ? null : d.model, { revision: d.revision, error: null, agentHandles: withHandles }, now());
    if (!d.unchanged) copyWithHandles.set(db, withHandles);
  } catch (e) {
    const code = isObj(e) && typeof e.code === "string" ? e.code : "error";
    const reason = e instanceof Error ? e.message : "fleet read failed";
    const msg = (code === FEED_INVALID ? `Governance feed refused: ${reason}` : `Governance not reachable: ${code}: ${reason}`).slice(0, 280);
    const t = now();
    const expired = st.syncedAt == null || t - st.syncedAt > FLEET_MAX_STALE_MS;
    // Refusal → clear now; transient → keep the last copy for ≤ 10 min after the last successful read, then clear.
    // The timer keeps retrying every REFRESH_MS either way.
    try {
      await writeFleetChunked(db, isRefusal(e) || expired ? emptyFleet() : null, { revision: st.revision, error: msg }, t);
    } catch (writeError) {
      // The database refuses the write that records the error / clears the copy: fail closed in memory.
      dropFleetCopy(db, `${msg} (and the copy could not be cleared: ${writeError instanceof Error ? writeError.message : "database error"})`);
    }
  }
}

/** Refresh when the copy is stale or older than REFRESH_MS (person ops; bounded wait so the UI stays responsive). */
export async function refreshIfStale(db: Db, callApp: CallApp, waitMs = 3000, now: () => number = Date.now): Promise<void> {
  const st = fleetState(db);
  if (!st.stale && st.syncedAt != null && now() - st.syncedAt < REFRESH_MS) return;
  await Promise.race([syncFleet(db, callApp, now), new Promise((r) => setTimeout(r, waitMs).unref())]);
}

/** The 60 s timer, when the SDK hands out a background `callApp` (C85). Returns a stop function. */
export function startFleetTimer(db: Db, callApp: CallApp): () => void {
  void syncFleet(db, callApp);
  const t = setInterval(() => void syncFleet(db, callApp), REFRESH_MS);
  t.unref();
  return () => clearInterval(t);
}
