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
import { accessSpecs } from "../src/ui/access-model.ts";

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

// ── stub server ────────────────────────────────────────────────────────────
const AGENT = { id: "agt_01J0000000000000000000000A", name: "Front desk", mode: "free", status: "active", access: [] };
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
    "tb.agents_list": { agents: [AGENT] },
    fleet_status: FLEET,
    rules_list: LIST(saved),
    rules_preview: PREVIEW,
  };
  if (op === "rules_set") {
    const r = row(body.input?.rule);
    saved.push(r);
    return json(200, { status: "ok", output: { rule: r } });
  }
  if (op === "rules_delete") {
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
    assert.match(text, /Not set: your rules and the default mode decide/);
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
});
