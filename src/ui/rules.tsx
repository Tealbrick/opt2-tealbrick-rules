// Rules page: the rule list, the rule editor (a form in a Dialog, saving passes the revision that was edited) and the
// dry run. Everything goes through person ops; agents can only submit drafts (C84).
import { Button, Card, Dialog, EmptyState, Field, Notice, Select, Swatch, Switch, Tag, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useState } from "react";
import { day, EFFECTS, emptySpec, errorText, joinList, list, matchText, type Out, type RuleRow, type RuleSpec, run, when } from "./api.ts";
import { ChipChoice, DecisionTag, type Directory, DirectoryErrors, Head, LoadError, Loading, useDirectory, useLoaded } from "./shared.tsx";

const DECISIONS = [
  { value: "allow", label: "Allow" },
  { value: "deny", label: "Refuse" },
  { value: "hold", label: "Hold for my review" },
];
const TRUSTS = ["unreviewed", "trusted", "limited", "blocked"] as const;
/** The dry run's caller choice for "an app" (agents are listed by id). */
const APP_CALLER = "__app__";
const MODES = [
  { value: "free" as const, label: "Free" },
  { value: "bound" as const, label: "Bound" },
];

/** Rule editor (structured form). Saving passes the revision that was edited (stale → revision_conflict). */
function Editor({ initial, dir, products, onDone }: { initial: RuleRow | null; dir: Directory; products: readonly string[]; onDone: (saved: boolean) => void }) {
  const [s, setS] = useState<RuleSpec>(() => structuredClone(initial?.spec ?? emptySpec()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const m = s.match;
  const setMatch = (patch: Partial<RuleSpec["match"]>) => setS({ ...s, match: { ...m, ...patch } });
  const obo = m.onBehalfOf ?? {};
  const setObo = (patch: Partial<NonNullable<RuleSpec["match"]["onBehalfOf"]>>) => {
    const next = { ...obo, ...patch };
    setMatch({ onBehalfOf: next.teams || next.ids || next.kinds || next.trust ? next : undefined });
  };
  const tags = s.narrowing?.memoryTags ?? {};
  const setTags = (patch: { anyOf?: string[]; noneOf?: string[] }) => {
    const next = { ...tags, ...patch };
    setS({ ...s, narrowing: next.anyOf || next.noneOf ? { memoryTags: next } : undefined });
  };
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await run("rules_set", { ...(initial ? { id: initial.id, expectedRev: initial.rev } : {}), rule: s });
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
      title={initial ? `Edit rule (revision ${initial.rev})` : "New rule"}
      onClose={() => onDone(false)}
      busy={busy}
      size="lg"
      footer={
        <>
          <Button onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !s.title || !s.outcome.reason} onClick={() => void save()}>
            {busy ? "Saving" : "Save rule"}
          </Button>
        </>
      }
    >
      {error ? (
        <Notice tone="needs-you" role="alert">
          {error}
        </Notice>
      ) : null}
      <DirectoryErrors dir={dir} />
      <div className="rules-form">
        <Field label="Title">
          <TextInput value={s.title} maxLength={120} onChange={(e) => setS({ ...s, title: e.target.value })} />
        </Field>
        <Field label="Priority" hint="Lower runs first. The first matching rule decides.">
          <TextInput type="number" min={0} max={1000} value={s.priority} onChange={(e) => setS({ ...s, priority: Number(e.target.value) })} />
        </Field>
        <Field label="Decision">
          <Select
            value={s.outcome.decision}
            options={DECISIONS}
            onValueChange={(v) => setS({ ...s, outcome: { ...s.outcome, decision: v as RuleSpec["outcome"]["decision"] }, narrowing: v === "allow" ? s.narrowing : undefined })}
          />
        </Field>
        <div className="rules-switch">
          <Switch label="Active" checked={s.active} onCheckedChange={(on) => setS({ ...s, active: on })} />
        </div>
      </div>
      <Field label="Reason" hint="Shown to the agent and recorded with every decision (max 280 characters).">
        <TextInput value={s.outcome.reason} maxLength={280} onChange={(e) => setS({ ...s, outcome: { ...s.outcome, reason: e.target.value } })} />
      </Field>

      <section className="rules-group" aria-label="When">
        <h3>When</h3>
        <ChipChoice label="Caller agents" options={dir.agents.map((a) => ({ value: a.id, label: a.name }))} value={m.agents} onChange={(v) => setMatch({ agents: v })} />
        <ChipChoice label="Agent mode" options={MODES} value={m.modes} onChange={(v) => setMatch({ modes: v })} />
        <ChipChoice label="Effect" options={EFFECTS.map((e) => ({ value: e, label: e }))} value={m.effects} onChange={(v) => setMatch({ effects: v })} />
        <div className="rules-form">
          <Field label="Apps" hint="Product ids, comma separated.">
            <TextInput value={joinList(m.products)} onChange={(e) => setMatch({ products: list(e.target.value) })} />
          </Field>
          <Field label="Operations" hint="Operation ids, comma separated. Needs the app above.">
            <TextInput value={joinList(m.operations)} onChange={(e) => setMatch({ operations: list(e.target.value) })} />
          </Field>
        </div>
        <ChipChoice
          label="Caller is a member of team (from Governance)"
          hint="none = any. If Governance can’t be read, a refuse or hold rule with this applies and an allow rule with this does not."
          options={dir.teams.map((t) => ({ value: t.id, label: t.name }))}
          value={m.callerTeams}
          onChange={(v) => setMatch({ callerTeams: v })}
        />
        <ChipChoice
          label="Calls from apps"
          hint="none = any caller. An app is identified by its verified product, never by its name; an agent never matches. If the product can’t be verified, a refuse or hold rule with this applies and an allow rule with this does not."
          options={[...new Set([...products, ...(m.callerProducts ?? [])])].sort().map((p) => ({ value: p, label: p }))}
          value={m.callerProducts}
          onChange={(v) => setMatch({ callerProducts: v })}
        />
        <ChipChoice
          label="On behalf of a member of team (from Governance)"
          options={dir.teams.map((t) => ({ value: t.id, label: t.name }))}
          value={obo.teams}
          onChange={(v) => setObo({ teams: v })}
        />
        <ChipChoice
          label="Requester trust (from Governance)"
          hint="none = any. Trust of the claimed requester; an unknown requester has none."
          options={TRUSTS.map((t) => ({ value: t, label: t }))}
          value={obo.trust}
          onChange={(v) => setObo({ trust: v })}
        />
        <Field label="On behalf of" hint="Ids or handles such as slack:U123, comma separated. A claimed requester can only make a decision stricter, never wider.">
          <TextInput value={joinList(obo.ids)} onChange={(e) => setObo({ ids: list(e.target.value) })} />
        </Field>
      </section>

      {s.outcome.decision === "allow" ? (
        <section className="rules-group" aria-label="Narrow what the agent may read">
          <h3>Narrow what the agent may read</h3>
          <div className="rules-form">
            <Field label="Only memories tagged (any of)">
              <TextInput value={joinList(tags.anyOf)} onChange={(e) => setTags({ anyOf: list(e.target.value) })} />
            </Field>
            <Field label="Never memories tagged">
              <TextInput value={joinList(tags.noneOf)} onChange={(e) => setTags({ noneOf: list(e.target.value) })} />
            </Field>
          </div>
        </section>
      ) : null}
      <Preview candidate={s} dir={dir} />
    </Dialog>
  );
}

/** Dry run: which rule would decide a sample call (with the edited rule included). */
function Preview({ candidate, dir }: { candidate?: RuleSpec; dir: Directory }) {
  const [caller, setCaller] = useState("");
  const [appProduct, setAppProduct] = useState("");
  const [mode, setMode] = useState<"free" | "bound">("free");
  const isApp = caller === APP_CALLER;
  const [product, setProduct] = useState("knowledge");
  const [op, setOp] = useState("memory_recall");
  const [effect, setEffect] = useState<(typeof EFFECTS)[number]>("read");
  const [handle, setHandle] = useState("");
  const [result, setResult] = useState<Out<"rules_preview"> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setError("");
    setBusy(true);
    try {
      const id = caller || dir.agents[0]?.id || "agt_preview";
      setResult(
        await run("rules_preview", {
          call: {
            caller: isApp ? { type: "app", id: "ins_preview", ...(appProduct.trim() ? { product: appProduct.trim() } : {}) } : { type: "agent", id, mode },
            target: { product, op, effect },
            ...(handle ? { onBehalfOf: { kind: handle.includes(":") || handle.startsWith("npub1") ? "channel_sender" : "person", id: handle } } : {}),
          },
          ...(candidate?.title && candidate.outcome.reason ? { candidate } : {}),
        }),
      );
    } catch (e) {
      setResult(null);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card as="section" className="rules-preview" aria-label="Try a call">
      <h3>Try a call (dry run)</h3>
      <div className="rules-form">
        <Field label="Caller">
          <Select value={caller} options={[{ value: "", label: "First agent" }, ...dir.agents.map((a) => ({ value: a.id, label: a.name })), { value: APP_CALLER, label: "An app" }]} onValueChange={setCaller} />
        </Field>
        {isApp ? (
          <Field label="App product" hint="Its verified product id, such as knowledge. Leave empty to try an app whose product can’t be verified.">
            <TextInput value={appProduct} onChange={(e) => setAppProduct(e.target.value)} />
          </Field>
        ) : (
          <Field label="Mode">
            <Select value={mode} options={MODES} onValueChange={(v) => setMode(v as "free" | "bound")} />
          </Field>
        )}
        <Field label="App">
          <TextInput value={product} onChange={(e) => setProduct(e.target.value)} />
        </Field>
        <Field label="Operation">
          <TextInput value={op} onChange={(e) => setOp(e.target.value)} />
        </Field>
        <Field label="Effect">
          <Select value={effect} options={EFFECTS.map((e) => ({ value: e, label: e }))} onValueChange={(v) => setEffect(v as (typeof EFFECTS)[number])} />
        </Field>
        <Field label="On behalf of (optional)">
          <TextInput value={handle} placeholder="slack:U123 or psn_…" onChange={(e) => setHandle(e.target.value)} />
        </Field>
      </div>
      <div className="tb-ctas">
        <Button onClick={() => void go()} disabled={busy}>
          {busy ? "Running" : "Run dry run"}
        </Button>
      </div>
      {error ? (
        <Notice tone="needs-you" role="alert">
          {error}
        </Notice>
      ) : null}
      {result ? (
        <div className="tb-stack" role="status">
          <div className="tb-row">
            <DecisionTag decision={result.answered} />
            <span>{result.reason}</span>
            {result.ruleTitle ? <span className="tb-hint">by “{result.ruleTitle}”</span> : null}
          </div>
          {result.narrowing ? <p className="tb-soft">Narrowed to memories: {JSON.stringify(result.narrowing.memoryTags)}</p> : null}
          {result.fleetAvailable ? (
            <p className="tb-hint">
              Caller teams: {result.callerTeams.length ? result.callerTeams.map(dir.teamName).join(", ") : "none"} · requester teams: {result.teams.length ? result.teams.map(dir.teamName).join(", ") : "none"} ·
              requester trust: {result.trust ?? "unknown"}
            </p>
          ) : (
            <p className="tb-soft">Governance can’t be read right now, so refuse and hold rules that name teams or trust apply and allow rules that name them do not.</p>
          )}
          {result.callerProductUnavailable ? (
            <p className="tb-soft">The calling app’s product can’t be verified, so refuse and hold rules that name apps (calls from) apply and allow rules that name them do not.</p>
          ) : null}
          {result.decision === "hold" && result.answered === "deny" ? (
            <p className="tb-soft">Holds from rules arrive with the next platform release. Until then a hold rule refuses.</p>
          ) : null}
          <ol className="rules-trace tb-list">
            {result.steps.map((st) => (
              <li key={st.ruleId}>
                <strong>{st.title}</strong>: {st.why}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </Card>
  );
}

/** Delete asks first: a Dialog with the rule’s name; a failed delete stays visible in it. */
function DeleteDialog({ rule, onDone }: { rule: RuleRow; onDone: (deleted: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await run("rules_delete", { id: rule.id, expectedRev: rule.rev });
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
      title="Delete this rule?"
      onClose={() => onDone(false)}
      busy={busy}
      footer={
        <>
          <Button onClick={() => onDone(false)} disabled={busy}>
            Keep it
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => void remove()}>
            {busy ? "Deleting" : "Delete rule"}
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
        The rule “{rule.spec.title}” stops applying at once. Its history stays.
      </p>
    </Dialog>
  );
}

export function RulesPage() {
  const dir = useDirectory();
  const load = useCallback(() => run("rules_list", {}), []);
  const { data, error, loading, reload } = useLoaded(load);
  const [editing, setEditing] = useState<RuleRow | "new" | null>(null);
  const [deleting, setDeleting] = useState<RuleRow | null>(null);
  const broken = data?.rules.filter((r) => r.problem).length ?? 0;
  return (
    <section className="app-page" aria-label="Rules">
      <Head
        title="Rules"
        lede="The first matching rule decides (lower priority first). No matching rule: allow. Every refusal and hold is recorded with its reason."
        action={
          <Button variant="primary" onClick={() => setEditing("new")}>
            New rule
          </Button>
        }
      />
      {error ? <LoadError message={error} retrying={loading} onRetry={reload} /> : null}
      <DirectoryErrors dir={dir} />
      {data && !data.holdSupported ? (
        <Notice tone="live">“Hold for my review” rules refuse for now. Holds from rules arrive with the next platform release (spec 0.1.13).</Notice>
      ) : null}
      {broken > 0 ? (
        <Notice tone="needs-you" role="alert">
          <strong>{broken === 1 ? "1 rule never matches:" : `${broken} rules never match:`}</strong> {broken === 1 ? "it names" : "they name"} an app or operation that the app doesn’t declare. Edit or
          delete {broken === 1 ? "it" : "them"}; until then {broken === 1 ? "it protects" : "they protect"} nothing.
        </Notice>
      ) : null}
      {data?.catalog.error ? (
        <p className="tb-hint">
          App catalog: last read failed ({data.catalog.error}). Rules are checked against the catalog of {when(data.catalog.syncedAt)}.
        </p>
      ) : null}
      {data === null ? (
        error ? null : <Loading what="rules" />
      ) : data.rules.length === 0 ? (
        <EmptyState title="No rules yet">Every call is allowed (within each app’s own limits).</EmptyState>
      ) : (
        <div className="ruled">
          {data.rules.map((r) => (
            <div className="item" key={r.id}>
              <Swatch group="control" />
              <h3>
                {r.spec.title} <DecisionTag decision={r.spec.outcome.decision} rule /> <span className="tb-hint rules-pri">priority {r.spec.priority}</span>
                {r.source.startsWith("drf_") ? <> <Tag>from draft</Tag></> : null}
                {r.problem ? <> <Tag status="needs-you">never matches</Tag></> : null}
                {r.spec.active ? null : <> <Tag status="idle">inactive</Tag></>}
              </h3>
              <p>
                {matchText(r.spec, dir.teamName, dir.agentName)} → {r.spec.outcome.reason}
                {r.spec.narrowing?.memoryTags ? ` · memories: ${JSON.stringify(r.spec.narrowing.memoryTags)}` : ""}
              </p>
              {r.problem ? <p>Never matches: {r.problem}</p> : null}
              <span className="meta">
                revision {r.rev} · {day(r.updatedAt)}
              </span>
              <div className="side">
                <Button size="sm" aria-label={`Edit ${r.spec.title}`} onClick={() => setEditing(r)}>
                  Edit
                </Button>
                <Button size="sm" variant="danger" aria-label={`Delete ${r.spec.title}`} onClick={() => setDeleting(r)}>
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {editing ? (
        <Editor
          initial={editing === "new" ? null : editing}
          dir={dir}
          products={data?.catalog.productIds ?? []}
          onDone={(saved) => {
            setEditing(null);
            if (saved) reload();
          }}
        />
      ) : null}
      {deleting ? (
        <DeleteDialog
          rule={deleting}
          onDone={(deleted) => {
            setDeleting(null);
            if (deleted) reload();
          }}
        />
      ) : null}
    </section>
  );
}
