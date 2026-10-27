// Rules' own tables (migrations/0001_init.sql): rules + revisions, drafts, decision traces, Fleet read model.
// Plain functions over the SDK `Db`. The gate reads rules and the Fleet index from per-database caches that every
// write here invalidates, so a hook call does no query except the trace insert.
import { ulid } from "@opt2-tealbrick/manifest";
import { type Db, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { CATALOG_MISSING, catalogOf, catalogProblem } from "./catalog.ts";
import { type CallFacts, type Decision, order, type Rule, type RuleSpec, specProblem, type Trust } from "./engine.ts";

/** At most this many live rules (a gate evaluates all of them on every call). */
export const MAX_RULES = 500;
/** Pending drafts per submitting agent. */
export const MAX_PENDING_DRAFTS = 20;
/** Decision traces kept: newest N, and none older than the retention window. */
export const TRACE_KEEP = 100_000;
export const TRACE_RETENTION_MS = 30 * 24 * 3600 * 1000;

const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(Number(ms)).toISOString());
const json = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== "string") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

// ── caches ───────────────────────────────────────────────────────────────────
const ruleCache = new WeakMap<Db, Rule[]>();
interface FleetCacheEntry {
  idx: Map<string, string[]>;
  idxAny: Map<string, string[]>;
  trust: Map<string, TrustEntry>;
  gone: Set<string>;
  okAt: number | null;
  usable: boolean;
}
const fleetCache = new WeakMap<Db, FleetCacheEntry>();
/** Count of markFleetStale calls per database: a sync that sees it move while it ran reads once more (dirty flag). */
const staleMarks = new WeakMap<Db, number>();
export const staleMarksOf = (db: Db): number => staleMarks.get(db) ?? 0;
/**
 * A Fleet copy older than this (no successful read since) is not used (A2A-9): the facts count as UNAVAILABLE, so deny and
 * hold rules that name Fleet facts apply and allow rules that name them do not (C230, fail closed).
 */
export const FLEET_MAX_STALE_MS = 10 * 60 * 1000;

export function invalidateRules(db: Db): void {
  ruleCache.delete(db);
}

/** Live rules (not deleted) in evaluation order; cached until the next write. */
export function liveRules(db: Db): Rule[] {
  const hit = ruleCache.get(db);
  if (hit) return hit;
  const rows = db.prepare("SELECT id, rev, spec, updated_at FROM rules WHERE deleted = 0").all();
  const rules = order(rows.map((r) => ({ id: String(r.id), rev: Number(r.rev), spec: JSON.parse(String(r.spec)) as RuleSpec, updatedAt: Number(r.updated_at) })));
  ruleCache.set(db, rules);
  return rules;
}

// ── rules ────────────────────────────────────────────────────────────────────
export interface RuleView {
  id: string;
  rev: number;
  spec: RuleSpec;
  source: string;
  createdAt: string;
  updatedAt: string;
}

function ruleView(r: Record<string, unknown>): RuleView {
  return { id: String(r.id), rev: Number(r.rev), spec: JSON.parse(String(r.spec)) as RuleSpec, source: String(r.source), createdAt: iso(Number(r.created_at)) as string, updatedAt: iso(Number(r.updated_at)) as string };
}

export function listRules(db: Db, includeDeleted = false): (RuleView & { deleted: boolean })[] {
  const rows = db.prepare(`SELECT * FROM rules ${includeDeleted ? "" : "WHERE deleted = 0"} ORDER BY deleted, priority, updated_at DESC, id`).all();
  return rows.map((r) => ({ ...ruleView(r), deleted: Number(r.deleted) === 1 }));
}

export type RevisionChange = "created" | "updated" | "deleted" | "restored";
export interface RevisionView {
  rev: number;
  change: RevisionChange;
  spec: RuleSpec;
  actor: string;
  at: string;
  /** change "restored" only: the revision whose spec this one copied */
  from?: number;
}

export function getRule(db: Db, id: string): { rule: RuleView; deleted: boolean; revisions: RevisionView[] } {
  const row = db.prepare("SELECT * FROM rules WHERE id = ?").get(id);
  if (!row) throw new TbError("not_found", "no rule with this id", 404);
  const revisions = db
    .prepare("SELECT rev, change, spec, actor, at, from_rev FROM rule_revisions WHERE rule_id = ? ORDER BY rev DESC")
    .all(id)
    .map((r) => ({
      rev: Number(r.rev),
      change: String(r.change) as RevisionChange,
      spec: JSON.parse(String(r.spec)) as RuleSpec,
      actor: String(r.actor),
      at: iso(Number(r.at)) as string,
      ...(r.from_rev == null ? {} : { from: Number(r.from_rev) }),
    }));
  return { rule: ruleView(row), deleted: Number(row.deleted) === 1, revisions };
}

/** Why a stored or submitted spec is unusable ("" = fine): schema-free checks, then the app catalog (never matches). */
export function ruleProblem(db: Db, spec: RuleSpec): string {
  return specProblem(spec) || catalogProblem(spec, catalogOf(db));
}

/** Writer strict (L24): refuse a spec with a problem. `label` prefixes the message (drafts name the rule). */
function checkSpec(db: Db, spec: RuleSpec, label = ""): void {
  const p = ruleProblem(db, spec);
  if (p === CATALOG_MISSING) throw new TbError("catalog_unavailable", p, 503);
  if (p) throw new TbError("input_invalid", `${label}${p}`, 400);
}

/** Create (no id) or update (id + optional expectedRev). Writes a revision row. */
export function saveRule(db: Db, input: { id?: string; expectedRev?: number; spec: RuleSpec; actor: string; source?: string }, now = Date.now()): RuleView {
  checkSpec(db, input.spec);
  const out = db.transaction(() => {
    if (!input.id) {
      const live = Number(db.prepare("SELECT COUNT(*) AS n FROM rules WHERE deleted = 0").get()?.n ?? 0);
      if (live >= MAX_RULES) throw new TbError("too_many_rules", `at most ${MAX_RULES} rules`, 409);
      const id = `rul_${ulid(now)}`;
      const spec = JSON.stringify(input.spec);
      db.prepare("INSERT INTO rules (id, rev, spec, priority, active, deleted, source, created_at, updated_at) VALUES (?, 1, ?, ?, ?, 0, ?, ?, ?)").run(id, spec, input.spec.priority, input.spec.active ? 1 : 0, input.source ?? "owner", now, now);
      db.prepare("INSERT INTO rule_revisions (rule_id, rev, change, spec, actor, at) VALUES (?, 1, 'created', ?, ?, ?)").run(id, spec, input.actor, now);
      return id;
    }
    const row = db.prepare("SELECT rev, deleted FROM rules WHERE id = ?").get(input.id);
    if (!row || Number(row.deleted) === 1) throw new TbError("not_found", "no rule with this id", 404);
    const rev = Number(row.rev);
    if (input.expectedRev !== undefined && input.expectedRev !== rev) throw new TbError("revision_conflict", `the rule changed (now revision ${rev}); reload and edit again`, 409);
    const spec = JSON.stringify(input.spec);
    db.prepare("UPDATE rules SET rev = ?, spec = ?, priority = ?, active = ?, updated_at = ? WHERE id = ?").run(rev + 1, spec, input.spec.priority, input.spec.active ? 1 : 0, now, input.id);
    db.prepare("INSERT INTO rule_revisions (rule_id, rev, change, spec, actor, at) VALUES (?, ?, 'updated', ?, ?, ?)").run(input.id, rev + 1, spec, input.actor, now);
    return input.id;
  });
  invalidateRules(db);
  return ruleView(db.prepare("SELECT * FROM rules WHERE id = ?").get(out) as Record<string, unknown>);
}

/** Removes the rule from evaluation; its history stays (a new 'deleted' revision). */
export function deleteRule(db: Db, input: { id: string; expectedRev?: number; actor: string }, now = Date.now()): { id: string; rev: number } {
  const rev = db.transaction(() => {
    const row = db.prepare("SELECT rev, spec, deleted FROM rules WHERE id = ?").get(input.id);
    if (!row || Number(row.deleted) === 1) throw new TbError("not_found", "no rule with this id", 404);
    const cur = Number(row.rev);
    if (input.expectedRev !== undefined && input.expectedRev !== cur) throw new TbError("revision_conflict", `the rule changed (now revision ${cur})`, 409);
    db.prepare("UPDATE rules SET rev = ?, deleted = 1, active = 0, updated_at = ? WHERE id = ?").run(cur + 1, now, input.id);
    db.prepare("INSERT INTO rule_revisions (rule_id, rev, change, spec, actor, at) VALUES (?, ?, 'deleted', ?, ?, ?)").run(input.id, cur + 1, String(row.spec), input.actor, now);
    return cur + 1;
  });
  invalidateRules(db);
  return { id: input.id, rev };
}

/**
 * Q-7 (C373): make the spec of an earlier revision the rule's current spec. It is a write like `saveRule`: the same writer
 * checks (a spec that names an operation the catalog no longer has is refused with the writer's reason), the actor is
 * recorded, and a NEW revision row (change 'restored', `from_rev` = the copied revision) is added; history is never
 * rewritten. A deleted rule comes back (counts against MAX_RULES like a new one). Restoring the current revision of a live
 * rule is refused (nothing would change). `expectedRev` = the current revision the owner saw (stale → revision_conflict).
 */
export function restoreRule(db: Db, input: { id: string; rev: number; expectedRev?: number; actor: string }, now = Date.now()): { id: string; rev: number; restoredFrom: number } {
  const target = db.prepare("SELECT spec FROM rule_revisions WHERE rule_id = ? AND rev = ?").get(input.id, input.rev);
  if (!db.prepare("SELECT id FROM rules WHERE id = ?").get(input.id)) throw new TbError("not_found", "no rule with this id", 404);
  if (!target) throw new TbError("not_found", `this rule has no revision ${input.rev}`, 404);
  const spec = JSON.parse(String(target.spec)) as RuleSpec;
  checkSpec(db, spec, `revision ${input.rev} can’t be restored: `);
  const rev = db.transaction(() => {
    const cur = db.prepare("SELECT rev, deleted FROM rules WHERE id = ?").get(input.id) as Record<string, unknown>;
    const curRev = Number(cur.rev);
    const deleted = Number(cur.deleted) === 1;
    if (input.expectedRev !== undefined && input.expectedRev !== curRev) throw new TbError("revision_conflict", `the rule changed (now revision ${curRev}); reload and try again`, 409);
    if (!deleted && input.rev === curRev) throw new TbError("input_invalid", `revision ${input.rev} is already the current version`, 400);
    if (deleted) {
      const live = Number(db.prepare("SELECT COUNT(*) AS n FROM rules WHERE deleted = 0").get()?.n ?? 0);
      if (live >= MAX_RULES) throw new TbError("too_many_rules", `at most ${MAX_RULES} rules`, 409);
    }
    const text = JSON.stringify(spec);
    db.prepare("UPDATE rules SET rev = ?, spec = ?, priority = ?, active = ?, deleted = 0, updated_at = ? WHERE id = ?").run(curRev + 1, text, spec.priority, spec.active ? 1 : 0, now, input.id);
    db.prepare("INSERT INTO rule_revisions (rule_id, rev, change, spec, actor, at, from_rev) VALUES (?, ?, 'restored', ?, ?, ?, ?)").run(input.id, curRev + 1, text, input.actor, now, input.rev);
    return curRev + 1;
  });
  invalidateRules(db);
  return { id: input.id, rev, restoredFrom: input.rev };
}

// ── drafts ───────────────────────────────────────────────────────────────────
export interface DraftView {
  id: string;
  status: "pending" | "approved" | "rejected";
  text: string;
  note: string;
  rules: RuleSpec[];
  submittedBy: { type: string; id: string; name: string };
  /** who proposed it: an agent, or an app (G-3e: the Drafts page says "proposed by <app>") */
  source: DraftSource;
  submittedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  ruleIds: string[];
}

export interface DraftSource {
  /** `owner` (C373): the owner typed the English rule in Rules (`rule_compose_save`) */
  kind: "agent" | "app" | "owner";
  /** product id of the proposing app: the VERIFIED `Caller.product` (SDK 0.1.27); absent on drafts stored before it */
  product?: string;
  name?: string;
  instance?: string;
}

/**
 * Who proposed a draft, derived for a draft stored without `source` (before 0.3.0). An app caller of that time is known
 * by its instance id and manifest name only: no product is verified for it, so none is shown (the Drafts page says "unverified").
 */
export function sourceOf(by: { type: string; id: string; name: string }): DraftSource {
  if (by.type !== "app") return { kind: "agent" };
  return { kind: "app", name: by.name.slice(0, 80), instance: by.id };
}

/**
 * Who proposes a draft now. `id` is the identity: the agent id, or for an app the VERIFIED product (`Caller.product`,
 * SDK 0.1.27), or its instance id when no product is verified. `name` is a display label only (an app's own manifest name; two apps can share one). `instance` is the
 * app's instance id, kept for the owner's information.
 */
export interface Submitter {
  type: string;
  id: string;
  name: string;
  /** an app's VERIFIED product (then `id` is the product); absent for an agent and for an app with no verified product (then `id` is its instance id) */
  product?: string;
  instance?: string;
}

function sourceFor(by: Submitter): DraftSource {
  if (by.type === "person") return { kind: "owner" };
  if (by.type !== "app") return { kind: "agent" };
  if (by.product) return { kind: "app", product: by.product, name: by.name.slice(0, 80), ...(by.instance ? { instance: by.instance } : {}) };
  return { kind: "app", name: by.name.slice(0, 80), instance: by.id };
}

function draftView(r: Record<string, unknown>): DraftView {
  const by = { type: String(r.submitted_by_type), id: String(r.submitted_by_id), name: String(r.submitted_by_name) };
  return {
    id: String(r.id),
    status: String(r.status) as DraftView["status"],
    text: String(r.text),
    note: String(r.note),
    rules: json<RuleSpec[]>(r.rules, []),
    submittedBy: by,
    source: json<DraftSource | null>(r.source, null) ?? sourceOf(by),
    submittedAt: iso(Number(r.submitted_at)) as string,
    decidedAt: iso(r.decided_at == null ? null : Number(r.decided_at)),
    decidedBy: r.decided_by == null ? null : String(r.decided_by),
    ruleIds: json<string[]>(r.rule_ids, []),
  };
}

export function submitDraft(db: Db, input: { text: string; note?: string; rules: RuleSpec[]; by: Submitter }, now = Date.now()): DraftView {
  input.rules.forEach((spec, i) => {
    checkSpec(db, spec, `rule ${i + 1} (“${spec.title}”): `);
  });
  // The cap counts per identity AND type. All unverified apps (no verified product, so no identity but an instance id that a
  // reinstall changes) share ONE cap, so a reinstall cannot reset it. A draft stored before 0.3.0 has no `source` and counts there.
  const unverifiedApp = input.by.type === "app" && !input.by.product;
  const pending = Number(
    (unverifiedApp
      ? db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE status = 'pending' AND submitted_by_type = 'app' AND json_extract(source, '$.product') IS NULL").get()
      : db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE status = 'pending' AND submitted_by_type = ? AND submitted_by_id = ?").get(input.by.type, input.by.id)
    )?.n ?? 0,
  );
  if (pending >= MAX_PENDING_DRAFTS) throw new TbError("too_many_drafts", `at most ${MAX_PENDING_DRAFTS} pending drafts per ${unverifiedApp ? "set of unverified apps" : input.by.type === "app" ? "app" : input.by.type === "person" ? "owner" : "agent"}; ${input.by.type === "person" ? "approve or reject some on the Drafts page first" : "ask the owner to review them"}`, 429);
  const id = `drf_${ulid(now)}`;
  db.prepare(
    "INSERT INTO drafts (id, status, text, note, rules, submitted_by_type, submitted_by_id, submitted_by_name, submitted_at, source) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, input.text, input.note ?? "", JSON.stringify(input.rules), input.by.type, input.by.id, input.by.name.slice(0, 120), now, JSON.stringify(sourceFor(input.by)));
  return draftView(db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as Record<string, unknown>);
}

export function getDraft(db: Db, id: string): DraftView | null {
  const row = db.prepare("SELECT * FROM drafts WHERE id = ?").get(id);
  return row ? draftView(row) : null;
}

/**
 * `draft_status`: the state of a draft, only for the caller that submitted it. A draft of someone else answers exactly
 * like a missing one (404 not_found), so an id never tells a caller whether another caller's draft exists.
 */
export function draftStatusFor(db: Db, caller: { type: string; id: string }, draftId: string): { draftId: string; status: DraftView["status"]; submittedAt: string; decidedAt: string | null; ruleCount: number } {
  const row = db.prepare("SELECT * FROM drafts WHERE id = ? AND submitted_by_type = ? AND submitted_by_id = ?").get(draftId, caller.type, caller.id);
  if (!row) throw new TbError("not_found", "no draft with this id", 404);
  const d = draftView(row);
  return { draftId: d.id, status: d.status, submittedAt: d.submittedAt, decidedAt: d.decidedAt, ruleCount: d.ruleIds.length };
}

export function pendingDraftCount(db: Db): number {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE status = 'pending'").get()?.n ?? 0);
}

export function listDrafts(db: Db, status: DraftView["status"] | undefined, limit: number): DraftView[] {
  const rows = status
    ? db.prepare("SELECT * FROM drafts WHERE status = ? ORDER BY submitted_at DESC, id DESC LIMIT ?").all(status, limit)
    : db.prepare("SELECT * FROM drafts ORDER BY (status = 'pending') DESC, submitted_at DESC, id DESC LIMIT ?").all(limit);
  return rows.map(draftView);
}

/** Approve (rules created, source = draft id) or reject, once. A decided draft is final. */
export function decideDraft(db: Db, input: { id: string; decision: "approve" | "reject"; actor: string }, now = Date.now()): DraftView {
  const row = db.prepare("SELECT * FROM drafts WHERE id = ?").get(input.id);
  if (!row) throw new TbError("not_found", "no draft with this id", 404);
  if (String(row.status) !== "pending") throw new TbError("draft_decided", `this draft is already ${String(row.status)}`, 409);
  const ruleIds: string[] = [];
  if (input.decision === "approve") {
    // A draft whose rule could never match is not applied (it would look like protection and protect nothing, L3).
    json<RuleSpec[]>(row.rules, []).forEach((spec, i) => {
      const p = ruleProblem(db, spec);
      if (p === CATALOG_MISSING) throw new TbError("catalog_unavailable", p, 503);
      if (p) throw new TbError("draft_never_matches", `This draft cannot be applied: rule ${i + 1} (“${spec.title}”): ${p}. Reject it and ask the agent for a corrected draft.`, 409);
    });
    const live = Number(db.prepare("SELECT COUNT(*) AS n FROM rules WHERE deleted = 0").get()?.n ?? 0);
    if (live + json<RuleSpec[]>(row.rules, []).length > MAX_RULES) throw new TbError("too_many_rules", `at most ${MAX_RULES} rules; delete some first`, 409);
    for (const spec of json<RuleSpec[]>(row.rules, [])) ruleIds.push(saveRule(db, { spec, actor: input.actor, source: input.id }, now).id);
  }
  db.prepare("UPDATE drafts SET status = ?, decided_at = ?, decided_by = ?, rule_ids = ? WHERE id = ? AND status = 'pending'").run(
    input.decision === "approve" ? "approved" : "rejected",
    now,
    input.actor,
    JSON.stringify(ruleIds),
    input.id,
  );
  return draftView(db.prepare("SELECT * FROM drafts WHERE id = ?").get(input.id) as Record<string, unknown>);
}

// ── decision traces ──────────────────────────────────────────────────────────
export type Answered = "allow" | "deny" | "hold" | "narrow" | "redact";
export interface TraceInput {
  callId: string | null;
  phase: "before" | "context" | "after" | "preview";
  facts: CallFacts;
  decision: Decision;
  answered: Answered;
  reason: string;
  rule: { id: string; rev: number; title: string } | null;
  detail?: Record<string, unknown> | null;
  durationUs: number;
}

let inserts = 0;

/** The trace's `detail` JSON: the given detail plus the tool name, the recipient count and the workflow id (null = nothing to keep). */
function traceDetail(t: TraceInput): string | null {
  const tool = t.facts.target.tool;
  const count = Array.isArray(t.facts.recipients) ? t.facts.recipients.length : undefined;
  // C373 D2c: the verified workflow id of an app caller (an id, not personal data)
  const workflow = t.facts.callerWorkflow ?? undefined;
  if (!t.detail && tool === undefined && count === undefined && workflow === undefined) return null;
  return JSON.stringify({ ...t.detail, ...(tool !== undefined ? { tool } : {}), ...(count !== undefined ? { recipients: count } : {}), ...(workflow !== undefined ? { workflow } : {}) });
}

export function recordDecision(db: Db, t: TraceInput, now = Date.now()): string {
  const id = `dec_${ulid(now)}`;
  const obo = t.facts.claim ? JSON.stringify({ ...t.facts.claim, verified: t.facts.claimVerified, teams: t.facts.claimTeams, trust: t.facts.claimTrusts }) : null;
  db.prepare(
    "INSERT INTO decisions (id, call_id, phase, at, caller_type, caller_id, caller_mode, caller_product, product, op, effect, decision, answered, reason, rule_id, rule_rev, rule_title, on_behalf_of, detail, duration_us) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    t.callId,
    t.phase,
    now,
    t.facts.caller.type,
    t.facts.caller.id,
    t.facts.caller.mode,
    t.facts.callerProduct,
    t.facts.target.product,
    t.facts.target.op,
    t.facts.target.effect,
    t.decision,
    t.answered,
    t.reason.slice(0, 280),
    t.rule?.id ?? null,
    t.rule?.rev ?? null,
    t.rule?.title ?? null,
    obo,
    // spec 0.1.68: the tool name of a dynamic call rides in `detail` (no column: the decisions table needs no migration).
    // C373 D5: of the recipients only their COUNT is kept (known recipients), never a handle; unknown ones are `recipientsUnknown`.
    traceDetail(t),
    Math.max(0, Math.round(t.durationUs)),
  );
  if (++inserts % 1000 === 0) pruneDecisions(db, now);
  return id;
}

export function pruneDecisions(db: Db, now = Date.now()): void {
  db.prepare("DELETE FROM decisions WHERE at < ?").run(now - TRACE_RETENTION_MS);
  db.prepare("DELETE FROM decisions WHERE id IN (SELECT id FROM decisions ORDER BY id DESC LIMIT -1 OFFSET ?)").run(TRACE_KEEP);
}

export interface DecisionView {
  id: string;
  callId: string | null;
  phase: TraceInput["phase"];
  at: string;
  /** `product`: the VERIFIED product of an app caller at decision time; null for an agent, an unverified app, and rows recorded before 0.5.0 */
  caller: { type: string; id: string; mode: string | null; product: string | null };
  target: { product: string; op: string; effect: string; tool?: string };
  decision: Decision;
  answered: Answered;
  reason: string;
  ruleId: string | null;
  ruleRev: number | null;
  ruleTitle: string | null;
  onBehalfOf: Record<string, unknown> | null;
  detail: Record<string, unknown> | null;
  durationUs: number;
}

function decisionView(r: Record<string, unknown>): DecisionView {
  const detail = json<Record<string, unknown> | null>(r.detail, null);
  const tool = typeof detail?.tool === "string" ? detail.tool : undefined;
  return {
    id: String(r.id),
    callId: r.call_id == null ? null : String(r.call_id),
    phase: String(r.phase) as DecisionView["phase"],
    at: iso(Number(r.at)) as string,
    caller: { type: String(r.caller_type), id: String(r.caller_id), mode: r.caller_mode == null ? null : String(r.caller_mode), product: r.caller_product == null ? null : String(r.caller_product) },
    target: { product: String(r.product), op: String(r.op), effect: String(r.effect), ...(tool !== undefined ? { tool } : {}) },
    decision: String(r.decision) as Decision,
    answered: String(r.answered) as Answered,
    reason: String(r.reason),
    ruleId: r.rule_id == null ? null : String(r.rule_id),
    ruleRev: r.rule_rev == null ? null : Number(r.rule_rev),
    ruleTitle: r.rule_title == null ? null : String(r.rule_title),
    onBehalfOf: json<Record<string, unknown> | null>(r.on_behalf_of, null),
    detail,
    durationUs: Number(r.duration_us),
  };
}

/**
 * `appCaller`: an APP reads its own decisions by its VERIFIED product (any instance of it, so a reinstall keeps its history),
 * and rows recorded without a product (before 0.5.0, or an unverified app) by its instance id. An app with no verified product
 * passes `product: null` and reads by instance id only.
 */
export function listDecisions(
  db: Db,
  q: { callId?: string; caller?: string; appCaller?: { product: string | null; instance: string }; decision?: Decision; product?: string; phase?: TraceInput["phase"]; cursor?: string; limit: number },
): { items: DecisionView[]; nextCursor: string | null } {
  const where: string[] = [];
  const args: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    if (value === undefined || value === "") return;
    where.push(sql);
    args.push(value);
  };
  add("call_id = ?", q.callId);
  add("caller_id = ?", q.caller);
  if (q.appCaller) {
    const { product, instance } = q.appCaller;
    if (product) {
      where.push("caller_type = 'app' AND (caller_product = ? OR (caller_product IS NULL AND caller_id = ?))");
      args.push(product, instance);
    } else {
      where.push("caller_type = 'app' AND caller_id = ?");
      args.push(instance);
    }
  }
  add("decision = ?", q.decision);
  add("product = ?", q.product);
  add("phase = ?", q.phase);
  add("id < ?", q.cursor);
  const rows = db.prepare(`SELECT * FROM decisions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...args, q.limit + 1);
  const items = rows.slice(0, q.limit).map(decisionView);
  return { items, nextCursor: rows.length > q.limit ? (items.at(-1)?.id ?? null) : null };
}

// ── Fleet read model ─────────────────────────────────────────────────────────
export interface FleetTeam {
  id: string;
  name: string;
  people: number;
  agents: number;
  /** member keys of EVERY member: agent:<id>, contact:<id>, handle:<canonical handle> (deny and hold rules) */
  keys: string[];
  /** the keys of members that count (not blocked, departed, removed): a subset of `keys` (allow rules) */
  activeKeys: string[];
}

/** Everyone who holds one key (a handle can be held by several contacts): the SET of their raw trust values, and whether all are active. */
export interface TrustEntry {
  trusts: Trust[];
  /** false when any holder is blocked, departed or removed (a gone holder never satisfies an allow rule by trust) */
  allActive: boolean;
}

/** One read of the feed, mapped: teams with member keys, and the trust of each contact key (contact:<id>, handle:<h>). */
export interface FleetModel {
  teams: FleetTeam[];
  trust: Map<string, TrustEntry>;
}

export interface FleetSyncState {
  revision: number | null;
  /** epoch ms of the last SUCCESSFUL read (errors never move it) */
  syncedAt: number | null;
  stale: boolean;
  error: string | null;
  /** false after a refusal cleared the copy (and before the first read): the copy is unavailable whatever its age */
  usable: boolean;
}

/** An error that could not be written to the database (it is broken); shown by fleet_status until the next good write. */
const memoryError = new WeakMap<Db, string>();

export function fleetState(db: Db): FleetSyncState {
  const r = db.prepare("SELECT revision, synced_at, stale, error, usable FROM fleet_sync WHERE id = 1").get();
  const mem = memoryError.get(db);
  return {
    revision: r?.revision == null ? null : Number(r.revision),
    syncedAt: r?.synced_at == null ? null : Number(r.synced_at),
    stale: mem !== undefined || Number(r?.stale ?? 1) === 1,
    error: mem ?? (r?.error == null ? null : String(r.error)),
    usable: mem === undefined && Number(r?.usable ?? 0) === 1,
  };
}

/**
 * Last resort when the database refuses the write that clears the copy: drop the in-memory copy so the gate sees the Fleet
 * facts as unavailable (fail closed) and keep the error in memory. Never throws.
 */
export function dropFleetCopy(db: Db, error: string): void {
  memoryError.set(db, error.slice(0, 280));
  fleetCache.set(db, { idx: new Map(), idxAny: new Map(), trust: new Map(), gone: new Set(), okAt: null, usable: false });
}

/** Set the stale flag without counting it (a sync re-arming itself). */
export function setFleetStale(db: Db): void {
  db.prepare("UPDATE fleet_sync SET stale = 1 WHERE id = 1").run();
}

export function markFleetStale(db: Db): void {
  staleMarks.set(db, staleMarksOf(db) + 1);
  setFleetStale(db);
}

/**
 * One sync outcome in one transaction. Success (`error` null): `model` replaces the copy (null = unchanged), the read
 * time moves and the copy is usable. Failure: `model` = an EMPTY model clears the copy (revision forgotten, next read is a
 * full one, copy unusable), null keeps it; the last successful read time stays.
 */
/** Rows per transaction while a big directory is written (about 10 ms each); the loop yields to the event loop between them. */
export const FLEET_WRITE_CHUNK_ROWS = 4000;

const add = (map: Map<string, string[]>, k: string, team: string) => {
  const list = map.get(k);
  if (list) list.push(team);
  else map.set(k, [team]);
};

/**
 * One sync outcome, as steps (a generator yields between transactions so a big directory never blocks the event loop for
 * long). Step 1 clears members and trust and marks the copy unusable, the chunks insert rows (the gate's index is built
 * from the same rows, once per sync, here), the last transaction writes teams and the sync row and swaps the in-memory
 * index. A crash in between leaves `usable = 0`: the copy is unavailable (fail closed) and the next read is a full one.
 */
function* writeSteps(db: Db, model: FleetModel | null, state: { revision: number | null; error: string | null }, now: number): Generator<void, void, void> {
  if (!model) {
    db.transaction(() => {
      if (state.error === null) db.prepare("UPDATE fleet_sync SET revision = ?, synced_at = ?, stale = 0, error = NULL, usable = 1 WHERE id = 1").run(state.revision, now);
      else db.prepare("UPDATE fleet_sync SET error = ? WHERE id = 1").run(state.error);
    });
    if (state.error === null) memoryError.delete(db);
    // an "unchanged" answer moves the read time; a transient error changes nothing the gate uses
    const hit = fleetCache.get(db);
    if (state.error === null) {
      if (hit) fleetCache.set(db, { ...hit, okAt: now, usable: true });
      else fleetCache.delete(db);
    }
    return;
  }
  db.transaction(() => {
    db.exec("DELETE FROM fleet_members; DELETE FROM fleet_trust;");
    db.prepare("UPDATE fleet_sync SET usable = 0, stale = 1 WHERE id = 1").run();
  });
  const idx = new Map<string, string[]>();
  const idxAny = new Map<string, string[]>();
  const trust = new Map<string, TrustEntry>();
  const gone = new Set<string>();
  const m = db.prepare("INSERT OR IGNORE INTO fleet_members (team_id, member_key, active) VALUES (?, ?, ?)");
  const tr = db.prepare("INSERT OR REPLACE INTO fleet_trust (member_key, trusts, all_active) VALUES (?, ?, ?)");
  let batch: (() => void)[] = [];
  function* flush(force: boolean): Generator<void, void, void> {
    if (batch.length === 0 || (!force && batch.length < FLEET_WRITE_CHUNK_ROWS)) return;
    const rows = batch;
    batch = [];
    db.transaction(() => {
      for (const run of rows) run();
    });
    yield;
  }
  for (const team of model.teams) {
    const active = new Set(team.activeKeys);
    for (const k of team.keys) {
      const on = active.has(k);
      add(idxAny, k, team.id);
      if (on) add(idx, k, team.id);
      batch.push(() => m.run(team.id, k, on ? 1 : 0));
      yield* flush(false);
    }
  }
  for (const [k, v] of model.trust) {
    trust.set(k, v);
    if (!v.allActive) gone.add(k);
    batch.push(() => tr.run(k, [...v.trusts].sort().join(","), v.allActive ? 1 : 0));
    yield* flush(false);
  }
  yield* flush(true);
  db.transaction(() => {
    db.exec("DELETE FROM fleet_teams;");
    const t = db.prepare("INSERT INTO fleet_teams (id, name, people, agents) VALUES (?, ?, ?, ?)");
    for (const team of model.teams) t.run(team.id, team.name, team.people, team.agents);
    if (state.error === null) db.prepare("UPDATE fleet_sync SET revision = ?, synced_at = ?, stale = 0, error = NULL, usable = 1 WHERE id = 1").run(state.revision, now);
    else db.prepare("UPDATE fleet_sync SET revision = NULL, stale = 1, error = ?, usable = 0 WHERE id = 1").run(state.error);
  });
  const usable = state.error === null;
  if (usable) memoryError.delete(db);
  fleetCache.set(db, { idx, idxAny, trust, gone, okAt: usable ? now : fleetState(db).syncedAt, usable });
}

/** Synchronous write (one go): small models, errors, tests. */
export function writeFleet(db: Db, model: FleetModel | null, state: { revision: number | null; error: string | null }, now = Date.now()): void {
  for (const g = writeSteps(db, model, state, now); !g.next().done; );
}

/** The write the sync uses: the same steps, yielding to the event loop between transactions. */
export async function writeFleetChunked(
  db: Db,
  model: FleetModel | null,
  state: { revision: number | null; error: string | null },
  now = Date.now(),
  pause: () => Promise<void> = () => new Promise((r) => setImmediate(r)),
): Promise<void> {
  const g = writeSteps(db, model, state, now);
  for (let r = g.next(); !r.done; r = g.next()) await pause();
}

export const emptyFleet = (): FleetModel => ({ teams: [], trust: new Map() });

export function fleetTeams(db: Db): { id: string; name: string; people: number; agents: number }[] {
  return db
    .prepare("SELECT id, name, people, agents FROM fleet_teams ORDER BY name, id")
    .all()
    .map((r) => ({ id: String(r.id), name: String(r.name), people: Number(r.people), agents: Number(r.agents) }));
}

export interface FleetFacts {
  /** false = never read, refused, or no successful read within FLEET_MAX_STALE_MS: the maps below are empty */
  available: boolean;
  /** member key → team ids, members that COUNT only (allow rules) */
  teams: Map<string, string[]>;
  /** member key → team ids, EVERY membership incl. blocked, departed, removed (deny and hold rules) */
  teamsAny: Map<string, string[]>;
  /** contact/agent key (`contact:<id>`, `handle:<h>`, `agent:<id>`) → its holders' trust set; a key that is missing is `unreviewed` */
  trust: Map<string, TrustEntry>;
  /** keys with at least one holder that is blocked, departed or removed */
  gone: Set<string>;
}

const NONE = (): FleetFacts => ({ available: false, teams: new Map(), teamsAny: new Map(), trust: new Map(), gone: new Set() });

/**
 * The Fleet facts the gate may use; cached until the next sync (built at write time). `available` is false (and the maps
 * empty) unless a read succeeded within FLEET_MAX_STALE_MS and no refusal cleared the copy, so a copy that can no longer be
 * confirmed never decides, whatever stopped the refresh. The engine then treats deny/hold rules that name Fleet facts as
 * applying and skips allow rules that name them.
 */
export function fleetFacts(db: Db, now = Date.now()): FleetFacts {
  let hit = fleetCache.get(db);
  if (!hit) {
    const st = fleetState(db);
    hit = { ...loadFleet(db), okAt: st.syncedAt, usable: st.usable };
    fleetCache.set(db, hit);
  }
  const available = hit.usable && hit.okAt != null && now - hit.okAt <= FLEET_MAX_STALE_MS;
  return available ? { available, teams: hit.idx, teamsAny: hit.idxAny, trust: hit.trust, gone: hit.gone } : NONE();
}

/** member key → team ids of members that count (empty while unavailable). */
export function fleetIndex(db: Db, now = Date.now()): Map<string, string[]> {
  return fleetFacts(db, now).teams;
}

function loadFleet(db: Db): Pick<FleetCacheEntry, "idx" | "idxAny" | "trust" | "gone"> {
  const idx = new Map<string, string[]>();
  const idxAny = new Map<string, string[]>();
  for (const r of db.prepare("SELECT team_id, member_key, active FROM fleet_members").all()) {
    add(idxAny, String(r.member_key), String(r.team_id));
    if (Number(r.active) === 1) add(idx, String(r.member_key), String(r.team_id));
  }
  const trust = new Map<string, TrustEntry>();
  const gone = new Set<string>();
  for (const r of db.prepare("SELECT member_key, trusts, all_active FROM fleet_trust").all()) {
    const k = String(r.member_key);
    trust.set(k, { trusts: String(r.trusts).split(",") as Trust[], allActive: Number(r.all_active) === 1 });
    if (Number(r.all_active) !== 1) gone.add(k);
  }
  return { idx, idxAny, trust, gone };
}
