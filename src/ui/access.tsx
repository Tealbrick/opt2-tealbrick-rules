// C374 Access page: for each agent and each app, how deep it may go (a level), what happens beyond that (hold or refuse), and
// which apps and tools it may use. A setting is saved as ordinary rules (./access-model.ts builds them); "Check" runs the real
// gate over the saved rules (rules_preview) for every effect, so the owner sees the result with every other rule included.
import { AccessBulk, type AccessChange, AccessFilterField, accessFilter, Button, Card, Dialog, Field, Notice, Select, Swatch, Tag, TextInput, useAccessFilter } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ACCESS_EFFECTS,
  type AccessCatalog,
  type AccessEffect,
  type AccessSetting,
  accessCells,
  accessOf,
  accessSpecs,
  bulkSetting,
  type Caller,
  callerKey,
  dynamicApps,
  EFFECT_WORD,
  effectOutcomes,
  isEdited,
  LEVELS,
  type Level,
  NOT_OFFERED_APPS,
  ONLY_APPS_LINE,
  settingLine,
  settingProblem,
  toolApps,
} from "./access-model.ts";
import { errorText, list, type Out, type RuleRow, run } from "./api.ts";
import { MODE_TEXT, MODE_TITLE, type Mode } from "./mode.tsx";
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
  // The old rules go last. If the first one will not go, nothing has changed yet: the new ones are removed again, and the old ones stay.
  // After that the setting is half saved, and the owner must hear it.
  let gone = 0;
  try {
    for (const r of old) {
      await run("rules_delete", { id: r.id, expectedRev: r.rev });
      gone++;
    }
  } catch (e) {
    if (gone === 0) {
      for (const m of made) await run("rules_delete", { id: m.id, expectedRev: m.rev }).catch(() => undefined);
      throw e;
    }
    throw Object.assign(new Error(`The new level is saved, but some old rules could not be removed. Open this agent and save it again. ${errorText(e)}`), { code: "input_invalid" });
  }
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
        hint={`none = every app. ${ONLY_APPS_LINE}`}
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
    rows.push({ label, decision: r.decision, by: r.ruleTitle ?? (r.decidedBy === "mode" ? `${MODE_TITLE[r.mode]} mode` : r.decidedBy === "floor" ? "the company floor" : r.decidedBy) });
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

function Row({ caller, found, cat, modeName, onEdit, onChanged }: { caller: Caller; found: { setting: AccessSetting; rules: RuleRow[] } | undefined; cat: AccessCatalog; modeName: string; onEdit: () => void; onChanged: () => void }) {
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
      <p>{found ? settingLine(found.setting) : `Not set: your rules and the default mode (${modeName}) decide.`}</p>
      {found?.setting.apps ? <p className="tb-hint">{ONLY_APPS_LINE}</p> : null}
      {found ? <p className="tb-hint">{`Remove gives ${caller.type === "agent" ? "this agent" : "this app"} back to the default mode (${modeName}).`}</p> : null}
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

const BULK_SCOPE = { id: "access", name: "Access" };
const LEVEL_CHOICES = LEVELS.map((l) => ({ id: String(l.level), label: l.title, hint: l.text }));

/** One level for several agents, by the save of the dialog, one agent at a time. Each agent keeps what happens beyond the level, its apps and its tools. */
function ManyAgents({ agents, byCaller: loaded, cat, modeName, onBack, reload }: { agents: readonly Caller[]; byCaller: ReadonlyMap<string, { setting: AccessSetting; rules: RuleRow[] }>; cat: AccessCatalog; modeName: string; onBack: () => void; reload: () => void }) {
  // What the last read gave, kept here: the next click must delete the rules that exist now, not the ones the page read before this click.
  const [fresh, setFresh] = useState<ReadonlyMap<string, { setting: AccessSetting; rules: RuleRow[] }> | null>(null);
  const byCaller = fresh ?? loaded;
  const [beyond, setBeyond] = useState<AccessSetting["beyond"]>("hold");
  // A setting edited by hand on the Rules page has rules the setting does not build: a save would overwrite them, so it is changed one by one.
  const handEdited = useMemo(() => agents.filter((c) => { const f = byCaller.get(callerKey(c)); return f ? isEdited(c, f, cat) : false; }), [agents, byCaller, cat]);
  const listed = useMemo(() => agents.filter((c) => !handEdited.includes(c)), [agents, handEdited]);
  const who = useMemo(
    () =>
      listed.map((c) => {
        const f = byCaller.get(callerKey(c));
        return { id: callerKey(c), name: c.name, note: f ? settingLine(f.setting) : "" };
      }),
    [listed, byCaller],
  );
  const cells = useMemo(() => accessCells(byCaller, BULK_SCOPE.id), [byCaller]);
  const write = async (change: AccessChange) => {
    const caller = listed.find((c) => callerKey(c) === change.agent);
    if (!caller) throw Object.assign(new Error("This agent is gone. Reload the page."), { code: "not_found" });
    const found = byCaller.get(change.agent);
    const next = bulkSetting(found?.setting, Number(change.level) as Level, beyond);
    const problem = settingProblem(next, caller, cat);
    if (problem) throw Object.assign(new Error(problem), { code: "input_invalid" });
    await saveAccess(caller, next, cat, found?.rules ?? []);
  };
  const read = useCallback(async () => {
    const next = accessOf((await loadRules()).rules);
    setFresh(next);
    reload();
    return accessCells(next, BULK_SCOPE.id);
  }, [reload]);
  return (
    <AccessBulk
      agents={who}
      scope={BULK_SCOPE}
      levels={LEVEL_CHOICES}
      allowNone={false}
      noneLabel="Not set"
      cells={cells}
      write={write}
      reload={read}
      explain={errorText}
      storageKey="rules-access"
      headingLevel={3}
      title="Set a level on many agents"
      backLabel="Back to the list"
      onBack={onBack}
      nowText={(level) => (level === null ? "Not set" : "")}
      words={{
        unit: { one: "agent", many: "agents" },
        set: "How deep they may go",
        start: "Pick agents, then one level.",
        sentence: (n) => `This sets how deep ${n === 1 ? "this agent" : `these ${n.toLocaleString("en")} agents`} may go. Your own rules still decide first.`,
        ask: (n, level) => `This sets ${n.toLocaleString("en")} agents to ${level}.`,
        nothing: (_n, level) => `Nothing to change: already ${level}.`,
      }}
      panel={
        <>
          <Notice tone="neutral">An agent that already has a setting keeps what happens beyond the level, its apps and its tools. Only its level changes. To end a setting, use Remove on the list: that gives the agent back to the default mode.</Notice>
          <Field label="Beyond the level, for an agent with no setting yet" hint={`It gets every app, and the default mode (${modeName}) no longer decides for it.`}>
            <Select value={beyond} options={BEYOND} onValueChange={(v) => setBeyond(v as AccessSetting["beyond"])} />
          </Field>
          {handEdited.length ? <p className="tb-hint">{`Not listed here, because their rules were edited by hand: ${handEdited.map((c) => c.name).join(", ")}. Change them one by one on the list.`}</p> : null}
        </>
      }
    />
  );
}

/** How many a filter shows, and the way back when it hides all. */
function FilterCount({ shown, total, what, onClear }: { shown: number; total: number; what: string; onClear: () => void }) {
  if (shown === total) return null;
  return (
    <p className="tb-hint">
      {`The filter shows ${shown} of ${total} ${what}.`}{" "}
      <Button onClick={onClear}>
        Clear the filter
      </Button>
    </p>
  );
}

export function AccessPage() {
  const dir: Directory = useDirectory();
  const { data, error, loading, reload } = useLoaded(loadRules);
  const [editing, setEditing] = useState<Caller | null>(null);
  const [many, setMany] = useState(false);
  const [query, setQuery] = useAccessFilter("rules-access:list");
  const filter = accessFilter(query);
  const opener = useRef<HTMLSpanElement>(null);
  const backTo = useRef(false);
  useEffect(() => {
    if (many || !backTo.current) return;
    opener.current?.querySelector("button")?.focus();
    backTo.current = false;
  }, [many]);
  const cat: AccessCatalog = useMemo(() => ({ productIds: data?.catalog.productIds ?? [], dynamicOps: data?.catalog.dynamicOps ?? [] }), [data]);
  const byCaller = useMemo(() => accessOf(data?.rules ?? []), [data]);
  const agents: Caller[] = useMemo(() => dir.agents.map((a) => ({ type: "agent", id: a.id, name: a.name })), [dir.agents]);
  const apps: Caller[] = cat.productIds.filter((p) => !NOT_OFFERED_APPS.includes(p)).map((p) => ({ type: "app", product: p, name: p }));
  const done = useCallback(
    (saved: boolean) => {
      setEditing(null);
      if (saved) reload();
    },
    [reload],
  );
  const mode: Mode = data?.mode.mode ?? "permissive";
  const modeName = MODE_TITLE[mode];
  const shownAgents = agents.filter((c) => filter.test(c.name));
  const shownApps = apps.filter((c) => filter.test(c.name));
  const rows = (callers: Caller[]) => (
    <div className="ruled">
      {callers.map((c) => (
        <Row key={callerKey(c)} caller={c} found={byCaller.get(callerKey(c))} cat={cat} modeName={modeName} onEdit={() => setEditing(c)} onChanged={reload} />
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
          <Notice tone="neutral">
            <strong>{`Default mode: ${modeName}.`}</strong> {`An agent or app with no setting here follows this mode. ${MODE_TEXT[mode]}`}
          </Notice>
          {many ? (
            <ManyAgents
              agents={agents}
              byCaller={byCaller}
              cat={cat}
              modeName={modeName}
              reload={reload}
              onBack={() => {
                backTo.current = true;
                setMany(false);
              }}
            />
          ) : (
            <>
              {agents.length + apps.length > 0 ? <AccessFilterField label="Filter these lists" value={query} onChange={setQuery} placeholder="Name, or a regex" filter={filter} /> : null}
              <Card as="section" aria-label="Agents">
                <div className="tb-row">
                  <h3>Agents</h3>
                  {agents.length ? (
                    <span ref={opener}>
                      <Button disabled={!!data.catalog.error} onClick={() => setMany(true)}>
                        Set a level on many
                      </Button>
                    </span>
                  ) : null}
                </div>
                {data.catalog.error && agents.length ? <p className="tb-hint">The app catalog could not be read, so a level cannot be set on many agents now.</p> : null}
                <FilterCount shown={shownAgents.length} total={agents.length} what="agents" onClear={() => setQuery("")} />
                {agents.length ? rows(shownAgents) : <p className="tb-hint">{dir.loading ? "Loading agents." : "No agents yet."}</p>}
              </Card>
              <Card as="section" aria-label="Apps">
                <h3>Apps</h3>
                <p className="tb-hint">Calls that one app makes to another (for example Evolving Workflows or Governance). Rules itself is not listed: it must read Governance.</p>
                <FilterCount shown={shownApps.length} total={apps.length} what="apps" onClear={() => setQuery("")} />
                {apps.length ? rows(shownApps) : <p className="tb-hint">The app catalog is not read yet.</p>}
              </Card>
            </>
          )}
        </>
      )}
      {editing ? <AccessDialog caller={editing} found={byCaller.get(callerKey(editing))} cat={cat} mode={mode} onDone={done} /> : null}
    </section>
  );
}
