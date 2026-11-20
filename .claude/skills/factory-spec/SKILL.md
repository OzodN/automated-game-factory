---
name: factory-spec
description: Orchestrator playbook for MODE B (game specification) and for requirement change requests — producing a complete, consistent, testable specification set and getting it approved. Load when a game is CONCEPT_APPROVED or SPEC_DRAFT, or a change request is open.
---

# Mode B — Specification playbook

## 1. Start
`node factory/cli/factory.mjs spec start` (CONCEPT_APPROVED → SPEC_DRAFT).

## 2. Required documents (`games/<id>/design/spec/`) — the CLI refuses approval if any is missing
| File | Owner | Content |
|---|---|---|
| `README.md` | orchestrator (you) | Index, requirement ID scheme, glossary, decisions log, open-question resolutions |
| `gdd.md` | game-designer | Mechanics with exact numbers, states, controls, progression, economy, onboarding, UI screens/flows, level/content tables (`GD-xxx`) |
| `tech-design.md` | tech-architect | Architecture, modules/scenes, state, events, save schema, layout strategy, performance budget (`TD-xxx`) |
| `art-audio.md` | asset-producer (+designer intent) | Style sheet, palette, UI kit, asset list with sources (library ids / remote index ids `<source>:<item>` to acquire / vector / original), audio list (music + sfx), budget (`AA-xxx`) |
| `playgama-integration.md` | tech-architect (+platform-engineer review if needed) | Bridge lifecycle, saves, ad placements + ids, rewarded offers, telemetry events, languages, compliance matrix vs. live checklist (`PG-xxx`) |
| `test-plan.md` | tech-architect + qa-engineer | Test strategy; each requirement ID → test type (unit/e2e/manual) and pass condition |

Add `level-design.md` or `economy.md` only when the game needs them.

Dispatch designer + architect + asset-producer in parallel (they write different files), then qa-engineer for the test plan mapping.

Who may write which spec file without a task claim (enforced by the PreToolUse guard, `factory/cli/lib/guard.mjs`): in CONCEPT_APPROVED / SPEC_DRAFT, or while a change request is open,
- game-designer, market-analyst and tech-architect write anywhere under `games/<id>/design/spec/` (and their research/tech areas);
- asset-producer (and `asset-producer-retry`) writes only `design/spec/art-audio.md`;
- qa-engineer (and `qa-engineer-retry`) writes only `design/spec/test-plan.md`;
- the orchestrator writes `README.md` (and may write any spec file).
Every other write by asset-producer or qa-engineer still needs a claimed task. Outside spec mode the spec is frozen for everyone.
Tell spec writers to use the Write/Edit tools. Shell lines the guard does not fully understand keep the strict text rules (OPERATOR-MANUAL "Guard refusals and the agents' shell"). A refusal there is reported, never worked around.

## 3. Consistency pass
Dispatch `tech-architect`: "Cross-check all spec files for contradictions, missing numbers, untestable statements and Playgama conflicts; list issues in `design/spec/README.md#review` and fix the ones in your files; report the rest." Route remaining issues to owners. Repeat until no issues remain.

## 4. Present for approval (in the human's language)
Summary: scope, phases estimate, key numbers, asset plan, monetization plan, risks, anything changed from the concept. Paths to every doc.
The human types **`/approve-spec`**, then you run `node factory/cli/factory.mjs gate approve-spec`.
Development starts only when the human separately types **`/start-development`** (see `factory-dev-loop`).

## Change requests (any time after spec approval)
1. Human types `/modify-requirements <text>` → run `node factory/cli/factory.mjs spec change-request`.
2. Owners edit `design/spec/*` (the guard re-opens it while the request is open). Record the change in `README.md#decisions`.
3. Show the human the diff summary; they type `/approve-spec-change` → `node factory/cli/factory.mjs spec refreeze` (commits and merges into develop).
4. If tasks are affected, have tech-architect produce a plan amendment and load it with `plan load <file> --amend`.
