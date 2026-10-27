// Drafts page: rules an agent wrote from English. Nothing applies until the owner approves. A draft with a rule that can
// never match is badged and cannot be approved (0.2.7). Approve and Reject show their errors (RUL-01), one call at a
// time per draft. A pending draft shows the priority each rule gets when approved now (review 0.5.0 S3-3, src/placement.ts).
import { Button, Card, EmptyState, Notice, Tag } from "@opt2-tealbrick/ui";
import { useCallback, useRef, useState } from "react";
import { type DraftRow, day, errorText, matchText, narrowingText, run, safeText, shortId } from "./api.ts";
import { DecisionTag, DirectoryErrors, Head, LoadError, Loading, useDirectory, useLoaded } from "./shared.tsx";

const DRAFT_STATUS = { pending: "busy", approved: "live", rejected: "default" } as const;

export function DraftsPage({ onChange }: { onChange: () => void }) {
  const dir = useDirectory();
  const load = useCallback(async () => (await run("drafts_list", {})).drafts, []);
  const { data: drafts, error, loading, reload } = useLoaded(load);
  const inflight = useRef(new Set<string>());
  const [busy, setBusy] = useState<readonly string[]>([]);
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});
  const decide = async (d: DraftRow, decision: "approve" | "reject") => {
    if (inflight.current.has(d.id)) return;
    inflight.current.add(d.id);
    setBusy([...inflight.current]);
    setFailures(({ [d.id]: _gone, ...rest }) => rest);
    try {
      await run("draft_decide", { id: d.id, decision });
      reload();
      onChange();
    } catch (e) {
      setFailures((f) => ({ ...f, [d.id]: errorText(e) }));
    } finally {
      inflight.current.delete(d.id);
      setBusy([...inflight.current]);
    }
  };
  return (
    <section className="app-page" aria-label="Drafts">
      <Head title="Drafts" lede="Ask your agent to write a rule in plain English. It sends its structured version here; nothing applies until you approve it." />
      {error ? <LoadError message={error} retrying={loading} onRetry={reload} /> : null}
      <DirectoryErrors dir={dir} />
      {drafts === null ? (
        error ? null : <Loading what="drafts" />
      ) : drafts.length === 0 ? (
        <EmptyState title="No drafts">When an agent writes a rule for you, it shows up here.</EmptyState>
      ) : (
        drafts.map((d) => {
          const stuck = (d.problems?.some(Boolean) ?? false) || !!d.placeProblem;
          const working = busy.includes(d.id);
          return (
            <Card as="article" className={d.status === "pending" ? "draft" : "draft is-decided"} key={d.id} aria-label={`Draft from ${safeText(d.submittedBy.name)}`}>
              <div className="tb-row">
                <Tag status={DRAFT_STATUS[d.status]}>{d.status}</Tag>
                <span className="tb-hint">
                  {d.source.kind === "owner" ? "written by you in Rules" : d.source.kind === "app" ? (d.source.product ? `proposed by the app ${d.source.product} (called itself “${safeText(d.source.name ?? d.submittedBy.name)}”)` : `proposed by an app named ${safeText(d.source.name ?? d.submittedBy.name)} (unverified)`) : `from ${safeText(d.submittedBy.name)}`} · {day(d.submittedAt)}
                </span>
              </div>
              <blockquote className="blockq">“{safeText(d.text, true)}”</blockquote>
              {d.note ? <p className="tb-hint">{d.source.kind === "owner" ? "Note" : "Agent note"}: {safeText(d.note, true)}</p> : null}
              {d.status === "pending" ? (
                <ol className="steps-list">
                  {d.rules.map((r, i) => (
                    <li key={JSON.stringify(r)}>
                      <b>
                        {safeText(r.title)} <DecisionTag decision={r.outcome.decision} rule /> <span className="tb-hint">priority {d.places?.[i]?.priority ?? r.priority}</span>
                        {d.problems?.[i] ? <Tag status="needs-you">never matches</Tag> : null}
                      </b>
                      <span>
                        {matchText(r, dir.teamName, dir.agentName, d.opTitles ?? {})} → {safeText(r.outcome.reason)}
                        {narrowingText(r.narrowing)}
                      </span>
                      {d.problems?.[i] ? <span>Never matches: {safeText(d.problems[i] ?? "")}</span> : null}
                      {d.places?.[i]?.why ? <span className="tb-hint">{safeText(d.places[i].why)}</span> : null}
                    </li>
                  ))}
                </ol>
              ) : null}
              {d.status === "pending" && d.placeProblem ? <Notice tone="needs-you">{d.placeProblem}</Notice> : null}
              {d.status === "pending" && d.problems?.some(Boolean) ? (
                <Notice tone="needs-you">This draft can’t be applied: a rule in it would never match, so it would protect nothing. Reject it and ask the agent for a corrected draft.</Notice>
              ) : null}
              {failures[d.id] ? (
                <Notice tone="needs-you" role="alert">
                  {failures[d.id]}
                </Notice>
              ) : null}
              {d.status === "pending" ? (
                <div className="tb-ctas">
                  <Button variant="primary" disabled={stuck || working} onClick={() => void decide(d, "approve")}>
                    Approve and apply
                  </Button>
                  <Button variant="danger" disabled={working} onClick={() => void decide(d, "reject")}>
                    Reject
                  </Button>
                </div>
              ) : (
                <p className="tb-hint">
                  {d.status} {day(d.decidedAt)}
                  {d.ruleIds.length ? (
                    <>
                      {" · rules "}
                      {d.ruleIds.map((id, i) => (
                        <span key={id} title={id}>
                          {i ? ", " : ""}
                          {shortId(id)}
                        </span>
                      ))}
                    </>
                  ) : null}
                </p>
              )}
            </Card>
          );
        })
      )}
    </section>
  );
}
