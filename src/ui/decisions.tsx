// Decisions page: the log of what Rules decided (newest first), filtered by call id or by decision.
import { Button, EmptyState, Field, Notice, SearchIcon, Select, Swatch, Tag, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type DecisionRow, errorText, run, safeText, shortId, when } from "./api.ts";
import { modeTraceText } from "./mode.tsx";
import { DecisionTag, Head, LoadError, Loading, useAgentNames } from "./shared.tsx";

type DecisionFilter = "" | "allow" | "deny" | "hold";
const SHOW = [
  { value: "", label: "all decisions" },
  { value: "deny", label: "refused" },
  { value: "hold", label: "held" },
  { value: "allow", label: "allowed" },
];

export function DecisionsPage() {
  const agentName = useAgentNames();
  const [items, setItems] = useState<DecisionRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<{ callId: string; decision: DecisionFilter }>({ callId: "", decision: "" });
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const query = useMemo(() => ({ ...(filter.callId ? { callId: filter.callId } : {}), ...(filter.decision ? { decision: filter.decision } : {}), limit: 50 }), [filter]);
  const load = useCallback(
    (more?: string | null) => {
      const mine = ++seq.current;
      setLoading(true);
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
  return (
    <section className="app-page" aria-label="Decisions">
      <Head title="Decisions" lede="Reads that match no rule are not listed." />
      <div className="toolbar">
        <div className="tb-search rules-search">
          <SearchIcon />
          <TextInput placeholder="call id" aria-label="call id" value={filter.callId} onChange={(e) => setFilter({ ...filter, callId: e.target.value.trim() })} />
        </div>
        <div className="rules-show">
          <Field label="Show">
            <Select value={filter.decision} options={SHOW} onValueChange={(v) => setFilter({ ...filter, decision: v as DecisionFilter })} />
          </Field>
        </div>
      </div>
      {error ? <LoadError message={error} retrying={loading} onRetry={() => load()} /> : null}
      {items === null ? (
        error ? null : <Loading what="decisions" />
      ) : items.length === 0 ? (
        <EmptyState title="No decisions recorded yet">Rules records every call that is not a read, and every call a rule decided.</EmptyState>
      ) : (
        <div className="ruled">
          {items.map((d) => (
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
