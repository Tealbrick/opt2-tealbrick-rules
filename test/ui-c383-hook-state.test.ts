// C383 (D13) on the Rules pages, in happy-dom: the warning when the hook is off (permanent, no dismiss), the "cannot tell" line, nothing when on; holes 3, 8, 9 and D12 are said on the page.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-c383-hook");
const win = new Window({ url: "http://localhost/a/rules/", width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "sessionStorage", "localStorage", "HTMLElement", "Element", "Node", "MouseEvent", "Event", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true;

const state = (over: Record<string, unknown> = {}) => ({ gate: "on", context: "on", filter: "on", checkedAt: "2026-11-01T10:00:00.000Z", lastGateAt: "2026-11-01T10:00:00.000Z", ...over });
let mod: typeof import("../src/ui/hook-state.tsx");
let modes: typeof import("../src/ui/mode.tsx");
let h: typeof import("react").createElement;
let act: (cb: () => unknown) => Promise<void>;
let createRoot: typeof import("react-dom/client").createRoot;

async function render(el: unknown): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const r = createRoot(host);
  await act(async () => r.render(el as never));
  return host;
}

describe("Rules hook warning", () => {
  before(async () => {
    const r = spawnSync(process.execPath, ["--run", "kit"], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const b = spawnSync("node_modules/.bin/tsc", ["-p", "tsconfig.build.json", "--outDir", outDir, "--noEmit", "false"], { cwd: root, encoding: "utf8" });
    assert.equal(b.status, 0, b.stdout);
    mod = await import(pathToFileURL(join(outDir, "ui", "hook-state.js")).href);
    modes = await import(pathToFileURL(join(outDir, "ui", "mode.js")).href);
    const react = await import("react");
    h = react.createElement;
    act = react.act as never;
    createRoot = (await import("react-dom/client")).createRoot;
  });
  after(() => rmSync(outDir, { recursive: true, force: true }));

  it("hook off: an alert that says what stops working and where to switch it on, with no button to dismiss it", async () => {
    const host = await render(h(mod.HookStateNotice, { state: state({ gate: "off" }) as never }));
    const n = host.querySelector('[role="alert"]');
    assert.match(n?.textContent ?? "", /Rules is switched off in this workspace/);
    assert.match(n?.textContent ?? "", /company floor stop nothing/);
    assert.match(n?.textContent ?? "", /switch on “Rules: allow, refuse or hold”/);
    assert.equal(host.querySelectorAll("button").length, 0);
  });

  it("hook on: nothing", async () => {
    const host = await render(h(mod.HookStateNotice, { state: state() as never }));
    assert.equal(host.textContent, "");
    assert.equal(mod.hookStateText(null), null);
  });

  it("only the narrowing hooks off: says which, and does not say that all of Rules is off", () => {
    const t = mod.hookStateText(state({ filter: "off" }) as never);
    assert.equal(t?.tone, "needs-you");
    assert.match(t?.text ?? "", /“Rules: redact results outside the narrowing”/);
    assert.doesNotMatch(t?.text ?? "", /^Rules is switched off/);
  });

  it("unknown: says Rules cannot tell, never that it is on or off; names the last check or that none ran", () => {
    const seen = mod.hookStateText(state({ gate: "unknown", context: "unknown", filter: "unknown" }) as never);
    assert.equal(seen?.tone, "neutral");
    assert.match(seen?.text ?? "", /cannot tell/);
    assert.match(seen?.text ?? "", /last checked a call on/);
    assert.match(mod.hookStateText(state({ gate: "unknown", context: "unknown", filter: "unknown", lastGateAt: null }) as never)?.text ?? "", /has not checked a call yet/);
  });

  it("the Rules page says what Rules does not cover, with each limit of the audit", async () => {
    const host = await render(h(modes.RulesLimits));
    const t = host.textContent ?? "";
    assert.match(t, /model provider/);
    assert.match(t, /Team, role and trust rules match agents\./);
    assert.match(t, /Narrowing by dataset works in no app yet/);
    assert.match(t, /allow rule does not let an app send through Connect/);
  });
});
