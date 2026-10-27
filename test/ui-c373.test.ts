// C373 Q-7 and Q-9 on the Rules page (src/ui) against the real SDK client and a stub server, rendered in happy-dom:
// the rule History with "Restore this version" behind a confirm dialog, "Show deleted rules" with restore, and
// "Start from a template" (pick, fill the one parameter, the editor opens prefilled; nothing is saved until Save rule).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { templateSpec } from "../src/ui/templates.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-c373");

// ── DOM ────────────────────────────────────────────────────────────────────
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

// ── stub server ────────────────────────────────────────────────────────────
const spec = (title: string, decision: "allow" | "deny" | "hold") => ({ title, active: true, priority: 10, match: { products: ["connect"] }, outcome: { decision, reason: `because ${title}` } });
const RULE = { id: "rul_1", rev: 3, spec: spec("No sends", "deny"), source: "owner", createdAt: "2026-10-11T09:00:00.000Z", updatedAt: "2026-10-11T09:00:00.000Z", problem: null, deleted: false };
const GONE = { ...RULE, id: "rul_2", rev: 2, spec: spec("Old hold", "hold"), deleted: true };
const revisions = (rule: typeof RULE, deleted: boolean) => ({
  rule,
  deleted,
  revisions: deleted
    ? [
        { rev: 2, change: "deleted", spec: rule.spec, actor: "per_01J00000000000000000000OWN", at: "2026-10-12T09:00:00.000Z" },
        { rev: 1, change: "created", spec: rule.spec, actor: "per_01J00000000000000000000OWN", at: "2026-10-11T09:00:00.000Z" },
      ]
    : [
        { rev: 3, change: "restored", from: 1, spec: rule.spec, actor: "per_01J00000000000000000000OWN", at: "2026-10-13T09:00:00.000Z" },
        { rev: 2, change: "updated", spec: spec("Sends wait", "hold"), actor: "per_01J00000000000000000000OWN", at: "2026-10-12T09:00:00.000Z" },
        { rev: 1, change: "created", spec: rule.spec, actor: "per_01J00000000000000000000OWN", at: "2026-10-11T09:00:00.000Z" },
      ],
});
const LIST = (rules: unknown[]) => ({ rules, holdSupported: true, defaultDecision: "allow", catalog: { generatedAt: null, syncedAt: null, error: null, products: 1 } });
const FLEET = { source: "fleet", available: true, revision: 3, syncedAt: "2026-10-17T09:00:00.000Z", error: null, teams: [{ id: "tm_x", name: "Team X", people: 1, agents: 1 }] };

interface Stub {
  calls: { op: string; input: unknown }[];
  fail: Record<string, { status: number; code: string; message?: string } | undefined>;
  outputs: Record<string, unknown>;
}
const stub: Stub = { calls: [], fail: {}, outputs: {} };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const defaults = (): Record<string, unknown> => ({
  "tb.agents_list": { agents: [{ id: "agt_01J0000000000000000000000A", name: "Front desk", mode: "free", status: "active", access: [] }] },
  fleet_status: FLEET,
  rules_list: LIST([RULE]),
  rules_set: { rule: RULE },
  rule_restore: { id: RULE.id, rev: 4, restoredFrom: 1 },
});

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/rules/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: ["rules_set", "rule_restore"] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: { id?: string; includeDeleted?: boolean } };
  stub.calls.push({ op, input: body.input });
  const failure = stub.fail[op];
  if (failure) return json(failure.status, { error: { code: failure.code, message: failure.message ?? `raw upstream text for ${failure.code}`, requestId: "req_1" } });
  if (op === "rules_get") return json(200, { status: "ok", output: body.input?.id === GONE.id ? revisions(GONE, true) : revisions(RULE, false) });
  if (op === "rules_list" && body.input?.includeDeleted && !stub.outputs.rules_list) return json(200, { status: "ok", output: LIST([RULE, GONE]) });
  const out = stub.outputs[op] ?? defaults()[op];
  if (out !== undefined) return json(200, { status: "ok", output: out });
  return json(404, { error: { code: "unknown_op", message: op } });
}) as typeof fetch;

// ── React ──────────────────────────────────────────────────────────────────
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
const byLabel = (host: Element, label: string) => {
  const found = host.querySelector(`button[aria-label="${label}"]`);
  assert.ok(found, `button labelled "${label}"`);
  return found as HTMLButtonElement;
};
/** The open dialog whose title (h2) is `title`. */
const dialog = (title: string): HTMLElement => {
  const d = [...document.querySelectorAll("dialog")].find((x) => x.querySelector("h2")?.textContent?.trim() === title);
  assert.ok(d, `dialog "${title}" (open: ${[...document.querySelectorAll("dialog h2")].map((x) => x.textContent).join(" | ")})`);
  return d as HTMLElement;
};
const noDialog = (title: string) => assert.equal([...document.querySelectorAll("dialog h2")].filter((x) => x.textContent?.trim() === title).length, 0, `no dialog "${title}"`);
const radio = (root: Element, title: string) => {
  const r = [...root.querySelectorAll('button[role="radio"]')].find((b) => b.textContent?.includes(title));
  assert.ok(r, `choice "${title}"`);
  return r as HTMLButtonElement;
};
async function choose(root: Element, label: string) {
  await click(root.querySelector('button[role="combobox"]') as Element);
  const o = [...root.querySelectorAll('li[role="option"]')].find((x) => x.textContent?.trim() === label);
  assert.ok(o, `option "${label}"`);
  await click(o);
}
const textOf = (el: Element) => el.textContent ?? "";
const reset = () => {
  stub.calls = [];
  stub.fail = {};
  stub.outputs = {};
};
const callsOf = (op: string) => stub.calls.filter((c) => c.op === op);
const inputOf = (root: Element, label: string): HTMLInputElement => {
  const l = [...root.querySelectorAll("label")].find((x) => x.textContent?.trim().startsWith(label));
  assert.ok(l, `field "${label}"`);
  const el = (l.htmlFor ? root.ownerDocument.getElementById(l.htmlFor) : l.querySelector("input")) as HTMLInputElement | null;
  assert.ok(el, `input of "${label}"`);
  return el;
};

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

describe("Q-7: rule history and restore", () => {
  it("the editor lists the revisions; Restore this version asks first, then calls rule_restore with the seen revision and reloads", async () => {
    reset();
    const m = await mount(h(rules.RulesPage));
    await click(button(m.host, "Edit"));
    const editor = dialog("Edit rule (revision 3)");
    const hist = editor.querySelector('section[aria-label="History"]') as HTMLElement;
    assert.ok(hist, "History section in the editor");
    assert.equal(hist.querySelectorAll("li").length, 3);
    assert.match(textOf(hist), /Revision 3restored/);
    assert.match(textOf(hist), /from revision 1/);
    assert.match(textOf(hist), /Sends wait · Hold for my review/);
    assert.equal(hist.querySelector('button[aria-label="Restore revision 3"]'), null, "no restore on the current version");
    const before = callsOf("rules_list").length;
    await click(byLabel(hist, "Restore revision 2"));
    noDialog("Edit rule (revision 3)");
    const confirm = dialog("Restore this version?");
    assert.match(textOf(confirm), /Revision 2 of “No sends” becomes the current rule as revision 4/);
    assert.equal(callsOf("rule_restore").length, 0, "nothing restored before the confirm");
    await click(button(confirm, "Restore"));
    assert.deepEqual(
      callsOf("rule_restore").map((c) => c.input),
      [{ ruleId: "rul_1", rev: 2, expectedRev: 3 }],
    );
    noDialog("Restore this version?");
    assert.ok(callsOf("rules_list").length > before, "the list reloads");
    await m.unmount();
  });

  it("a refused restore shows the writer's reason inside the confirm dialog; Cancel restores nothing", async () => {
    reset();
    stub.fail.rule_restore = { status: 400, code: "input_invalid", message: "revision 2 can’t be restored: app “crm” does not declare operation “export_all”" };
    const m = await mount(h(rules.RulesPage));
    await click(button(m.host, "Edit"));
    await click(byLabel(dialog("Edit rule (revision 3)"), "Restore revision 2"));
    await click(button(dialog("Restore this version?"), "Restore"));
    const confirm = dialog("Restore this version?");
    assert.match(confirm.querySelector('[role="alert"]')?.textContent ?? "", /can’t be restored: app “crm” does not declare/);
    await click(button(confirm, "Cancel"));
    noDialog("Restore this version?");
    await m.unmount();
  });

  it("Show deleted rules lists them with a deleted tag and History; restoring one brings it back", async () => {
    reset();
    const m = await mount(h(rules.RulesPage));
    assert.equal(m.host.querySelectorAll(".item").length, 1);
    await click(m.host.querySelector('input[role="switch"]') as Element);
    assert.deepEqual(callsOf("rules_list").at(-1)?.input, { includeDeleted: true });
    const rows = [...m.host.querySelectorAll(".item")];
    assert.equal(rows.length, 2);
    const gone = rows[1] as Element;
    assert.match(textOf(gone), /Old hold/);
    assert.ok([...gone.querySelectorAll(".tb-tag")].some((t) => t.textContent === "deleted"));
    assert.equal([...gone.querySelectorAll("button")].filter((b) => b.textContent === "Edit" || b.textContent === "Delete").length, 0, "a deleted rule has no Edit or Delete");
    await click(byLabel(gone, "History of Old hold"));
    const hist = dialog("Old hold");
    assert.ok(hist.querySelector('button[aria-label="Restore revision 2"]'), "the deleted revision can be restored");
    await click(byLabel(hist, "Restore revision 1"));
    const confirm = dialog("Restore this version?");
    assert.match(textOf(confirm), /apply again at once/);
    await click(button(confirm, "Restore"));
    assert.deepEqual(
      callsOf("rule_restore").map((c) => c.input),
      [{ ruleId: "rul_2", rev: 1, expectedRev: 2 }],
    );
    await m.unmount();
  });
});

describe("Q-9: start from a template", () => {
  it("empty state and header offer templates; pick, fill the agent, the editor opens prefilled; nothing is saved before Save rule", async () => {
    reset();
    stub.outputs.rules_list = LIST([]);
    const m = await mount(h(rules.RulesPage));
    const empty = m.host.querySelector(".tb-empty") as Element;
    assert.ok(empty, "empty state");
    assert.ok(button(empty, "Start from a template"), "in the empty state");
    assert.ok(button(m.host.querySelector(".page-head") as Element, "Start from a template"), "next to New rule");
    await click(button(empty, "Start from a template"));
    const pick = dialog("Start from a template");
    assert.equal(pick.querySelectorAll('button[role="radio"]').length, 4, "the team template shows while Governance teams are known");
    await click(radio(pick, "Hold an agent’s outward actions"));
    assert.ok(button(pick, "Continue").disabled, "Continue waits for the agent");
    await choose(pick, "Front desk");
    assert.ok(!button(pick, "Continue").disabled);
    await click(button(pick, "Continue"));
    noDialog("Start from a template");
    const editor = dialog("New rule from a template");
    assert.equal(inputOf(editor, "Title").value, "Hold Front desk’s outward actions");
    assert.equal(inputOf(editor, "Reason").value, "Front desk: outward actions wait for you");
    assert.equal(callsOf("rules_set").length, 0, "a template saves nothing by itself");
    await click(button(editor, "Save rule"));
    assert.deepEqual(
      callsOf("rules_set").map((c) => c.input),
      [{ rule: templateSpec("hold-agent-outward", { id: "agt_01J0000000000000000000000A", name: "Front desk" }) }],
    );
    await m.unmount();
  });

  it("a template without a parameter continues at once; the team template is hidden without Governance teams", async () => {
    reset();
    stub.outputs.fleet_status = { ...FLEET, teams: [] };
    const m = await mount(h(rules.RulesPage));
    await click(button(m.host.querySelector(".page-head") as Element, "Start from a template"));
    const pick = dialog("Start from a template");
    assert.equal(pick.querySelectorAll('button[role="radio"]').length, 3);
    assert.equal(
      [...pick.querySelectorAll('button[role="radio"]')].some((b) => b.textContent?.includes("of a team")),
      false,
    );
    await click(radio(pick, "Block destructive actions for bound agents"));
    await click(button(pick, "Continue"));
    const editor = dialog("New rule from a template");
    assert.equal(inputOf(editor, "Title").value, "Block destructive actions for bound agents");
    await click(button(editor, "Cancel"));
    assert.equal(callsOf("rules_set").length, 0);
    await m.unmount();
  });

  it("the team template fills the team chosen from the Governance copy", async () => {
    reset();
    const m = await mount(h(rules.RulesPage));
    await click(button(m.host.querySelector(".page-head") as Element, "Start from a template"));
    const pick = dialog("Start from a template");
    await click(radio(pick, "Hold outward actions of a team"));
    await choose(pick, "Team X");
    await click(button(pick, "Continue"));
    await click(button(dialog("New rule from a template"), "Save rule"));
    assert.deepEqual((callsOf("rules_set")[0]?.input as { rule: unknown } | undefined)?.rule, templateSpec("hold-team-outward", { id: "tm_x", name: "Team X" }));
    await m.unmount();
  });
});
