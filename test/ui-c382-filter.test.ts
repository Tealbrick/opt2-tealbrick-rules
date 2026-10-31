// The list filters of Rules (C382 batch 4): the rule list (text and agent), the editor's chips (filter and "Select all shown") and the
// Decisions log. Each says N of M and has Clear, a remembered filter shows after a reload, the paged log says its text reads only the
// loaded rows with Load more in reach, and a filter never unselects a chip it hides. Compiled with the build tsconfig and rendered in happy-dom.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-c382-filter");

const win = new Window({ url: "http://localhost/a/rules/", width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "sessionStorage", "localStorage", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLDialogElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true;

const AGENTS = Array.from({ length: 10 }, (_, i) => ({ id: `agt_${i}`, name: `Agent ${String(i).padStart(2, "0")}`, mode: "free", status: "active", access: [] }));
const TEAMS = Array.from({ length: 3 }, (_, i) => ({ id: `tm_${i}`, name: `Team ${i}`, people: 1, agents: 1 }));
const rule = (n: number) => ({
  id: `rul_${n}`,
  rev: 1,
  spec: { title: `Rule ${String(n).padStart(2, "0")}`, active: true, priority: n, match: n % 2 ? { agents: [`agt_${n % 4}`] } : { products: ["connect"] }, outcome: { decision: "deny", reason: `Reason ${n}` } },
  source: "owner",
  createdAt: "2026-10-11T09:00:00.000Z",
  updatedAt: "2026-10-11T09:00:00.000Z",
  problem: null,
});
const decisionRow = (n: number) => ({
  id: `dec_${String(n).padStart(3, "0")}`,
  callId: `cal_${n}`,
  phase: "before",
  at: "2026-10-30T10:00:00.000Z",
  caller: { type: "agent", id: `agt_${n % 3}`, mode: "free", product: null },
  target: { product: "connect", op: n % 2 ? "send_message" : "list_chats", effect: "outward" },
  decision: "deny",
  answered: "deny",
  reason: `Refused number ${n}`,
  ruleId: null,
  ruleRev: null,
  ruleTitle: null,
  onBehalfOf: null,
  detail: null,
  durationUs: 1200,
});

const PAGE = 12;
interface Stub {
  rules: ReturnType<typeof rule>[];
  decisions: ReturnType<typeof decisionRow>[];
  calls: { op: string; input: Record<string, unknown> }[];
}
const stub: Stub = { rules: [], decisions: [], calls: [] };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const catalog = { generatedAt: null, syncedAt: null, error: null, products: 1, productIds: ["connect"] };
const OUTPUTS: Record<string, () => unknown> = {
  "tb.agents_list": () => ({ agents: AGENTS }),
  floor_list: () => ({ entries: [], total: 0, feedRevision: 3, readAt: "2026-10-17T09:00:00.000Z", lastGateAt: null, governanceReadable: true, unlisted: 0, regressed: null }),
  fleet_status: () => ({ source: "fleet", available: true, revision: 3, syncedAt: "2026-10-17T09:00:00.000Z", error: null, teams: TEAMS, roles: [] }),
  drafts_list: () => ({ drafts: [] }),
  rules_list: () => ({ rules: stub.rules, holdSupported: true, defaultDecision: "allow", catalog }),
};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/rules/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: [] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const inp = (JSON.parse(String(init?.body ?? "{}")) as { input?: Record<string, unknown> }).input ?? {};
  stub.calls.push({ op, input: inp });
  if (op === "decisions_list") {
    const all = stub.decisions.filter((d) => (!inp.caller || d.caller.id === inp.caller) && (!inp.decision || d.decision === inp.decision) && (!inp.callId || d.callId === inp.callId));
    const from = inp.cursor ? Number(inp.cursor) : 0;
    return json(200, { status: "ok", output: { items: all.slice(from, from + PAGE), nextCursor: from + PAGE < all.length ? String(from + PAGE) : null } });
  }
  const out = OUTPUTS[op];
  return out ? json(200, { status: "ok", output: out() }) : json(404, { error: { code: "unknown_op", message: op } });
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
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
  });
};
const buttons = (host: Element, label: string) => [...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === label);
const text = (host: Element) => host.textContent ?? "";
const KEY = "tb-filter:/a/rules/:";
const remember = (k: string, v: string) => localStorage.setItem(`${KEY}${k}`, v);
const reset = () => {
  localStorage.clear();
  stub.rules = [];
  stub.decisions = [];
  stub.calls = [];
};

type Rules = typeof import("../src/ui/rules.tsx");
type Decisions = typeof import("../src/ui/decisions.tsx");
let rules: Rules;
let decisions: Decisions;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  const load = (f: string) => import(pathToFileURL(join(outDir, "ui", f)).href);
  rules = (await load("rules.js")) as Rules;
  decisions = (await load("decisions.js")) as Decisions;
});
after(() => rmSync(outDir, { recursive: true, force: true }));

const items = (host: Element) => host.querySelectorAll(".ruled .item").length;
const ruleBar = (host: Element) => host.querySelector(".tb-listfilter input") as HTMLInputElement;

describe("Rule list filter", () => {
  it("a short list shows no filter bar", async () => {
    reset();
    stub.rules = [rule(1), rule(2)];
    const m = await mount(h(rules.RulesPage));
    assert.equal(m.host.querySelector(".tb-listfilter"), null);
    assert.equal(items(m.host), 2);
    await m.unmount();
  });

  it("a long list: text narrows it, N of M, the whole list was read, Clear restores", async () => {
    reset();
    stub.rules = Array.from({ length: 10 }, (_, i) => rule(i));
    const m = await mount(h(rules.RulesPage));
    assert.equal(items(m.host), 10);
    await type(ruleBar(m.host), "Rule 03");
    assert.equal(items(m.host), 1);
    assert.match(text(m.host), /Showing 1 of 10 rules\./);
    assert.doesNotMatch(text(m.host), /loaded so far/, "rules_list answers every rule: nothing is paged");
    await click(buttons(m.host, "Clear filter")[0] as Element);
    assert.equal(items(m.host), 10);
    assert.equal(localStorage.getItem(`${KEY}rules`), "");
    await m.unmount();
  });

  it("the agent a rule names is a filter; a rule that names no agent can be picked; Clear resets the agent and the text", async () => {
    reset();
    stub.rules = Array.from({ length: 10 }, (_, i) => rule(i)); // odd n name agt_(n % 4): agt_1 for 1,5,9; agt_3 for 3,7
    remember("rules:agent", "agt_1");
    const m = await mount(h(rules.RulesPage));
    assert.equal(items(m.host), 3);
    assert.match(text(m.host), /Showing 3 of 10 rules\./);
    remember("rules:agent", "__none");
    await m.unmount();
    const none = await mount(h(rules.RulesPage));
    assert.equal(items(none.host), 5, "the five even rules name no agent");
    await click(buttons(none.host, "Clear filter")[0] as Element);
    assert.equal(items(none.host), 10);
    assert.equal(localStorage.getItem(`${KEY}rules:agent`), "");
    await none.unmount();
  });

  it("a remembered text shows after a reload, even on a short list, and a no-match says all rules were searched", async () => {
    reset();
    stub.rules = [rule(1), rule(2)];
    remember("rules", "zzz");
    const m = await mount(h(rules.RulesPage));
    assert.equal(ruleBar(m.host).value, "zzz");
    assert.match(text(m.host), /Showing 0 of 2 rules\./);
    assert.match(text(m.host), /No rule matches\. The filter searched all 2 rules\./);
    await m.unmount();
  });
});

describe("Editor chips filter", () => {
  const openEditor = async () => {
    const m = await mount(h(rules.RulesPage));
    await click(buttons(m.host, "New rule")[0] as Element);
    const d = document.querySelector("dialog[open], dialog") as HTMLElement;
    assert.ok(d);
    const group = (label: string) => d.querySelector(`[role="group"][aria-label="${label}"]`) as HTMLElement;
    const chips = (label: string) => [...group(label).querySelectorAll("button")];
    const field = (label: string) => group(label).closest(".tb-field") as HTMLElement;
    return { m, d, group, chips, field };
  };

  it("a list of 10 agents gets a filter; Select all shown selects only the chips it shows and says how many", async () => {
    reset();
    const { m, chips, field } = await openEditor();
    assert.equal(chips("Caller agents").length, 10);
    const f = field("Caller agents");
    await type(f.querySelector("input") as HTMLInputElement, "Agent 0[1-3]");
    assert.equal(chips("Caller agents").length, 3);
    assert.match(text(f), /Showing 3 of 10 agents\./);
    await click(buttons(f, "Select all shown")[0] as Element);
    assert.match(text(f), /Selected 3 more agents\./);
    assert.match(text(f), /3 selected\./);
    assert.deepEqual(
      chips("Caller agents").map((c) => c.getAttribute("aria-pressed")),
      ["true", "true", "true"],
    );
    await click(buttons(f, "Clear filter")[0] as Element);
    const pressed = chips("Caller agents").filter((c) => c.getAttribute("aria-pressed") === "true").map((c) => c.textContent?.trim());
    assert.deepEqual(pressed, ["Agent 01", "Agent 02", "Agent 03"], "nothing else was selected");
    await m.unmount();
  });

  it("a pressed chip the filter hides stays pressed and is counted; Unselect all shown leaves it alone", async () => {
    reset();
    const { m, chips, field } = await openEditor();
    const f = () => field("Caller agents");
    await click(chips("Caller agents")[0] as Element); // Agent 00
    await type(f().querySelector("input") as HTMLInputElement, "Agent 0[5-6]");
    assert.equal(chips("Caller agents").length, 2);
    assert.match(text(f()), /1 selected, 1 hidden by the filter\./);
    await click(buttons(f(), "Select all shown")[0] as Element);
    assert.match(text(f()), /3 selected, 1 hidden by the filter\./);
    await click(buttons(f(), "Unselect all shown")[0] as Element);
    assert.match(text(f()), /Unselected 2 agents\. The ones the filter hides stay selected\./);
    assert.match(text(f()), /1 selected, 1 hidden by the filter\./);
    assert.equal(buttons(f(), "Select all shown")[0]?.hasAttribute("disabled"), false);
    await click(buttons(f(), "Clear filter")[0] as Element);
    assert.deepEqual(
      chips("Caller agents").filter((c) => c.getAttribute("aria-pressed") === "true").map((c) => c.textContent?.trim()),
      ["Agent 00"],
    );
    await m.unmount();
  });

  it("a filter with no match disables Select all shown and the chip list says what was searched", async () => {
    reset();
    const { m, chips, field } = await openEditor();
    const f = field("Caller agents");
    await type(f.querySelector("input") as HTMLInputElement, "zzz");
    assert.equal(chips("Caller agents").length, 0);
    assert.match(text(f), /No agent matches\. The filter searched all 10 agents\./);
    assert.equal(buttons(f, "Select all shown")[0]?.hasAttribute("disabled"), true);
    await m.unmount();
  });

  it("a short list of chips (3 teams) shows no filter and no Select all", async () => {
    reset();
    const { m, field } = await openEditor();
    const f = field("Caller is a member of team (from Governance)");
    assert.equal(f.querySelector("input"), null);
    assert.equal(buttons(f, "Select all shown").length, 0);
    await m.unmount();
  });

  it("a remembered chip filter shows in the editor and is counted", async () => {
    reset();
    remember("rules:chips:agents", "Agent 09");
    const { m, chips, field } = await openEditor();
    assert.equal(chips("Caller agents").length, 1);
    assert.match(text(field("Caller agents")), /Showing 1 of 10 agents\./);
    await m.unmount();
  });
});

describe("Decisions filter", () => {
  it("a paged log: a text with no match says it read only the loaded rows and Load more is in reach; Load more reads more", async () => {
    reset();
    stub.decisions = Array.from({ length: PAGE + 3 }, (_, i) => decisionRow(i));
    remember("decisions", "Refused number 13");
    const m = await mount(h(decisions.DecisionsPage));
    assert.equal(items(m.host), 0);
    assert.match(text(m.host), /No loaded decision matches\./);
    assert.match(text(m.host), new RegExp(`The filter searches only the ${PAGE} decisions loaded so far\\.`));
    assert.match(text(m.host), new RegExp(`Showing 0 of ${PAGE} loaded decisions\\.`));
    assert.doesNotMatch(text(m.host), /No decisions recorded yet/);
    const more = buttons(m.host, "Load more");
    assert.ok(more.length >= 1, "Load more is in reach");
    await click(more[0] as Element);
    assert.equal(items(m.host), 1);
    assert.match(text(m.host), /Showing 1 of 15 decisions\./);
    assert.doesNotMatch(text(m.host), /loaded so far/);
    await m.unmount();
  });

  it("a complete log with no match says all rows were searched; Clear restores", async () => {
    reset();
    stub.decisions = Array.from({ length: 5 }, (_, i) => decisionRow(i));
    remember("decisions", "zzz");
    const m = await mount(h(decisions.DecisionsPage));
    assert.match(text(m.host), /No decision matches\. The filter searched all 5 decisions\./);
    await click(buttons(m.host, "Clear filter")[0] as Element);
    assert.equal(items(m.host), 5);
    await m.unmount();
  });

  it("a long log: text narrows the loaded rows and shows N of M", async () => {
    reset();
    stub.decisions = Array.from({ length: 9 }, (_, i) => decisionRow(i));
    const m = await mount(h(decisions.DecisionsPage));
    assert.equal(items(m.host), 9);
    await type(m.host.querySelector(".tb-listfilter input") as HTMLInputElement, "send_message");
    assert.equal(items(m.host), 4);
    assert.match(text(m.host), /Showing 4 of 9 decisions\./);
    assert.doesNotMatch(text(m.host), /loaded so far/, "nothing more to load");
    await m.unmount();
  });

  it("the agent is the server's filter: the call carries caller, the count is not a loaded-rows search, and Clear drops it", async () => {
    reset();
    stub.decisions = Array.from({ length: 60 }, (_, i) => decisionRow(i));
    const m = await mount(h(decisions.DecisionsPage));
    const select = [...m.host.querySelectorAll('button[aria-label="Agent"], [aria-label="Agent"]')].find((e) => e.getAttribute("role") === "combobox" || e.tagName === "BUTTON") as Element;
    assert.ok(select, "the Agent select");
    await click(select);
    const option = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.trim() === "Agent 01") as Element;
    assert.ok(option, "an option for Agent 01");
    await click(option);
    const last = stub.calls.filter((c) => c.op === "decisions_list").at(-1);
    assert.equal(last?.input.caller, "agt_1");
    assert.match(text(m.host), new RegExp(`Showing ${PAGE} of ${PAGE} loaded decisions\\.`));
    assert.doesNotMatch(text(m.host), /searches only/, "no text typed: the server did the filtering");
    await click(buttons(m.host, "Clear filter")[0] as Element);
    assert.equal(stub.calls.filter((c) => c.op === "decisions_list").at(-1)?.input.caller, undefined);
    await m.unmount();
  });

  it("no decisions and no filter: the empty state, no filter bar", async () => {
    reset();
    const m = await mount(h(decisions.DecisionsPage));
    assert.match(text(m.host), /No decisions recorded yet/);
    assert.equal(m.host.querySelector(".tb-listfilter"), null);
    await m.unmount();
  });
});
