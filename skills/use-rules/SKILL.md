---
name: use-rules
description: How Rules and Approvals decides your calls, how to ask why, and how to draft a rule from the owner's English.
---
# Using Rules and Approvals

{{agent.name}}, the owner of this workspace keeps rules in Rules and Approvals. Rules checks other apps' calls before they run. It answers allow, refuse or hold, always with a reason.

## When a call is refused or held

- A refusal from Rules starts with `Rules:` and names the rule (for example `(rule rul_…)`). Do not retry the same call. Tell the owner the reason.
- A held call needs the owner's review. Poll the target app's `tb_hold_status` with the `holdId`. After approval, repeat the same call once with the same input.
- Call `rules__rules_explain` to see why your recent calls were allowed, refused or held. Pass `callId` to ask about one call. You see only your own calls.

## Drafting a rule from the owner's English

Rules never calls a model to decide; a model may only help draft. When the owner asks you to set a rule in plain English, you translate it (the owner can also type a rule in Rules itself; its own reader handles simple rules and leaves the rest to you):

1. Read the owner's sentence. Split it into one structured rule per outcome (at most 10).
2. Call `rules__rule_draft_submit` with `text` (the owner's exact words), `rules` (your structured rules) and an optional `note` (your doubts). Send an idempotency key.
3. Tell the owner to open Rules and Approvals, page Drafts, and approve or reject it. Nothing applies before the owner approves.

A structured rule has:
- `title`, `priority` (0..1000, lower runs first; the first matching rule decides), `active`.
- `match` (all named criteria must match; an empty list means any): `agents` (caller ids), `modes` (`free`, `bound`), `products`, `operations` (needs `products`; the app's MANIFEST operation ids, never MCP tool names: Connect's `connect__tools_call` / `tools_search` tools are operation `tools`; a rule naming an operation the app does not declare is refused because it would never match), `tools` (needs `products`; exact, case-sensitive names of tools of a connected service, such as `gmail_send`; it also covers that tool's resolved variants such as `gmail_send__first_contact`, never look-alikes such as `gmail_send_bulk`; name the catalog tool, not a `__` variant, for a dynamic operation such as Connect's `tools`: the rule matches a call that names one of them; if a dynamic call names no tool, a deny or hold rule with `tools` still applies and an allow rule does not), `effects` (`read`, `write`, `outward`, `destructive`, `money`), `callerTeams` (Governance team ids the CALLING agent belongs to), `onBehalfOf` (`teams` = Governance team ids, `ids` = contact ids or handles such as `slack:U123`, `kinds`, `trust` = trust states of the claimed requester: `unreviewed`, `trusted`, `limited`, `blocked`).
- `outcome`: `decision` (`allow`, `deny`, `hold`) and `reason` (shown to agents, max 280 characters).
- `narrowing` (only with `allow`): `memoryTags.anyOf` (only memories with one of these tags) and `memoryTags.noneOf` (never memories with these tags); `deepDatasets.anyOf` (deep knowledge reads only these datasets) and `deepDatasets.noneOf` (never these datasets). Dataset ids are exact and case-sensitive, as the data app lists them (for example `public.orders`), 1 to 128 characters, up to 64 per list. Rules does not follow lineage: a view or pipeline output built from a dataset is a dataset of its own, so list derived datasets explicitly. When rules overlap, `anyOf` lists intersect and `noneOf` lists unite, so an `anyOf` list never grows.

Example. "When someone from team Sales tags you, talk only about work, use only work memories, and never touch money" becomes two rules: `{match: {effects: ["money"], onBehalfOf: {teams: ["<sales team id>"]}}, outcome: {decision: "deny", reason: "Requests from Sales may not involve money"}, priority: 10}` and `{match: {onBehalfOf: {teams: ["<sales team id>"]}}, outcome: {decision: "allow", reason: "Requests from Sales see only work memories"}, narrowing: {memoryTags: {anyOf: ["work"]}}, priority: 20}`.

If Rules cannot read Governance, a deny or hold rule that names teams or trust applies and an allow rule that names them does not. You can check one of your drafts with `rules__draft_status` (`draftId`); it answers only for drafts you submitted.

When there is no matching rule, a call is allowed. Who asked ("on behalf of") is a claim; rules about it can only make a decision stricter, never wider.
