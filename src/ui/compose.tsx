// The owner's English rule box on the Rules page (C373, journey J3). The owner types a rule in plain English, Rules shows the
// structured rules it read (`rule_compose`, a proposal only), the owner can edit or remove each one, and "Save for approval"
// stores them as a draft (`rule_compose_save`). Nothing applies until the owner approves the draft on the Drafts page (C84).
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Card, Field, Notice, Textarea } from "@opt2-tealbrick/ui";
import { type ReactNode, useRef, useState } from "react";
import { errorText, matchText, narrowingText, type Out, type RuleSpec, run } from "./api.ts";
import { DecisionTag, type Directory } from "./shared.tsx";

type Proposal = Out<"rule_compose">;

/** A fresh idempotency key for one save (the same key on a retry of the same proposal, so a retry never makes two drafts). */
const newKey = () => `compose-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

export function Composer({
  dir,
  editor,
  onSaved,
  onOpenDrafts,
}: {
  dir: Directory;
  /** the structured editor for one proposed rule: `done(next)` with the edited rule, or `done(null)` to keep it as it was */
  editor: (spec: RuleSpec, done: (next: RuleSpec | null) => void) => ReactNode;
  onSaved?: () => void;
  onOpenDrafts?: () => void;
}) {
  const [text, setText] = useState("");
  const [shown, setShown] = useState<{ text: string; proposal: Proposal } | null>(null);
  const [rules, setRules] = useState<RuleSpec[]>([]);
  /** rules the owner changed in the editor: their line comes from the rule itself, not from the proposal */
  const [changed, setChanged] = useState<ReadonlySet<number>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const [busy, setBusy] = useState<"show" | "save" | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const key = useRef(newKey());

  const show = async () => {
    if (busy || !text.trim()) return;
    setBusy("show");
    setError("");
    setSaved(false);
    try {
      // the agent names this page read (tb.agents_list), so names resolve also right after a restart
      const proposal = await run("rule_compose", { text: text.trim(), ...(dir.agents.length ? { agents: dir.agents.slice(0, 500).map((a) => ({ id: a.id, name: (a.name || a.id).slice(0, 120) })) } : {}) });
      setShown({ text: text.trim(), proposal });
      setRules(proposal.rules);
      setChanged(new Set());
      key.current = newKey();
    } catch (e) {
      setShown(null);
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (busy || !shown || rules.length === 0) return;
    setBusy("save");
    setError("");
    try {
      await callOp("rule_compose_save", { text: shown.text, rules } as never, { idempotencyKey: key.current });
      setSaved(true);
      setShown(null);
      setRules([]);
      setText("");
      onSaved?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = (i: number) => {
    setRules(rules.filter((_, j) => j !== i));
    setChanged(new Set([...changed].filter((j) => j !== i).map((j) => (j > i ? j - 1 : j))));
    key.current = newKey();
  };

  const p = shown?.proposal;
  return (
    <Card as="section" className="rules-compose" aria-label="Write a rule in plain English">
      <h2>Write a rule in plain English</h2>
      <Field label="Your rule" hint="For example: Hold Hermes’s outward actions. Or: When someone from team Sales tags the CEO agent, only work-tagged memories, no money.">
        <Textarea rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <div className="tb-ctas">
        <Button onClick={() => void show()} disabled={busy !== null || !text.trim()}>
          {busy === "show" ? "Reading" : "Show rules"}
        </Button>
      </div>
      {error ? (
        <Notice tone="needs-you" role="alert">
          {error}
        </Notice>
      ) : null}
      {saved ? (
        <Notice tone="live" role="status">
          <span className="tb-row">
            <span>Saved. Approve it on Drafts.</span>
            {onOpenDrafts ? (
              <Button size="sm" onClick={onOpenDrafts}>
                Open Drafts
              </Button>
            ) : null}
          </span>
        </Notice>
      ) : null}
      {p ? (
        <div className="tb-stack" role="status">
          {rules.length ? (
            <>
              <p className="tb-soft">Rules read from your words. Nothing applies until you approve them.</p>
              <ol className="steps-list" aria-label="Proposed rules">
                {rules.map((r, i) => (
                  <li key={JSON.stringify(r)}>
                    <b>
                      {r.title} <DecisionTag decision={r.outcome.decision} rule /> <span className="tb-hint">priority {r.priority}</span>
                    </b>
                    <span>{changed.has(i) || !p.lines[i] ? `${matchText(r, dir.teamName, dir.agentName)}${narrowingText(r.narrowing)}` : p.lines[i]}</span>
                    <span className="tb-hint">Reason: {r.outcome.reason}</span>
                    <span className="tb-row">
                      <Button size="sm" aria-label={`Edit ${r.title}`} onClick={() => setEditing(i)} disabled={busy !== null}>
                        Edit
                      </Button>
                      <Button size="sm" aria-label={`Remove ${r.title}`} onClick={() => remove(i)} disabled={busy !== null}>
                        Remove
                      </Button>
                    </span>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p className="tb-soft">Rules found no rule it can save in your words.</p>
          )}
          {p.unmatched.length ? (
            <Notice tone="needs-you">
              <span className="tb-stack">
                <strong>Not read:</strong>
                {p.unmatched.map((u) => (
                  <span key={`${u.text}-${u.hint}`}>
                    “{u.text}”: {u.hint}
                  </span>
                ))}
              </span>
            </Notice>
          ) : null}
          {p.notes.length ? (
            <ul className="rules-trace tb-list" aria-label="Notes">
              {p.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
          <div className="tb-ctas">
            <Button variant="primary" onClick={() => void save()} disabled={busy !== null || rules.length === 0}>
              {busy === "save" ? "Saving" : "Save for approval"}
            </Button>
          </div>
        </div>
      ) : null}
      {editing !== null && rules[editing]
        ? editor(rules[editing] as RuleSpec, (next) => {
            const i = editing;
            setEditing(null);
            if (!next) return;
            setRules(rules.map((r, j) => (j === i ? next : r)));
            setChanged(new Set([...changed, i]));
            key.current = newKey();
          })
        : null}
    </Card>
  );
}
