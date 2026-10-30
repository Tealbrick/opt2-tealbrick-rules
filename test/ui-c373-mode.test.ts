// C373c on the Rules page (src/ui) against the real SDK client and a stub server, rendered in happy-dom: the default mode
// card (three plain-English choices; tighter changes at once, looser asks first), the read-only system lines, the dry run's
// mode comparison, and the Decisions page text for a trace the mode decided.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { looser, MODES } from "../src/mode.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-c373-mode");

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
const SYSTEM = [
  { id: "rules-governance-feed", title: "Rules reads Governance", text: "Calls from the Rules app itself to Governance directory_feed are never held or refused by the mode." },
  { id: "platform-standard-ops", title: "Platform hold checks", text: "Standard platform operations are never held or refused by the mode." },
];
const LIST = (rules: unknown[], mode = "verification") => ({
  rules,
  holdSupported: true,
  defaultDecision: mode === "closed" ? "deny" : mode === "verification" ? "hold" : "allow",
  mode: { mode, changedAt: "2026-10-27T08:00:00.000Z", changedBy: "per_01J00000000000000000000OWN" },
  system: SYSTEM,
  catalog: { generatedAt: null, syncedAt: null, error: null, products: 1, productIds: ["connect"] },
});
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
  mode_set: { mode: "closed", previous: "verification", changed: true, changedAt: "2026-10-27T09:00:00.000Z", changedBy: "per_1" },
  rules_preview: {
    mode: "closed",
    decidedBy: "mode",
    exemption: null,
    modeNote: "No rule matches → Closed mode would REFUSE this call",
    decision: "deny",
    answered: "deny",
    reason: "no rule allows this call (Closed mode)",
    ruleId: null,
    ruleTitle: null,
    narrowing: null,
    teams: [],
    callerTeams: [],
    trust: null,
    fleetAvailable: true,
    callerProductUnavailable: false,
    steps: [],
  },
  decisions_list: {
    items: [
      {
        id: "dec_1",
        callId: "cal_01J0000000000000000000001",
        phase: "before",
        at: "2026-10-27T09:00:00.000Z",
        caller: { type: "agent", id: "agt_01J0000000000000000000000A", mode: "free", product: null },
        target: { product: "connect", op: "buzz_dm", effect: "outward" },
        decision: "hold",
        answered: "hold",
        reason: "no rule covers this call (Verification mode)",
        ruleId: null,
        ruleRev: null,
        ruleTitle: null,
        onBehalfOf: null,
        detail: { decidedBy: "mode", mode: "verification" },
        durationUs: 120,
      },
    ],
    nextCursor: null,
  },
});

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/rules/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: ["rules_set", "rule_restore", "mode_set"] });
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

type Rules = typeof import("../src/ui/rules.tsx");
type ModeUi = typeof import("../src/ui/mode.tsx");
type Decisions = typeof import("../src/ui/decisions.tsx");
let rules: Rules;
let modeUi: ModeUi;
let decisions: Decisions;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  rules = (await import(pathToFileURL(join(outDir, "ui", "rules.js")).href)) as Rules;
  modeUi = (await import(pathToFileURL(join(outDir, "ui", "mode.js")).href)) as ModeUi;
  decisions = (await import(pathToFileURL(join(outDir, "ui", "decisions.js")).href)) as Decisions;
});
after(() => rmSync(outDir, { recursive: true, force: true }));

const modeCard = (host: Element) => {
  const c = host.querySelector('section[aria-label="Default mode"]');
  assert.ok(c, "the default mode card");
  return c as HTMLElement;
};
const fieldOf = (root: Element, label: string) => {
  const f = [...root.querySelectorAll("label.tb-field")].find((l) => l.querySelector(".tb-label")?.textContent?.trim() === label);
  assert.ok(f, `field "${label}"`);
  return f as HTMLElement;
};

describe("C373c: default mode on the Rules page", () => {
  it("shows the three modes with plain-English lines, the current one checked, at the top of the page", async () => {
    reset();
    const m = await mount(h(rules.RulesPage));
    const card = modeCard(m.host);
    const page = m.host.querySelector('section[aria-label="Rules"]') as HTMLElement;
    assert.equal([...page.children].indexOf(card), 1, "the card sits right under the page head");
    const radios = [...card.querySelectorAll('button[role="radio"]')];
    assert.deepEqual(radios.map((r) => r.querySelector(".tb-choice-title")?.textContent), ["Permissive", "Verification", "Closed"]);
    assert.deepEqual(radios.map((r) => r.getAttribute("aria-checked")), ["false", "true", "false"]);
    assert.match(textOf(card), /No rule matches: the call waits for your review/);
    assert.match(textOf(card), /No rule matches: the call is refused\./);
    assert.match(textOf(card), /Changed 27 Oct 2026/);
    await m.unmount();
  });

  it("Closed asks first and warns that calls between apps stop too (S3); Switch sends no confirm flag and the page reloads", async () => {
    reset();
    const m = await mount(h(rules.RulesPage));
    const lists = callsOf("rules_list").length;
    await click(radio(modeCard(m.host), "Closed"));
    const d = dialog("Switch to Closed mode?");
    assert.match(textOf(d), /calls that apps make to each other/);
    assert.match(textOf(d), /Access page/);
    assert.equal(callsOf("mode_set").length, 0, "nothing sent before the confirm");
    await click(button(d, "Switch to Closed"));
    assert.deepEqual(callsOf("mode_set").map((c) => c.input), [{ mode: "closed" }]);
    noDialog("Switch to Closed mode?");
    assert.ok(callsOf("rules_list").length > lists, "reloaded");
    await m.unmount();
  });

  it("a looser mode asks first: Keep changes nothing; Switch sends confirm: true", async () => {
    reset();
    const m = await mount(h(rules.RulesPage));
    await click(radio(modeCard(m.host), "Permissive"));
    const d = dialog("Switch to Permissive mode?");
    assert.match(textOf(d), /will run without your review/);
    assert.equal(callsOf("mode_set").length, 0, "nothing sent before the confirm");
    await click(button(d, "Keep Verification"));
    noDialog("Switch to Permissive mode?");
    assert.equal(callsOf("mode_set").length, 0);
    await click(radio(modeCard(m.host), "Permissive"));
    await click(button(dialog("Switch to Permissive mode?"), "Switch to Permissive"));
    assert.deepEqual(callsOf("mode_set").map((c) => c.input), [{ mode: "permissive", confirm: true }]);
    noDialog("Switch to Permissive mode?");
    await m.unmount();
  });

  it("a refused change stays visible in the dialog as the app's own sentence", async () => {
    reset();
    stub.fail.mode_set = { status: 409, code: "confirm_required", message: "Moving from Closed to Verification mode lets calls wait. Confirm to change it." };
    stub.outputs.rules_list = LIST([RULE], "closed");
    const m = await mount(h(rules.RulesPage));
    await click(radio(modeCard(m.host), "Verification"));
    await click(button(dialog("Switch to Verification mode?"), "Switch to Verification"));
    assert.match(textOf(dialog("Switch to Verification mode?")), /Confirm to change it\./);
    await m.unmount();
  });

  it("lists the built-in exemptions as read-only system lines", async () => {
    reset();
    const m = await mount(h(rules.RulesPage));
    const sys = m.host.querySelector('section[aria-label="System lines"]') as HTMLElement;
    assert.ok(sys, "system lines");
    assert.equal(sys.querySelectorAll(".item").length, 2);
    assert.match(textOf(sys), /Rules reads Governance\s*system\s*read-only/);
    assert.equal(sys.querySelectorAll("button").length, 0, "no edit or delete on a system line");
    await m.unmount();
  });

  it("the empty rule list says what the mode does with every call", async () => {
    reset();
    stub.outputs.rules_list = LIST([], "closed");
    const m = await mount(h(rules.RulesPage));
    assert.match(textOf(m.host), /Every agent and app call is refused \(Closed mode\), except the system lines below/);
    await m.unmount();
  });

  it("the dry run compares modes: the chosen mode is sent and the mode outcome is shown", async () => {
    reset();
    const m = await mount(h(rules.RulesPage));
    await click(button(m.host, "New rule"));
    const editor = dialog("New rule");
    await choose(fieldOf(editor, "Default mode"), "Closed");
    await click(button(editor, "Run dry run"));
    assert.equal((callsOf("rules_preview")[0]?.input as { mode?: string } | undefined)?.mode, "closed");
    assert.match(textOf(editor), /No rule matches → Closed mode would REFUSE this call/);
    await m.unmount();
  });

  it("the dry run without a choice uses the current mode (no mode sent)", async () => {
    reset();
    const m = await mount(h(rules.RulesPage));
    await click(button(m.host, "New rule"));
    await click(button(dialog("New rule"), "Run dry run"));
    assert.equal("mode" in ((callsOf("rules_preview")[0]?.input ?? { mode: "missing" }) as object), false);
    await m.unmount();
  });

  it("the Decisions page says when the mode decided", async () => {
    reset();
    const m = await mount(h(decisions.DecisionsPage));
    assert.match(textOf(m.host), /no rule covers this call \(Verification mode\) · decided by Verification mode \(no rule matched\)/);
    assert.equal(modeUi.modeTraceText(null), "");
    assert.equal(modeUi.modeTraceText({ decidedBy: "exemption", mode: "closed" }), " · Closed mode did not apply (system exemption)");
    await m.unmount();
  });

  it("the browser's mode order is the server's (src/mode.ts)", () => {
    assert.deepEqual([...modeUi.MODE_ORDER], [...MODES]);
    for (const a of MODES) for (const b of MODES) assert.equal(modeUi.isLooser(a, b), looser(a, b), `${a} → ${b}`);
  });
});
