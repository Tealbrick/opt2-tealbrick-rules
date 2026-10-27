// C373 dev.5 fixes on the Rules page (src/ui) against the real SDK client and a stub server, rendered in happy-dom:
// D12 "Allow always" from a hold card (a query on the launch path prepares an allow rule; nothing is saved before Save rule),
// D11 "Check against recent calls", and the defensive rendering of control characters.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { escapeControls } from "../src/text-guard.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-c373-dev5");
const BASE = "http://localhost/a/rules/";

// ── DOM ────────────────────────────────────────────────────────────────────
const win = new Window({ url: BASE, width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "sessionStorage", "HTMLElement", "HTMLButtonElement", "HTMLDialogElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true;

// ── stub server ────────────────────────────────────────────────────────────
const AGENT = "agt_01J0000000000000000000000A";
const HOLD = "hld_01J0000000000000000000000A";
const spec = (title: string, decision: "allow" | "deny" | "hold", priority: number, match: Record<string, unknown> = { products: ["connect"] }) => ({ title, active: true, priority, match, outcome: { decision, reason: `because ${title}` } });
const row = (id: string, s: ReturnType<typeof spec>) => ({ id, rev: 1, spec: s, source: "owner", createdAt: "2026-10-11T09:00:00.000Z", updatedAt: "2026-10-11T09:00:00.000Z", problem: null, deleted: false });
const HOLD_RULE = row("rul_hold", spec("Sends wait", "hold", 40));
const DENY_RULE = row("rul_deny", spec("No sends to anyone", "deny", 30));
const CATALOG = { generatedAt: null, syncedAt: null, error: null, products: 3, productIds: ["connect", "evolution", "knowledge"], dynamicOps: ["connect.tools"] };
const LIST = (rules: unknown[]) => ({ rules, holdSupported: true, defaultDecision: "allow", catalog: CATALOG });
const FLEET = { source: "fleet", available: true, revision: 3, syncedAt: "2026-10-17T09:00:00.000Z", error: null, teams: [] };

interface Stub {
  calls: { op: string; input: unknown }[];
  fail: Record<string, { status: number; code: string; message?: string } | undefined>;
  outputs: Record<string, unknown>;
}
const stub: Stub = { calls: [], fail: {}, outputs: {} };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const defaults = (): Record<string, unknown> => ({
  "tb.agents_list": { agents: [{ id: AGENT, name: "Front desk", mode: "free", status: "active", access: [] }] },
  fleet_status: FLEET,
  rules_list: LIST([HOLD_RULE]),
  rules_set: { rule: HOLD_RULE },
});

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/rules/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: ["rules_set"] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: unknown };
  stub.calls.push({ op, input: body.input });
  const failure = stub.fail[op];
  if (failure) return json(failure.status, { error: { code: failure.code, message: failure.message ?? `raw upstream text for ${failure.code}`, requestId: "req_1" } });
  const out = stub.outputs[op] ?? defaults()[op];
  if (out !== undefined) return json(200, { status: "ok", output: out });
  return json(404, { error: { code: "unknown_op", message: op } });
}) as typeof fetch;

// ── React ──────────────────────────────────────────────────────────────────
const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TbProvider } = await import("@opt2-tealbrick/miniapp-sdk/client");

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}
async function mount(el: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => r.render(h(TbProvider, { product: "rules" }, el)));
  await flush();
  return {
    host,
    unmount: async () => {
      await act(async () => r.unmount());
      host.remove();
    },
  };
}
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).click());
  await flush();
};
const button = (host: Element, text: string, n = 0) => {
  const found = [...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === text)[n];
  assert.ok(found, `button "${text}"`);
  return found as HTMLButtonElement;
};
const dialog = (title: string): HTMLElement => {
  const d = [...document.querySelectorAll("dialog")].find((x) => x.querySelector("h2")?.textContent?.trim() === title);
  assert.ok(d, `dialog "${title}" (open: ${[...document.querySelectorAll("dialog h2")].map((x) => x.textContent).join(" | ")})`);
  return d as HTMLElement;
};
const noDialog = () => assert.equal(document.querySelectorAll("dialog[open] h2").length, 0, `no dialog open (${[...document.querySelectorAll("dialog h2")].map((x) => x.textContent).join(" | ")})`);
const textOf = (el: Element) => el.textContent ?? "";
const callsOf = (op: string) => stub.calls.filter((c) => c.op === op);
const typeInto = (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
  });
const inputOf = (root: Element, label: string): HTMLInputElement => {
  const l = [...root.querySelectorAll("label")].find((x) => x.textContent?.trim().startsWith(label));
  assert.ok(l, `field "${label}"`);
  const el = (l.htmlFor ? root.ownerDocument.getElementById(l.htmlFor) : l.querySelector("input")) as HTMLInputElement | null;
  assert.ok(el, `input of "${label}"`);
  return el;
};
/** The rule of the first rules_set call. */
const sentRule = (): { match: Record<string, unknown>; priority: number } => {
  const call = callsOf("rules_set")[0];
  assert.ok(call, "rules_set was called");
  return (call.input as { rule: { match: Record<string, unknown>; priority: number } }).rule;
};
const reset = (query = "") => {
  stub.calls = [];
  stub.fail = {};
  stub.outputs = {};
  win.happyDOM.setURL(`${BASE}${query}`);
};
const allowQuery = (extra: Record<string, string>) => `?${new URLSearchParams({ new: "allow", product: "connect", op: "buzz_dm", hold: HOLD, ...extra }).toString()}`;

type Rules = typeof import("../src/ui/rules.tsx");
type Api = typeof import("../src/ui/api.ts");
type Drafts = typeof import("../src/ui/drafts.tsx");
type Decisions = typeof import("../src/ui/decisions.tsx");
type HoldAllow = typeof import("../src/ui/hold-allow.ts");
let rules: Rules;
let api: Api;
let drafts: Drafts;
let decisions: Decisions;
let holdAllow: HoldAllow;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  rules = (await import(pathToFileURL(join(outDir, "ui", "rules.js")).href)) as Rules;
  api = (await import(pathToFileURL(join(outDir, "ui", "api.js")).href)) as Api;
  drafts = (await import(pathToFileURL(join(outDir, "ui", "drafts.js")).href)) as Drafts;
  decisions = (await import(pathToFileURL(join(outDir, "ui", "decisions.js")).href)) as Decisions;
  holdAllow = (await import(pathToFileURL(join(outDir, "ui", "hold-allow.js")).href)) as HoldAllow;
});
after(() => rmSync(outDir, { recursive: true, force: true }));

describe("D12: Allow always from a hold card", () => {
  it("an agent caller: the editor opens prefilled before the hold rule, shows priority and why, saves nothing until Save rule, and the query leaves the URL", async () => {
    reset(allowQuery({ agent: AGENT }));
    const m = await mount(h(rules.RulesPage));
    const editor = dialog("Allow always");
    assert.equal(inputOf(editor, "Title").value, "Allow buzz_dm for Front desk");
    assert.equal(inputOf(editor, "Reason").value, `Always allowed by the owner (from hold ${HOLD})`);
    assert.equal(inputOf(editor, "Priority").value, "39", "right before the hold rule at 40");
    assert.match(textOf(editor), /Priority 39: before your hold rule “Sends wait” \(priority 40\)/);
    assert.match(textOf(editor), /no refuse rule of yours could match it/);
    assert.equal(callsOf("rules_set").length, 0, "the link saves nothing");
    assert.equal(win.location.search, "", "the query is removed so a reload does not reopen it");
    assert.equal(win.location.pathname, "/a/rules/");
    await click(button(editor, "Save rule"));
    assert.deepEqual(
      callsOf("rules_set").map((c) => c.input),
      [
        {
          rule: {
            title: "Allow buzz_dm for Front desk",
            active: true,
            priority: 39,
            match: { products: ["connect"], operations: ["buzz_dm"], agents: [AGENT] },
            outcome: { decision: "allow", reason: `Always allowed by the owner (from hold ${HOLD})` },
          },
        },
      ],
    );
    await m.unmount();
  });

  it("an app caller: callerProducts holds the verified product and the title names the app", async () => {
    reset(allowQuery({ callerProduct: "evolution", product: "knowledge", op: "memory_recall" }));
    const m = await mount(h(rules.RulesPage));
    const editor = dialog("Allow always");
    assert.equal(inputOf(editor, "Title").value, "Allow memory_recall for evolution");
    await click(button(editor, "Save rule"));
    const sent = sentRule();
    assert.deepEqual(sent.match, { products: ["knowledge"], operations: ["memory_recall"], callerProducts: ["evolution"] });
    assert.equal(sent.priority, 20, "the hold rule names connect only, so it cannot have held a knowledge call: the usual place for an allow rule");
    await m.unmount();
  });

  it("a dynamic operation without a tool: no tool is prefilled, a warning shows and Save stays off until one tool is named", async () => {
    reset(allowQuery({ agent: AGENT, op: "tools" }));
    const m = await mount(h(rules.RulesPage));
    const editor = dialog("Allow always");
    assert.match(textOf(editor), /This app runs many tools; choose the one tool to always allow/);
    assert.equal(inputOf(editor, "Tools").value, "", "never a rule that allows any tool");
    assert.ok(button(editor, "Save rule").disabled, "Save is off");
    await click(button(editor, "Save rule"));
    assert.equal(callsOf("rules_set").length, 0);
    await typeInto(inputOf(editor, "Tools"), "gmail_send");
    assert.ok(!button(editor, "Save rule").disabled, "Save is on once a tool is named");
    assert.doesNotMatch(textOf(editor), /choose the one tool/);
    await click(button(editor, "Save rule"));
    const rule = sentRule();
    assert.deepEqual(rule.match.tools, ["gmail_send"]);
    await m.unmount();
  });

  it("a dynamic operation with a tool in the link needs no typing", async () => {
    reset(allowQuery({ agent: AGENT, op: "tools", tool: "gmail_send" }));
    const m = await mount(h(rules.RulesPage));
    const editor = dialog("Allow always");
    assert.equal(inputOf(editor, "Tools").value, "gmail_send");
    assert.ok(!button(editor, "Save rule").disabled);
    await m.unmount();
  });

  it("garbage values: a plain notice, no editor, no prefill; the query is still removed", async () => {
    const garbage: Record<string, string>[] = [
      { product: "Connect" },
      { op: "buzz dm" },
      { hold: "hld_short" },
      { agent: "agt_<script>" },
      { agent: "per_01J0000000000000000000000A" },
      { tool: "gmail__send" },
      { new: "deny" },
      { agent: AGENT, callerProduct: "evolution" },
    ];
    for (const extra of garbage) {
      reset(allowQuery({ agent: AGENT, ...extra }));
      const m = await mount(h(rules.RulesPage));
      noDialog();
      assert.match(textOf(m.host), /“Allow always” link is not valid/, JSON.stringify(extra));
      assert.equal(callsOf("rules_set").length, 0);
      assert.equal(win.location.search, "");
      await m.unmount();
    }
    // neither caller, or a repeated key
    for (const q of [`?new=allow&product=connect&op=buzz_dm&hold=${HOLD}`, `${allowQuery({ agent: AGENT })}&op=other_op`]) {
      reset(q);
      const m = await mount(h(rules.RulesPage));
      noDialog();
      assert.match(textOf(m.host), /link is not valid/);
      await m.unmount();
    }
  });

  it("no query: nothing opens", async () => {
    reset();
    const m = await mount(h(rules.RulesPage));
    noDialog();
    assert.doesNotMatch(textOf(m.host), /link is not valid/);
    await m.unmount();
  });

  it("priority: after a refuse rule that could match, even when that is after the hold rule (warning); a refuse rule at 1000 blocks Save", async () => {
    reset(allowQuery({ agent: AGENT }));
    stub.outputs.rules_list = LIST([HOLD_RULE, row("rul_deny", spec("No sends to anyone", "deny", 50))]);
    let m = await mount(h(rules.RulesPage));
    let editor = dialog("Allow always");
    assert.equal(inputOf(editor, "Priority").value, "51", "never ahead of the refuse rule at 50");
    assert.match(textOf(editor), /after your refuse rule “No sends to anyone” \(priority 50\)/);
    assert.match(textOf(editor), /Your hold rule “Sends wait” \(priority 40\) still runs first/);
    await m.unmount();

    reset(allowQuery({ agent: AGENT }));
    stub.outputs.rules_list = LIST([HOLD_RULE, row("rul_deny", spec("Last refuse", "deny", 1000))]);
    m = await mount(h(rules.RulesPage));
    editor = dialog("Allow always");
    assert.match(textOf(editor), /the last place, so an allow rule cannot go after it/);
    assert.ok(button(editor, "Save rule").disabled);
    await m.unmount();
  });
});

describe("D12: allowPlan and readAllowQuery (pure)", () => {
  const q = { product: "connect", op: "buzz_dm", hold: HOLD, agent: AGENT };
  it("a refuse or hold rule that cannot match this call does not move the rule", () => {
    const other = [row("a", spec("Other app", "deny", 900, { products: ["knowledge"] })), row("b", spec("Other agent", "deny", 800, { agents: ["agt_01J0000000000000000000000B"] })), row("c", spec("Inactive", "deny", 700)), HOLD_RULE];
    const plan = holdAllow.allowPlan(q, other.map((r) => (r.id === "c" ? { ...r, spec: { ...r.spec, active: false } } : r)), "Front desk", false);
    assert.equal(plan.spec.priority, 39);
    assert.deepEqual(plan.warnings, []);
    assert.equal(plan.blocked, null);
  });
  it("without a hold rule (Verification mode) the usual place for an allow rule; a matching refuse rule still goes first", () => {
    assert.equal(holdAllow.allowPlan(q, [], "Front desk", false).spec.priority, 20);
    assert.equal(holdAllow.allowPlan(q, [DENY_RULE], "Front desk", false).spec.priority, 31);
    assert.equal(holdAllow.allowPlan(q, [row("d", spec("Tools only", "deny", 90, { products: ["connect"], operations: ["buzz_dm"], callerProducts: ["evolution"] }))], "Front desk", false).spec.priority, 20, "an agent never matches callerProducts");
  });
  it("a hold rule at priority 0 cannot be gone before: warning, priority 0", () => {
    const plan = holdAllow.allowPlan(q, [row("e", spec("First hold", "hold", 0))], "Front desk", false);
    assert.equal(plan.spec.priority, 0);
    assert.match(plan.warnings.join(" "), /priority 0, the first place/);
  });
  it("long names are clipped to the title limit", () => {
    assert.ok(holdAllow.allowPlan(q, [], "x".repeat(300), false).spec.title.length <= 120);
  });
  it("readAllowQuery: none, ok, bad", () => {
    assert.deepEqual(holdAllow.readAllowQuery(""), { kind: "none" });
    assert.deepEqual(holdAllow.readAllowQuery("?other=1"), { kind: "none" });
    assert.deepEqual(holdAllow.readAllowQuery(allowQuery({ agent: AGENT })), { kind: "ok", query: q });
    assert.equal(holdAllow.readAllowQuery(allowQuery({})).kind, "bad");
    assert.equal(holdAllow.readAllowQuery(allowQuery({ agent: "" })).kind, "bad");
  });
});

describe("D11: Check against recent calls", () => {
  const rowOf = (i: number, over: Record<string, unknown> = {}) => ({
    id: `dec_${String(i).padStart(3, "0")}`,
    at: `2026-10-27T09:${String(i % 60).padStart(2, "0")}:00.000Z`,
    caller: i % 2 ? { type: "agent", id: AGENT, product: null } : { type: "app", id: "ins_1", product: "evolution" },
    target: { product: "connect", op: "buzz_dm", effect: "outward" },
    before: { decision: "allow", by: "Permissive mode" },
    after: { decision: "hold", by: "Sends wait" },
    changed: true,
    ...over,
  });
  const openEditor = async (m: { host: Element }) => {
    await click(button(m.host, "New rule"));
    const editor = dialog("New rule");
    await typeInto(inputOf(editor, "Title"), "Sends wait");
    await typeInto(inputOf(editor, "Reason"), "Sends wait for me");
    return editor;
  };

  it("sends the unsaved rule, lists the newest 20 rows with caller, app, operation and before to after, and stores nothing", async () => {
    reset();
    stub.outputs.rules_preview_recent = { checked: 80, matched: 25, changed: 24, cannotCheck: null, note: "Only calls Rules recorded are checked.", rows: Array.from({ length: 25 }, (_, i) => rowOf(i, i === 3 ? { changed: false, after: { decision: "allow", by: "Permissive mode" } } : {})) };
    const m = await mount(h(rules.RulesPage));
    const editor = await openEditor(m);
    assert.equal(callsOf("rules_preview_recent").length, 0, "nothing runs before the button");
    await click(button(editor, "Check against recent calls"));
    const calls = callsOf("rules_preview_recent");
    assert.equal(calls.length, 1);
    const sent = calls[0]?.input as { rule: { title: string }; ruleId?: string; limit: number };
    assert.equal(sent.rule.title, "Sends wait");
    assert.equal(sent.ruleId, undefined, "a new rule replaces nothing");
    const box = editor.querySelector('[aria-label="Recent calls"]') as HTMLElement;
    assert.match(textOf(box), /Of the last 80 recorded calls, this rule would have matched 25\. The decision would change for 24\./);
    const rows = [...box.querySelectorAll("li")];
    assert.equal(rows.length, 20);
    assert.match(textOf(rows[0] as Element), /evolution · connect\.buzz_dm · allow \(Permissive mode\) → hold \(Sends wait\)/);
    assert.match(textOf(rows[1] as Element), /Front desk · connect\.buzz_dm/);
    assert.match(textOf(rows[3] as Element), /no change/);
    assert.match(textOf(box), /Showing the newest 20 of 25/);
    assert.equal(callsOf("rules_set").length, 0);
    await m.unmount();
  });

  it("an existing rule passes its id, so its stored version is replaced; a rule that can't be checked says why; the button waits for title and reason", async () => {
    reset();
    stub.outputs.rules_preview_recent = { checked: 0, matched: 0, changed: 0, cannotCheck: "This rule names recipients. The decision log keeps only how many recipients a call had.", note: "n", rows: [] };
    const m = await mount(h(rules.RulesPage));
    await click(button(m.host, "New rule"));
    assert.ok(button(dialog("New rule"), "Check against recent calls").disabled, "no title and reason yet");
    await click(button(dialog("New rule"), "Cancel"));
    await click(button(m.host, "Edit"));
    const editor = dialog("Edit rule (revision 1)");
    await click(button(editor, "Check against recent calls"));
    assert.equal((callsOf("rules_preview_recent").at(0)?.input as { ruleId?: string } | undefined)?.ruleId, "rul_hold");
    assert.match(textOf(editor.querySelector('[aria-label="Recent calls"]') as Element), /keeps only how many recipients/);
    await m.unmount();
  });

  it("a failed check shows the plain error", async () => {
    reset();
    stub.fail.rules_preview_recent = { status: 400, code: "input_invalid", message: "app “nosuch” does not declare operation “x”" };
    const m = await mount(h(rules.RulesPage));
    const editor = await openEditor(m);
    await click(button(editor, "Check against recent calls"));
    assert.match(textOf(editor), /does not declare operation/);
    await m.unmount();
  });
});

describe("RU-1: a stored value with control or invisible characters is shown written out", () => {
  const RLO = String.fromCodePoint(0x202e);
  const ZWJ = String.fromCodePoint(0x200d);
  const BEL = String.fromCodePoint(0x07);
  const noRaw = (el: Element) => assert.ok(!/[\p{Cc}\p{Cf}]/u.test((el.textContent ?? "").replace(/[\n\t]/g, "")), `no raw control character in ${(el.textContent ?? "").slice(0, 80)}`);

  it("safeText (browser) and escapeControls (server) give the same answer", () => {
    for (const t of [`a${RLO}b`, `x${ZWJ}y${BEL}`, `tab\there\nline`, "plain café 日本語", `${String.fromCodePoint(0xfeff)}start`, ""]) {
      assert.equal(api.safeText(t), escapeControls(t), JSON.stringify(t));
      assert.equal(api.safeText(t, true), escapeControls(t, true), `${JSON.stringify(t)} multiline`);
    }
    assert.equal(api.safeText(`a${RLO}b`), "a⟨U+202E⟩b");
  });

  it("the rule list, its Edit label and the editor fields show the legacy title and reason escaped", async () => {
    reset();
    const legacy = row("rul_legacy", { ...spec(`Pay${RLO}ments wait`, "deny", 10), outcome: { decision: "deny", reason: `nope${ZWJ}` } });
    stub.outputs.rules_list = LIST([legacy]);
    const m = await mount(h(rules.RulesPage));
    const item = m.host.querySelector(".item") as Element;
    assert.match(textOf(item), /Pay⟨U\+202E⟩ments wait/);
    assert.match(textOf(item), /nope⟨U\+200D⟩/);
    noRaw(item);
    assert.ok(item.querySelector('button[aria-label="Edit Pay⟨U+202E⟩ments wait"]'));
    await click(button(item, "Edit"));
    const editor = dialog("Edit rule (revision 1)");
    assert.equal(inputOf(editor, "Title").value, "Pay⟨U+202E⟩ments wait");
    assert.equal(inputOf(editor, "Reason").value, "nope⟨U+200D⟩");
    await m.unmount();
  });

  it("Drafts and Decisions escape text, note, titles, reasons and rule titles", async () => {
    reset();
    stub.outputs.drafts_list = {
      drafts: [
        {
          id: "drf_1",
          status: "pending",
          text: `hold${RLO}sends\nsecond line`,
          note: `n${BEL}`,
          rules: [spec(`T${ZWJ}itle`, "hold", 10)],
          submittedBy: { type: "agent", id: AGENT, name: `Bot${RLO}` },
          source: { kind: "agent" },
          submittedAt: "2026-10-27T09:00:00.000Z",
          decidedAt: null,
          decidedBy: null,
          ruleIds: [],
          problems: [null],
          opTitles: {},
        },
      ],
    };
    stub.outputs.decisions_list = {
      items: [
        {
          id: "dec_1",
          callId: null,
          phase: "before",
          at: "2026-10-27T09:00:00.000Z",
          caller: { type: "agent", id: AGENT, mode: null, product: null },
          target: { product: "connect", op: "buzz_dm", effect: "outward" },
          decision: "deny",
          answered: "deny",
          reason: `Rules: no${RLO}way`,
          ruleId: "rul_1",
          ruleRev: 1,
          ruleTitle: `Ev${ZWJ}il`,
          onBehalfOf: null,
          detail: null,
          durationUs: 100,
        },
      ],
      nextCursor: null,
    };
    let m = await mount(h(drafts.DraftsPage, { onChange: () => undefined }));
    const draft = m.host.querySelector("article") as Element;
    assert.match(textOf(draft), /hold⟨U\+202E⟩sends/);
    assert.match(textOf(draft), /second line/, "a line break stays in the draft text");
    assert.match(textOf(draft), /n⟨U\+0007⟩/);
    assert.match(textOf(draft), /T⟨U\+200D⟩itle/);
    assert.match(textOf(draft), /from Bot⟨U\+202E⟩/);
    noRaw(draft);
    await m.unmount();
    m = await mount(h(decisions.DecisionsPage));
    assert.match(textOf(m.host), /Reads that match no rule are not listed\./, "QA-C373-RU-2: the page says what it does not list");
    const item = m.host.querySelector(".item") as Element;
    assert.match(textOf(item), /no⟨U\+202E⟩way/);
    assert.match(textOf(item), /rule “Ev⟨U\+200D⟩il”/);
    noRaw(item);
    await m.unmount();
  });
});

describe("RU-3: a manifest that could not be read is named, not a global failure", () => {
  it("one skipped release: the note names product and version and the page does not say the catalog read failed", async () => {
    reset();
    stub.outputs.rules_list = LIST([HOLD_RULE]);
    (stub.outputs.rules_list as { catalog: object }).catalog = { ...CATALOG, skipped: [{ product: "connect", version: "0.4.2", reason: "fetch 404" }] };
    let m = await mount(h(rules.RulesPage));
    assert.match(textOf(m.host), /1 app manifest could not be read: connect 0\.4\.2\./);
    assert.doesNotMatch(textOf(m.host), /last read failed/);
    await m.unmount();
    (stub.outputs.rules_list as { catalog: object }).catalog = { ...CATALOG, skipped: Array.from({ length: 7 }, (_, i) => ({ product: `app${i}`, version: "1.0.0", reason: "fetch 404" })) };
    m = await mount(h(rules.RulesPage));
    assert.match(textOf(m.host), /7 app manifests could not be read: app0 1\.0\.0, app1 1\.0\.0, app2 1\.0\.0, app3 1\.0\.0, app4 1\.0\.0, and 2 more\./);
    await m.unmount();
  });
  it("a failed index read still says so", async () => {
    reset();
    stub.outputs.rules_list = LIST([HOLD_RULE]);
    (stub.outputs.rules_list as { catalog: object }).catalog = { ...CATALOG, error: "fetch 404", syncedAt: "2026-10-27T01:00:00.000Z", skipped: [] };
    const m = await mount(h(rules.RulesPage));
    assert.match(textOf(m.host), /App catalog: last read failed \(fetch 404\)/);
    assert.doesNotMatch(textOf(m.host), /could not be read/);
    await m.unmount();
  });
});
