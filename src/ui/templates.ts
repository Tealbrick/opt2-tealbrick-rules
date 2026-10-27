// Q-9 (C373): starter rules as one-click templates. Pure data and one builder, no React and no I/O, so the server
// tests run the same specs through the writer and the engine. Nothing here is active by itself: a template only fills
// the rule editor, and the owner saves it with rules_set like any rule. It lives in src/ui because the UI build serves
// only files under src/ui (scripts/build-ui.ts); it imports types only.
import type { RuleSpec } from "./api.ts";

/** The one thing a template asks for before it fills the editor. */
export type TemplateParam = "agent" | "team" | "app";

export interface RuleTemplate {
  id: "hold-agent-outward" | "hold-money" | "deny-bound-destructive" | "hold-team-outward" | "hold-app-outward";
  title: string;
  /** one sentence for the picker */
  summary: string;
  /** what the owner picks first (agent from the agent directory, team from the Governance copy, app from the app catalog); absent = nothing */
  param?: TemplateParam;
}

export const TEMPLATES: readonly RuleTemplate[] = [
  { id: "hold-agent-outward", title: "Hold an agent’s outward actions", summary: "Messages, posts and other actions that leave the workspace wait for your review.", param: "agent" },
  { id: "hold-money", title: "Hold all money actions", summary: "Every payment or other money action of any agent waits for your review." },
  { id: "deny-bound-destructive", title: "Block destructive actions for bound agents", summary: "Bound agents may not delete or overwrite anything." },
  { id: "hold-team-outward", title: "Hold outward actions of a team", summary: "Outward actions of every agent in a Governance team wait for your review.", param: "team" },
  { id: "hold-app-outward", title: "Hold an app’s outward actions", summary: "Outward actions that another app starts (not an agent) wait for your review.", param: "app" },
];

/** The picked agent or team: its id (stored in the rule) and its name (only used in the title and reason). */
export interface TemplateArg {
  id: string;
  name: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The rule a template stands for. `arg` is required for a template with a `param` (else: Error). The name is clipped so
 * the title (120) and reason (280) stay inside the manifest limits whatever the agent or team is called.
 */
export function templateSpec(id: RuleTemplate["id"], arg?: TemplateArg): RuleSpec {
  const base = { active: true, priority: 100 } as const;
  const need = (): TemplateArg => {
    if (!arg?.id) throw new Error(`template ${id} needs ${id === "hold-team-outward" ? "a team" : id === "hold-app-outward" ? "an app" : "an agent"}`);
    return { id: arg.id, name: clip(arg.name.trim() || arg.id, 60) };
  };
  switch (id) {
    case "hold-agent-outward": {
      const a = need();
      return { ...base, title: `Hold ${a.name}’s outward actions`, match: { agents: [a.id], effects: ["outward"] }, outcome: { decision: "hold", reason: `${a.name}: outward actions wait for you` } };
    }
    case "hold-money":
      return { ...base, title: "Hold all money actions", match: { effects: ["money"] }, outcome: { decision: "hold", reason: "Money actions wait for your review." } };
    case "deny-bound-destructive":
      return { ...base, title: "Block destructive actions for bound agents", match: { modes: ["bound"], effects: ["destructive"] }, outcome: { decision: "deny", reason: "Bound agents may not run destructive actions." } };
    case "hold-team-outward": {
      const t = need();
      return { ...base, title: `Hold outward actions of ${t.name}`, match: { callerTeams: [t.id], effects: ["outward"] }, outcome: { decision: "hold", reason: `${t.name}: outward actions wait for you` } };
    }
    case "hold-app-outward": {
      // calls from the app with this VERIFIED product (C237); the product id is the app's name in the catalog
      const p = need();
      return { ...base, title: `Hold ${p.name}’s outward actions`, match: { callerProducts: [p.id], effects: ["outward"] }, outcome: { decision: "hold", reason: `${p.name}: outward actions wait for you` } };
    }
  }
}
