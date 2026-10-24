# Rules & Approvals (Tealbrick mini app)

Rules & Approvals (product id `rules`): the per-workspace policy. It gates other apps' calls with allow, refuse or hold, always with a recorded reason. English rule requests are drafted by the owner's own agent and approved by the owner; Rules never calls a model. Built on the Miniapp SDK.

**Status:** stable 0.2.12; `main` is 0.4.0 (dev channel until promoted; 0.3.0 is never promoted, C266; it needs Governance 0.2.0 or newer for team rules, else they fail closed). Visibility: public, Apache-2.0. Published as the public GHCR image `ghcr.io/tealbrick/opt2-tealbrick-rules` (on 2026-10-17 its version tags are the plain build `0.2.12`, its earlier dev pre-release, and a `sha-` tag; there is no `0.2.11` tag in that registry). The manifest declares `requires.bridge: 0.1.17` (needed to carry the hold verdict).

- Repository: `Tealbrick/opt2-tealbrick-rules` (GitHub organisation `Tealbrick`)
- Licence: Apache-2.0 for the app code (`LICENSE`, `NOTICE`); upstream licences are in `THIRD_PARTY_NOTICES.md`. The Tealbrick brand mark and app art are Tealbrick artwork and are not covered by the Apache-2.0 licence.

## No secrets policy

This repository is public. It must never contain secrets or personal data, and neither may its issues or pull requests:

- No API keys, tokens, passwords, private keys, deployment secrets, `.env` files or connection strings. Use `.env.example` with placeholder values only.
- Runtime secrets live in the deployment platform (Railway variables) and are copied between services without printing them.
- No personal names, private agent configurations or customer data.
- Every pull request and every push to `main` runs a secret scan (gitleaks, the `secret-scan` step in `.woodpecker/ci.yaml`). GitHub secret scanning and push protection are not enabled on this repository, so this CI step is the guard. Optional local guard: `pre-commit install` (`.pre-commit-config.yaml` runs gitleaks).
- If a secret is committed anyway: rotate it first, then remove it from history.

## App

`tealbrick.manifest.json` is the only description of the app. The SDK derives the routes, input and output validation, OpenAPI, receipts, holds, idempotency, scopes, backups and status from it. You write handlers by operation id (`src/app.ts`) and plain migrations (`migrations/`). The app has no keys. The only app-specific environment variable is the test-only `TB_RULES_CATALOG_OFF`.

## What Rules does

Rules declares hooks on all products. **If Rules is down, every agent call in the workspace is refused (`hook_failed`), reads included.** A hook leaves the gate only by explicit owner action, never by a transient state.

Rule shape: `title`, `active`, `priority` 0 to 1000 (lower first), `match` {agents, modes, products, operations, `tools`, effects, `callerTeams`, `onBehalfOf` {teams, ids, kinds, trust}}, `outcome` {decision allow, deny or hold; reason up to 280 characters}, optional `narrowing` {`memoryTags` {anyOf, noneOf}, `deepDatasets` {anyOf, noneOf}}. The first matching active rule decides. No match means allow. An empty `anyOf` from an owner is refused.

`match.tools` (spec 0.1.68, bridge cap `hook_tool`) lists tool names (the bridge's canonical names, `^[a-z][a-z0-9_]{1,47}$`, up to 100, needs `products`): it matches a call whose hook `target.tool` (the dynamic entry name of a dynamic call) is in the list, by exact, case-sensitive equality (no wildcard, prefix or alias). A call WITHOUT `target.tool`: on a static op a rule with `tools` never matches; on a dynamic op (or one the app catalog cannot place) it fails closed like the Fleet facts do (C236): a deny or hold rule with `tools` APPLIES, an allow rule with `tools` does not. So an older bridge or a bridge bug cannot switch a refusing tool rule off. The decision detail records `toolUnknown: true`. `narrowing.deepDatasets` (spec 0.1.68; each list holds up to 64 ids of 1 to 128 characters, and the object needs `anyOf` or `noneOf`) limits the datasets a data app (Knowledge deep knowledge) may read for the call. Ids are the data app's canonical dataset ids: EXACT and CASE-SENSITIVE, never trimmed or case-folded (a name with a space at either end is refused at save). It merges across matching rules per key: `anyOf` lists intersect (disjoint gives `[]` = nothing passes), `noneOf` lists unite, and a list present on either side survives (absent is not "all"). Rules only emits it; the data app applies it before it reads. Rules does not follow lineage: a view or pipeline output built from a disallowed dataset is a dataset of its own, so owners list derived datasets explicitly (SDK-API 18.5 rule 4a). Rules cannot read the bridge capabilities with the pinned SDK, so it does not show "needs a bridge with `hook_tool`" on rules with `tools` (Core and the GUI do, BRIDGE v0.1.68).

- **Gate (`rules_gate`, before hook, every product):** the first active rule that matches the call decides (lower priority first): allow, refuse or hold, always with the rule's reason. It answers from local cached tables only (no app call, no model call, no network), with its own budget of 250 ms (hook limit 1 s); any error or overrun refuses (fail closed). Outward, destructive and money calls, and every call a rule decided, are recorded as decision traces keyed by the bridge `callId` (join with the target app's receipts). Traces hold ids, product, operation, effect, decision, reason, rule reference and `onBehalfOf`, never call inputs or outputs; they are pruned to 30 days and 100,000 rows.
- **Hold:** a hold rule answers `{allow: false, hold: {family: "policy", reason}}`; the bridge carries the verdict in the call proof and the TARGET app holds the call in its own holds table (`heldBy` = `rules/rules_gate`). The owner decides there; the retry of the same input runs once; a refusal on the retry still wins. If the hook-answer validator ever refused a policy hold, Rules would refuse instead (fail closed).
- **Bridge version:** holds need a bridge that carries the hold verdict (bridge 0.1.17 or later; the manifest declares `requires.bridge`). On an older bridge a hold is treated as a deny: the hold answer also carries `reason`, so the old bridge refuses the call with "Needs owner review: <reason>" (fail closed); nothing runs without the owner.
- **Context (`rules_context`):** `rules.narrowing` `{v, ruleId, reason, memoryTags {anyOf, noneOf}, deepDatasets {anyOf, noneOf}}` (Knowledge reads it; a key no rule set is absent). `v` is 2 exactly when the merged narrowing has `deepDatasets` (spec 0.1.68), else 1: a reader without dataset narrowing refuses v 2 (`narrowing_unsupported`) instead of answering unfiltered, `rules.matched`, `rules.onBehalfOf`.
- **After (`rules_filter`, reads only, 2000 ms):** redacts result objects whose `tags[]` fail the narrowing.
- **On behalf of:** the bridge copies the runner's claim into `tb.onBehalfOf` (unverified). Rules resolves it to Fleet teams; a claim can only make a decision stricter, never wider.
- **Fleet read model:** Governance (product id `fleet`) `directory_feed` (contract `fleet.directory_feed/1`, `sinceRevision`) through the companion grant, never inside a hook: at start and every 60 s with an app-initiated call, on agent-list changes, and from owner pages when older than 60 s. Every answer is validated against the vendored schema (`src/contracts`) and every handle must satisfy `normalizeHandle(h) === h`; a mismatch is a refusal (error shown by `fleet_status`, nothing of the answer read). Fail closed (C230, C236): a refusal (no grant, not found, unlicensed, any 4xx, an invalid answer) clears the copy at once; a transient failure (5xx incl. the feed's 503 `feed_too_large`, timeout) keeps it only while the last successful read is 10 minutes old or less. While the copy is unavailable (never read, refused, too old), a **deny or hold** rule that names Fleet facts (`callerTeams`, `onBehalfOf.teams`, `onBehalfOf.trust`) **applies**, and an **allow** rule that names them does **not**. The Rules pages say "Governance data unavailable — team rules apply strictly".
- **Badge:** pending English drafts count toward the app's `pendingHolds` (TBD badge).
- **App catalog (since 0.2.7, writers strict):** at start and every 6 h (every minute after a failure) Rules reads the SIGNED release index that Core reads (platform `registry` release; JWS verified with the pinned release key, which is a copy of the platform `registry/keys.json`, so a release-key rotation needs a new Rules release; each manifest is checked against `manifestDigest` and `validateManifest`). Every writer (owner rule create/update, dry-run candidate, `rule_draft_submit`, draft apply) refuses a rule that can never match: an unknown app, an operation a named app does not declare (an MCP tool name such as `tools_call` gets "did you mean `tools`"), an owner-only (person) operation, or an effect the named operation never has (dynamic operations excepted: the bridge sends the resolved effect). Without any catalog yet, a rule that names apps is refused with `catalog_unavailable` (503). Stored rules and drafts are never deleted: the Rules page flags them "never matches", and such a draft cannot be applied (`draft_never_matches`, 409). The gate never reads the catalog. Unit tests set `TB_RULES_CATALOG_OFF=1`. The catalog is the only outbound call of the app (15 s timeout, 4 MB cap; outbound HTTPS to github.com).
- **English rules:** the owner's own agent translates and calls `rule_draft_submit` (a draft only); the owner approves it on the Drafts page. Rules never calls a model.

## Language

New code is TypeScript (Node 24+). Swift only where the macOS app requires it.

## Layout

| Path | Content |
|---|---|
| `tealbrick.manifest.json` | the only description: ops (person: rules, drafts, decisions, preview, Fleet status; agent: `rules_explain`, `rule_draft_submit`, `draft_status`), hooks, Fleet companion |
| `src/engine.ts` | pure rule engine: match, first match, narrow-only claims, narrowing merge, redaction pointers |
| `src/hooks.ts` | the three hook handlers (fail closed) |
| `src/store.ts` | tables: rules + revisions, drafts, decision traces, Fleet copy (cached for the gate) |
| `src/fleet.ts` | Fleet read model sync |
| `src/catalog.ts` | the signed app catalog (release index) used by the writers |
| `src/app.ts` | `defineApp`: one typed handler per operation, hooks, events, `onStart` |
| `src/ui/` | owner UI in `<AppShell>`: Rules (editor + dry run), Drafts, Decisions, Teams, Holds, Agents |
| `migrations/` | 2 forward-only migrations (`0001_init.sql` baseline, `0002_catalog.sql`). Never edit a released file. |
| `skills/use-rules/SKILL.md` | the agent skill: refusals, explain, drafting rules from English |
| `scripts/build-ui.ts` | UI build without a bundler (tsc output + vendored modules + import map) |
| `gen/` (not committed) | `tb-gen` output; `node --run kit` generates the kit and compiles it to `dist/kit` (`#kit` import) |
| `Dockerfile` | the one opt2 app Dockerfile pattern |
| `.woodpecker/ci.yaml`, `.github/workflows/opt2-release.yml` | the opt2 CI template ci-v9.9, generated from `Tealbrick/opt2-tealbrick-platform`; do not edit |
| `tealbrick-ci.json` | CI settings: kind `miniapp`, one image |
| `conformance.start.ts` | boots the app for `tb-conformance` |
| `test/` | engine, hook, catalog and app checks, UI checks |

## Develop

```sh
corepack enable && pnpm install --frozen-lockfile --ignore-scripts   # commit pnpm-lock.yaml: CI installs with --frozen-lockfile
# typecheck, test, conformance, build and start first run `tb-gen kit` (op ids + I/O types from the manifest)
pnpm typecheck && pnpm lint && pnpm test
pnpm build            # kit, server to dist/, UI to dist/ui
pnpm conformance      # SDK conformance suite against this app (not release evidence; QA is)
TB_STANDALONE=1 TB_DATA_DIR=.data pnpm start   # app-alone mode: person UI only, no agent calls (operations answer 503 no_bridge)
```

## Environment

The SDK reads only `TB_*` variables (SDK API section 13). The Dockerfile defaults `TB_DATA_DIR=/data` (the `data` volume mount) and `TB_BACKUP_DIR=/data/backup` (one volume per service). The deploy recipe sets the rest: `TB_INSTANCE_ID`, `TB_ENROL_CODE`, `TB_BRIDGE_URL`, `TB_PORTAL_KEYS`, `TB_KEK`. Optional: `TB_LOG_LEVEL`, `TB_RESTORE_FROM`, `TB_STANDALONE`. The listen port is the manifest `runtime.port`.

Before its first claim the SDK checks that `TB_DATA_DIR` is a mounted volume; on a container's own disk it waits and does not use the enrolment code. Tests and CI that run `startApp` or `tb-exec` in bridge mode on Linux set `TB_DATA_EPHEMERAL=1` in that test or CI step (the conformance suite sets it itself; this repository's unit tests run app-alone and need none). Never set it in a deploy recipe.

## Release

1. Set the same version in `package.json` and `tealbrick.manifest.json`.
2. Tag `v<semver>` (for example `v0.2.11`) on a green pipeline and push the tag. Tags are immutable.
3. The release Action builds and pushes the GHCR image and the kit tarball, then writes the signed release record from the manifest. `registry-sync` signs the index entry with the image digest and the manifest digest.
4. Core deploys the newest stable version when the owner installs or updates the app. Core (E3, live since RS-3) switches to the new version only after a health check and rolls back when it fails, restoring the pre-update data snapshot; the gate is "not worse than before" (C219). The full effect needs the app to run SDK 0.1.25, which holds for the dev channel builds today and for stable after their promotion.

Check `publisher` and `source.repo` in the manifest. The repository name must match the image name in `tealbrick-ci.json` (`opt2-tealbrick-rules`).
## Dependency pins and caching

- `@opt2-tealbrick/*` dependencies are pinned as tarball URLs on the dist host (`Tealbrick/opt2-tealbrick-dist` releases). `pnpm-lock.yaml` carries the sha512 integrity of every such tarball. After changing one, run `pnpm install`, then `node <opt2-tealbrick-platform>/ci/tb-ci.ts pin-tarballs .`, then `pnpm install --frozen-lockfile`, and commit the lockfile. Image builds run `pnpm install --frozen-lockfile --ignore-scripts`.
- `pnpm build` writes the UI to `dist/ui/index.html` + `dist/ui/assets-<content hash>/`; the SDK serves `index.html` as `no-cache` and the hashed directory as immutable, so a deploy is visible at once.

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md): design of this app (operations, scopes, data, background work).
- [`CONTRIBUTING.md`](CONTRIBUTING.md): how to change it.
- Runtime contract: `docs/SDK-API.md` in `Tealbrick/opt2-tealbrick-specs`. UI kit: `Tealbrick/opt2-tealbrick-packages`.
- System documentation (overview, environments, runbooks) lives in the private repo Tealbrick/opt2-tealbrick-docs.
