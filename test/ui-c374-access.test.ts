// C374 Access page (src/ui/access.tsx) against the real SDK client and a stub server, rendered in happy-dom: every agent and
// app is listed; "Set access" saves the built rules with rules_set; a saved setting reads back as one line; "Check" runs the
// real dry run per effect; Remove deletes the setting's rules.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { accessSpecs, askBeforeTopLevel, bulkSetting } from "../src/ui/access-model.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-c374-access");

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
g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);

// ── stub server ────────────────────────────────────────────────────────────
const AGENT = { id: "agt_01J0000000000000000000000A", name: "Front desk", mode: "free", status: "active", access: [] };
let agentRows: unknown[] = [AGENT];
let refuseSet: ((rule: unknown) => { status: number; body: unknown } | undefined) | null = null;
let refuseDelete: ((id: string | undefined) => { status: number; body: unknown } | undefined) | null = null;
const CATALOG = { generatedAt: null, syncedAt: null, error: null, products: 3, productIds: ["connect", "kanban", "rules"], dynamicOps: ["connect.tools"], skipped: [] };
const LIST = (rules: unknown[]) => ({ rules, holdSupported: true, defaultDecision: "allow", mode: { mode: "permissive", changedAt: null, changedBy: null }, system: [], catalog: CATALOG });
const FLEET = { source: "fleet", available: true, revision: 3, syncedAt: "2026-10-17T09:00:00.000Z", error: null, teams: [] };
let saved: unknown[] = [];
let n = 0;
const stub = { calls: [] as { op: string; input: unknown }[] };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const row = (spec: unknown) => ({ id: `rul_${++n}`, rev: 1, spec, source: "owner", createdAt: "2026-10-28T09:00:00.000Z", updatedAt: "2026-10-28T09:00:00.000Z", problem: null, deleted: false });
const PREVIEW = { mode: "permissive", decidedBy: "rule", exemption: null, modeNote: null, decision: "hold", answered: "hold", reason: "x", ruleId: "rul_2", ruleTitle: "Access · Front desk · outward: hold", narrowing: null, teams: [], callerTeams: [], trust: null, callerTrust: null, fleetAvailable: true, callerProductUnavailable: false, recipientsUnknown: false, workflowUnavailable: false, steps: [] };

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/rules/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: ["rules_set", "rules_delete", "mode_set"] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: { rule?: unknown; id?: string } };
  stub.calls.push({ op, input: body.input });
  const out: Record<string, unknown> = {
    "tb.agents_list": { agents: agentRows },
    fleet_status: FLEET,
    rules_list: LIST(saved),
    rules_preview: PREVIEW,
  };
  if (op === "rules_set") {
    const refused = refuseSet?.(body.input?.rule);
    if (refused) return json(refused.status, refused.body);
    const r = row(body.input?.rule);
    saved.push(r);
    return json(200, { status: "ok", output: { rule: r } });
  }
  if (op === "rules_delete") {
    const held = refuseDelete?.(body.input?.id);
    if (held) return json(held.status, held.body);
    saved = saved.filter((r) => (r as { id: string }).id !== body.input?.id);
    return json(200, { status: "ok", output: { id: body.input?.id, rev: 2 } });
  }
  if (out[op] !== undefined) return json(200, { status: "ok", output: out[op] });
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


type Access = typeof import("../src/ui/access.tsx");
let access: Access;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  access = (await import(pathToFileURL(join(outDir, "ui", "access.js")).href)) as Access;
});
after(() => rmSync(outDir, { recursive: true, force: true }));

const button = (host: Element, text: string, n = 0) => {
  const found = [...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === text)[n];
  assert.ok(found, `button "${text}"`);
  return found as HTMLButtonElement;
};
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).click());
  await flush();
};
const dialog = (title: string): HTMLElement => {
  const d = [...document.querySelectorAll("dialog")].find((x) => x.querySelector("h2")?.textContent?.trim() === title);
  assert.ok(d, `dialog "${title}"`);
  return d as HTMLElement;
};
const callsOf = (op: string) => stub.calls.filter((c) => c.op === op);

describe("C374: Access page", () => {
  it("lists agents and apps (not Rules), saves a setting as the built rules, reads it back, checks it, removes it", async () => {
    const m = await mount(h(access.AccessPage));
    const text = m.host.textContent ?? "";
    assert.match(text, /Front desk/);
    assert.match(text, /connect/);
    assert.match(text, /kanban/);
    assert.equal([...m.host.querySelectorAll("h3")].some((x) => x.textContent?.trim().startsWith("rules")), false, "Rules itself is not offered");
    assert.match(text, /Not set: your rules and the default mode \(Permissive\) decide/);
    await click(button(m.host, "Set access"));
    const d = dialog("Access of Front desk");
    assert.match(d.textContent ?? "", /What this does/);
    await click(button(d, "Save access"));
    const want = accessSpecs({ type: "agent", id: AGENT.id, name: "Front desk" }, { level: 2, beyond: "hold" }, CATALOG);
    assert.deepEqual(callsOf("rules_set").map((c) => (c.input as { rule: unknown }).rule), want);
    assert.match(m.host.textContent ?? "", /Read and change · beyond that: waits for your review · every app/);
    await click(button(m.host, "Check"));
    assert.equal(callsOf("rules_preview").length, 5, "one dry run per effect");
    assert.match(m.host.textContent ?? "", /by Access · Front desk · outward: hold/);
    await click(button(m.host, "Remove"));
    assert.equal(callsOf("rules_delete").length, want.length);
    assert.equal(saved.length, 0);
    await m.unmount();
  });

  // ── C382 batch 2 ─────────────────────────────────────────────────────────
  const A = { id: "agt_A", name: "Alpha", mode: "free", status: "active", access: [] };
  const B = { id: "agt_B", name: "QA Beta", mode: "free", status: "active", access: [] };
  const C = { id: "agt_C", name: "QA Gamma", mode: "free", status: "active", access: [] };
  const D = { id: "agt_D", name: "Delta", mode: "free", status: "active", access: [] };
  const caller = (a: { id: string; name: string }) => ({ type: "agent" as const, id: a.id, name: a.name });
  const seed = () => {
    stub.calls = [];
    refuseSet = null;
    agentRows = [A, B, C, D];
    saved = [];
    for (const spec of accessSpecs(caller(A), { level: 1, beyond: "deny", apps: ["connect"], tools: ["gmail_send"] }, CATALOG)) saved.push(row(spec));
    // Delta's rules were edited by hand on the Rules page: one rule no longer matches what its setting builds
    const edited = accessSpecs(caller(D), { level: 2, beyond: "hold" }, CATALOG);
    (edited[0] as { priority: number }).priority = 5;
    for (const spec of edited) saved.push(row(spec));
  };
  const specsFor = (id: string) => saved.map((r) => (r as { spec: { match: { agents?: string[] } } }).spec).filter((x) => x.match.agents?.includes(id));
  const pickName = async (host: Element, name: string) => {
    const o = [...host.querySelectorAll('[role="option"]')].find((x) => x.querySelector(".tb-access-pick-name")?.textContent === name);
    assert.ok(o, `option ${name}`);
    await click(o as Element);
  };

  it("the list: the mode is in plain view at the top; beyond, the refused apps and Remove show for every agent with a setting; a filter narrows it and hides nothing silently", async () => {
    seed();
    const m = await mount(h(access.AccessPage));
    const text = m.host.textContent ?? "";
    assert.match(text, /Default mode: Permissive\./);
    assert.ok(text.indexOf("Default mode: Permissive") < text.indexOf("Alpha"), "the mode comes first");
    assert.match(text, /Read only · beyond that: refused · only connect/);
    assert.match(text, /Apps you do not pick are refused\./);
    assert.match(text, /Not set: your rules and the default mode \(Permissive\) decide/);
    assert.equal([...m.host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Remove").length, 2, "Alpha and Delta");
    assert.match(text, /Remove gives this agent back to the default mode \(Permissive\)\./);
    const input = m.host.querySelector("input") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor((window as unknown as { HTMLInputElement: typeof HTMLInputElement }).HTMLInputElement.prototype, "value")?.set?.call(input, "^(?!QA)");
      input.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
    });
    await flush();
    const after = m.host.textContent ?? "";
    assert.match(after, /The filter shows 2 of 4 agents\./);
    assert.doesNotMatch(after, /QA Beta/);
    await click(button(m.host, "Clear the filter"));
    assert.match(m.host.textContent ?? "", /QA Beta/);
    await m.unmount();
  });

  it("many: one level, by the dialog's save; an agent keeps beyond, apps and tools; one with no setting gets the chosen beyond; there is no way to remove in bulk; a hand edit is left out and named", async () => {
    seed();
    const m = await mount(h(access.AccessPage));
    await click(button(m.host, "Set a level on many"));
    const text = m.host.textContent ?? "";
    assert.match(text, /Default mode: Permissive\./, "the mode stays in view");
    assert.match(text, /Only its level changes\./);
    assert.match(text, /Not listed here, because their rules were edited by hand: Delta\./);
    assert.equal([...m.host.querySelectorAll('[role="option"]')].some((o) => o.textContent?.includes("Delta")), false);
    assert.equal([...m.host.querySelectorAll("button")].some((b) => ["Not set", "Remove"].includes(b.textContent?.trim() ?? "")), false, "no button loosens to the mode");
    assert.match([...m.host.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes("Alpha"))?.textContent ?? "", /beyond that: refused · only connect · only the tools gmail_send/);
    const deltaBefore = JSON.stringify(specsFor("agt_D"));
    await pickName(m.host, "Alpha");
    await pickName(m.host, "QA Beta");
    await click(button(m.host, "Read and change"));
    assert.deepEqual(specsFor("agt_A"), accessSpecs(caller(A), { level: 2, beyond: "deny", apps: ["connect"], tools: ["gmail_send"] }, CATALOG), "only the level moved");
    assert.deepEqual(specsFor("agt_B"), accessSpecs(caller(B), { level: 2, beyond: "hold" }, CATALOG));
    assert.equal(JSON.stringify(specsFor("agt_D")), deltaBefore);
    assert.deepEqual(specsFor("agt_C"), []);
    assert.match(m.host.textContent ?? "", /Alpha and QA Beta: Read and change\. 2 set\./);
    await m.unmount();
  });

  it("many: a setting the level cannot carry fails on its row, and its rules stay; a session failure stops the rest", async () => {
    seed();
    let m = await mount(h(access.AccessPage));
    await click(button(m.host, "Set a level on many"));
    await pickName(m.host, "Alpha");
    await pickName(m.host, "QA Beta");
    const alphaBefore = JSON.stringify(specsFor("agt_A"));
    await click(button(m.host, "Nothing"));
    assert.match(m.host.textContent ?? "", /Failed: Alpha\. With level Nothing no tool can run/);
    assert.equal(JSON.stringify(specsFor("agt_A")), alphaBefore);
    assert.match(m.host.textContent ?? "", /1 set, 1 failed/);
    await m.unmount();

    seed();
    agentRows = Array.from({ length: 12 }, (_, i) => ({ id: `agt_${i}`, name: `QA ${i}`, mode: "free", status: "active", access: [] }));
    saved = [];
    refuseSet = () => ({ status: 401, body: { error: { code: "session_required", message: "sign in" } } });
    m = await mount(h(access.AccessPage));
    await click(button(m.host, "Set a level on many"));
    await click(button(m.host, "Select all shown"));
    await click(button(m.host, "Read only"));
    const tries = callsOf("rules_set").length;
    assert.ok(tries <= 4, `${tries} writes: only those in progress`);
    const done = m.host.textContent ?? "";
    assert.match(done, /Stopped\. You’re signed out\./);
    assert.match(done, /8 not tried/);
    assert.equal(saved.length, 0);
    await m.unmount();
    refuseSet = null;
    agentRows = [AGENT];
    saved = [];
  });

  it("many: two clicks in a row delete the rules of the last read, so no second set stays behind", async () => {
    seed();
    const m = await mount(h(access.AccessPage));
    await click(button(m.host, "Set a level on many"));
    await pickName(m.host, "Alpha");
    await click(button(m.host, "Read and change"));
    await click(button(m.host, "Also outward"));
    assert.deepEqual(specsFor("agt_A"), accessSpecs(caller(A), { level: 3, beyond: "deny", apps: ["connect"], tools: ["gmail_send"] }, CATALOG));
    assert.doesNotMatch(m.host.textContent ?? "", /Failed:/);
    await m.unmount();
  });

  it("many: an old rule that will not go leaves the setting as it was, and a half save says so", async () => {
    seed();
    const before = JSON.stringify(specsFor("agt_A"));
    let m = await mount(h(access.AccessPage));
    await click(button(m.host, "Set a level on many"));
    await pickName(m.host, "Alpha");
    let tried = 0;
    refuseDelete = () => {
      tried++;
      return tried === 1 ? { status: 409, body: { error: { code: "revision_conflict", message: "the rule changed; reload and edit again" } } } : undefined;
    };
    await click(button(m.host, "Read and change"));
    refuseDelete = null;
    assert.equal(JSON.stringify(specsFor("agt_A")), before, "the new rules went again; the old ones stayed");
    assert.match(m.host.textContent ?? "", /Failed: Alpha\. the rule changed/);
    await m.unmount();
    // the second old rule will not go: the first is gone, so the setting is half saved
    seed();
    let deletes = 0;
    refuseDelete = (id) => (++deletes === 2 && id ? { status: 409, body: { error: { code: "revision_conflict", message: "the rule changed; reload and edit again" } } } : undefined);
    m = await mount(h(access.AccessPage));
    await click(button(m.host, "Set a level on many"));
    await pickName(m.host, "Alpha");
    await click(button(m.host, "Read and change"));
    refuseDelete = null;
    assert.match(m.host.textContent ?? "", /Failed: Alpha\. The new level is saved, but some old rules could not be removed\./);
    assert.notEqual(JSON.stringify(specsFor("agt_A")), before);
    await m.unmount();
    saved = [];
    agentRows = [AGENT];
  });

  it("the top level on more than one agent asks first and names the count and what it allows; other levels and one agent do not", () => {
    assert.equal(askBeforeTopLevel(5, 1), null);
    assert.equal(askBeforeTopLevel(4, 25), null);
    assert.match(askBeforeTopLevel(5, 2) ?? "", /This gives 2 agents the level Everything\. They may .*delete and overwrite/);
  });
  it("bulkSetting: the level changes and nothing else", () => {
    const old = { level: 1 as const, beyond: "deny" as const, apps: ["connect"], tools: ["gmail_send"] };
    assert.deepEqual(bulkSetting(old, 3, "hold"), { level: 3, beyond: "deny", apps: ["connect"], tools: ["gmail_send"] });
    assert.deepEqual(bulkSetting(undefined, 3, "hold"), { level: 3, beyond: "hold" });
  });
});
