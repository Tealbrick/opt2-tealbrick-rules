// Small pieces the Rules pages share: load state with the error kept (RUL-14), the agent and team directory a rule
// names its callers from, the decision pill and the multi-choice chips.
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Chip, ChipGroup, Notice, Tag } from "@opt2-tealbrick/ui";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { DECISION_LABEL, DECISION_STATUS, errorText, type Role, run, type Team } from "./api.ts";
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

/**
 * Agent names for rows that store an agent id: one `tb.agents_list` read. If it fails, the ids stay as they are
 * (quietly; the page never waits for it or blocks on it).
 */
export function useAgentNames(): (id: string) => string {
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
  return useCallback((id: string) => agents.find((a) => a.id === id)?.name ?? id, [agents]);
}

// ── multi-choice chips ──────────────────────────────────────────────────────

/** Several-of-many choice drawn as toggle chips (a pill chooses a state). Nothing pressed = any. */
export function ChipChoice<T extends string>({
  label,
  hint = "none = any",
  options,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  options: readonly { value: T; label: string }[];
  value: readonly T[] | undefined;
  onChange: (v: T[] | undefined) => void;
}) {
  const set = new Set(value ?? []);
  return (
    <div className="tb-field">
      <span className="tb-label">{label}</span>
      <ChipGroup label={label}>
        {options.map((o) => (
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
