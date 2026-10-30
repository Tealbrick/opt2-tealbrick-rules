# Provenance of the contract files in this folder

These files are byte copies. Do not edit them. To update, copy the files from a newer spec tag and change this header in
the same commit. `test/feed.test.ts` fails when a file no longer matches the sha256 below.

- Source repo: `Tealbrick/opt2-tealbrick-specs` (private)
- Tag: `spec-v0.1.42` (annotated tag object `0e1b92c2c962b728588e1aeccd1bd721cfe7e726`, commit `e2e05cdf9eb49bdaf726b6180779964d3cb3e506`)
- Contract: `fleet.directory_feed/1` (producer: Governance, product id `fleet`, op `directory_feed`; consumer: this app, Rules & Approvals). Decision C230.
- Copied from the vendored copy in `opt2-tealbrick-fleet/test/contracts/` (same bytes, same sha256).

| File here | Path in the source repo (at the tag) | sha256 |
|---|---|---|
| `fleet.directory_feed.1.schema.json` | `packages/spec/schemas/contracts/fleet.directory_feed.1.schema.json` | `18d49f48f1196af77223acb38ea9b95f5786c587019b4688cd9417f5708df724` |
| `fleet.directory_feed.1.json` | `packages/spec/examples/contracts/fleet.directory_feed.1.json` | `339d4b8c9377b0c035fd8937518565aac368bc4a3e8a3bb468559aedc7b4db71` |

How this app uses them: `src/fleet.ts` validates EVERY `directory_feed` answer against the agent-handles schema below (a superset of
this one: an answer without agent handles passes both) with the JSON Schema 2020-12
validator that `@opt2-tealbrick/manifest` exports (`validateAgainstSchema`, ajv 8, formats as annotations) and applies the
extra reader rule `normalizeHandle(h) === h` for every handle. A mismatch is a refusal (the error is recorded, the copy is
cleared, nothing of the answer is read). The fixtures `valid`, `invalid` and `invalidByNormalizeHandle` run through the same
reader in `test/feed.test.ts`.

## fleet.directory_feed/1 with agent handles (C373, RULES-INTERFACE §3) — Governance's DERIVED file, byte copy

`fleet.directory_feed.1.agent_handles.schema.json` is the spec-v0.1.42 schema above plus ONE optional property,
`$defs.full.properties.agents.items.properties.handles` (array of `#/$defs/handle`, maxItems 16, uniqueItems), as Governance
derives it. Governance sends `agents[].handles` only to a reader whose request carries `accept: ["agent_handles"]` (Rules 0.5.0
does); without it the answer is the old shape. `test/feed.test.ts` checks both files below against this sha256, checks that
the two are the same bytes, and rebuilds the derived schema from the spec byte copy (any other difference fails).

- Source repo: `Tealbrick/opt2-tealbrick-fleet` (Governance 0.3.0 work), branch `feat/c373-governance-0.3.0`, commit `7067eab`
  ("feed: optional accept ["agent_handles"] adds agents[].handles from a Connect cache"), file
  `test/contracts/fleet.directory_feed.1.agent_handles.schema.json`; Governance's PROVENANCE.md names the same sha256.
- Copied with `git -C <fleet> show 7067eab:test/contracts/fleet.directory_feed.1.agent_handles.schema.json` on 2026-10-27.
- PENDING: commit `7067eab` was not pushed when it was copied. Re-check the bytes against Governance 0.3.0 when it is merged
  or released, before Rules 0.5.0 is tagged.

| File here | sha256 |
|---|---|
| `fleet.directory_feed.1.agent_handles.schema.json` | `9a11657d8ac88580aa76af647118ed57e19798c56498e804b03b4fcd49515823` |

## fleet.directory_feed/1 with lifecycle (C380, spec 0.1.89) — the runtime schema since 0.7.0, byte copy

Before 0.7.0 the runtime schema was the agent-handles file above. That file stays here because the test still rebuilds it from the spec copy.

Source: `Tealbrick/opt2-tealbrick-specs`, tag `spec-v0.1.89`. `src/fleet.ts` validates every answer against it: the base schema plus the optional `agents[].handles`, and `lifecycle`, `floor` on agents and contacts. `accept: ["agent_handles", "lifecycle"]`. `test/feed.test.ts` runs its fixtures through the real reader.

| File here | Path in the source repo (at the tag) | sha256 |
|---|---|---|
| `fleet.directory_feed.1.lifecycle.schema.json` | `packages/spec/schemas/contracts/fleet.directory_feed.1.lifecycle.schema.json` | `35ebfd9f49eebeebc3c84a0ea686ab4efb18503953599828bdfd94f76734695f` |
| `../../src/contracts/fleet.directory_feed.1.lifecycle.schema.json` (runtime copy) | same | `35ebfd9f49eebeebc3c84a0ea686ab4efb18503953599828bdfd94f76734695f` |
| `fleet.directory_feed.1.lifecycle.json` | `packages/spec/examples/contracts/fleet.directory_feed.1.lifecycle.json` | `3c0004d98b361bf629fb6489e655516e3fbf5123b1a1adb9d84bf62d3a17e1b2` |
