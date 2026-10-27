// Q-7 (C373): a rule's revision history and "Restore this version". The list reads rules_get; restoring asks first in its
// own dialog and then calls rule_restore, which writes the old spec as a NEW revision (same checks as Save rule).
import { Button, Dialog, Notice, Tag } from "@opt2-tealbrick/ui";
import { useCallback, useState } from "react";
import { DECISION_LABEL, errorText, matchText, type Out, run, safeText, shortId, when } from "./api.ts";
import { type Directory, LoadError, Loading, useLoaded } from "./shared.tsx";

export type Revision = Out<"rules_get">["revisions"][number];
/** What the owner asked to restore: the rule, the revision to copy, and the revision that is current now. */
export interface RestoreTarget {
  ruleId: string;
  title: string;
  currentRev: number;
  deleted: boolean;
  revision: Revision;
}

const CHANGE: Record<Revision["change"], string> = { created: "created", updated: "edited", deleted: "deleted", restored: "restored" };

/** The revisions of one rule, newest first, each with "Restore this version" (not on the current version of a live rule). */
export function RuleHistory({ ruleId, dir, onRestore }: { ruleId: string; dir: Directory; onRestore: (t: RestoreTarget) => void }) {
  const load = useCallback(() => run("rules_get", { id: ruleId }), [ruleId]);
  const { data, error, loading, reload } = useLoaded(load);
  return (
    <section className="rules-group" aria-label="History">
      <h3>History</h3>
      {error ? <LoadError message={error} retrying={loading} onRetry={reload} /> : null}
      {data === null ? (
        error ? null : <Loading what="history" />
      ) : (
        <ol className="rules-history tb-list">
          {data.revisions.map((r) => {
            const current = r.rev === data.rule.rev;
            return (
              <li key={r.rev}>
                <span className="tb-row">
                  <strong>Revision {r.rev}</strong>
                  <Tag status={r.change === "deleted" ? "idle" : "live"}>{CHANGE[r.change] ?? r.change}</Tag>
                  {r.from ? <span className="tb-hint">from revision {r.from}</span> : null}
                  {current && !data.deleted ? <Tag>current</Tag> : null}
                </span>
                <span className="tb-hint">
                  <span title={r.actor}>{shortId(r.actor)}</span> · {when(r.at)}
                </span>
                <span className="tb-soft">
                  {safeText(r.spec.title)} · {DECISION_LABEL[r.spec.outcome.decision]} · {matchText(r.spec, dir.teamName, dir.agentName)} → {safeText(r.spec.outcome.reason)}
                  {r.spec.active ? "" : " · inactive"}
                </span>
                {current && !data.deleted ? null : (
                  <span>
                    <Button
                      size="sm"
                      aria-label={`Restore revision ${r.rev}`}
                      onClick={() => onRestore({ ruleId, title: safeText(data.rule.spec.title), currentRev: data.rule.rev, deleted: data.deleted, revision: r })}
                    >
                      Restore this version
                    </Button>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** History of a rule outside the editor (a deleted rule has no editor). */
export function HistoryDialog({ rule, dir, onClose, onRestore }: { rule: { id: string; title: string }; dir: Directory; onClose: () => void; onRestore: (t: RestoreTarget) => void }) {
  return (
    <Dialog
      open
      kicker="Rule history"
      title={rule.title}
      onClose={onClose}
      size="lg"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <RuleHistory ruleId={rule.id} dir={dir} onRestore={onRestore} />
    </Dialog>
  );
}

/** Restore asks first; a refused restore (for example a revision that names an operation the app no longer has) stays visible here. */
export function RestoreDialog({ target, onDone }: { target: RestoreTarget; onDone: (restored: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const restore = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await run("rule_restore", { ruleId: target.ruleId, rev: target.revision.rev, expectedRev: target.currentRev });
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
      kicker="Rule"
      title="Restore this version?"
      onClose={() => onDone(false)}
      busy={busy}
      footer={
        <>
          <Button onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void restore()}>
            {busy ? "Restoring" : "Restore"}
          </Button>
        </>
      }
    >
      {error ? (
        <Notice tone="needs-you" role="alert">
          {error}
        </Notice>
      ) : null}
      <p>
        Revision {target.revision.rev} of “{target.title}” becomes the current rule as revision {target.currentRev + 1}. The history stays.
        {target.deleted ? (target.revision.spec.active ? " The rule is deleted now; restoring it makes it apply again at once." : " The rule is deleted now; it comes back inactive.") : ""}
      </p>
      <p className="tb-soft">
        {safeText(target.revision.spec.title)} · {DECISION_LABEL[target.revision.spec.outcome.decision]} → {safeText(target.revision.spec.outcome.reason)}
      </p>
    </Dialog>
  );
}
