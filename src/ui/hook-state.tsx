// C383 (D13): Rules is the workspace's company policy (C378), so a switched-off hook is said on every page of the app, for as long as it is off. It cannot be dismissed.
// The state comes from Rules' own read of Governance (src/hook-watch.ts). Portal says the same from its own hook list.
import { Notice } from "@opt2-tealbrick/ui";
import { useEffect, useState } from "react";
import { type Out, run, when } from "./api.ts";

export type HookStateOut = Out<"hook_state">;

const PORTAL_STEPS = "In Portal, open this workspace, select Rules & Approvals, go to Hooks, and switch it on.";
/** The hook titles Portal lists (manifest `hooks[].title`). */
const CONTEXT_TITLE = "Rules: narrowing for the target app";
const FILTER_TITLE = "Rules: redact results outside the narrowing";
const GATE_TITLE = "Rules: allow, refuse or hold";

/** What the banner says; null = nothing to say. An "unknown" gate is not "off": it says that Rules cannot tell, and the last time it checked a call. */
export function hookStateText(s: HookStateOut | null): { tone: "needs-you" | "neutral"; text: string } | null {
  if (!s) return null;
  if (s.gate === "off") return { tone: "needs-you", text: `Rules is switched off in this workspace. Agents and apps call every app with no check: your rules, holds, the default mode and the company floor stop nothing. ${PORTAL_STEPS.replace("switch it on", `switch on “${GATE_TITLE}”`)}` };
  const off = [s.context === "off" ? CONTEXT_TITLE : null, s.filter === "off" ? FILTER_TITLE : null].filter((t): t is string => t !== null);
  if (off.length > 0) return { tone: "needs-you", text: `A part of Rules is switched off in this workspace: ${off.map((t) => `“${t}”`).join(" and ")}. An allow rule that narrows what a caller reads does not fully apply. ${PORTAL_STEPS}` };
  if (s.gate === "unknown") return { tone: "neutral", text: `Rules cannot tell from here if its hook is on: it finds this out when it reads Governance. ${s.lastGateAt ? `It last checked a call on ${when(s.lastGateAt)}.` : "It has not checked a call yet."} Portal shows the switch: open this workspace, select Rules & Approvals, go to Hooks.` };
  return null;
}

/** Read at start and once a minute, because the owner moves the switch in Portal, in another page. A failed read keeps the last answer: this line is not the place to report it. */
export function useHookState(on: boolean): HookStateOut | null {
  const [state, setState] = useState<HookStateOut | null>(null);
  useEffect(() => {
    if (!on) return;
    let live = true;
    const read = () => {
      run("hook_state", {})
        .then((s) => {
          if (live) setState(s);
        })
        .catch(() => undefined);
    };
    read();
    const t = setInterval(read, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [on]);
  return state;
}

export function HookStateNotice({ state }: { state: HookStateOut | null }) {
  const said = hookStateText(state);
  if (!said) return null;
  return (
    <Notice tone={said.tone} role={said.tone === "needs-you" ? "alert" : "status"}>
      {said.text}
    </Notice>
  );
}
