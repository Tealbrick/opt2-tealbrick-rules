// C374 Access page: for each agent and each app, how deep it may go (a level), what happens beyond that (hold or refuse), and
// which apps and tools it may use. A setting is saved as ordinary rules (./access-model.ts builds them); "Check" runs the real
// gate over the saved rules (rules_preview) for every effect, so the owner sees the result with every other rule included.
import { Button, Card, Dialog, Field, Notice, Select, Swatch, Tag, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useMemo, useState } from "react";
import {
  ACCESS_EFFECTS,
  type AccessCatalog,
  type AccessEffect,
  type AccessSetting,
  accessOf,
  accessSpecs,
  type Caller,
  callerKey,
  dynamicApps,
  EFFECT_WORD,
  effectOutcomes,
  isEdited,
  LEVELS,
  type Level,
  NOT_OFFERED_APPS,
  settingLine,
  settingProblem,
  toolApps,
} from "./access-model.ts";
import { errorText, list, type Out, type RuleRow, run } from "./api.ts";
import { MODE_TITLE } from "./mode.tsx";
import { ChipChoice, DecisionTag, type Directory, DirectoryErrors, Head, LoadError, Loading, useDirectory, useLoaded } from "./shared.tsx";

const BEYOND = [
  { value: "hold", label: "Hold for my review" },
  { value: "deny", label: "Refuse" },
];
const loadRules = () => run("rules_list", {});

/** Save: the new rules first; if one is refused, the new ones are removed again and the old ones stay. Then the old ones go. */
async function saveAccess(caller: Caller, s: AccessSetting, cat: AccessCatalog, old: readonly RuleRow[]): Promise<string> {
  const specs = accessSpecs(caller, s, cat);
  const made: { id: string; rev: number }[] = [];
  try {
    for (const rule of specs) {
      const out = await run("rules_set", { rule });
      made.push({ id: out.rule.id, rev: out.rule.rev });
    }
  } catch (e) {
    for (const m of made) await run("rules_delete", { id: m.id, expectedRev: m.rev }).catch(() => undefined);
    throw e;
  }
  for (const r of old) await run("rules_delete", { id: r.id, expectedRev: r.rev });
  return `${specs.length} ${specs.length === 1 ? "rule" : "rules"} saved.`;
}

async function removeAccess(old: readonly RuleRow[]): Promise<void> {
  for (const r of old) await run("rules_delete", { id: r.id, expectedRev: r.rev });
}

function AccessDialog({ caller, found, cat, mode, onDone }: { caller: Caller; found: { setting: AccessSetting; rules: RuleRow[] } | undefined; cat: AccessCatalog; mode: string; onDone: (saved: boolean) => void }) {
  const [s, setS] = useState<AccessSetting>(() => structuredClone(found?.setting ?? { level: 2, beyond: "hold" }));
  const [toolsText, setToolsText] = useState((found?.setting.tools ?? []).join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const tools = list(toolsText);
  const next: AccessSetting = { level: s.level, beyond: s.beyond, ...(s.apps ? { apps: s.apps } : {}), ...(tools ? { tools } : {}) };
  const problem = settingProblem(next, caller, cat);
  const apps = cat.productIds.filter((p) => !NOT_OFFERED_APPS.includes(p) && !(caller.type === "app" && p === caller.product));
  const dyn = dynamicApps(cat);
  const toolTargets = toolApps({ ...next, tools: undefined }, cat);
  const save = async () => {
    if (busy || problem) return;
    setBusy(true);
    setError("");
    try {
      await saveAccess(caller, next, cat, found?.rules ?? []);
      onDone(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      kicker="Access"
      title={`Access of ${caller.name}`}
      onClose={() => onDone(false)}
      busy={busy}
      size="lg"
      footer={
        <>
          <Button onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !!problem} onClick={() => void save()}>
            {busy ? "Saving" : "Save access"}
          </Button>
        </>
      }
    >
      {error ? (
        <Notice tone="needs-you" role="alert">
          {error}
        </Notice>
      ) : null}
      <Field label="How deep it may go">
        <Select value={String(s.level)} options={LEVELS.map((l) => ({ value: String(l.level), label: l.title }))} onValueChange={(v) => setS({ ...s, level: Number(v) as Level })} />
      </Field>
      <p className="tb-hint">{LEVELS.find((l) => l.level === s.level)?.text}</p>
      {s.level < ACCESS_EFFECTS.length ? (
        <Field label="Beyond that">
          <Select value={s.beyond} options={BEYOND} onValueChange={(v) => setS({ ...s, beyond: v as AccessSetting["beyond"] })} />
        </Field>
      ) : null}
      <ChipChoice
        label="Only these apps"
        hint="none = every app. Apps you do not pick are refused."
        options={apps.map((p) => ({ value: p, label: p }))}
        value={s.apps}
        onChange={(v) => setS({ ...s, apps: v })}
      />
      <Field
        label="Only these tools"
        hint={
          toolTargets.length
            ? `Tool names of connected services, comma separated (for ${toolTargets.join(", ")}). Empty = every tool. Other tools are refused. A name also covers its x__… variants.`
            : dyn.size
              ? "None of the picked apps runs tools of connected services."
              : "No app in the catalog runs tools of connected services."
        }
      >
        <TextInput value={toolsText} disabled={toolTargets.length === 0 || s.level === 0} onChange={(e) => setToolsText(e.target.value)} />
      </Field>
      <section className="rules-group" aria-label="What this does">
        <h3>What this does</h3>
        <ul className="access-outcomes">
          {effectOutcomes(next).map((o) => (
            <li key={o.effect}>
              <span className="access-effect">{EFFECT_WORD[o.effect]}</span> <DecisionTag decision={o.decision} rule />
            </li>
          ))}
          {next.apps ? (
            <li>
              <span className="access-effect">other apps</span> <DecisionTag decision="deny" rule />
            </li>
          ) : null}
          {next.tools && s.level > 0 ? (
            <li>
              <span className="access-effect">other tools</span> <DecisionTag decision="deny" rule />
            </li>
          ) : null}
        </ul>
        <p className="tb-hint">
          Your own rules on the Rules page decide first (they have a lower priority). Calls of Rules’ own “why was I stopped” and “propose a rule” always run. The default mode ({MODE_TITLE[mode as keyof typeof MODE_TITLE] ?? mode}) no longer decides
          for {caller.name}: this setting covers every call.
        </p>
      </section>
      {problem ? <p className="tb-hint">{problem}</p> : null}
    </Dialog>
  );
}

type Check = { label: string; decision: string; by: string }[];

/** The real gate over the saved rules: one dry run per effect (inside the picked apps), outside the apps, and for tools. */
async function checkAccess(caller: Caller, s: AccessSetting, cat: AccessCatalog): Promise<Check> {
  const callerIn = caller.type === "agent" ? { type: "agent" as const, id: caller.id, mode: "free" as const } : { type: "app" as const, id: "ins_access_check", product: caller.product };
  const usable = cat.productIds.filter((p) => !NOT_OFFERED_APPS.includes(p) && !(caller.type === "app" && p === caller.product));
  const dyn = dynamicApps(cat);
  const inside = (s.apps ?? usable).find((p) => !dyn.has(p)) ?? (s.apps ?? usable)[0];
  const rows: Check = [];
  const one = async (label: string, target: { product: string; op: string; effect: AccessEffect; tool?: string }) => {
    const r: Out<"rules_preview"> = await run("rules_preview", { call: { caller: callerIn, target } });
    rows.push({ label, decision: r.decision, by: r.ruleTitle ?? (r.decidedBy === "mode" ? `${MODE_TITLE[r.mode]} mode` : r.decidedBy) });
  };
  if (inside) for (const e of ACCESS_EFFECTS) await one(`${EFFECT_WORD[e]} in ${inside}`, { product: inside, op: "access_check", effect: e });
  const outside = s.apps ? usable.find((p) => !s.apps?.includes(p)) : undefined;
  if (outside) await one(`read in ${outside} (not picked)`, { product: outside, op: "access_check", effect: "read" });
  const tp = toolApps(s, cat)[0];
  const op = tp ? dyn.get(tp)?.[0] : undefined;
  if (s.tools && tp && op && s.level > 0) {
    await one(`tool ${s.tools[0]} in ${tp}`, { product: tp, op, effect: "read", tool: s.tools[0] as string });
    await one(`another tool in ${tp}`, { product: tp, op, effect: "read", tool: "access_check_other" });
  }
  return rows;
}

function Row({ caller, found, cat, onEdit, onChanged }: { caller: Caller; found: { setting: AccessSetting; rules: RuleRow[] } | undefined; cat: AccessCatalog; onEdit: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [check, setCheck] = useState<Check | null>(null);
  const edited = found ? isEdited(caller, found, cat) : false;
  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="item">
      <Swatch group="control" />
      <h3>
        {caller.name} {caller.type === "app" ? <Tag status="idle">app</Tag> : null} {found ? <Tag status="live">set</Tag> : null} {edited ? <Tag status="needs-you">edited by hand</Tag> : null}
      </h3>
      <p>{found ? settingLine(found.setting) : "Not set: your rules and the default mode decide."}</p>
      {edited ? <p className="tb-hint">The rules of this setting were changed on the Rules page, or the app list changed. Save it again to put them back.</p> : null}
      {error ? (
        <Notice tone="needs-you" role="alert">
          {error}
        </Notice>
      ) : null}
      {check ? (
        <ul className="access-outcomes" aria-label={`Check of ${caller.name}`}>
          {check.map((c) => (
            <li key={c.label}>
              <span className="access-effect">{c.label}</span> <DecisionTag decision={c.decision as "allow" | "deny" | "hold"} rule /> <span className="tb-hint">by {c.by}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="side">
        <Button size="sm" variant={found ? undefined : "primary"} onClick={onEdit} disabled={busy}>
          {found ? "Change" : "Set access"}
        </Button>
        {found ? (
          <>
            <Button size="sm" disabled={busy} onClick={() => void act(async () => setCheck(await checkAccess(caller, found.setting, cat)))}>
              {busy ? "Checking" : "Check"}
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await removeAccess(found.rules);
                  setCheck(null);
                  onChanged();
                })
              }
            >
              Remove
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function AccessPage() {
  const dir: Directory = useDirectory();
  const { data, error, loading, reload } = useLoaded(loadRules);
  const [editing, setEditing] = useState<Caller | null>(null);
  const cat: AccessCatalog = useMemo(() => ({ productIds: data?.catalog.productIds ?? [], dynamicOps: data?.catalog.dynamicOps ?? [] }), [data]);
  const byCaller = useMemo(() => accessOf(data?.rules ?? []), [data]);
  const agents: Caller[] = dir.agents.map((a) => ({ type: "agent", id: a.id, name: a.name }));
  const apps: Caller[] = cat.productIds.filter((p) => !NOT_OFFERED_APPS.includes(p)).map((p) => ({ type: "app", product: p, name: p }));
  const done = useCallback(
    (saved: boolean) => {
      setEditing(null);
      if (saved) reload();
    },
    [reload],
  );
  const rows = (callers: Caller[]) => (
    <div className="ruled">
      {callers.map((c) => (
        <Row key={callerKey(c)} caller={c} found={byCaller.get(callerKey(c))} cat={cat} onEdit={() => setEditing(c)} onChanged={reload} />
      ))}
    </div>
  );
  return (
    <section className="app-page" aria-label="Access">
      <Head title="Access" lede="For each agent and each app: how deep it may go, what happens beyond that, and which apps and tools it may use. Your own rules on the Rules page decide first." />
      {error ? <LoadError message={error} retrying={loading} onRetry={reload} /> : null}
      <DirectoryErrors dir={dir} />
      {data?.catalog.error ? <p className="tb-hint">App catalog: last read failed ({data.catalog.error}).</p> : null}
      {data === null ? (
        error ? null : <Loading what="access" />
      ) : (
        <>
          <Card as="section" aria-label="Agents">
            <h3>Agents</h3>
            {agents.length ? rows(agents) : <p className="tb-hint">{dir.loading ? "Loading agents." : "No agents yet."}</p>}
          </Card>
          <Card as="section" aria-label="Apps">
            <h3>Apps</h3>
            <p className="tb-hint">Calls that one app makes to another (for example Evolving Workflows or Governance). Rules itself is not listed: it must read Governance.</p>
            {apps.length ? rows(apps) : <p className="tb-hint">The app catalog is not read yet.</p>}
          </Card>
        </>
      )}
      {editing ? <AccessDialog caller={editing} found={byCaller.get(callerKey(editing))} cat={cat} mode={data?.mode.mode ?? "permissive"} onDone={done} /> : null}
    </section>
  );
}
