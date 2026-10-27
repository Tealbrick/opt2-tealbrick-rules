// App definition (SDK-API §3). The manifest is the only source: the SDK derives routes, input/output validation,
// OpenAPI, receipts, holds, idempotency, backups and status from it. This file registers exactly one handler per
// manifest operation id and one handler per manifest hook id. Op ids and I/O types come from the generated kit (`#kit`).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AppDefinition, type Db, defineApp, type HandlerSpec, type OpContext, type SdkAppDefinition, TbError } from "@opt2-tealbrick/miniapp-sdk";
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
  OP,
  type OpId,
  type RuleDraftSubmitInput,
  type RuleDraftSubmitOutput,
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
  type RulesSetInput,
  type RulesSetOutput,
} from "#kit";
import { catalogOf, catalogState, ensureCatalog, isDynamicOp, opTitles, type SyncOptions, startCatalogTimer } from "./catalog.ts";
import { type CallFacts, evaluate, explain, order, type Rule, type RuleSpec, validProduct } from "./engine.ts";
import { type CallApp, refreshIfStale, startFleetTimer, strictest, syncFleet } from "./fleet.ts";
import { claimFleetFacts, gateAnswer, HOLD_SUPPORTED, makeHooks } from "./hooks.ts";
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
  ruleProblem,
  type Submitter,
  saveRule,
  submitDraft,
} from "./store.ts";

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

/** Review data for a draft: per rule why it can never match (null = fine), and each named operation's manifest title. */
function reviewed(ctx: OpContext, d: DraftView): DraftView & { problems: (string | null)[]; opTitles: Record<string, string> } {
  return { ...d, problems: d.rules.map((s) => ruleProblem(ctx.db, s) || null), opTitles: opTitles(d.rules, catalogOf(ctx.db)) };
}

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
        defaultDecision: "allow",
        catalog: { generatedAt: st.generatedAt, syncedAt: st.syncedAt == null ? null : new Date(st.syncedAt).toISOString(), error: st.error, products: catalogOf(ctx.db)?.size ?? 0, productIds: [...(catalogOf(ctx.db)?.keys() ?? [])].sort() },
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
  [OP.rulesPreview]: op<RulesPreviewInput, RulesPreviewOutput>({
    async run(input, ctx) {
      person(ctx);
      await freshFleet(ctx);
      if (input.candidate) {
        await catalogFor(ctx, [input.candidate]);
        const p = ruleProblem(ctx.db, input.candidate);
        if (p) throw new TbError("input_invalid", p, 400);
      }
      const rules: Rule[] = order([...liveRules(ctx.db), ...(input.candidate ? [{ id: "candidate", rev: 0, spec: input.candidate, updatedAt: Date.now() }] : [])]);
      const claim = input.call.onBehalfOf ?? null;
      const fx = fleetFacts(ctx.db);
      const facts: CallFacts = {
        caller: { type: input.call.caller.type, id: input.call.caller.id, mode: input.call.caller.mode ?? null },
        target: { ...input.call.target, ...dynamicFact(ctx.db, input.call.target.product, input.call.target.op) },
        claim,
        claimVerified: false,
        ...claimFleetFacts(fx, claim),
        callerTeams: input.call.caller.type === "agent" ? (fx.teams.get(`agent:${input.call.caller.id}`) ?? []) : [],
        callerTeamsAny: input.call.caller.type === "agent" ? (fx.teamsAny.get(`agent:${input.call.caller.id}`) ?? []) : [],
        fleetAvailable: fx.available,
        // the dry run's product is typed in by the owner; it passes the same validity rule as a bridge-sent one
        callerProduct: input.call.caller.type === "app" && validProduct(input.call.caller.product) ? input.call.caller.product : null,
      };
      const v = evaluate(rules, facts);
      return {
        decision: v.decision,
        answered: gateAnswer(v).answered,
        reason: v.reason,
        ruleId: v.rule?.id ?? null,
        ruleTitle: v.rule?.title ?? null,
        narrowing: v.narrowing,
        teams: [...new Set([...facts.claimTeams, ...facts.claimTeamsAny])],
        callerTeams: [...new Set([...facts.callerTeams, ...facts.callerTeamsAny])],
        trust: facts.claimTrusts.length ? facts.claimTrusts.reduce(strictest) : null,
        fleetAvailable: facts.fleetAvailable,
        callerProductUnavailable: v.closedOnProduct,
        steps: explain(rules, facts),
      };
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
  [OP.rulesExplain]: op<RulesExplainInput, RulesExplainOutput>({
    // A caller sees only its own calls' decisions (the identity is bound by the grant, never by input).
    async run(input, ctx) {
      // An agent is its agent id. An app is its VERIFIED product (S4-3: any instance of it, so a reinstall keeps its history); rows
      // recorded without a product (before 0.3.2) and an app with no verified product are read by the verified instance id.
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
    // Creates a DRAFT only; the owner approves it in the UI (C84). Rules itself never calls a model.
    redact: (input) => `rule draft (${input.rules.length} rule${input.rules.length === 1 ? "" : "s"}): ${input.text.slice(0, 200)}`,
    async run(input, ctx) {
      await catalogFor(ctx, input.rules);
      const d = submitDraft(ctx.db, { text: input.text, note: input.note, rules: input.rules, by: identity(ctx) });
      ctx.receipt.meta({ draftId: d.id });
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
    async agentsChanged(_agents, ctx) {
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
    startFleetTimer(ctx.db, ctx.callApp as CallApp);
    // App catalog from the signed release index (writer checks only; the gate never reads it).
    startCatalogTimer(ctx.db, catalogOpts(ctx.log));
  },
};

export const app = defineApp(definition);
