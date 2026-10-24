// App catalog: the operations each product declares, from the SIGNED release index (the source Core's release sync reads,
// L1): verify the index JWS with the pinned release key, fetch each manifest from its URL, check `manifestDigest` and
// validate it with the shared `validateManifest`. Rules stores a compact summary per manifest digest.
//
// Only WRITERS use it (owner rules, drafts, draft apply, dry-run candidates): a rule that names an operation the target app
// does not declare can never match, so it is refused (writer strict, L24; silent failure is a bug, L3). The gate never
// reads the catalog, so a missing or stale catalog never changes a decision (reader tolerant).
import { derivedToolNames, EFFECTS, keySetFrom, type Manifest, validateManifest, verifyReleaseIndex } from "@opt2-tealbrick/manifest";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import type { RuleSpec } from "./engine.ts";

/** The signed release index Core reads (Platform `registry` release). */
export const RELEASE_INDEX_URL = "https://github.com/Tealbrick/opt2-tealbrick-platform/releases/download/registry/index.json";
/** Pinned release key = opt2-tealbrick-platform `registry/keys.json` (public value; the key Core pins as RELEASE_INDEX_PUBLIC_JWKS). */
export const RELEASE_KEYS = { keys: [{ kty: "OKP" as const, crv: "Ed25519" as const, x: "H7nxFrNugQLVOqEXVIB4aOg83Jn19UCosd27fqnoPPI" }] };
/** Full refresh interval; a failed read retries after CATALOG_RETRY_MS. */
export const CATALOG_REFRESH_MS = 6 * 3600 * 1000;
export const CATALOG_RETRY_MS = 60 * 1000;
/** How long a write waits for a running catalog read before it refuses (catalog_unavailable). */
export const CATALOG_WAIT_MS = 8000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_TEXT = 4_000_000;
const POOL = 6;

export interface OpSummary {
  id: string;
  title: string;
  effect: string;
  audience: string;
  dynamic: boolean;
  /** MCP tool names this op derives (`<product>__<op>`, `_search` / `_call` in search mode) */
  tools: string[];
}
export interface CatalogOp {
  /** title from the newest release that declares the op */
  title: string;
  /** declared effects across releases */
  effects: string[];
  /** true when some release declares it with audience agent (hooks see only those, MANIFEST §8) */
  agent: boolean;
  /** dynamic op: the bridge sends the resolved effect per call, so any effect can match */
  dynamic: boolean;
}
export interface ProductOps {
  ops: Map<string, CatalogOp>;
  /** MCP tool name, with and without the `<product>__` prefix → op id */
  tools: Map<string, string>;
}
export type Catalog = Map<string, ProductOps>;
export interface CatalogState {
  generatedAt: string | null;
  syncedAt: number | null;
  attemptedAt: number | null;
  error: string | null;
}

// ── read model ───────────────────────────────────────────────────────────────
const cache = new WeakMap<Db, Catalog | null>();

export function catalogState(db: Db): CatalogState {
  const r = db.prepare("SELECT generated_at, synced_at, attempted_at, error FROM catalog_sync WHERE id = 1").get();
  return {
    generatedAt: r?.generated_at == null ? null : String(r.generated_at),
    syncedAt: r?.synced_at == null ? null : Number(r.synced_at),
    attemptedAt: r?.attempted_at == null ? null : Number(r.attempted_at),
    error: r?.error == null ? null : String(r.error),
  };
}

/** The catalog of the last verified index, or null when no index was ever read. Cached until the next sync. */
export function catalogOf(db: Db): Catalog | null {
  if (cache.has(db)) return cache.get(db) ?? null;
  const st = db.prepare("SELECT digests FROM catalog_sync WHERE id = 1").get();
  let cat: Catalog | null = null;
  if (st?.digests != null) {
    const listed = new Set(JSON.parse(String(st.digests)) as string[]);
    const rows = db.prepare("SELECT digest, product, ops FROM catalog_manifests ORDER BY published_at, version").all();
    cat = buildCatalog(rows.filter((r) => listed.has(String(r.digest))).map((r) => ({ product: String(r.product), ops: JSON.parse(String(r.ops)) as OpSummary[] })));
  }
  cache.set(db, cat);
  return cat;
}

/** Whether an op is dynamic by the catalog; `undefined` = the catalog cannot place it (no catalog, unknown app or op). Local read, no network. */
export function isDynamicOp(db: Db, product: string, op: string): boolean | undefined {
  return catalogOf(db)?.get(product)?.ops.get(op)?.dynamic;
}

/** Folds manifest summaries (oldest first) into one catalog: ops are the union over releases, titles from the newest. */
export function buildCatalog(manifests: readonly { product: string; ops: readonly OpSummary[] }[]): Catalog {
  const cat: Catalog = new Map();
  for (const m of manifests) {
    const p = cat.get(m.product) ?? { ops: new Map(), tools: new Map() };
    cat.set(m.product, p);
    for (const o of m.ops) {
      const prev = p.ops.get(o.id);
      p.ops.set(o.id, {
        title: o.title,
        effects: [...new Set([...(prev?.effects ?? []), o.effect])],
        agent: (prev?.agent ?? false) || o.audience === "agent",
        dynamic: (prev?.dynamic ?? false) || o.dynamic,
      });
      for (const t of o.tools) {
        p.tools.set(t, o.id);
        if (t.startsWith(`${m.product}__`)) p.tools.set(t.slice(m.product.length + 2), o.id);
      }
    }
  }
  return cat;
}

/** Compact summary of a verified manifest's operations. */
export function summarize(m: Manifest): OpSummary[] {
  return m.operations.map((o) => ({
    id: o.id,
    title: o.title,
    effect: o.effect,
    audience: o.audience,
    dynamic: !!(o as { dynamic?: unknown }).dynamic,
    tools: derivedToolNames(m.id, o),
  }));
}

// ── writer checks ────────────────────────────────────────────────────────────
export const CATALOG_MISSING = "Rules has not read the app catalog yet, so it cannot check app and operation names. Try again in a minute.";

/** True when checking `spec` needs the catalog (it names apps or operations). */
export function needsCatalog(spec: RuleSpec): boolean {
  return (spec.match.products?.length ?? 0) > 0 || (spec.match.operations?.length ?? 0) > 0;
}

const q = (s: string) => `“${s}”`;
const agentOpIds = (p: ProductOps) => [...p.ops].filter(([, o]) => o.agent).map(([id]) => id);

/**
 * Why `spec` can never match a real hook call ("" = it can). The bridge sends the hooks the MANIFEST op id of an
 * agent-audience op (never an MCP tool name, never a person op) and, for dynamic ops, the resolved effect.
 * `cat` null = no catalog: only specs that name no app pass.
 */
export function catalogProblem(spec: RuleSpec, cat: Catalog | null): string {
  const m = spec.match;
  const products = m.products ?? [];
  const ops = m.operations ?? [];
  const effects: readonly string[] = m.effects ?? [];
  const tools = m.tools ?? [];
  const bad = effects.find((e) => !(EFFECTS as readonly string[]).includes(e));
  if (bad) return `unknown effect ${q(bad)} (effects: ${EFFECTS.join(", ")})`;
  if (products.length === 0 && ops.length === 0) return "";
  if (!cat) return CATALOG_MISSING;
  for (const p of products) if (!cat.has(p)) return `unknown app ${q(p)}: no release of it is in the signed app catalog`;
  for (const op of ops) {
    for (const p of products) {
      const po = cat.get(p) as ProductOps;
      const o = po.ops.get(op);
      if (!o) {
        const hint = po.tools.get(op);
        if (hint) return `app ${q(p)} has no operation ${q(op)}: that is an MCP tool name, and Rules sees the operation id. Did you mean \`${hint}\`?`;
        const known = agentOpIds(po);
        const dyn = [...po.ops].find(([, o]) => o.agent && o.dynamic)?.[0];
        const tool = dyn ? ` If ${q(op)} is a tool of a connected service, name the operation \`${dyn}\` and list the tool in the rule's tools.` : "";
        return `app ${q(p)} does not declare operation ${q(op)}, so the rule would never match (its agent operations: ${known.slice(0, 15).join(", ")}${known.length > 15 ? ", …" : ""}).${tool}`;
      }
      if (!o.agent) return `${q(p)} operation ${q(op)} is owner-only (person audience); agent calls never reach it, so the rule would never match`;
      if (effects.length && !o.dynamic && !o.effects.some((e) => effects.includes(e)))
        return `${q(p)} operation ${q(op)} has effect ${o.effects.join("/")}, which the rule's effects (${effects.join(", ")}) exclude, so the rule would never match`;
      // spec 0.1.66: only a dynamic call carries `target.tool`
      if (tools.length && !o.dynamic) return `${q(p)} operation ${q(op)} is not a dynamic operation, so its calls carry no tool name and the rule's tools (${tools.join(", ")}) would never match`;
    }
  }
  if (tools.length && ops.length === 0)
    for (const p of products) {
      const po = cat.get(p) as ProductOps;
      if (![...po.ops.values()].some((o) => o.agent && o.dynamic)) return `app ${q(p)} has no dynamic agent operation, so no call of it carries a tool name and the rule's tools would never match`;
    }
  if (ops.length === 0 && effects.length)
    for (const p of products) {
      const po = cat.get(p) as ProductOps;
      if (![...po.ops.values()].some((o) => o.agent && (o.dynamic || o.effects.some((e) => effects.includes(e)))))
        return `app ${q(p)} has no agent operation with effect ${effects.join("/")}, so the rule would never match`;
    }
  return "";
}

/** "product.op" → manifest title, for every operation a spec names (review UI). */
export function opTitles(specs: readonly RuleSpec[], cat: Catalog | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cat) return out;
  for (const s of specs)
    for (const p of s.match.products ?? [])
      for (const op of s.match.operations ?? []) {
        const t = cat.get(p)?.ops.get(op)?.title;
        if (t) out[`${p}.${op}`] = t.slice(0, 200);
      }
  return out;
}

// ── sync ─────────────────────────────────────────────────────────────────────
export type FetchText = (url: string) => Promise<string>;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_TEXT) throw new Error("too large");
  return text;
}

interface IndexRecord {
  product?: unknown;
  kind?: unknown;
  version?: unknown;
  manifestUrl?: unknown;
  manifestDigest?: unknown;
  publishedAt?: unknown;
}

export interface SyncOptions {
  fetchText?: FetchText;
  url?: string;
  keys?: typeof RELEASE_KEYS;
  now?: () => number;
  /** delay step between index re-reads after a signature mismatch (test seam) */
  retryMs?: number;
  log?: { warn(msg: string, data?: Record<string, unknown>): void };
}

/** Reads the signed index and every new manifest it lists; one write per outcome. Errors keep the last catalog. */
export async function syncCatalog(db: Db, opts: SyncOptions = {}): Promise<void> {
  const get = opts.fetchText ?? fetchText;
  const url = opts.url ?? RELEASE_INDEX_URL;
  const now = opts.now ?? Date.now;
  try {
    // index.json and index.jws are two assets: right after a publish one may still be the old one. Retry a mismatch.
    type Body = { schema?: unknown; generatedAt?: unknown; releases?: unknown };
    let body = null as Body | null;
    let ok = false as boolean;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, (opts.retryMs ?? 3000) * attempt));
      const text = await get(url);
      const jws = (await get(url.replace(/\.json$/, ".jws"))).trim();
      body = JSON.parse(text) as Body;
      if (body?.schema !== "opt2.release-index/v2" || !Array.isArray(body.releases)) throw new Error("unexpected release index schema");
      const v = verifyReleaseIndex(jws, body as never, { now: Math.floor(now() / 1000), keys: keySetFrom(opts.keys ?? RELEASE_KEYS, "tb:releases") });
      ok = v.ok;
    }
    if (!ok || !body) throw new Error("release index signature refused");
    const known = new Set(db.prepare("SELECT digest FROM catalog_manifests").all().map((r) => String(r.digest)));
    const listed: string[] = [];
    const todo: IndexRecord[] = [];
    for (const r of body.releases as IndexRecord[]) {
      if (r?.kind !== "app" || typeof r.manifestUrl !== "string" || typeof r.manifestDigest !== "string") continue;
      if (known.has(r.manifestDigest)) listed.push(r.manifestDigest);
      else todo.push(r);
    }
    const fetched: { digest: string; product: string; version: string; publishedAt: string; ops: OpSummary[] }[] = [];
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const r = todo[next++] as IndexRecord;
        try {
          const val = validateManifest(JSON.parse(await get(r.manifestUrl as string)));
          if (!val.ok) throw new Error("manifest invalid");
          if (val.digest !== r.manifestDigest) throw new Error("manifest digest mismatch");
          const m = val.manifest as Manifest;
          if (m.id !== r.product || m.version !== r.version) throw new Error("manifest identity mismatch");
          fetched.push({ digest: val.digest, product: m.id, version: m.version, publishedAt: String(r.publishedAt ?? ""), ops: summarize(m) });
        } catch (e) {
          opts.log?.warn("catalog: release skipped", { product: String(r.product), version: String(r.version), reason: e instanceof Error ? e.message.slice(0, 120) : "unknown" });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(POOL, todo.length) }, worker));
    const t = now();
    db.transaction(() => {
      const ins = db.prepare("INSERT OR IGNORE INTO catalog_manifests (digest, product, version, published_at, ops) VALUES (?, ?, ?, ?, ?)");
      for (const f of fetched) {
        ins.run(f.digest, f.product, f.version, f.publishedAt, JSON.stringify(f.ops));
        listed.push(f.digest);
      }
      db.prepare("UPDATE catalog_sync SET generated_at = ?, synced_at = ?, attempted_at = ?, digests = ?, error = NULL WHERE id = 1").run(
        typeof body?.generatedAt === "string" ? body.generatedAt : null,
        t,
        t,
        JSON.stringify(listed),
      );
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 280) : "unknown";
    opts.log?.warn("catalog: read failed", { error: msg });
    try {
      db.prepare("UPDATE catalog_sync SET attempted_at = ?, error = ? WHERE id = 1").run(now(), msg);
    } catch {
      // database closed (app stopping): nothing to record
    }
  }
  cache.delete(db);
}

const inflight = new WeakMap<Db, Promise<void>>();

/** One catalog read at a time per database. */
export function syncOnce(db: Db, opts: SyncOptions = {}): Promise<void> {
  let p = inflight.get(db);
  if (!p) {
    p = syncCatalog(db, opts).finally(() => inflight.delete(db));
    inflight.set(db, p);
  }
  return p;
}

/**
 * Before a write: when the catalog is missing, or one of `specs` names something it does not know and the last attempt
 * is older than CATALOG_RETRY_MS (a just-released app), read the index once and wait up to CATALOG_WAIT_MS.
 */
export async function ensureCatalog(db: Db, specs: readonly RuleSpec[], opts: SyncOptions & { waitMs?: number } = {}): Promise<void> {
  if (!specs.some(needsCatalog)) return;
  const cat = catalogOf(db);
  const st = catalogState(db);
  const now = (opts.now ?? Date.now)();
  const unknown = cat !== null && specs.some((s) => catalogProblem(s, cat) !== "");
  const due = st.attemptedAt == null || now - st.attemptedAt > CATALOG_RETRY_MS;
  if (cat !== null && !(unknown && due)) return;
  if (cat === null && !due && !inflight.has(db)) return;
  let timer: NodeJS.Timeout | undefined;
  const wait = new Promise<void>((r) => {
    timer = setTimeout(r, opts.waitMs ?? CATALOG_WAIT_MS);
  });
  await Promise.race([syncOnce(db, opts), wait]);
  clearTimeout(timer);
}

/** Start: read now, then every CATALOG_REFRESH_MS (every CATALOG_RETRY_MS after a failure). Never inside a hook. */
export function startCatalogTimer(db: Db, opts: SyncOptions = {}): () => void {
  // Unit tests that boot the app set this so they never reach the network (production never sets it).
  if (process.env.TB_RULES_CATALOG_OFF === "1") return () => {};
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    await syncOnce(db, opts);
    if (stopped) return;
    let failed = true;
    try {
      failed = catalogState(db).error !== null;
    } catch {
      return; // database closed: the app stopped
    }
    timer = setTimeout(tick, failed ? CATALOG_RETRY_MS : CATALOG_REFRESH_MS);
    timer.unref?.();
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
