// The workspace default mode (C373c) on the Rules page: the three modes with one-line explanations, a confirm dialog for a
// move to a looser mode (closed → verification → permissive), the read-only system lines (built-in exemptions), and the
// texts the dry run and the Decisions page use. The browser build does not load src/mode.ts, so the order lives here too
// (a test pins both to the same answer).
import { Button, Card, Choices, Dialog, Notice, Swatch, Tag } from "@opt2-tealbrick/ui";
import { useState } from "react";
import { errorText, type Out, run, when } from "./api.ts";

export type Mode = Out<"rules_list">["mode"]["mode"];
export type ModeState = Out<"rules_list">["mode"];
export type SystemLine = Out<"rules_list">["system"][number];

export const MODE_ORDER: readonly Mode[] = ["permissive", "verification", "closed"];
export const MODE_TITLE: Record<Mode, string> = { permissive: "Permissive", verification: "Verification", closed: "Closed" };
export const MODE_TEXT: Record<Mode, string> = {
  permissive: "No rule matches: the call runs.",
  verification: "No rule matches: the call waits for your review (in the app’s Holds and in Inbox).",
  closed: "No rule matches: the call is refused.",
};
/** S3 (QA, dev.6): Closed also refuses the calls apps make to each other; the owner reads this before the switch. */
export const CLOSED_WARNING =
  "Closed also refuses calls that apps make to each other when no rule allows them, for example Observer reading Connect or Evolving Workflows running a step. Allow those apps first on the Access page (or with an allow rule), or they stop working.";
/** A move to a looser mode needs a confirm (the server refuses it without one: 409 confirm_required). */
export const isLooser = (from: Mode, to: Mode): boolean => MODE_ORDER.indexOf(to) < MODE_ORDER.indexOf(from);

/** The empty rule list says what happens to every call in this mode. */
export function noRulesText(mode: Mode | undefined): string {
  if (mode === "verification") return "Every agent and app call waits for your review (Verification mode), except the system lines below. A template is a quick start: nothing applies until you save it.";
  if (mode === "closed") return "Every agent and app call is refused (Closed mode), except the system lines below. A template is a quick start: nothing applies until you save it.";
  return "Every agent and app call is allowed (within each app’s own limits). A template is a quick start: nothing applies until you save it.";
}

/** Decisions page: " · decided by Closed mode (no rule matched)" for a trace the mode decided; "" otherwise. */
export function modeTraceText(detail: Record<string, unknown> | null | undefined): string {
  const mode = typeof detail?.mode === "string" && detail.mode in MODE_TITLE ? MODE_TITLE[detail.mode as Mode] : null;
  if (!mode) return "";
  if (detail?.decidedBy === "exemption") return ` · ${mode} mode did not apply (system exemption)`;
  return detail?.decidedBy === "mode" ? ` · decided by ${mode} mode (no rule matched)` : "";
}

function ConfirmLooser({ from, to, onDone }: { from: Mode; to: Mode; onDone: (changed: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const change = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await run("mode_set", isLooser(from, to) ? { mode: to, confirm: true } : { mode: to });
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
      kicker="Default mode"
      title={`Switch to ${MODE_TITLE[to]} mode?`}
      onClose={() => onDone(false)}
      busy={busy}
      footer={
        <>
          <Button onClick={() => onDone(false)} disabled={busy}>
            Keep {MODE_TITLE[from]}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void change()}>
            {busy ? "Switching" : `Switch to ${MODE_TITLE[to]}`}
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
        {to === "permissive"
          ? "Calls that no rule covers will run without your review."
          : to === "closed"
            ? "Calls that no rule covers will be refused."
            : "Calls that no rule covers will wait for your review instead of being refused."}{" "}
        Rules that match still decide as before.
      </p>
      {to === "closed" ? <Notice tone="needs-you">{CLOSED_WARNING}</Notice> : null}
    </Dialog>
  );
}

/** The mode at the top of the Rules page. Tighter: changes at once. Looser: asks first. */
export function ModeCard({ state, onChanged }: { state: ModeState; onChanged: () => void }) {
  const [asking, setAsking] = useState<Mode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pick = async (to: Mode) => {
    if (busy || to === state.mode) return;
    setError("");
    if (isLooser(state.mode, to) || to === "closed") {
      setAsking(to);
      return;
    }
    setBusy(true);
    try {
      await run("mode_set", { mode: to });
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card as="section" className="rules-mode" aria-label="Default mode">
      <h3>Default mode</h3>
      <p className="tb-hint">What happens to a call that no rule covers. Rules that match decide as before.</p>
      <Choices label="Default mode" value={state.mode} options={MODE_ORDER.map((m) => ({ value: m, title: MODE_TITLE[m], body: MODE_TEXT[m], disabled: busy }))} onChange={(v) => void pick(v)} />
      {state.changedAt ? <p className="tb-hint">Changed {when(state.changedAt)}</p> : null}
      {error ? (
        <Notice tone="needs-you" role="alert">
          {error}
        </Notice>
      ) : null}
      {asking ? (
        <ConfirmLooser
          from={state.mode}
          to={asking}
          onDone={(changed) => {
            setAsking(null);
            if (changed) onChanged();
          }}
        />
      ) : null}
    </Card>
  );
}

/** The built-in exemptions of the mode, as read-only "system" lines of the rule list. */
export function SystemLines({ lines }: { lines: readonly SystemLine[] }) {
  if (lines.length === 0) return null;
  return (
    <section className="ruled" aria-label="System lines">
      {lines.map((l) => (
        <div className="item" key={l.id}>
          <Swatch group="control" />
          <h3>
            {l.title} <Tag status="idle">system</Tag> <span className="tb-hint">read-only</span>
          </h3>
          <p>{l.text}</p>
        </div>
      ))}
    </section>
  );
}
