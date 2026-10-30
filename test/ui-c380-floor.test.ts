// C380 on the Rules page (src/ui/floor.tsx) against the real SDK client and a stub server, in happy-dom: the company floor card in each state
// (loading, empty, error, Governance gone), one line per holder, Clear asks first and says the entry can come back; no raw id outside Details.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-c380-floor");

const win = new Window({ url: "http://localhost/a/rules/", width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "sessionStorage", "HTMLElement", "HTMLButtonElement", "HTMLDialogElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "CustomEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true;

const AGENT = "agt_01J0000000000000000000000A";
const STOPPED = {
  entries: [
    { kind: "agent", id: AGENT, code: "leaving", holder: `agent:${AGENT}`, revision: 7, at: "2026-10-30T16:00:00.000Z" },
    { kind: "contact", id: "ct_left", code: "blocked", holder: "contact:ct_left", revision: 7, at: "2026-10-30T15:00:00.000Z" },
    { kind: "handle", id: "slack:U666", code: "blocked", holder: "contact:ct_left", revision: 7, at: "2026-10-30T15:00:00.000Z" },
  ],
  total: 3,
  feedRevision: 7,
  readAt: "2026-10-30T16:00:00.000Z",
  lastGateAt: "2026-10-30T16:01:00.000Z",
  governanceReadable: true,
};
const EMPTY = { ...STOPPED, entries: [], total: 0 };
interface Stub {
  calls: { op: string; input: unknown }[];
  fail: Record<string, { status: number; code: string; message?: string } | undefined>;
  floor: unknown;
}
const stub: Stub = { calls: [], fail: {}, floor: STOPPED };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/rules/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: ["floor_clear"] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: unknown };
  stub.calls.push({ op, input: body.input });
  const failure = stub.fail[op];
  if (failure) return json(failure.status, { error: { code: failure.code, message: failure.message ?? `raw upstream text for ${failure.code}`, requestId: "req_1" } });
  if (op === "floor_list" && stub.floor === "hang") return new Promise<Response>(() => {});
  if (op === "floor_list") return json(200, { status: "ok", output: stub.floor });
  if (op === "floor_clear") return json(200, { status: "ok", output: { cleared: 1 } });
  return json(404, { error: { code: "unknown_op", message: op } });
}) as typeof fetch;

type Mounted = { host: HTMLElement; unmount: () => Promise<void> };
let floor: typeof import("../src/ui/floor.tsx");
let h: typeof import("react").createElement;
let act: (cb: () => unknown) => Promise<void>;
let createRoot: typeof import("react-dom/client").createRoot;

async function mount(el: ReactElement): Promise<Mounted> {
  const host = document.createElement("div");
  document.body.append(host);
  const r = createRoot(host);
  await act(async () => {
    r.render(el);
    await new Promise((res) => setTimeout(res, 20));
  });
  return {
    host,
    unmount: async () => {
      await act(async () => r.unmount());
      host.remove();
    },
  };
}
const textOf = (n: Element) => (n.textContent ?? "").replace(/\s+/g, " ").trim();
const button = (scope: ParentNode, name: string) => [...scope.querySelectorAll("button")].find((b) => textOf(b) === name) as HTMLButtonElement;
const click = (b: HTMLElement) =>
  act(async () => {
    b.dispatchEvent(new (globalThis as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent("click", { bubbles: true }));
    await new Promise((res) => setTimeout(res, 20));
  });
const name = (id: string) => (id === AGENT ? "Front desk" : id);

describe("Company floor card", () => {
  before(async () => {
    const r = spawnSync(process.execPath, ["--run", "kit"], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const b = spawnSync("node_modules/.bin/tsc", ["-p", "tsconfig.build.json", "--outDir", outDir, "--noEmit", "false"], { cwd: root, encoding: "utf8" });
    assert.equal(b.status, 0, b.stdout);
    floor = await import(pathToFileURL(join(outDir, "ui", "floor.js")).href);
    const react = await import("react");
    h = react.createElement;
    act = react.act as never;
    createRoot = (await import("react-dom/client")).createRoot;
  });
  after(() => rmSync(outDir, { recursive: true, force: true }));

  it("lists one line per holder, in plain words; raw ids and handles only under Details", async () => {
    stub.floor = STOPPED;
    const m = await mount(h(floor.FloorCard, { agentName: name }));
    const items = [...m.host.querySelectorAll(".item")];
    assert.equal(items.length, 2);
    assert.match(textOf(items[0] as Element), /Front desk\s*Leaving since/);
    assert.match(textOf(items[1] as Element), /A person in Governance\s*Blocked since .*1 channel handle/);
    for (const it of items) {
      const copy = it.cloneNode(true) as Element;
      copy.querySelector("details")?.remove();
      assert.ok(!/agt_|ct_left|slack:/.test(textOf(copy)), textOf(copy));
    }
    assert.ok((items[1] as Element).querySelector("details")?.textContent?.includes("slack:U666"));
    assert.ok(button(m.host, "Clear all"));
    await m.unmount();
  });

  it("loading: says so, and shows no list or Clear yet", async () => {
    stub.floor = "hang";
    const m = await mount(h(floor.FloorCard, { agentName: name }));
    assert.match(textOf(m.host.querySelector('[role="status"]') as Element), /Loading the company floor/);
    assert.equal(m.host.querySelectorAll("button").length, 0);
    await m.unmount();
  });

  it("empty: says nobody is stopped and when it last read; no Clear", async () => {
    stub.floor = EMPTY;
    const m = await mount(h(floor.FloorCard, { agentName: name }));
    assert.match(textOf(m.host), /Nobody is stopped\. Last read from Governance/);
    assert.equal(m.host.querySelectorAll("button").length, 0);
    await m.unmount();
  });

  it("never read: says so", async () => {
    stub.floor = { ...EMPTY, readAt: null, governanceReadable: false };
    const m = await mount(h(floor.FloorCard, { agentName: name }));
    assert.match(textOf(m.host), /Rules has not read this from Governance yet/);
    assert.equal(m.host.querySelector('[role="status"]'), null, "nothing to warn about");
    await m.unmount();
  });

  it("Governance gone: the list stays, and the card says so", async () => {
    stub.floor = { ...STOPPED, governanceReadable: false };
    const m = await mount(h(floor.FloorCard, { agentName: name }));
    assert.match(textOf(m.host.querySelector('[role="status"]') as Element), /Governance cannot be read now\. This list stays as it was/);
    assert.equal(m.host.querySelectorAll(".item").length, 2);
    await m.unmount();
  });

  it("error: plain text and Try again, never raw upstream text", async () => {
    stub.fail.floor_list = { status: 500, code: "internal_error" };
    const m = await mount(h(floor.FloorCard, { agentName: name }));
    const alert = m.host.querySelector('[role="alert"]') as Element;
    assert.ok(alert);
    assert.ok(!textOf(alert).includes("raw upstream"));
    stub.fail.floor_list = undefined;
    stub.floor = EMPTY;
    await click(button(alert, "Try again"));
    assert.match(textOf(m.host), /Nobody is stopped/);
    await m.unmount();
  });

  it("Clear asks first, says it can come back, sends the holder, then reloads; a failure stays in the dialog", async () => {
    stub.floor = STOPPED;
    stub.calls = [];
    const m = await mount(h(floor.FloorCard, { agentName: name }));
    await click(button(m.host.querySelector(".item") as Element, "Clear"));
    assert.equal(stub.calls.filter((c) => c.op === "floor_clear").length, 0, "nothing sent yet");
    const dialog = () => [...document.querySelectorAll("dialog, [role='dialog']")].find((d) => textOf(d).includes("Clear Front desk?")) as Element;
    assert.match(textOf(dialog()), /If Governance still lists this, it comes back at the next read/);
    stub.fail.floor_clear = { status: 500, code: "internal_error" };
    await click(button(dialog(), "Clear"));
    assert.ok(dialog().querySelector('[role="alert"]'));
    stub.fail.floor_clear = undefined;
    stub.floor = EMPTY;
    await click(button(dialog(), "Clear"));
    assert.deepEqual(stub.calls.filter((c) => c.op === "floor_clear").at(-1)?.input, { confirm: true, holder: `agent:${AGENT}` });
    assert.match(textOf(m.host), /Nobody is stopped/);
    await m.unmount();
  });

  it("Clear all sends no holder", async () => {
    stub.floor = STOPPED;
    stub.calls = [];
    const m = await mount(h(floor.FloorCard, { agentName: name }));
    await click(button(m.host, "Clear all"));
    const dialog = [...document.querySelectorAll("dialog, [role='dialog']")].find((d) => textOf(d).includes("Clear everyone on this list?")) as Element;
    await click(button(dialog, "Clear"));
    assert.deepEqual(stub.calls.filter((c) => c.op === "floor_clear").at(-1)?.input, { confirm: true });
    await m.unmount();
  });
});
