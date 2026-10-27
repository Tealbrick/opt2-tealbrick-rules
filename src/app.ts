// App definition (SDK-API §3). The manifest is the only source: the SDK derives routes, input/output validation,
// OpenAPI, receipts, holds, idempotency, backups and status from it. This file registers exactly one handler per
// manifest operation id and one handler per manifest hook id. Op ids and I/O types come from the generated kit (`#kit`).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeHandle, validateAgainstSchema } from "@opt2-tealbrick/manifest";
import { type AppDefinition, type Db, defineApp, type HandlerSpec, type Json, type OpContext, type SdkAppDefinition, TbError } from "@opt2-tealbrick/miniapp-sdk";
import {
  type DecisionsListInput,
  type DecisionsListOutput,
  type DraftDecideInput,
  type DraftDecideOutput,
  type DraftStatusInput,
  type DraftStatusOutput,
  type DraftsListInput,
  type DraftsListOutput,
  type FleetStatusInput,
  type FleetStatusOutput,
  type ModeGetInput,
  type ModeGetOutput,
  type ModeSetInput,
  type ModeSetOutput,
  OP,
  type OpId,
  type RuleComposeInput,
  type RuleComposeOutput,
  type RuleComposeSaveInput,
  type RuleComposeSaveOutput,
  type RuleDraftSubmitInput,
  type RuleDraftSubmitOutput,
  type RuleRestoreInput,
  type RuleRestoreOutput,
  type RulesDeleteInput,
  type RulesDeleteOutput,
  type RulesExplainInput,
  type RulesExplainOutput,
  type RulesGetInput,
  type RulesGetOutput,
  type RulesListInput,
  type RulesListOutput,
  type RulesPreviewInput,
  type RulesPreviewOutput,
  type RulesPreviewRecentInput,
  type RulesPreviewRecentOutput,
  type RulesSetInput,
  type RulesSetOutput,
} from "#kit";
import { catalogOf, catalogState, ensureCatalog, isDynamicOp, opTitles, type SyncOptions, startCatalogTimer } from "./catalog.ts";
import { APP_NAMES, type ComposeEnv, type DrafterId, describeRule, type Proposal, parserDrafter, placeProposal, priorityWhy, vetProposal } from "./compose.ts";
import { knownAgents, rememberAgents } from "./directory.ts";
import { type CallFacts, evaluate, explain, order, type Rule, type RuleSpec, validProduct, wellFormedTool } from "./engine.ts";
import { type CallApp, refreshIfStale, startFleetTimer, strictest, syncFleet } from "./fleet.ts";
import { callerTrustFacts, claimFleetFacts, gateAnswer, HOLD_SUPPORTED, MAX_RECIPIENTS, makeHooks, recipientFacts, registerBridgeCaps, workflowCapVisible } from "./hooks.ts";
import { composeModeNotes, decidedBy, EXEMPTIONS, modeNote, traceDecidedBy } from "./mode.ts";
import { currentMode, modeHistory, modeState, setMode } from "./mode-store.ts";
import { draftBinding, type ModelSource, modelDrafter } from "./model-drafter.ts";
import { type DraftPlace, placeDraft } from "./placement.ts";
import { previewRecent } from "./recent.ts";
import {
  type DraftView,
  decideDraft,
  deleteRule,
  draftStatusFor,
  fleetFacts,
  fleetState,
  fleetTeams,
  getDraft,
  getRule,
  listDecisions,
  listDrafts,
  listRules,
  liveRules,
  markFleetStale,
  pendingDraftCount,
  restoreRule,
  ruleProblem,
  type Submitter,
  saveRule,
  writerProblem as storedWriterProblem,
  submitDraft,
} from "./store.ts";
import { escapeControls } from "./text-guard.ts";

export const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8")) as AppDefinition["manifest"];
export const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

/** Typed handler. The SDK validates `input` against the manifest schema before `run` and the output after it. */
function op<I, O>(spec: HandlerSpec<I, O>): HandlerSpec {
  return spec as unknown as HandlerSpec;
}

function person(ctx: OpContext): string {
  if (ctx.caller.type !== "person") throw new TbError("forbidden", "only the owner may do this", 403);
  return ctx.caller.id;
}

/**
 * The identity of the caller of an agent-audience op. An agent is its agent id. An APP is its VERIFIED product
 * (`ctx.caller.product`, SDK 0.1.27: the Portal-signed slice entry for the grant's instance), never its manifest name
 * (display only; two apps can share one). An app caller with no verified product fails closed: nothing that depends on a
 * product applies to it (no product is recorded or matched), and its own draft is keyed by its instance id (`ctx.caller.id`,
 * a verified id) with no product, shown to the owner as unverified. The conformance check A12.companion_inbound requires
 * such a caller to be able to run `rule_draft_submit`; a draft is only a proposal the owner must approve (C84).
 */
function identity(ctx: OpContext): Submitter {
  const { type, id, name, product } = ctx.caller;
  if (type !== "app") return { type, id, name };
  if (!validProduct(product)) return { type, id, name };
  return { type, id: product, name, product, instance: id };
}

/** Companion read through the op's own context (person ops); outside handlers once C85 lands (see onStart). */
const opCallApp =
  (ctx: OpContext): CallApp =>
  (product, opId, input) =>
    ctx.callApp(product, opId, input) as ReturnType<CallApp>;

async function freshFleet(ctx: OpContext, force = false): Promise<void> {
  if (force) markFleetStale(ctx.db);
  try {
    await refreshIfStale(ctx.db, opCallApp(ctx));
  } catch (e) {
    ctx.log.warn("fleet refresh failed", { error: e instanceof Error ? e.message : "unknown" });
  }
}

/** Catalog read before a write that names apps or operations (bounded wait; see ensureCatalog). */
async function catalogFor(ctx: OpContext, specs: readonly RuleSpec[]): Promise<void> {
  await ensureCatalog(ctx.db, specs, catalogOpts(ctx.log));
}

const catalogOpts = (log: OpContext["log"]): SyncOptions => ({ log: { warn: (msg, data) => log.warn(msg, data as never) } });

/**
 * Review data for a draft: per rule why it can never match (null = fine), each named operation's manifest title, and for a PENDING
 * draft the priority each rule gets when it is approved now (S3-3: placed again against the current rules, active and inactive).
 */
function reviewed(ctx: OpContext, d: DraftView): DraftView & { problems: (string | null)[]; opTitles: Record<string, string>; places?: DraftPlace[]; placeProblem?: string } {
  const plan = d.status === "pending" ? placeDraft(d.rules, liveRules(ctx.db).map((r) => r.spec)) : null;
  return { ...d, problems: d.rules.map((s) => ruleProblem(ctx.db, s) || null), opTitles: opTitles(d.rules, catalogOf(ctx.db)), ...(plan ? { places: plan.places, ...(plan.problem ? { placeProblem: plan.problem } : {}) } : {}) };
}

/**
 * The dry run's recipients, typed by the owner: each value goes through `normalizeHandle` like the bridge does (C373 D5). Absent,
 * `recipientsIncomplete`, more than 64, or a value that is not a handle = unknown (null), exactly how the gate reads such a call.
 */
function previewRecipients(list: readonly string[] | undefined, incomplete: boolean | undefined): string[] | null {
  if (!list || incomplete === true || list.length > MAX_RECIPIENTS) return null;
  const out = new Set<string>();
  for (const v of list) {
    const h = normalizeHandle(v);
    if (!h) return null;
    out.add(h);
  }
  return [...out];
}

/** The RuleSpec schema of the manifest (the one the SDK validates `rules_set` input with). */
const RULE_SCHEMA = (() => {
  const set = manifest.operations.find((o) => o.id === "rules_set") as unknown as { input: { $defs: { RuleSpec: Record<string, unknown> } } };
  return { ...set.input.$defs.RuleSpec, $defs: set.input.$defs } as unknown as Parameters<typeof validateAgainstSchema>[0];
})();

/**
 * THE writer check for a proposed rule ("" = fine): the manifest schema (what the SDK checks on `rules_set` and draft
 * input), then `ruleProblem` (the check every writer runs). A drafter's rules can only become drafts through it.
 */
const writerProblem =
  (db: Db) =>
  (spec: RuleSpec): string => {
    const v = validateAgainstSchema(RULE_SCHEMA, spec as unknown as Json);
    if (!v.ok) return `the rule does not fit the rule schema: ${v.errors.slice(0, 2).map((e) => `${e.path || "/"} ${e.message}`).join("; ")}`;
    return storedWriterProblem(db, spec);
  };

/** Names the owner can use in an English rule: agents (directory), Governance teams (Fleet copy), apps (catalog). */
function composeEnv(ctx: OpContext, shown: readonly { id: string; name: string }[] = []): ComposeEnv {
  const cat = catalogOf(ctx.db);
  // agentsChanged list first; the owner page adds what it read from the SDK's tb.agents_list (same slice) for the gap after a restart
  const agents = [...knownAgents(ctx.db)];
  for (const a of shown) if (!agents.some((x) => x.id === a.id)) agents.push({ id: a.id, name: a.name });
  return {
    agents,
    teams: fleetTeams(ctx.db).map((t) => ({ id: t.id, name: t.name })),
    apps: [...(cat?.keys() ?? [])].map((id) => ({ id, names: APP_NAMES[id] ?? [] })),
    problem: writerProblem(ctx.db),
    // active AND inactive rules (S3-3): re-activating a rule later must not be weakened by a composed one
    existing: liveRules(ctx.db).map((r) => ({ priority: r.spec.priority, decision: r.spec.outcome.decision })),
  };
}

export const MODEL_DRAFT_NOTE = "Drafted with your model. Check every rule before you save it.";
export const MODEL_FAILED_NOTE = "Your model could not help this time, so this is Rules’ own reading.";
export const MODEL_FEWER_NOTE = "Your model’s draft had fewer rules Rules can save, so this is Rules’ own reading.";

/**
 * The English box's drafters (C373 Q-A). The deterministic parser always runs first. Only when it could not read everything AND
 * the owner bound the optional model role (`utility`, else `reasoning`; bridge cap `model_roles`) does the model draft the
 * whole text; its proposal is vetted exactly like the parser's (writer checks plus known names). Review 0.5.0 S3-4: the model only
 * ADDS rules. Every rule the parser read stays (its refuse and hold rules above all); a model rule that repeats one is dropped, and
 * a model ALLOW with an empty match (every call of every agent) is refused. Any model failure falls back to the parser with a note.
 * Never used by a hook.
 */
async function draftRules(ctx: OpContext, text: string, env: ComposeEnv): Promise<{ drafter: DrafterId; proposal: Proposal }> {
  const vet = async (p: Proposal): Promise<Proposal> => {
    await catalogFor(ctx, p.rules.filter((r) => !!r && typeof r === "object" && !!r.match && typeof r.match === "object"));
    return vetProposal(p, env.problem, env);
  };
  const parsed = await vet(await parserDrafter.draft(text, env));
  if (parsed.unmatched.length === 0) return { drafter: parserDrafter.id, proposal: parsed };
  const binding = await draftBinding(ctx as ModelSource, (msg, data) => ctx.log.warn(msg, data));
  if (!binding) return { drafter: parserDrafter.id, proposal: parsed };
  try {
    const drafted = await vet(await modelDrafter(binding, { signal: ctx.signal }).draft(text, env));
    const merged = mergeModelDraft(parsed, drafted, env.existing);
    if (merged.added === 0) return { drafter: parserDrafter.id, proposal: { ...parsed, notes: [...parsed.notes, MODEL_FEWER_NOTE], unmatched: [...parsed.unmatched, ...merged.refused] } };
    return { drafter: "model", proposal: { ...merged.proposal, notes: [MODEL_DRAFT_NOTE, ...merged.proposal.notes] } };
  } catch (e) {
    // a fixed text only: an error message can carry the provider URL (and a credential in it), so it is never logged (S4-4)
    ctx.log.warn("model draft failed", { error: modelErrorKind(e) });
    return { drafter: parserDrafter.id, proposal: { ...parsed, notes: [...parsed.notes, MODEL_FAILED_NOTE] } };
  }
}

/** A model failure as a fixed word (never its message: S4-4). */
export function modelErrorKind(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  if (name === "AbortError" || name === "TimeoutError") return "timeout";
  if (name === "SyntaxError") return "answer_not_json";
  const m = e instanceof Error ? /^the model answered HTTP (\d{3})$/.exec(e.message) : null;
  return m ? `http_${m[1]}` : "error";
}

export const MODEL_EMPTY_ALLOW = "The model proposed an allow rule for every call of every agent. Rules never proposes that from a model; write it in the editor if you mean it.";

/**
 * S3-4: the parser's rules (all kept) plus the model's rules that add something: not a repeat of a parser rule, not an allow with an
 * empty match. Both placed with the same `placeProposal`, at most MAX_COMPOSED_RULES (vetProposal). `added` = model rules kept.
 */
export function mergeModelDraft(parsed: Proposal, drafted: Proposal, existing: ComposeEnv["existing"]): { proposal: Proposal; added: number; refused: Proposal["unmatched"] } {
  const key = (r: RuleSpec) => JSON.stringify([r.outcome.decision, r.match, r.narrowing ?? null]);
  const have = new Set(parsed.rules.map(key));
  const unmatched = [...parsed.unmatched];
  const refused: Proposal["unmatched"] = [];
  const extra: RuleSpec[] = [];
  for (const r of drafted.rules) {
    if (have.has(key(r))) continue;
    if (r.outcome.decision === "allow" && Object.keys(r.match).length === 0) {
      refused.push({ text: typeof r.title === "string" ? r.title.slice(0, 200) : "a rule", hint: MODEL_EMPTY_ALLOW });
      continue;
    }
    have.add(key(r));
    extra.push(r);
  }
  for (const u of drafted.unmatched) if (!unmatched.some((x) => x.text === u.text)) unmatched.push(u);
  const placed = placeProposal({ rules: [...parsed.rules, ...extra], notes: [...parsed.notes, ...drafted.notes], unmatched: [...unmatched, ...refused] }, existing);
  const vetted = vetProposal(placed, () => "");
  return { proposal: vetted, added: vetted.rules.length - Math.min(parsed.rules.length, vetted.rules.length), refused };
}

/** `product.op` of every dynamic operation the catalog lists (the "Allow always" link asks for one tool on these). */
const dynamicOpIds = (db: Db): string[] =>
  [...(catalogOf(db) ?? [])]
    .flatMap(([product, p]) => [...p.ops].filter(([, o]) => o.dynamic).map(([id]) => `${product}.${id}`))
    .sort()
    .slice(0, 1000);

const dynamicFact = (db: Db, product: string, op: string): { dynamic?: boolean } => {
  const dynamic = isDynamicOp(db, product, op);
  return dynamic === undefined ? {} : { dynamic };
};

export const handlers = {
  [OP.rulesList]: op<RulesListInput, RulesListOutput>({
    async run(input, ctx) {
      person(ctx);
      const rules = listRules(ctx.db, input.includeDeleted ?? false);
      await catalogFor(ctx, rules.map((r) => r.spec));
      const st = catalogState(ctx.db);
      return {
        // Stored rules that can never match stay (never deleted) and are flagged; the gate simply never matches them.
        rules: rules.map((r) => ({ ...r, problem: ruleProblem(ctx.db, r.spec) || null })),
        holdSupported: HOLD_SUPPORTED,
        // the default mode (C373c) decides a call no rule matches; its built-in exemptions are shown as read-only system lines
        defaultDecision: ({ permissive: "allow", verification: "hold", closed: "deny" } as const)[currentMode(ctx.db)],
        mode: modeState(ctx.db),
        system: EXEMPTIONS.map((e) => ({ ...e })),
        catalog: {
          generatedAt: st.generatedAt,
          syncedAt: st.syncedAt == null ? null : new Date(st.syncedAt).toISOString(),
          error: st.error,
          products: catalogOf(ctx.db)?.size ?? 0,
          productIds: [...(catalogOf(ctx.db)?.keys() ?? [])].sort(),
          dynamicOps: dynamicOpIds(ctx.db),
          skipped: st.skipped,
        },
      };
    },
  }),
  [OP.rulesGet]: op<RulesGetInput, RulesGetOutput>({
    async run(input, ctx) {
      person(ctx);
      return getRule(ctx.db, input.id);
    },
  }),
  [OP.rulesSet]: op<RulesSetInput, RulesSetOutput>({
    async run(input, ctx) {
      const actor = person(ctx);
      await catalogFor(ctx, [input.rule]);
      return { rule: saveRule(ctx.db, { id: input.id, expectedRev: input.expectedRev, spec: input.rule, actor }) };
    },
  }),
  [OP.rulesDelete]: op<RulesDeleteInput, RulesDeleteOutput>({
    async run(input, ctx) {
      return deleteRule(ctx.db, { id: input.id, expectedRev: input.expectedRev, actor: person(ctx) });
    },
  }),
  [OP.ruleRestore]: op<RuleRestoreInput, RuleRestoreOutput>({
    // Q-7 (C373): same writer checks and actor recording as rules_set; the catalog is read first because the old spec may name apps.
    async run(input, ctx) {
      const actor = person(ctx);
      const target = getRule(ctx.db, input.ruleId).revisions.find((r) => r.rev === input.rev);
      if (target) await catalogFor(ctx, [target.spec]);
      return restoreRule(ctx.db, { id: input.ruleId, rev: input.rev, expectedRev: input.expectedRev, actor });
    },
  }),
  [OP.rulesPreview]: op<RulesPreviewInput, RulesPreviewOutput>({
    async run(input, ctx) {
      person(ctx);
      await freshFleet(ctx);
      if (input.candidate) {
        await catalogFor(ctx, [input.candidate]);
        const p = storedWriterProblem(ctx.db, input.candidate);
        if (p) throw new TbError("input_invalid", p, 400);
      }
      const rules: Rule[] = order([...liveRules(ctx.db), ...(input.candidate ? [{ id: "candidate", rev: 0, spec: input.candidate, updatedAt: Date.now() }] : [])]);
      const claim = input.call.onBehalfOf ?? null;
      const fx = fleetFacts(ctx.db);
      // the recipients stay out of the facts (only their per-recipient Fleet facts go in, as in the gate)
      const { recipients: typedRecipients, recipientsIncomplete, ...target } = input.call.target;
      const facts: CallFacts = {
        caller: { type: input.call.caller.type, id: input.call.caller.id, mode: input.call.caller.mode ?? null },
        // a typed tool that is no catalog tool name counts as absent, exactly like the gate reads one (S4-1)
        target: { ...target, ...(target.tool !== undefined && !wellFormedTool(target.tool) ? { tool: undefined } : {}), ...dynamicFact(ctx.db, target.product, target.op) },
        claim,
        claimVerified: false,
        ...claimFleetFacts(fx, claim),
        callerTeams: input.call.caller.type === "agent" ? (fx.teams.get(`agent:${input.call.caller.id}`) ?? []) : [],
        callerTeamsAny: input.call.caller.type === "agent" ? (fx.teamsAny.get(`agent:${input.call.caller.id}`) ?? []) : [],
        ...callerTrustFacts(fx, input.call.caller),
        recipients: recipientFacts(fx, previewRecipients(typedRecipients, recipientsIncomplete)),
        fleetAvailable: fx.available,
        // the dry run's product is typed in by the owner; it passes the same validity rule as a bridge-sent one
        callerProduct: input.call.caller.type === "app" && validProduct(input.call.caller.product) ? input.call.caller.product : null,
        // the dry run's workflow is typed in (the schema checks the pattern); the cap is the one the gate sees
        callerWorkflow: input.call.caller.type === "app" ? (input.call.caller.workflow ?? null) : null,
        workflowCapVisible: workflowCapVisible(ctx.db),
      };
      // the dry run may try another default mode than the current one (C373c); nothing is stored
      const mode = input.mode ?? currentMode(ctx.db);
      const v = evaluate(rules, facts, mode);
      return {
        mode,
        decidedBy: decidedBy(v),
        exemption: v.byMode?.exemption ?? null,
        modeNote: modeNote(v),
        decision: v.decision,
        answered: gateAnswer(v).answered,
        reason: v.reason,
        ruleId: v.rule?.id ?? null,
        ruleTitle: v.rule?.title ?? null,
        narrowing: v.narrowing,
        teams: [...new Set([...facts.claimTeams, ...facts.claimTeamsAny])],
        callerTeams: [...new Set([...facts.callerTeams, ...facts.callerTeamsAny])],
        trust: facts.claimTrusts.length ? facts.claimTrusts.reduce(strictest) : null,
        callerTrust: facts.callerTrusts?.length ? facts.callerTrusts.reduce(strictest) : null,
        fleetAvailable: facts.fleetAvailable,
        callerProductUnavailable: v.closedOnProduct,
        recipientsUnknown: v.recipientsUnknown,
        workflowUnavailable: v.closedOnWorkflow,
        steps: explain(rules, facts),
      };
    },
  }),
  [OP.rulesPreviewRecent]: op<RulesPreviewRecentInput, RulesPreviewRecentOutput>({
    // D11 (C373): the unsaved rule over the last recorded gate decisions (what they keep, nothing else); stores nothing.
    async run(input, ctx) {
      person(ctx);
      await catalogFor(ctx, [input.rule]);
      const p = storedWriterProblem(ctx.db, input.rule);
      if (p) throw new TbError("input_invalid", p, 400);
      return previewRecent(ctx.db, { candidate: input.rule, replaces: input.ruleId, limit: input.limit }, currentMode(ctx.db)) as RulesPreviewRecentOutput;
    },
  }),
  [OP.decisionsList]: op<DecisionsListInput, DecisionsListOutput>({
    async run(input, ctx) {
      person(ctx);
      return listDecisions(ctx.db, { ...input, limit: input.limit ?? 50 }) as DecisionsListOutput;
    },
  }),
  [OP.draftsList]: op<DraftsListInput, DraftsListOutput>({
    async run(input, ctx) {
      person(ctx);
      const drafts = listDrafts(ctx.db, input.status, input.limit ?? 50);
      await catalogFor(ctx, drafts.filter((d) => d.status === "pending").flatMap((d) => d.rules));
      return { drafts: drafts.map((d) => reviewed(ctx, d)) };
    },
  }),
  [OP.draftDecide]: op<DraftDecideInput, DraftDecideOutput>({
    async run(input, ctx) {
      const actor = person(ctx);
      if (input.decision === "approve") await catalogFor(ctx, getDraft(ctx.db, input.id)?.rules ?? []);
      const draft = decideDraft(ctx.db, { id: input.id, decision: input.decision, actor });
      ctx.statusChanged();
      return { draft: reviewed(ctx, draft) };
    },
  }),
  [OP.fleetStatus]: op<FleetStatusInput, FleetStatusOutput>({
    async run(input, ctx) {
      person(ctx);
      await freshFleet(ctx, input.refresh === true);
      const st = fleetState(ctx.db);
      const teams = fleetTeams(ctx.db);
      return {
        source: st.revision != null || teams.length > 0 ? "fleet" : "none",
        available: fleetFacts(ctx.db).available,
        revision: st.revision,
        syncedAt: st.syncedAt == null ? null : new Date(st.syncedAt).toISOString(),
        error: st.error,
        teams,
      };
    },
  }),
  [OP.modeGet]: op<ModeGetInput, ModeGetOutput>({
    async run(_input, ctx) {
      person(ctx);
      return { ...modeState(ctx.db), history: modeHistory(ctx.db), system: EXEMPTIONS.map((e) => ({ ...e })) };
    },
  }),
  [OP.modeSet]: op<ModeSetInput, ModeSetOutput>({
    // Owner only (person op; agents never reach it). Looser needs confirm: true (409 confirm_required); every change is recorded.
    async run(input, ctx) {
      const actor = person(ctx);
      return setMode(ctx.db, { mode: input.mode, confirm: input.confirm, actor });
    },
  }),
  [OP.rulesExplain]: op<RulesExplainInput, RulesExplainOutput>({
    // A caller sees only its own calls' decisions (the identity is bound by the grant, never by input).
    async run(input, ctx) {
      // An agent is its agent id. An app is its VERIFIED product (S4-3: any instance of it, so a reinstall keeps its history); rows
      // recorded without a product (before 0.5.0) and an app with no verified product are read by the verified instance id.
      const me = ctx.caller.type === "app" ? { appCaller: { product: identity(ctx).product ?? null, instance: ctx.caller.id } } : { caller: ctx.caller.id };
      const { items } = listDecisions(ctx.db, { ...me, callId: input.callId, limit: input.limit ?? 10 });
      return {
        decisions: items.map((d) => ({
          callId: d.callId,
          at: d.at,
          product: d.target.product,
          op: d.target.op,
          decision: d.decision,
          answered: d.answered,
          reason: d.reason,
          ruleId: d.ruleId,
          ruleTitle: d.ruleTitle,
          fleetUnavailable: d.detail?.fleetUnavailable === true,
          callerProductUnavailable: d.detail?.callerProductUnavailable === true,
          recipientsUnknown: d.detail?.recipientsUnknown === true,
          workflowUnavailable: d.detail?.workflowUnavailable === true,
          // C373c: a rule, or the workspace default mode (a row with neither is a Permissive no-match row)
          ...traceDecidedBy(d.ruleId, d.detail),
        })),
      };
    },
  }),
  [OP.draftStatus]: op<DraftStatusInput, DraftStatusOutput>({
    // Only for drafts THIS caller submitted (agent or companion app); anyone else's draft answers like a missing one.
    async run(input, ctx) {
      const me = identity(ctx);
      return draftStatusFor(ctx.db, { type: me.type, id: me.id }, input.draftId);
    },
  }),
  [OP.ruleDraftSubmit]: op<RuleDraftSubmitInput, RuleDraftSubmitOutput>({
    // Creates a DRAFT only; the owner approves it in the UI (C84). Rules never calls a model to decide; a model may only help draft.
    redact: (input) => `rule draft (${input.rules.length} rule${input.rules.length === 1 ? "" : "s"}): ${escapeControls(input.text.slice(0, 200), true)}`,
    async run(input, ctx) {
      await catalogFor(ctx, input.rules);
      const d = submitDraft(ctx.db, { text: input.text, note: input.note, rules: input.rules, by: identity(ctx) });
      ctx.receipt.meta({ draftId: d.id });
      ctx.statusChanged();
      return { draftId: d.id, status: "pending" as const };
    },
  }),
  [OP.ruleCompose]: op<RuleComposeInput, RuleComposeOutput>({
    // The owner's English box (C373, J3): a PROPOSAL only, no state. Every drafter's rules pass the writer checks (vetProposal).
    async run(input, ctx) {
      person(ctx);
      await freshFleet(ctx);
      const env = composeEnv(ctx, input.agents ?? []);
      const { drafter, proposal: p } = await draftRules(ctx, input.text, env);
      const agentName = (id: string) => env.agents.find((a) => a.id === id)?.name ?? id;
      const teamName = (id: string) => fleetTeams(ctx.db).find((t) => t.id === id)?.name ?? id;
      return { drafter, rules: p.rules, lines: p.rules.map((r) => `${describeRule(r, agentName, teamName)} ${priorityWhy(r, env.existing)}`), notes: [...composeModeNotes(p.rules, currentMode(ctx.db)), ...p.notes].slice(0, 100), unmatched: p.unmatched.slice(0, 100) };
    },
  }),
  [OP.ruleComposeSave]: op<RuleComposeSaveInput, RuleComposeSaveOutput>({
    // The owner's own English rule as a pending DRAFT (source owner). It applies only through draft_decide (C84).
    redact: (input) => `owner rule draft (${input.rules.length} rule${input.rules.length === 1 ? "" : "s"}): ${escapeControls(input.text.slice(0, 200), true)}`,
    async run(input, ctx) {
      const actor = person(ctx);
      await catalogFor(ctx, input.rules);
      const d = submitDraft(ctx.db, { text: input.text, note: input.note, rules: input.rules, by: { type: "person", id: actor, name: ctx.caller.name || "Owner" } });
      ctx.statusChanged();
      return { draftId: d.id, status: "pending" as const };
    },
  }),
} satisfies Record<OpId, HandlerSpec>;

export const hooks = makeHooks(manifest.id);

export const definition: SdkAppDefinition = {
  manifest,
  handlers,
  hooks,
  migrations: migrationsDir,
  events: {
    // A changed agent list may change Fleet's teams: mark the copy stale and refresh now (app-initiated call, C85).
    async agentsChanged(agents, ctx) {
      // Agent names for the owner's English rule box (lookup only; rules store ids).
      rememberAgents(ctx.db, agents);
      markFleetStale(ctx.db);
      void syncFleet(ctx.db, ctx.callApp as CallApp);
    },
  },
  // Pending English drafts count toward the app's pendingHolds (TBD badge, C86).
  async pendingCount(db) {
    return pendingDraftCount(db);
  },
  // Fleet read model: refresh now and every 60 s with an app-initiated companion call (C85), never inside a hook.
  async onStart(ctx) {
    // C373 D2c: the hook context has no bridgeCaps (SDK 0.1.40); the hooks read this start context's reader per database
    registerBridgeCaps(ctx.db, (ctx as { bridgeCaps?: () => readonly string[] }).bridgeCaps);
    startFleetTimer(ctx.db, ctx.callApp as CallApp);
    // App catalog from the signed release index (writer checks only; the gate never reads it).
    startCatalogTimer(ctx.db, catalogOpts(ctx.log));
  },
};

export const app = defineApp(definition);
