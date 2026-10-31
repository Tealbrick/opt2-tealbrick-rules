// Small pieces the Rules pages share: load state with the error kept (RUL-14), the agent and team directory a rule
// names its callers from, the decision pill and the multi-choice chips.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { accessFilter, Button, Chip, ChipGroup, type FilterNoun, ListFilter, Notice, Tag, useAccessFilter } from "@opt2-tealbrick/ui";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { DECISION_LABEL, DECISION_STATUS, errorText, type Role, run, type Team } from "./api.ts";
import { FILTER_FROM, filterKey } from "./list-filter.ts";
import type { Agent } from "./standard.tsx";

/** Load state that keeps the error: a failed load is shown as an error with Try again, never as an empty list. */
export function useLoaded<T>(load: () => Promise<T>): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true);
    load()
      .then((v) => {
        if (mine !== seq.current) return;
        setData(v);
        setError(null);
      })
      .catch((e) => {
        if (mine === seq.current) setError(errorText(e));
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }, [load]);
  useEffect(reload, [reload]);
  return { data, error, loading, reload };
}

/** A failed load: what happened and a Try again button. */
export function LoadError({ message, retrying, onRetry }: { message: string; retrying: boolean; onRetry: () => void }) {
  return (
    <Notice tone="needs-you" role="alert">
      <span className="tb-row">
        <span>{message}</span>
        <Button size="sm" onClick={onRetry} disabled={retrying}>
          Try again
        </Button>
      </span>
    </Notice>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p className="tb-soft" role="status">
      Loading {what}.
    </p>
  );
}

export function Head({ title, lede, action }: { title: string; lede?: ReactNode; action?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="tb-stack rules-head">
        <h1>{title}</h1>
        {lede ? <p className="tb-lede">{lede}</p> : null}
      </div>
      {action}
    </div>
  );
}

/** Pill for a decision. `label` swaps the plain word for the rule-list wording (Allow, Refuse, Hold for my review). */
export function DecisionTag({ decision, rule }: { decision: keyof typeof DECISION_STATUS; rule?: boolean }) {
  return <Tag status={DECISION_STATUS[decision]}>{rule && decision in DECISION_LABEL ? DECISION_LABEL[decision as keyof typeof DECISION_LABEL] : decision}</Tag>;
}

// ── the directory a rule names things from ──────────────────────────────────

export interface Directory {
  agents: readonly Agent[];
  teams: readonly Team[];
  /** the flat roles of Governance (C380 T2-a) */
  roles: readonly Role[];
  agentName: (id: string) => string;
  teamName: (id: string) => string;
  roleName: (id: string) => string;
  /** plain messages of what could not be loaded (RUL-14); names fall back to ids meanwhile */
  errors: readonly string[];
  /** false = Rules cannot rely on its Governance copy (C236); null = not known (still loading, or fleet_status failed) */
  fleetAvailable: boolean | null;
  loading: boolean;
  reload: () => void;
}

/** What the owner reads for a role id that Governance does not list (archived, or gone). */
export const UNLISTED_ROLE = "a role that is archived or gone";

/** The exact wording the Lead asked for (C236). */
export const FLEET_UNAVAILABLE_TEXT = "Governance data unavailable — team rules apply strictly";

/** Agents (`tb.agents_list`) and Fleet teams (`fleet_status`), each with its own load error kept. */
export function useDirectory(): Directory {
  const [agents, setAgents] = useState<readonly Agent[]>([]);
  const [teams, setTeams] = useState<readonly Team[]>([]);
  const [roles, setRoles] = useState<readonly Role[]>([]);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [fleetAvailable, setFleetAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true);
    Promise.allSettled([callOp<{ agents: Agent[] }>("tb.agents_list", {}), run("fleet_status", {})]).then(([a, t]) => {
      if (mine !== seq.current) return;
      const errs: string[] = [];
      if (a.status === "fulfilled") setAgents(a.value.agents);
      else errs.push(`Couldn’t load your agents, so their names show as ids. ${errorText(a.reason)}`);
      if (t.status === "fulfilled") {
        setTeams(t.value.teams);
        setRoles(t.value.roles ?? []);
        setFleetAvailable(t.value.available);
      } else {
        setFleetAvailable(null);
      }
      if (t.status !== "fulfilled") errs.push(`Couldn’t load your Governance teams, so their names show as ids. ${errorText(t.reason)}`);
      setErrors(errs);
      setLoading(false);
    });
  }, []);
  useEffect(reload, [reload]);
  const agentName = useCallback((id: string) => agents.find((a) => a.id === id)?.name ?? id, [agents]);
  const teamName = useCallback((id: string) => teams.find((t) => t.id === id)?.name ?? id, [teams]);
  // A role the list does not have is archived or gone (Governance leaves an archived role out): say that, never its id. While the list loads, or when it could not be read, say only "a role".
  const roleName = useCallback((id: string) => roles.find((r) => r.id === id)?.name ?? (loading || fleetAvailable === null ? "a role" : UNLISTED_ROLE), [roles, loading, fleetAvailable]);
  return { agents, teams, roles, agentName, teamName, roleName, errors, fleetAvailable, loading, reload };
}

/** Why the directory is incomplete, with Try again. */
export function DirectoryErrors({ dir }: { dir: Directory }) {
  return (
    <>
      {dir.fleetAvailable === false ? <Notice tone="needs-you">{FLEET_UNAVAILABLE_TEXT}</Notice> : null}
      {dir.errors.length === 0 ? null : <LoadError message={dir.errors.join(" ")} retrying={dir.loading} onRetry={dir.reload} />}
    </>
  );
}

/** The agents of this workspace (one `tb.agents_list` read); empty while it loads or when it could not be read (quietly: the page never waits for it). */
export function useAgents(): readonly Agent[] {
  const [agents, setAgents] = useState<readonly Agent[]>([]);
  useEffect(() => {
    let live = true;
    callOp<{ agents: Agent[] }>("tb.agents_list", {})
      .then((r) => {
        if (live) setAgents(r.agents);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return agents;
}

/**
 * Agent names for rows that store an agent id: one `tb.agents_list` read. If it fails, the ids stay as they are
 * (quietly; the page never waits for it or blocks on it).
 */
export function useAgentNames(): (id: string) => string {
  const agents = useAgents();
  return useCallback((id: string) => agents.find((a) => a.id === id)?.name ?? id, [agents]);
}

// ── multi-choice chips ──────────────────────────────────────────────────────

export type ChipFilter = {
  /** the screen part of the storage key (`tb-filter:<app>:<screen>`): one per list of chips */
  screen: string;
  /** the label of the filter field, such as "Filter the agents" */
  label: string;
  /** what the chips are, such as { one: "agent", many: "agents" } */
  noun: FilterNoun;
};

/**
 * Several-of-many choice drawn as toggle chips (a pill chooses a state). Nothing pressed = any. With `filter` a long list
 * of chips gets a text filter and "Select all shown": the filter only hides chips, it never unpresses one, and a pressed
 * chip it hides is counted ("3 selected, 2 hidden by the filter").
 */
export function ChipChoice<T extends string>(props: {
  label: string;
  hint?: string;
  options: readonly { value: T; label: string }[];
  value: readonly T[] | undefined;
  onChange: (v: T[] | undefined) => void;
  filter?: ChipFilter;
}) {
  return props.filter ? <FilteredChips {...props} filter={props.filter} /> : <ChipRow {...props} shown={props.options} />;
}

type RowProps<T extends string> = { label: string; hint?: string; options: readonly { value: T; label: string }[]; value: readonly T[] | undefined; onChange: (v: T[] | undefined) => void };

function ChipRow<T extends string>({ label, hint = "none = any", options, shown, value, onChange, top }: RowProps<T> & { shown: readonly { value: T; label: string }[]; top?: ReactNode }) {
  const set = new Set(value ?? []);
  return (
    <div className="tb-field">
      <span className="tb-label">{label}</span>
      {top}
      <ChipGroup label={label}>
        {shown.map((o) => (
          <Chip
            key={o.value}
            pressed={set.has(o.value)}
            onClick={() => {
              const next = new Set(set);
              if (!next.delete(o.value)) next.add(o.value);
              onChange(next.size ? [...next] : undefined);
            }}
          >
            {o.label}
          </Chip>
        ))}
      </ChipGroup>
      <span className="tb-hint">{options.length === 0 ? "Nothing to choose from yet." : hint}</span>
    </div>
  );
}

function FilteredChips<T extends string>({ filter, ...row }: RowProps<T> & { filter: ChipFilter }) {
  const { options, value, onChange } = row;
  const [query, setQuery] = useAccessFilter(filterKey(filter.screen));
  const [said, setSaid] = useState("");
  const text = accessFilter(query);
  const on = query.trim() !== "";
  const shown = options.filter((o) => text.test(o.label));
  const set = new Set(value ?? []);
  const hiddenValues = new Set(options.filter((o) => !shown.includes(o)).map((o) => o.value));
  const hiddenSelected = [...set].filter((v) => hiddenValues.has(v)).length;
  const left = shown.filter((o) => !set.has(o.value));
  const pressed = shown.length - left.length;
  const many = (n: number) => `${n.toLocaleString("en")} ${n === 1 ? filter.noun.one : filter.noun.many}`;
  const change = (next: Set<T>, what: string) => {
    setSaid(what);
    onChange(next.size ? [...next] : undefined);
  };
  const top =
    options.length >= FILTER_FROM || on ? (
      <>
        <ListFilter
          label={filter.label}
          value={query}
          onChange={(v) => {
            setSaid("");
            setQuery(v);
          }}
          filter={text}
          placeholder="Name, or a regex"
          noun={filter.noun}
          shown={shown.length}
          total={options.length}
          onClear={() => {
            setSaid("");
            setQuery("");
          }}
        />
        <div className="tb-row">
          <Button
            disabled={left.length === 0}
            onClick={() => change(new Set([...set, ...left.map((o) => o.value)]), `Selected ${left.length.toLocaleString("en")} more ${left.length === 1 ? filter.noun.one : filter.noun.many}.`)}
          >
            Select all shown
          </Button>
          <Button
            disabled={pressed === 0}
            onClick={() => {
              const next = new Set(set);
              for (const o of shown) next.delete(o.value);
              change(next, `Unselected ${many(pressed)}.${hiddenSelected === 0 ? "" : " The ones the filter hides stay selected."}`);
            }}
          >
            Unselect all shown
          </Button>
        </div>
        <p className="tb-hint" role="status" aria-live="polite">
          {`${set.size.toLocaleString("en")} selected${hiddenSelected > 0 ? `, ${hiddenSelected.toLocaleString("en")} hidden by the filter` : ""}.`}
          {said ? ` ${said}` : ""}
        </p>
      </>
    ) : undefined;
  return <ChipRow {...row} shown={shown} top={top} />;
}

