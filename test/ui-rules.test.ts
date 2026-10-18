// The Rules pages (src/ui) against the real SDK client and a stub server: errors are shown (RUL-01 for Approve / Reject
// of a draft and for the rule editor, RUL-14 for every loader), a draft with a rule that never matches cannot be
// approved (0.2.7). The UI is compiled with the build tsconfig into dist/ui-test-rules and rendered in happy-dom.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-rules");

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
const spec = (title: string, decision: "allow" | "deny" | "hold") => ({ title, active: true, priority: 10, match: { products: ["connect"] }, outcome: { decision, reason: "because" } });
const draft = (id: string, text: string, problems: (string | null)[]) => ({
  id,
  status: "pending",
  text,
  note: "",
  rules: problems.map((_, i) => spec(`Rule ${i + 1}`, "deny")),
  submittedBy: { type: "agent", id: "agt_1", name: "Front desk" },
  source: { kind: "agent" },
  submittedAt: "2026-10-13T09:00:00.000Z",
  decidedAt: null,
  decidedBy: null,
  ruleIds: [],
  problems,
  opTitles: {},
});
const GOOD = draft("drf_good", "Ask me before first messages.", [null]);
const BAD = draft("drf_bad", "Never export the old CRM.", ["app “crm” does not declare operation “export_all”, so the rule would never match."]);
const RULE = { id: "rul_1", rev: 3, spec: spec("No sends", "deny"), source: "owner", createdAt: "2026-10-11T09:00:00.000Z", updatedAt: "2026-10-11T09:00:00.000Z", problem: null };

interface Stub {
  calls: { op: string; input: unknown }[];
  fail: Record<string, { status: number; code: string } | undefined>;
  gate: Record<string, Promise<void> | undefined>;
}
const stub: Stub = { calls: [], fail: {}, gate: {} };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const OUTPUTS: Record<string, unknown> = {
  "tb.agents_list": { agents: [{ id: "agt_1", name: "Front desk", mode: "free", status: "active", access: [] }] },
  fleet_status: { source: "fleet", available: true, revision: 3, syncedAt: "2026-10-17T09:00:00.000Z", error: null, teams: [{ id: "tm_x", name: "Team X", people: 1, agents: 1 }] },
  drafts_list: { drafts: [GOOD, BAD] },
  rules_list: { rules: [RULE], holdSupported: true, defaultDecision: "allow", catalog: { generatedAt: null, syncedAt: null, error: null, products: 3, productIds: ["connect", "crm", "knowledge"] } },
  draft_decide: { draft: GOOD },
  rules_set: { rule: RULE },
  rules_delete: { id: RULE.id, rev: 4 },
  decisions_list: { items: [], nextCursor: null },
  rules_preview: {
    decision: "allow",
    answered: "allow",
    reason: "No rule matched; the default is allow.",
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
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/rules/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: [] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: unknown };
  stub.calls.push({ op, input: body.input });
  await stub.gate[op];
  const failure = stub.fail[op];
  if (failure) return json(failure.status, { error: { code: failure.code, message: `raw upstream text for ${failure.code}`, requestId: "req_1" } });
  if (op in OUTPUTS) return json(200, { status: "ok", output: OUTPUTS[op] });
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
const click = (el: Element) => act(async () => (el as HTMLElement).click());
const button = (host: Element, text: string, n = 0) => {
  const found = [...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === text)[n];
  assert.ok(found, `button "${text}"`);
  return found as HTMLButtonElement;
};
const alerts = (host: Element) => [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? "");
const cards = (host: Element) => [...host.querySelectorAll("article.draft")];
const reset = () => {
  stub.calls = [];
  stub.fail = {};
  stub.gate = {};
};
const callsOf = (op: string) => stub.calls.filter((c) => c.op === op);

type Drafts = typeof import("../src/ui/drafts.tsx");
type Rules = typeof import("../src/ui/rules.tsx");
type Teams = typeof import("../src/ui/teams.tsx");
type Decisions = typeof import("../src/ui/decisions.tsx");
let drafts: Drafts;
let rules: Rules;
let teams: Teams;
let decisions: Decisions;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  const load = (f: string) => import(pathToFileURL(join(outDir, "ui", f)).href);
  drafts = (await load("drafts.js")) as Drafts;
  rules = (await load("rules.js")) as Rules;
  teams = (await load("teams.js")) as Teams;
  decisions = (await load("decisions.js")) as Decisions;
});
after(() => rmSync(outDir, { recursive: true, force: true }));

describe("Drafts page", () => {
  it("a draft with a rule that never matches is badged, explained and cannot be approved; a good one can", async () => {
    reset();
    const m = await mount(h(drafts.DraftsPage, { onChange: () => {} }));
    const [good, bad] = cards(m.host) as [Element, Element];
    assert.ok(!button(good, "Approve and apply").disabled);
    assert.ok(button(bad, "Approve and apply").disabled);
    assert.ok(!button(bad, "Reject").disabled);
    assert.match(bad.textContent ?? "", /never matches/);
    assert.match(bad.textContent ?? "", /can’t be applied/);
    await m.unmount();
  });

  it("RUL-01: a failed Approve shows a plain message in an alert on that draft and keeps it", async () => {
    reset();
    stub.fail.draft_decide = { status: 409, code: "draft_decided" };
    const m = await mount(h(drafts.DraftsPage, { onChange: () => {} }));
    await click(button(cards(m.host)[0] as Element, "Approve and apply"));
    await flush();
    assert.match(alerts(m.host)[0] ?? "", /raw upstream text for draft_decided/, "the app’s own refusal text is shown");
    assert.equal(cards(m.host).length, 2);
    assert.ok(!button(cards(m.host)[0] as Element, "Reject").disabled, "buttons are back after the call");
    stub.fail.draft_decide = { status: 500, code: "internal_error" };
    await click(button(cards(m.host)[0] as Element, "Reject"));
    await flush();
    assert.match(alerts(m.host)[0] ?? "", /Something went wrong/);
    assert.doesNotMatch(alerts(m.host).join(" "), /raw upstream/, "never the raw upstream text of an unknown error");
    await m.unmount();
  });

  it("an approved draft reloads the list and tells the shell (count)", async () => {
    reset();
    let changed = 0;
    const m = await mount(h(drafts.DraftsPage, { onChange: () => changed++ }));
    await click(button(cards(m.host)[0] as Element, "Approve and apply"));
    await flush();
    assert.deepEqual(callsOf("draft_decide").map((c) => c.input), [{ id: "drf_good", decision: "approve" }]);
    assert.equal(changed, 1);
    assert.deepEqual(alerts(m.host), []);
    await m.unmount();
  });

  it("C8: while a decision runs its buttons are disabled and a second click sends nothing", async () => {
    reset();
    let release = () => {};
    stub.gate.draft_decide = new Promise<void>((r) => {
      release = r;
    });
    const m = await mount(h(drafts.DraftsPage, { onChange: () => {} }));
    const approve = button(cards(m.host)[0] as Element, "Approve and apply");
    await act(async () => {
      approve.click();
      approve.click();
    });
    assert.ok(approve.disabled && button(cards(m.host)[0] as Element, "Reject").disabled);
    assert.equal(callsOf("draft_decide").length, 1);
    release();
    await flush();
    await m.unmount();
  });

  it("RUL-14: a failed load is an error with Try again, not “No drafts”", async () => {
    reset();
    stub.fail.drafts_list = { status: 500, code: "internal_error" };
    const m = await mount(h(drafts.DraftsPage, { onChange: () => {} }));
    assert.match(alerts(m.host)[0] ?? "", /Something went wrong/);
    assert.equal(m.host.querySelector(".tb-empty"), null);
    stub.fail.drafts_list = undefined;
    await click(button(m.host, "Try again"));
    await flush();
    assert.equal(cards(m.host).length, 2);
    await m.unmount();
  });
});

describe("Rules page", () => {
  it("RUL-14: a failed load is an error with Try again; a failed team and agent load is named", async () => {
    reset();
    stub.fail.rules_list = { status: 500, code: "internal_error" };
    stub.fail.fleet_status = { status: 503, code: "unavailable" };
    const m = await mount(h(rules.RulesPage));
    const all = alerts(m.host).join(" | ");
    assert.match(all, /Something went wrong/);
    assert.match(all, /Couldn’t load your Governance teams/);
    assert.equal(m.host.querySelector(".tb-empty"), null);
    stub.fail = {};
    await click(button(m.host, "Try again", 0));
    await flush();
    assert.equal(m.host.querySelectorAll(".item").length, 1);
    await m.unmount();
  });

  it("RUL-01: a failed save (stale revision) and a failed delete show their message inside the dialog", async () => {
    reset();
    const m = await mount(h(rules.RulesPage));
    stub.fail.rules_set = { status: 409, code: "revision_conflict" };
    await click(button(m.host, "Edit"));
    await click(button(document.body, "Save rule"));
    await flush();
    const dialog = document.querySelector("dialog") as HTMLElement;
    assert.match(dialog.querySelector('[role="alert"]')?.textContent ?? "", /raw upstream text for revision_conflict/);
    assert.deepEqual(callsOf("rules_set").map((c) => (c.input as { expectedRev: number }).expectedRev), [3], "saving passes the edited revision");
    await click(button(dialog, "Cancel"));
    stub.fail.rules_delete = { status: 500, code: "internal_error" };
    await click(button(m.host, "Delete"));
    await click(button(document.body, "Delete rule"));
    await flush();
    assert.match((document.querySelector("dialog") as HTMLElement).querySelector('[role="alert"]')?.textContent ?? "", /Something went wrong/);
    assert.equal(m.host.querySelectorAll(".item").length, 1, "the rule is still listed");
    await m.unmount();
  });

  it("a rule that never matches is flagged in the list", async () => {
    reset();
    OUTPUTS.rules_list = { ...(OUTPUTS.rules_list as object), rules: [{ ...RULE, problem: "app “crm” does not declare operation “export_all”" }] };
    const m = await mount(h(rules.RulesPage));
    assert.match(m.host.textContent ?? "", /1 rule never matches/);
    const tags = [...m.host.querySelectorAll(".item h3 .tb-tag.needs-you")].map((t) => t.textContent ?? "");
    assert.ok(tags.includes("never matches"), `never matches tag in the rule title, got ${JSON.stringify(tags)}`);
    await m.unmount();
    OUTPUTS.rules_list = { ...(OUTPUTS.rules_list as object), rules: [RULE] };
  });
});

describe("Teams and Decisions pages", () => {
  it("RUL-14: a failed load is an error, not “No teams” or “No decisions”", async () => {
    reset();
    stub.fail.fleet_status = { status: 500, code: "internal_error" };
    stub.fail.decisions_list = { status: 500, code: "internal_error" };
    const t = await mount(h(teams.TeamsPage));
    assert.match(alerts(t.host)[0] ?? "", /Something went wrong/);
    assert.equal(t.host.querySelector(".tb-empty"), null);
    await t.unmount();
    const d = await mount(h(decisions.DecisionsPage));
    assert.match(alerts(d.host)[0] ?? "", /Something went wrong/);
    assert.equal(d.host.querySelector(".tb-empty"), null);
    await d.unmount();
  });
});

const FLEET_OK = OUTPUTS.fleet_status;
const NOTICE = "Governance data unavailable — team rules apply strictly";
const textOf = (host: Element) => host.textContent ?? "";

describe("C236 / G-3: Governance data unavailable", () => {
  it("fire-on-bad: the Rules, Drafts and Teams pages show the exact notice while Rules cannot read Governance", async () => {
    reset();
    OUTPUTS.fleet_status = { source: "none", available: false, revision: null, syncedAt: null, error: "Governance not reachable: no_grant: no grant", teams: [] };
    for (const [name, el] of [
      ["rules", h(rules.RulesPage)],
      ["drafts", h(drafts.DraftsPage, { onChange: () => {} })],
    ] as const) {
      const m = await mount(el);
      assert.ok(textOf(m.host).includes(NOTICE), `${name}: notice shown`);
      assert.equal([...m.host.querySelectorAll(".tb-notice")].filter((n) => n.textContent === NOTICE).length, 1, "exactly once");
      await m.unmount();
    }
    const t = await mount(h(teams.TeamsPage));
    assert.match(textOf(t.host), /Governance not readable|No Governance/);
    assert.match(textOf(t.host), /allow rules that name them do not/);
    await t.unmount();
    OUTPUTS.fleet_status = FLEET_OK;
  });

  it("quiet-on-good: no notice when Governance is available, nor while the status itself failed to load", async () => {
    reset();
    const m = await mount(h(rules.RulesPage));
    assert.ok(!textOf(m.host).includes(NOTICE));
    await m.unmount();
    stub.fail.fleet_status = { status: 500, code: "internal_error" };
    const m2 = await mount(h(rules.RulesPage));
    assert.ok(!textOf(m2.host).includes(NOTICE), "unknown is not 'unavailable'");
    await m2.unmount();
  });
});

describe("G-3: match fields and who proposed a draft", () => {
  it("the Drafts page says 'proposed by <app>' for an app, 'from <agent>' for an agent", async () => {
    reset();
    const byApp = { ...draft("drf_app", "Hold sends for team X.", [null]), source: { kind: "app", name: "Governance", instance: "ins_1" }, submittedBy: { type: "app", id: "ins_1", name: "Governance" } };
    const saved = OUTPUTS.drafts_list;
    OUTPUTS.drafts_list = { drafts: [byApp, GOOD] };
    const m = await mount(h(drafts.DraftsPage, { onChange: () => {} }));
    const [app, agent] = cards(m.host) as [Element, Element];
    assert.match(textOf(app), /proposed by an app named Governance \(unverified\)/);
    assert.doesNotMatch(textOf(agent), /proposed by/);
    assert.match(textOf(agent), /from Front desk/);
    await m.unmount();
    OUTPUTS.drafts_list = saved;
  });

  it("the Drafts page shows the verified product of an app, with the name only as its own label", async () => {
    reset();
    const byApp = { ...draft("drf_app", "Hold sends for team X.", [null]), source: { kind: "app", product: "fleet", name: "Observer", instance: "ins_1" }, submittedBy: { type: "app", id: "fleet", name: "Observer" } };
    const saved = OUTPUTS.drafts_list;
    OUTPUTS.drafts_list = { drafts: [byApp] };
    const m = await mount(h(drafts.DraftsPage, { onChange: () => {} }));
    const [app] = cards(m.host) as [Element];
    assert.match(textOf(app), /proposed by the app fleet \(called itself “Observer”\)/);
    assert.doesNotMatch(textOf(app), /unverified/);
    await m.unmount();
    OUTPUTS.drafts_list = saved;
  });

  it("a rule list line names caller teams and requester trust", async () => {
    reset();
    const r = { ...RULE, spec: { ...spec("Team X holds", "hold"), match: { callerTeams: ["tm_x"], onBehalfOf: { trust: ["unreviewed", "blocked"] } } } };
    const saved = OUTPUTS.rules_list;
    OUTPUTS.rules_list = { ...(saved as object), rules: [r] };
    const m = await mount(h(rules.RulesPage));
    assert.match(textOf(m.host), /caller in team Team X/);
    assert.match(textOf(m.host), /requester trust unreviewed, blocked/);
    await m.unmount();
    OUTPUTS.rules_list = saved;
  });
});

// ── C237 / 0.3.1: calls from apps ──────────────────────────────────────────────────────────────────────────────
const optionOf = (root: Element, label: string) => {
  const found = [...root.querySelectorAll('[role="option"]')].find((o) => o.textContent === label);
  assert.ok(found, `option "${label}"`);
  return found as HTMLElement;
};
const inputOf = (root: Element, label: string) => {
  const field = [...root.querySelectorAll("label.tb-field")].find((l) => l.querySelector(".tb-label")?.textContent === label);
  return (field?.querySelector("input") ?? null) as HTMLInputElement | null;
};
const chipOf = (root: Element, group: string, label: string) => {
  const g = root.querySelector(`[role="group"][aria-label="${group}"]`);
  assert.ok(g, `chip group "${group}"`);
  const chip = [...(g as Element).querySelectorAll("button")].find((b) => b.textContent === label);
  assert.ok(chip, `chip "${label}" in "${group}"`);
  return chip as HTMLButtonElement;
};
const typeInto = (el: HTMLInputElement, value: string) =>
  act(async () => {
    const set = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
    set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const NO_PRODUCT_NOTICE = /The calling app’s product can’t be verified, so refuse and hold rules that name apps \(calls from\) apply and allow rules that name them do not\./;
const lastCall = (op: string) => callsOf(op).at(-1)?.input as Record<string, any>;

describe("C237: calls from apps", () => {
  it("a rule list line names the apps a rule is for; a rule without the criterion says nothing about apps", async () => {
    reset();
    const r = { ...RULE, spec: { ...spec("Watch apps", "hold"), match: { callerProducts: ["knowledge", "crm"] } } };
    const saved = OUTPUTS.rules_list;
    OUTPUTS.rules_list = { ...(saved as object), rules: [r, RULE] };
    const m = await mount(h(rules.RulesPage));
    const lines = [...m.host.querySelectorAll(".item p")].map((p) => p.textContent ?? "");
    assert.match(lines[0] ?? "", /^calls from app knowledge, crm → because/);
    assert.doesNotMatch(lines[1] ?? "", /calls from app/);
    await m.unmount();
    OUTPUTS.rules_list = saved;
  });

  it("the editor offers the catalog's apps as chips and saves the chosen ones; untouched, it sends no callerProducts", async () => {
    reset();
    const m = await mount(h(rules.RulesPage));
    await click(button(m.host, "Edit"));
    const dialog = document.querySelector("dialog") as HTMLElement;
    const group = dialog.querySelector('[role="group"][aria-label="Calls from apps"]');
    assert.deepEqual([...(group?.querySelectorAll("button") ?? [])].map((b) => b.textContent), ["connect", "crm", "knowledge"], "the catalog's product ids");
    assert.match(dialog.textContent ?? "", /An app is identified by its verified product, never by its name; an agent never matches/);
    await click(button(dialog, "Save rule"));
    await flush();
    assert.equal("callerProducts" in lastCall("rules_set").rule.match, false, "quiet: nothing chosen");
    await click(button(m.host, "Edit"));
    const again = document.querySelector("dialog") as HTMLElement;
    await click(chipOf(again, "Calls from apps", "knowledge"));
    await click(chipOf(again, "Calls from apps", "crm"));
    assert.equal(chipOf(again, "Calls from apps", "crm").getAttribute("aria-pressed"), "true");
    await click(button(again, "Save rule"));
    await flush();
    assert.deepEqual(lastCall("rules_set").rule.match.callerProducts, ["knowledge", "crm"]);
    await m.unmount();
  });

  it("a rule that names an app the catalog does not list keeps it as a chip, and the app can be switched off", async () => {
    reset();
    const r = { ...RULE, spec: { ...RULE.spec, match: { callerProducts: ["old-app"] } } };
    const saved = OUTPUTS.rules_list;
    OUTPUTS.rules_list = { ...(saved as object), rules: [r] };
    const m = await mount(h(rules.RulesPage));
    await click(button(m.host, "Edit"));
    const dialog = document.querySelector("dialog") as HTMLElement;
    assert.equal(chipOf(dialog, "Calls from apps", "old-app").getAttribute("aria-pressed"), "true");
    await click(chipOf(dialog, "Calls from apps", "old-app"));
    await click(button(dialog, "Save rule"));
    await flush();
    assert.equal("callerProducts" in lastCall("rules_set").rule.match, false, "nothing named any more: any caller");
    await m.unmount();
    OUTPUTS.rules_list = saved;
  });

  it("dry run as an app: it sends the app and its product (none when left empty), and says when the product was unavailable", async () => {
    reset();
    const saved = OUTPUTS.rules_preview;
    const m = await mount(h(rules.RulesPage));
    await click(button(m.host, "New rule"));
    const dialog = document.querySelector("dialog") as HTMLElement;
    assert.equal(inputOf(dialog, "App product"), null, "an agent caller has no product field");
    assert.ok(dialog.querySelector('[aria-label="Try a call"]')?.textContent?.includes("Mode"), "it has a mode");
    await click(optionOf(dialog, "An app"));
    assert.ok(!dialog.querySelector('[aria-label="Try a call"]')?.textContent?.includes("Mode"), "an app has no mode");
    const product = inputOf(dialog, "App product") as HTMLInputElement;
    assert.ok(product, "an app caller has a product field");
    await typeInto(product, "knowledge");
    await click(button(dialog, "Run dry run"));
    await flush();
    assert.deepEqual(lastCall("rules_preview").call.caller, { type: "app", id: "ins_preview", product: "knowledge" });
    assert.doesNotMatch(dialog.textContent ?? "", NO_PRODUCT_NOTICE, "quiet: the product was given");
    // no product: the dry run sends none and shows the notice the answer asks for
    OUTPUTS.rules_preview = { ...(saved as object), decision: "deny", answered: "deny", reason: "no", ruleId: "rul_1", ruleTitle: "No sends", callerProductUnavailable: true, steps: [{ ruleId: "rul_1", title: "No sends", matched: true, why: "matches: the calling app's verified product is unavailable, so this rule applies (fail closed)" }] };
    await typeInto(product, "");
    await click(button(dialog, "Run dry run"));
    await flush();
    assert.deepEqual(lastCall("rules_preview").call.caller, { type: "app", id: "ins_preview" });
    assert.match(dialog.textContent ?? "", NO_PRODUCT_NOTICE);
    assert.match(dialog.textContent ?? "", /the calling app's verified product is unavailable, so this rule applies/);
    await m.unmount();
    OUTPUTS.rules_preview = saved;
  });

  it("dry run as an agent is unchanged: type agent with a mode, no product, no product notice", async () => {
    reset();
    const m = await mount(h(rules.RulesPage));
    await click(button(m.host, "New rule"));
    const dialog = document.querySelector("dialog") as HTMLElement;
    await click(button(dialog, "Run dry run"));
    await flush();
    assert.deepEqual(lastCall("rules_preview").call.caller, { type: "agent", id: "agt_1", mode: "free" });
    assert.doesNotMatch(dialog.textContent ?? "", NO_PRODUCT_NOTICE);
    await m.unmount();
  });

  it("the Decisions page names an app by its verified product and says when the product could not be verified", async () => {
    reset();
    const item = (id: string, caller: Record<string, unknown>, detail: unknown) => ({
      id,
      callId: `cal_${id}`,
      phase: "before",
      at: "2026-10-18T09:00:00.000Z",
      caller,
      target: { product: "connect", op: "buzz_dm", effect: "outward" },
      decision: "deny",
      answered: "deny",
      reason: "no",
      ruleId: "rul_1",
      ruleRev: 1,
      ruleTitle: "No sends",
      onBehalfOf: null,
      detail,
      durationUs: 10,
    });
    const saved = OUTPUTS.decisions_list;
    OUTPUTS.decisions_list = {
      items: [
        item("dec_a", { type: "app", id: "ins_01J000000000000000000000AA", mode: null, product: "knowledge" }, null),
        item("dec_b", { type: "app", id: "ins_01J000000000000000000000BB", mode: null, product: null }, { callerProductUnavailable: true }),
      ],
      nextCursor: null,
    };
    const m = await mount(h(decisions.DecisionsPage));
    const [verified, unverified] = [...m.host.querySelectorAll(".item")].map((e) => e.textContent ?? "");
    assert.match(verified ?? "", /app knowledge \(instance ins_01J000…\)/);
    assert.doesNotMatch(verified ?? "", /could not be verified/);
    assert.match(unverified ?? "", /app ins_01J000000000000000000000BB/);
    assert.match(unverified ?? "", /the calling app’s product could not be verified, so this rule applied strictly/);
    await m.unmount();
    OUTPUTS.decisions_list = saved;
  });
});
