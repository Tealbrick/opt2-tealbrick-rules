// Q-9 (C373): "Start from a template". Pick a starter rule, fill its one parameter (an agent from the agent directory or a
// team from the Governance copy), then the normal rule editor opens prefilled; nothing is saved until the owner saves it.
import { Button, Choices, Dialog, Field, Notice, Select } from "@opt2-tealbrick/ui";
import { useState } from "react";
import type { RuleSpec } from "./api.ts";
import type { Directory } from "./shared.tsx";
import { type RuleTemplate, TEMPLATES, templateSpec } from "./templates.ts";

/** The templates the owner can use now: the team template only while Governance teams are known, the app template only while the app catalog lists apps. */
export function availableTemplates(dir: Directory, products: readonly string[] = []): RuleTemplate[] {
  return TEMPLATES.filter((t) => (t.param !== "team" || dir.teams.length > 0) && (t.param !== "app" || products.length > 0));
}

/** `products` = the app catalog's product ids (rules_list `catalog.productIds`), for the app template. */
export function TemplatePicker({ dir, products = [], onPick, onClose }: { dir: Directory; products?: readonly string[]; onPick: (spec: RuleSpec) => void; onClose: () => void }) {
  const templates = availableTemplates(dir, products);
  const [id, setId] = useState<RuleTemplate["id"] | null>(null);
  const [arg, setArg] = useState("");
  const chosen = templates.find((t) => t.id === id) ?? null;
  const options =
    chosen?.param === "agent"
      ? dir.agents.map((a) => ({ value: a.id, label: a.name }))
      : chosen?.param === "team"
        ? dir.teams.map((t) => ({ value: t.id, label: t.name }))
        : chosen?.param === "app"
          ? products.map((p) => ({ value: p, label: p }))
          : [];
  const what = chosen?.param === "agent" ? "agent" : chosen?.param === "team" ? "team" : "app";
  const ready = chosen !== null && (!chosen.param || options.some((o) => o.value === arg));
  const use = () => {
    if (!chosen || !ready) return;
    const name = options.find((o) => o.value === arg)?.label ?? arg;
    onPick(templateSpec(chosen.id, chosen.param ? { id: arg, name } : undefined));
  };
  return (
    <Dialog
      open
      kicker="Rule"
      title="Start from a template"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ready} onClick={use}>
            Continue
          </Button>
        </>
      }
    >
      <p className="tb-soft">A template fills the rule editor. Nothing applies until you save the rule.</p>
      <Choices
        label="Template"
        options={templates.map((t) => ({ value: t.id, title: t.title, body: t.summary }))}
        value={id}
        onChange={(v) => {
          setId(v);
          setArg("");
        }}
      />
      {chosen?.param ? (
        options.length === 0 ? (
          <Notice tone="needs-you">{what === "agent" ? "No agents to choose from yet." : what === "team" ? "No Governance teams to choose from yet." : "No apps to choose from yet."}</Notice>
        ) : (
          <Field label={what === "agent" ? "Agent" : what === "team" ? "Team" : "Calling app"}>
            <Select value={arg} placeholder={what === "agent" ? "Choose an agent" : what === "team" ? "Choose a team" : "Choose an app"} options={options} onValueChange={setArg} />
          </Field>
        )
      ) : null}
    </Dialog>
  );
}
