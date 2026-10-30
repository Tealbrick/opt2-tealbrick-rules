// The company floor on the Rules page (C380): who is stopped before any rule runs, why, and the owner's way out. The list comes from Governance and stays
// when Governance cannot be read, so this card is also the only place to lift an entry when Governance is gone or cannot be trusted.
import { Button, Card, Dialog, Notice, Swatch, Tag } from "@opt2-tealbrick/ui";
import { useCallback, useMemo, useState } from "react";
import { errorText, type Out, run, safeText, when } from "./api.ts";
import { LoadError, Loading, useLoaded } from "./shared.tsx";

type FloorOut = Out<"floor_list">;
type Row = FloorOut["entries"][number];

const WHY: Record<string, string> = { blocked: "Blocked", suspended: "Stopped for now", leaving: "Leaving", archived: "Closed", not_started: "Not started yet", departed: "Left" };
export const floorWhy = (code: string): string => WHY[code] ?? "Stopped";

export interface FloorHolder {
  holder: string;
  isAgent: boolean;
  code: string;
  at: string;
  handles: string[];
}

/** One line per agent or person: the entries of one holder, with its handles. Entries come newest first, so the list keeps that order. */
export function floorHolders(rows: readonly Row[]): FloorHolder[] {
  const out = new Map<string, FloorHolder>();
  for (const r of rows) {
    const h = out.get(r.holder) ?? { holder: r.holder, isAgent: r.holder.startsWith("agent:"), code: r.code, at: r.at, handles: [] };
    if (r.kind === "handle") h.handles.push(r.id);
    else {
      // the holder's own row names it; a handle row can be newer
      h.code = r.code;
      h.at = r.at;
    }
    out.set(r.holder, h);
  }
  return [...out.values()];
}

function ConfirmClear({ what, holder, total, onDone }: { what: string; holder: string | null; total: number; onDone: (changed: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const clear = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await run("floor_clear", holder ? { confirm: true, holder } : { confirm: true });
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
      kicker="Company floor"
      title={`Clear ${what}?`}
      onClose={() => onDone(false)}
      busy={busy}
      footer={
        <>
          <Button onClick={() => onDone(false)} disabled={busy}>
            Keep stopped
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void clear()}>
            {busy ? "Clearing" : "Clear"}
          </Button>
        </>
      }
    >
      {error ? (
        <Notice tone="needs-you" role="alert">
          {error}
        </Notice>
      ) : null}
      <p>Rules stops refusing {what} at once. Your rules and the default mode decide their calls again.</p>
      {holder ? null : <p>This clears every entry on the company floor, also any that arrived after this page loaded. It held {total === 1 ? "1 entry" : `${total} entries`} when this page loaded.</p>}
      <p>If Governance still lists this, it comes back at the next read. To keep it cleared, change it in Governance, or pause or remove Governance if you no longer trust it.</p>
    </Dialog>
  );
}

export function FloorCard({ agentName }: { agentName: (id: string) => string }) {
  const load = useCallback(() => run("floor_list", {}), []);
  const { data, error, loading, reload } = useLoaded(load);
  const [asking, setAsking] = useState<{ what: string; holder: string | null } | null>(null);
  const holders = useMemo(() => floorHolders(data?.entries ?? []), [data]);
  // the directory does not know a departed agent, and it is still loading at first: agentName then answers the raw id
  const nameOf = (h: FloorHolder) => {
    if (!h.isAgent) return "A person in Governance";
    const id = h.holder.slice("agent:".length);
    const name = agentName(id);
    return name === id ? "An agent in Governance" : safeText(name);
  };
  const cut = data ? data.total > data.entries.length : false;
  return (
    <Card as="section" className="rules-floor" aria-label="Company floor">
      <h3>Company floor</h3>
      <p className="tb-hint">Calls by, for or to these are refused before any rule runs, in every mode. The list comes from Governance. Rules keeps it when Governance cannot be read.</p>
      {error ? <LoadError message={error} retrying={loading} onRetry={reload} /> : null}
      {!data && !error ? <Loading what="the company floor" /> : null}
      {data && !data.governanceReadable && data.total > 0 ? (
        <Notice tone="needs-you" role="status">
          Governance cannot be read now. This list stays as it was {data.readAt ? `on ${when(data.readAt)}` : "at the last read"}.
        </Notice>
      ) : null}
      {data && data.total === 0 ? <p className="tb-soft">Nobody is stopped. {data.readAt ? `Last read from Governance ${when(data.readAt)}.` : "Rules has not read this from Governance yet."}</p> : null}
      {holders.length > 0 ? (
        <div className="ruled">
          {holders.map((h) => (
            <div className="item" key={h.holder}>
              <Swatch className="is-needs-you" />
              <h3>{nameOf(h)}</h3>
              <span className="meta">
                <Tag status="needs-you">{floorWhy(h.code)}</Tag> since {when(h.at)}
                {h.handles.length > 0 ? ` · ${h.handles.length === 1 ? "1 channel handle" : `${h.handles.length} channel handles`}` : ""}
              </span>
              <details className="floor-details tb-hint">
                <summary>Details</summary>
                {safeText(h.holder)}
                {h.handles.length > 0 ? ` · ${safeText(h.handles.join(", "))}` : ""}
              </details>
              <div className="side">
                <Button size="sm" onClick={() => setAsking({ what: nameOf(h), holder: h.holder })}>
                  Clear
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {cut && data ? <p className="tb-hint">Showing the newest {data.entries.length} of {data.total} entries.</p> : null}
      {data && (holders.length > 1 || cut) ? (
        <div className="tb-ctas">
          <Button size="sm" onClick={() => setAsking({ what: "everyone on the company floor", holder: null })}>
            Clear all
          </Button>
        </div>
      ) : null}
      {asking ? (
        <ConfirmClear
          what={asking.what}
          holder={asking.holder}
          total={data?.total ?? 0}
          onDone={(changed) => {
            setAsking(null);
            if (changed) reload();
          }}
        />
      ) : null}
    </Card>
  );
}
