// The Rules UI inside the ONE app shell, <AppShell> from @opt2-tealbrick/ui (SDK-API §14): rules, drafts from English,
// decision traces and Governance teams, plus the standard Holds and Agents & scopes pages (./standard.tsx).
import { useSession } from "@opt2-tealbrick/miniapp-sdk/client";
import { AppShell, appArt, appColour, Button, Notice, STANDARD_PAGES, Tag } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useState } from "react";
import { AccessPage } from "./access.tsx";
import { errorText, run } from "./api.ts";
import { DecisionsPage } from "./decisions.tsx";
import { DraftsPage } from "./drafts.tsx";
import { RulesPage } from "./rules.tsx";
import { AgentsPage, HoldsPage, portalHref, standardRoutes, useHoldList, useNav } from "./standard.tsx";
import { TeamsPage } from "./teams.tsx";

const NAME = "Rules & Approvals";
/** Where scripts/build-ui.ts puts this app's still (`stills/`, next to this module in the hashed asset directory, C61). */
const STILLS = new URL("./stills/", import.meta.url).href;

/** Shell page id → path under the base `/a/rules/`: Rules is the launch page (manifest `ui.launchPath`), Agents & scopes is `ui.configurePath`. */
const STANDARD = standardRoutes("rules");
const ROUTES = { rules: STANDARD.rules ?? "", access: "access", drafts: "drafts", decisions: "decisions", teams: "teams", holds: STANDARD.holds ?? "holds", agents: STANDARD.agents ?? "configure" };
const OWN_PAGES = [
  { id: "rules", label: "Rules" },
  { id: "access", label: "Access" },
  { id: "drafts", label: "Drafts" },
  { id: "decisions", label: "Decisions" },
  { id: "teams", label: "Teams" },
];
const STANDARD_SHOWN = STANDARD_PAGES.filter((p) => p.id === "holds" || p.id === "agents");

export function App() {
  const { principal, status, signOut } = useSession();
  const nav = useNav(ROUTES, "rules");
  const holds = useHoldList();
  const [portal] = useState(portalHref);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const refreshPending = useCallback(() => {
    run("drafts_list", { status: "pending", limit: 100 })
      .then((d) => {
        setPending(d.drafts.length);
        setPendingError(null);
      })
      .catch((e) => setPendingError(errorText(e)));
  }, []);
  const signedIn = status === "signed_in" && principal;
  useEffect(() => {
    if (status === "signed_in") refreshPending();
  }, [status, refreshPending]);
  const pages = [
    ...OWN_PAGES.map((p) => (p.id === "drafts" ? { ...p, badge: pending || null } : p)),
    ...STANDARD_SHOWN.map((p) => (p.id === "holds" ? { ...p, badge: holds.holds?.length || null } : p)),
  ];
  return (
    <AppShell
      title={NAME}
      colour={appColour("rules")}
      art={appArt("rules", STILLS)}
      portalHref={portal}
      pages={pages}
      current={nav.page}
      onNavigate={nav.go}
      pageHref={nav.href}
      actions={
        signedIn ? (
          <Button
            size="sm"
            onClick={() => {
              setNotice(null);
              signOut().catch(() => setNotice("Couldn’t sign you out. Check your connection and try again."));
            }}
          >
            Sign out
          </Button>
        ) : (
          <Tag status={status === "loading" ? "busy" : "needs-you"}>{status === "loading" ? "Loading" : "Signed out"}</Tag>
        )
      }
      banner={
        status === "signed_out" || notice || pendingError ? (
          <div className="tb-stack">
            {status === "signed_out" ? (
              <Notice tone="needs-you" role="alert">
                Open this app from Portal to sign in.
              </Notice>
            ) : null}
            {notice ? (
              <Notice tone="needs-you" role="alert">
                {notice}
              </Notice>
            ) : null}
            {pendingError ? (
              <Notice tone="needs-you" role="alert">
                <span className="tb-row">
                  <span>Couldn’t check for drafts that wait for you. {pendingError}</span>
                  <Button size="sm" onClick={refreshPending}>
                    Try again
                  </Button>
                </span>
              </Notice>
            ) : null}
          </div>
        ) : null
      }
    >
      {!signedIn ? null : nav.page === "access" ? (
        <AccessPage />
      ) : nav.page === "drafts" ? (
        <DraftsPage onChange={refreshPending} />
      ) : nav.page === "decisions" ? (
        <DecisionsPage />
      ) : nav.page === "teams" ? (
        <TeamsPage />
      ) : nav.page === "holds" ? (
        <HoldsPage list={holds} only={nav.hold} empty="No calls to Rules wait for your approval." />
      ) : nav.page === "agents" ? (
        <AgentsPage />
      ) : (
        <RulesPage onDraftSaved={refreshPending} onOpenDrafts={() => nav.go("drafts")} />
      )}
    </AppShell>
  );
}
