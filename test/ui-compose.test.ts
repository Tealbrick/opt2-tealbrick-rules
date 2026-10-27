// The English rule box on the Rules page (C373, J3) against the real SDK client and a stub server, rendered in happy-dom:
// "Show rules" reads the proposal (rule_compose), each rule is shown readably and can be edited in the structured editor
// (which then saves nothing) or removed, and "Save for approval" stores the draft (rule_compose_save) with ONE idempotency
// key per proposal (a retry never makes two drafts). Nothing is applied from this box (no rules_set, no draft_decide).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-compose");

const win = new Window({ url: "http://localhost/a/rules/", width: 1280, height: 860 });
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

const DENY = { title: "Refuse money · CEO · on behalf of Team X", description: "x", active: true, priority: 10, match: { agents: ["agt_ceo"], effects: ["money"], onBehalfOf: { teams: ["tm_x"] } }, outcome: { decision: "deny", reason: "The owner's rule" } };
const ALLOW = {
  title: "Allow only memories tagged work · CEO · on behalf of Team X",
  description: "x",
  active: true,
  priority: 20,
  match: { agents: ["agt_ceo"], onBehalfOf: { teams: ["tm_x"] } },
  outcome: { decision: "allow", reason: "The owner's rule" },
  narrowing: { memoryTags: { anyOf: ["work"] } },
};
const PROPOSAL = {
  drafter: "parser",
  rules: [DENY, ALLOW],
  lines: ["Refuse: calls by CEO on behalf of team Team X with effect money.", "Allow: calls by CEO on behalf of team Team X, only memories tagged work."],
  notes: ["Who asked is a claim. A rule about who asked can only make a decision stricter, never wider."],
  unmatched: [{ text: "Hold Hermez's sends", hint: "No agent named “Hermez”. Close names: Hermes." }],
};

const stub: { calls: { op: string; input: unknown; key?: string }[]; fail: Record<string, { status: number; code: string } | undefined> } = { calls: [], fail: {} };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const OUTPUTS: Record<string, unknown> = {
  "tb.agents_list": { agents: [{ id: "agt_ceo", name: "CEO", mode: "free", status: "active", access: [] }] },
  fleet_status: { source: "fleet", available: true, revision: 3, syncedAt: "2026-10-27T09:00:00.000Z", error: null, teams: [{ id: "tm_x", name: "Team X", people: 1, agents: 1 }] },
  rules_list: { rules: [], holdSupported: true, defaultDecision: "allow", catalog: { generatedAt: null, syncedAt: null, error: null, products: 1 } },
  rule_compose: PROPOSAL,
  rule_compose_save: { draftId: "drf_1", status: "pending" },
};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/rules/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: ["rule_compose_save", "rules_set"] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: unknown; idempotencyKey?: string };
  stub.calls.push({ op, input: body.input, key: body.idempotencyKey });
  const failure = stub.fail[op];
  if (failure) return json(failure.status, { error: { code: failure.code, message: `raw upstream text for ${failure.code}`, requestId: "req_1" } });
  if (op in OUTPUTS) return json(200, { status: "ok", output: OUTPUTS[op] });
  return json(404, { error: { code: "unknown_op", message: op } });
}) as typeof fetch;

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TbProvider } = await import("@opt2-tealbrick/miniapp-sdk/client");

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
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
const typeInto = (el: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(async () => {
    const proto = el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
  });
const box = (host: Element) => host.querySelector('section[aria-label="Write a rule in plain English"]') as HTMLElement;
const callsOf = (op: string) => stub.calls.filter((c) => c.op === op);
const reset = () => {
  stub.calls = [];
  stub.fail = {};
};
const TEXT = "When someone from team X tags the CEO agent: only work-tagged memories, no money";

type Rules = typeof import("../src/ui/rules.tsx");
let rules: Rules;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  rules = (await import(pathToFileURL(join(outDir, "ui", "rules.js")).href)) as Rules;
});
after(() => rmSync(outDir, { recursive: true, force: true }));

describe("English rule box", () => {
  it("Show rules → readable rules, what was not read, notes; Save for approval → a draft, never an applied rule", async () => {
    reset();
    let saved = 0;
    let opened = 0;
    const m = await mount(h(rules.RulesPage, { onDraftSaved: () => saved++, onOpenDrafts: () => opened++ }));
    const b = box(m.host);
    assert.ok(b, "the box is on the Rules page");
    assert.ok(button(b, "Show rules").disabled, "nothing typed: nothing to show");
    await typeInto(b.querySelector("textarea") as HTMLTextAreaElement, TEXT);
    await click(button(b, "Show rules"));
    assert.deepEqual(callsOf("rule_compose").map((c) => c.input), [{ text: TEXT, agents: [{ id: "agt_ceo", name: "CEO" }] }], "the names this page read go along");
    const text = b.textContent ?? "";
    assert.match(text, /Refuse: calls by CEO on behalf of team Team X with effect money\./);
    assert.match(text, /Allow: calls by CEO on behalf of team Team X, only memories tagged work\./);
    assert.match(text, /“Hold Hermez's sends”: No agent named “Hermez”\. Close names: Hermes\./);
    assert.match(text, /Who asked is a claim/);
    assert.match(text, /Nothing applies until you approve them/);
    await click(button(b, "Save for approval"));
    const sent = callsOf("rule_compose_save");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.input, { text: TEXT, rules: [DENY, ALLOW] });
    assert.match(sent[0]?.key ?? "", /^compose-/);
    assert.match(b.textContent ?? "", /Saved\. Approve it on Drafts\./);
    assert.equal(saved, 1, "the shell's Drafts badge refreshes");
    await click(button(b, "Open Drafts"));
    assert.equal(opened, 1);
    assert.deepEqual([...callsOf("rules_set"), ...callsOf("draft_decide")], [], "the box applies nothing");
    await m.unmount();
  });

  it("Edit opens the structured editor prefilled; Use this rule changes the proposal only; Remove drops a rule", async () => {
    reset();
    const m = await mount(h(rules.RulesPage, {}));
    const b = box(m.host);
    await typeInto(b.querySelector("textarea") as HTMLTextAreaElement, TEXT);
    await click(button(b, "Show rules"));
    await click(b.querySelector(`button[aria-label="Edit ${DENY.title}"]`) as Element);
    const dialog = document.querySelector("dialog") as HTMLElement;
    assert.match(dialog.textContent ?? "", /Edit proposed rule/);
    const title = [...dialog.querySelectorAll("input")].find((i) => i.value === DENY.title) as HTMLInputElement;
    assert.ok(title, "the title is prefilled");
    await typeInto(title, "No money for Team X requests");
    await click(button(document.body, "Use this rule"));
    assert.deepEqual(callsOf("rules_set"), [], "the editor saves nothing here");
    assert.match(b.textContent ?? "", /No money for Team X requests/);
    await click(b.querySelector(`button[aria-label="Remove ${ALLOW.title}"]`) as Element);
    assert.doesNotMatch(b.textContent ?? "", /only memories tagged work/);
    await click(button(b, "Save for approval"));
    const sent = callsOf("rule_compose_save")[0]?.input as { rules: { title: string }[] };
    assert.deepEqual(
      sent.rules.map((r) => r.title),
      ["No money for Team X requests"],
    );
    await m.unmount();
  });

  it("errors are shown plainly; a retried save sends the SAME idempotency key", async () => {
    reset();
    stub.fail.rule_compose = { status: 500, code: "internal_error" };
    const m = await mount(h(rules.RulesPage, {}));
    const b = box(m.host);
    await typeInto(b.querySelector("textarea") as HTMLTextAreaElement, TEXT);
    await click(button(b, "Show rules"));
    assert.match(b.querySelector('[role="alert"]')?.textContent ?? "", /Something went wrong/);
    stub.fail.rule_compose = undefined;
    await click(button(b, "Show rules"));
    stub.fail.rule_compose_save = { status: 409, code: "too_many_drafts" };
    await click(button(b, "Save for approval"));
    assert.match(b.querySelector('[role="alert"]')?.textContent ?? "", /raw upstream text for too_many_drafts/, "the app's own refusal is shown as it is");
    stub.fail.rule_compose_save = undefined;
    await click(button(b, "Save for approval"));
    const keys = callsOf("rule_compose_save").map((c) => c.key);
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1], "one proposal, one key");
    await m.unmount();
  });
});
