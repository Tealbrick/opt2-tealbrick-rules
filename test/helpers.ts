// Test helpers: a migrated node:sqlite database shaped like the SDK's Db, hook requests and contexts, rule specs.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Db, HookContext, HookRequest, Json, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { migrationsDir } from "../src/app.ts";
import type { RuleSpec, Trust } from "../src/engine.ts";

// Booted apps in unit tests never read the real release index (catalog tests use a signed fake index).
process.env.TB_RULES_CATALOG_OFF = "1";

export const AGENT_A = "agt_01J0000000000000000000000A";
export const AGENT_B = "agt_01J0000000000000000000000B";
export const OWNER = "per_01J00000000000000000000OWN";

/** In-memory database with every migration applied (same files the SDK runs). */
export function migratedDb(): { db: Db; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith(".sql")).sort()) raw.exec(readFileSync(join(migrationsDir, f), "utf8"));
  const db = {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    transaction<T>(fn: () => T): T {
      raw.exec("BEGIN");
      try {
        const out = fn();
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { db: db as unknown as Db, raw };
}

/**
 * A signed-catalog stand-in for tests that save rules naming apps (`products`, `callerProducts`): each product is known with no
 * operations, and the last read counts as just done (a rule that names another product never triggers a network read).
 * Call it right after `migratedDb()`, before anything reads the catalog.
 */
export function seedCatalog(db: Db, products: readonly string[]): Db {
  for (const [i, p] of products.entries()) db.prepare("INSERT INTO catalog_manifests (digest, product, version, published_at, ops) VALUES (?, ?, '1.0.0', '2026-10-13T00:00:00.000Z', '[]')").run(`sha256:seed${i}`, p);
  db.prepare("UPDATE catalog_sync SET generated_at = '2026-10-13T12:00:00.000Z', synced_at = ?, attempted_at = ?, digests = ?, error = NULL WHERE id = 1").run(Date.now(), Date.now(), JSON.stringify(products.map((_, i) => `sha256:seed${i}`)));
  return db;
}

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

export function hookCtx(db: Db, signal: AbortSignal = new AbortController().signal): HookContext {
  return { db, log: quiet, signal, getKey: async () => null, modelRole: async () => null, secrets: { put: async () => {}, get: async () => null, delete: async () => {} } } as HookContext;
}

/** Seeded pseudo-random numbers in [0, 1) (mulberry32): a failing fuzz case reproduces. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const APP_INSTANCE = "ins_01J0000000000000000000APP1";

/**
 * A hook request. `app` makes the caller an APP (an instance id, no mode); `app.product` is the bridge's `caller.product`
 * (left out of the request when the key is absent: a bridge older than 0.2.2). `callerExtra` adds raw fields to the caller.
 */
export function hookReq(
  phase: "before" | "context" | "after",
  o: {
    caller?: string;
    mode?: "free" | "bound";
    product?: string;
    op?: string;
    effect?: string;
    tool?: string;
    context?: Record<string, Json>;
    output?: Json;
    callId?: string;
    input?: Json;
    app?: { id?: string; product?: unknown };
    callerExtra?: Record<string, unknown>;
  },
): HookRequest {
  const caller = o.app
    ? { type: "app", id: o.app.id ?? APP_INSTANCE, ...("product" in o.app ? { product: o.app.product } : {}) }
    : { type: "agent", id: o.caller ?? AGENT_A, mode: o.mode ?? "free" };
  return {
    phase,
    call: {
      id: o.callId ?? "cal_01J00000000000000000000001",
      ws: "wsp_01J000000000000000000000WS",
      caller: { ...caller, ...o.callerExtra },
      target: { instance: "ins_01J0000000000000000000TGT", product: o.product ?? "connect", op: o.op ?? "buzz_dm", crud: ["create"], effect: o.effect ?? "outward", ...(o.tool !== undefined ? { tool: o.tool } : {}) },
      input: o.input ?? { text: "hello" },
    },
    context: o.context ?? {},
    ...(phase === "after" ? { output: o.output ?? null } : {}),
  } as unknown as HookRequest;
}

/** A valid fleet.directory_feed/1 answer (full): team tm_x with an agent, an active contact, a departed contact, a blocked contact and a removed agent. */
export const NPUB = "buzz:npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6";
export const AGENT_R = "agt_01J0000000000000000000000R";
export function feed(over: Record<string, unknown> = {}): Record<string, Json> {
  return {
    v: 1,
    revision: 7,
    teams: [
      {
        id: "tm_x",
        name: "Team X",
        members: [
          { kind: "agent", id: AGENT_A, role: "lead" },
          { kind: "agent", id: AGENT_R, role: "member" },
          { kind: "contact", id: "ct_anna", role: "member" },
          { kind: "contact", id: "ct_gone", role: "member" },
          { kind: "contact", id: "ct_block", role: "member" },
        ],
      },
      { id: "tm_y", members: [{ kind: "agent", id: AGENT_B, role: "member" }] },
    ],
    contacts: [
      { id: "ct_anna", kind: "person", status: "active", trust: "trusted", handles: ["slack:U777", NPUB] },
      { id: "ct_gone", kind: "person", status: "departed", trust: "trusted", handles: ["telegram:9"] },
      { id: "ct_block", kind: "outside_agent", status: "active", trust: "blocked", handles: ["slack:U666"] },
    ],
    agents: [
      { id: AGENT_A, status: "active", trust: "trusted", owner: "ct_anna" },
      { id: AGENT_B, status: "paused", trust: "unreviewed", owner: null },
      { id: AGENT_R, status: "removed", trust: "blocked", owner: null },
    ],
    ...over,
  } as Record<string, Json>;
}

/**
 * Trust facts for a hand-built CallFacts: `claimTrust` (a single holder: a value, or null = unknown requester → unreviewed),
 * or `claimTrusts` + `claimTrustActive` for several holders. No claim and nothing given → no trust.
 */
export function trustFacts(o: { claim?: unknown; claimTrust?: Trust | null; claimTrusts?: readonly Trust[]; claimTrustActive?: boolean }): { claimTrusts: readonly Trust[]; claimTrustActive: boolean } {
  const trusts = o.claimTrusts ?? (o.claimTrust !== undefined ? [o.claimTrust ?? "unreviewed"] : o.claim ? ["unreviewed" as const] : []);
  return { claimTrusts: trusts, claimTrustActive: o.claimTrustActive ?? true };
}

export function spec(o: Partial<RuleSpec> & { decision?: RuleSpec["outcome"]["decision"]; reason?: string }): RuleSpec {
  const { decision, reason, ...rest } = o;
  return { title: "rule", active: true, priority: 100, match: {}, outcome: { decision: decision ?? "deny", reason: reason ?? "not allowed" }, ...rest };
}

/** Minimal OpContext for handler tests (person or agent caller). */
export function opCtx(db: Db, caller: { type: "person" | "agent" | "app"; id: string; name?: string; mode?: "free" | "bound" | null; product?: string }, callApp?: OpContext["callApp"]): OpContext {
  const meta: Json[] = [];
  return {
    db,
    caller: { type: caller.type, id: caller.id, name: caller.name ?? caller.id, mode: caller.mode ?? null, ...(caller.product ? { product: caller.product } : {}) },
    log: quiet,
    receipt: { summary() {}, meta: (v: Json) => meta.push(v) },
    statusChanged() {},
    callApp: callApp ?? (async () => Promise.reject(Object.assign(new Error("no grant"), { code: "not_granted" }))),
    signal: new AbortController().signal,
  } as unknown as OpContext;
}

/**
 * Timing budgets (T-1, L39, C266). This Mac runs many sessions (load average 8 to 29), so the wall-clock maximum of
 * thousands of samples measures the scheduler, not the code: a hard 50 ms wall-clock maximum failed at load 8. A budget
 * therefore checks the CPU time of this process (`process.cpuUsage`, user + system), which other processes do not
 * inflate, against a ceiling measured on the code, and keeps a loose wall-clock ceiling that still catches a gross
 * regression (an accidental O(n^2) or a missing yield is far above both).
 */
export function cpuNowMs(): number {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
}
/** Loose wall-clock ceiling for one measured block: 10x the 50 ms target, for preemption on a loaded machine. */
export const WALL_CEILING_MS = 500;
