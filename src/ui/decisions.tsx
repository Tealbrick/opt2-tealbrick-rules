// Decisions page: the log of what Rules decided (newest first), filtered by call id or by decision.
import { accessFilter, Button, EmptyState, Field, ListFilter, Notice, SearchIcon, Select, type SelectOption, Swatch, Tag, TextInput, useAccessFilter } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type DecisionRow, errorText, run, safeText, shortId, when } from "./api.ts";
import { FILTER_FROM, filterKey } from "./list-filter.ts";
import { modeTraceText } from "./mode.tsx";
import { DecisionTag, Head, LoadError, Loading, useAgents } from "./shared.tsx";

type DecisionFilter = "" | "allow" | "deny" | "hold";
const ALL_AGENTS = "__all";
const SHOW = [
  { value: "", label: "all decisions" },
  { value: "deny", label: "refused" },
  { value: "hold", label: "held" },
  { value: "allow", label: "allowed" },
];

export function DecisionsPage() {
  const agents = useAgents();
  const agentName = useCallback((id: string) => agents.find((a) => a.id === id)?.name ?? id, [agents]);
  const [items, setItems] = useState<DecisionRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<{ callId: string; decision: DecisionFilter; caller: string }>({ callId: "", decision: "", caller: "" });
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false);
  const seq = useRef(0);
  const query = useMemo(() => ({ ...(filter.callId ? { callId: filter.callId } : {}), ...(filter.decision ? { decision: filter.decision } : {}), ...(filter.caller ? { caller: filter.caller } : {}), limit: 50 }), [filter]);
  const load = useCallback(
    (more?: string | null) => {
      const mine = ++seq.current;
      setLoading(true);
      setPaging(Boolean(more));
      if (more) setMoreError(null);
      else setError(null);
      run("decisions_list", { ...query, ...(more ? { cursor: more } : {}) })
        .then((r) => {
          if (mine !== seq.current) return;
          setItems((prev) => (more ? [...(prev ?? []), ...r.items] : r.items));
          setCursor(r.nextCursor);
        })
        .catch((e) => {
          if (mine !== seq.current) return;
          if (more) setMoreError(errorText(e));
          else setError(errorText(e));
        })
        .finally(() => {
          if (mine === seq.current) setLoading(false);
        });
    },
    [query],
  );
  useEffect(() => load(), [load]);
  // C382 batch 4: a text filter over the decisions loaded. The agent, the decision and the call id are the server's (they cover every decision); the text is not, so a paged log says it reads only the loaded rows.
  const [text, setText] = useAccessFilter(filterKey("decisions"));
  const textFilter = accessFilter(text);
  const all = items ?? [];
  const rows = all.filter((d) =>
    textFilter.test(
      [
        d.caller.type === "agent" ? agentName(d.caller.id) : (d.caller.product ?? d.caller.id),
        d.answered,
        d.target.product,
        d.target.op,
        d.target.tool,
        d.target.effect,
        d.reason,
        d.ruleTitle,
        d.callId,
      ]
        .filter(Boolean)
        .join(" "),
    ),
  );
  const serverOn = filter.callId !== "" || filter.decision !== "" || filter.caller !== "";
  const filterOn = serverOn || text.trim() !== "";
  const showBar = items !== null && (all.length >= FILTER_FROM || cursor !== null || filterOn);
  const agentChoices: SelectOption[] = [
    { value: ALL_AGENTS, label: "All agents" },
    ...agents.map((a) => ({ value: a.id, label: a.name })).sort((a, b) => a.label.localeCompare(b.label)),
    // a remembered or chosen agent that is not listed stays selectable, so the filter never hides
    ...(filter.caller !== "" && !agents.some((a) => a.id === filter.caller) ? [{ value: filter.caller, label: "An agent that is no longer listed" }] : []),
  ];
  return (
    <section className="app-page" aria-label="Decisions">
      <Head title="Decisions" lede="Reads that match no rule are not listed." />
      <div className="toolbar">
        <div className="tb-search rules-search">
          <SearchIcon />
          <TextInput placeholder="call id" aria-label="call id" value={filter.callId} onChange={(e) => setFilter({ ...filter, callId: e.target.value.trim() })} />
        </div>
        <div className="rules-show">
          <Field label="Agent">
            <Select aria-label="Agent" value={filter.caller === "" ? ALL_AGENTS : filter.caller} options={agentChoices} onValueChange={(v) => setFilter({ ...filter, caller: v === ALL_AGENTS ? "" : v })} />
          </Field>
        </div>
        <div className="rules-show">
          <Field label="Show">
            <Select value={filter.decision} options={SHOW} onValueChange={(v) => setFilter({ ...filter, decision: v as DecisionFilter })} />
          </Field>
        </div>
      </div>
      {showBar ? (
        <ListFilter
          label="Filter the decisions"
          value={text}
          onChange={setText}
          filter={textFilter}
          placeholder="Agent, app, operation, reason, or a regex"
          noun={{ one: "decision", many: "decisions" }}
          shown={rows.length}
          total={all.length}
          facets={serverOn}
          more={cursor !== null}
          busy={loading && !paging}
          onLoadMore={() => load(cursor)}
          loadMoreLabel="Load more"
          loadingMore={loading}
          onClear={() => {
            setText("");
            setFilter({ callId: "", decision: "", caller: "" });
          }}
        />
      ) : null}
      {error ? <LoadError message={error} retrying={loading} onRetry={() => load()} /> : null}
      {items === null ? (
        error ? null : <Loading what="decisions" />
      ) : items.length === 0 ? (
        filterOn ? null : <EmptyState title="No decisions recorded yet">Rules records every call that is not a read, and every call a rule decided.</EmptyState>
      ) : (
        <div className="ruled">
          {rows.map((d) => (
            <div className="item" key={d.id}>
              <Swatch className={d.answered === "deny" ? "is-needs-you" : undefined} />
              <h3>
                <DecisionTag decision={d.answered} /> {d.target.product}.{d.target.op}
                {d.target.tool ? ` (${d.target.tool})` : ""} <Tag>{d.target.effect}</Tag>
              </h3>
              <p>
                {safeText(d.reason)}
                {d.ruleTitle ? ` · rule “${safeText(d.ruleTitle)}” rev ${d.ruleRev}` : ""}
                {modeTraceText(d.detail)}
                {d.onBehalfOf ? ` · on behalf of ${safeText(JSON.stringify(d.onBehalfOf))}` : ""}
                {d.detail?.callerProductUnavailable === true ? " · the calling app’s product could not be verified, so this rule applied strictly" : ""}
                {d.callId ? (
                  <>
                    {" · call "}
                    <span title={d.callId}>{shortId(d.callId)}</span>
                  </>
                ) : null}
              </p>
              <span className="meta">
                {d.caller.type} {d.caller.type === "agent" ? agentName(d.caller.id) : (d.caller.product ? `${d.caller.product} (instance ${shortId(d.caller.id)})` : d.caller.id)}
                {d.caller.mode ? ` (${d.caller.mode})` : ""} · {when(d.at)} · {d.phase} · {Math.round(d.durationUs / 100) / 10} ms
              </span>
            </div>
          ))}
        </div>
      )}
      {moreError ? (
        <Notice tone="needs-you" role="alert">
          {moreError}
        </Notice>
      ) : null}
      {cursor ? (
        <div className="tb-ctas">
          <Button onClick={() => load(cursor)} disabled={loading}>
            Load more
          </Button>
        </div>
      ) : null}
    </section>
  );
}
