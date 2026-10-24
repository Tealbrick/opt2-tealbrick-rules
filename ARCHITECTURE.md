# Rules & Approvals (Tealbrick mini app): architecture

State: verified against the repo on 2026-10-17. Claims cite paths in this repo. Anything not verified is marked UNVERIFIED. For the whole system see the system `ARCHITECTURE.md` and `SYSTEM-OVERVIEW.md`.

## Common app pattern (verified for this repo on 2026-10-17)

- **Runtime**: Node 24, TypeScript run through `tsc` to `dist/`, UI built by `scripts/build-ui.ts` (no bundler; content-hashed `assets-<hash>/`). The app is started by `startApp` from `@opt2-tealbrick/miniapp-sdk` (`src/main.ts`).
- **Dockerfile**: two stages on `node:24-slim` pinned by digest, `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm run build && pnpm prune --prod`, the manifest also copied to `/opt/tb/tealbrick.manifest.json` (the `tb-exec` default), `USER node`, no `VOLUME`. The SDK drops root to uid 1000 itself when the platform starts the container as root (Railway volumes are root-owned).
- **Data**: one SQLite file `TB_DATA_DIR/app.db` owned by the SDK. App tables use their own prefix; SDK tables use `tb_*`. On Railway there is ONE volume per service: the backup directory is `<data mount>/backup`, so the volume size is data plus backup (C28).
- **Migrations**: `migrations/NNNN_name.sql` (or `.ts` exporting `up(db)`). The SDK enforces forward-only: gap-free from 0001, one transaction each, sha256 recorded in `tb_migrations`. A changed, missing, misnamed or `down` migration stops the app with `migration_invalid`.
- **Backups and restore**: SDK cron runner writes `tb-backup-<UTC>.tar.gz`; export `tealbrick.export/1` never carries the instance key, KEK, keys, secrets or sessions. Restore at next boot with `TB_RESTORE_FROM`.
- **Authorization**: the bridge gates (`gate()`); the SDK decides (`authorize()`): run, hold or refuse. Holds and receipts live in the app's own `tb_receipts` table. Raw call input is never stored, only a digest.
- **Manifest** `tealbrick.manifest.json` is the only source for operations, scopes, settings, hooks, companions, skills, runtime hints, backups and UI paths. Schema `tealbrick.miniapp/2`, `sdkMajor 1`, `source.license Apache-2.0`. Agent ops become MCP tools `<product>__<op>`. Person ops are owner UI only.
- **Generated**: `gen/` (openapi, kit, docs, railway) is produced by `tb-gen` and is not committed. The typed client kit is built into `dist/kit` and imported as `#kit` in apps that have one.
- **Standard UI pages** (from the kit `AppShell`): Holds, Receipts, Agents and scopes, Keys (where the app has keys), Backups and export.
- **Licence files**: `LICENSE` (Apache-2.0), `NOTICE`, `THIRD_PARTY_NOTICES.md`. The brand mark and app art are Tealbrick artwork and are not Apache-licensed.
- **Private by design**: no public address. Only the bridge is public.

## Rules & Approvals: what it does

Rules declares hooks on all products. **If Rules is down, every agent call in the workspace is refused (`hook_failed`), reads included.** A hook leaves the gate only by explicit owner action, never by a transient state (C117, L33).

Rule shape: `title`, `active`, `priority` 0 to 1000 (lower first), `match` {agents, modes, products, operations, `tools`, effects, `callerTeams`, `onBehalfOf` {teams, ids, kinds, trust}}, `outcome` {decision allow, deny or hold; reason up to 280 characters}, optional `narrowing` {`memoryTags` {anyOf, noneOf}, `deepDatasets` {anyOf, noneOf}}. The first matching active rule decides. No match means allow. Outward, destructive and money calls are always recorded. An unverified `onBehalfOf` claim may only make a decision stricter (C82).

## Operations (from `tealbrick.manifest.json`)

12 operations. No hold families on its own ops (Rules produces holds on other apps with family `policy`).
- Agent (an app with a companion grant may call them too): `rules_explain` (read), `rule_draft_submit` (write; draft only; records who proposed it: `source` {kind `agent` or `app`, product, name}), `draft_status` (read; answers only for drafts the caller itself submitted, any other id is `not_found`, the same as a missing one).
- Person read: `rules_list`, `rules_get`, `rules_preview` (dry run), `decisions_list`, `drafts_list`, `fleet_status`. Person write: `rules_set`, `rules_delete`, `draft_decide`.
- Writers refuse a rule that can never match (unknown app or op, person-only op, impossible effect, `tools` on a static op or on an app without a dynamic op) using the app catalog. An empty `anyOf` from an owner is refused (C115), for `memoryTags` and for `deepDatasets`.
- Spec 0.1.68 (C336 RQ-2, with C325 and C330; specs#47): `match.tools` matches the bridge's `target.tool` (case-sensitive; an entry `x` matches `x` and its resolved variants `x__…` only, QA-RULES18-4; an entry containing `__` is refused at save; no other wildcard). Without `target.tool`: a static op never matches; a dynamic op (placed by the cached app catalog, `dynamic` fact; an op the catalog cannot place counts as dynamic) fails closed: deny and hold rules apply, allow rules do not, and `detail.toolUnknown` is recorded; `narrowing.deepDatasets` limits the datasets a data app may read. Both are fields of the rule JSON in the `rules.spec` column, so there is no migration: a stored rule without them reads as before. Rules only emits `deepDatasets` in `rules.narrowing`, with `v: 2` exactly when it is present (else `v: 1`); it never reads or filters dataset rows, and the after hook still redacts by memory tags only (a dataset narrowing is applied by the data app before it reads, SDK-API 18.5). The decision log keeps the tool name in `detail.tool` and shows it as `target.tool`.
- Dataset ids compare EXACTLY (case-sensitive, no trim). The comparison (`datasetsMatch`, SDK-API 18.5 rules 3 and 4: key absent passes; key present needs a non-empty id list, under `noneOf` as under `anyOf`; then `anyOf` needs every id in it and `noneOf` excludes; no lineage, rule 4a: derived datasets are listed explicitly) is a LOCAL copy in `src/engine.ts` with a TODO: the shared helper is in @opt2-tealbrick/manifest from 0.1.30, and the copy is deleted when Rules pins that release (one mechanism, L1). The pins and the SDK types still carry spec 0.1.62 shapes, so `target.tool` is read structurally (`toolOf` in `src/hooks.ts`, marked `spec 0.1.68`); the pin bump follows the spec release. The pinned SDK exposes no bridge capabilities to an app, so the editor cannot show "needs a bridge with `hook_tool`" (Core and the GUI do).

## Scopes, hooks and companions

- **Scopes:** None. `needsAgentDirectory: true`. Pending English drafts feed `pendingHolds` (TBD badge).
- **Hooks:** Three, all products. `rules_gate`: phase `before`, order 0, timeout 1000 ms (own budget 250 ms). It reads only local cached tables: no app call, no model, no network. Any error or overrun refuses. A hold needs bridge 0.1.17 or later, else it degrades to a refusal. `rules_context`: phase `context`, emits `rules.narrowing` (v 1, or v 2 when `deepDatasets` is present) with `memoryTags` and `deepDatasets` (consumed by Knowledge), `rules.matched`, `rules.onBehalfOf`. `rules_filter`: phase `after`, read effects only, 2000 ms, redacts result objects whose `tags[]` fail the narrowing.
- **Companion grants it asks for:** `fleet.directory_feed` (read; Governance, contract `fleet.directory_feed/1`). The copy (teams, contact trust) is refreshed at start, every 60 s, on agent-list changes, and from owner pages if older than 60 s. A refusal or an invalid answer clears it at once; a transient failure keeps it up to 10 minutes. **Fail closed:** when the copy is unavailable, deny and hold rules that name Fleet facts apply and allow rules that name them do not (C230, C236). Mapping: keys `agent:<id>`, `contact:<id>`, `handle:<canonical>`, each with its HOLDERS (a handle can have several). Deny/hold rules match when ANY holder matches (membership, trust); allow rules need EVERY holder active (not blocked, departed, removed) and matching; trust is the holders' raw trust set, unknown = `unreviewed`. Without the facts the highest severity among the closed deny/hold rules before the first fact-free match decides. A skipped allow rule's narrowing still applies, and the after hook redacts by the verdict the before hook pinned.

## Settings, keys and environment

None. No keys. Test-only variable `TB_RULES_CATALOG_OFF`.

## Data

- **Stored:** Migrations 0001 to 0005 (0003 to 0005: `fleet_trust`, `fleet_sync.usable`, `fleet_members.active`, `drafts.source`; they clear the 0.2.x Fleet copy): `rules` (current spec JSON, priority, active, soft delete), `rule_revisions`, `drafts`, `decisions` (trace per call and phase; pruned to 30 days and 100,000 rows), `fleet_teams`, `fleet_members`, `fleet_trust`, `fleet_sync`, `catalog_manifests`, `catalog_sync`.
- **Never stored:** Call inputs and outputs. Traces hold ids, product, op, effect, decision, reason, rule reference and onBehalfOf.

## External calls and background work

- **External:** The only outbound call is the app catalog (`src/catalog.ts`): the signed release index from the platform `registry` release, JWS-verified with a pinned Ed25519 release key, then each manifest URL checked against `manifestDigest` and `validateManifest`. Refresh at start and every 6 hours (every 60 s after a failure), 15 s timeout, 4 MB cap, never inside a hook. It is used only by writers. Without a catalog, a rule that names apps is refused (`catalog_unavailable`, 503); stored rules are never deleted. **The release key is copied into this app; a release-key rotation needs a new Rules release.**
- **Background:** Fleet refresh (60 s) and catalog refresh (6 hours); decision pruning.

## Person UI

Rules (editor and dry run), Drafts, Decisions, Teams, Holds, Agents and scopes (`src/ui/App.tsx`).

## Requirements and runtime hints

Bridge 0.1.17 or later. Fleet recommended. Outbound HTTPS to github.com.

Port 8080. 0.25 cpu, 256 MB. Data 1 GB plus backup 2 GB. Backup cron `30 2 * * *`, retain 7.

## Pinned packages

Stable 0.2.12: miniapp-sdk 0.1.25. Main (0.4.0): miniapp-sdk 0.1.31, manifest 0.1.25, conformance 0.1.22, ui 0.2.4 (`ctx.caller.product`, the verified product of an app caller, is in 0.1.27 and later). Stable: manifest 0.1.18, conformance 0.1.18, ui 0.2.4. There is no `@opt2-tealbrick/spec` dependency.

All `@opt2-tealbrick/*` pins use dist-host tarball URLs. Upgrade safety (SDK 0.1.25: pre-update snapshot, migration lock, failed mode) is in this app only where the pin above says 0.1.25 (the plain version 0.2.12 is on the dev channel; its qa1 soak is the gate for stable, C221, PROMOTE-STABLE §7). All RS-3 apps pin SDK 0.1.25 (dev channel; stable after the qa1 soak of the plain version). Core restores the snapshot on an automatic rollback (portal-core#1, E3). This Core is live since 2026-10-16 22:37:58Z (Core 29ae2fe).

## Known gaps

- Narrowing rules that omit write ops still let writes through unnarrowed (open follow-up to F90; not re-checked on 2026-10-17: UNVERIFIED).
- Rules does not yet match on a dynamic tool name (backlog).
- Scheduled ops do not re-run bridge before-hooks at fire time (needs a bridge and SDK design).