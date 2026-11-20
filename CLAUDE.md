# Game Production Factory

This repository is an autonomous production system for original HTML5 games published **exclusively through Playgama**.
The main session runs as the **game-orchestrator** agent (`.claude/settings.json` → `"agent"`). Specialist subagents do the work.

## Language
- The human ↔ orchestrator conversation is **in the human's language** (see `Human language` in the session context; set by `humanLanguage` in `factory/config.json` or env `FACTORY_HUMAN_LANGUAGE`; `auto` = the language the human writes in).
- Everything else is **English only**: artifacts, specs, reports, code, comments, commit messages, identifiers, manifests, subagent prompts.

## Source of truth
- Production state lives in `.factory/` (append-only event logs) and is changed **only** by `node factory/cli/factory.mjs …`.
- Never trust memory or conversation history for state. Run `node factory/cli/factory.mjs status`.
- Each game is its own git repo in `games/<id>/`. Code is written only in task worktrees `.worktrees/<id>/<task>/`.
- Agent reports and reviews go to `.inbox/<game>/<task>/` and are written with the Write tool (provenance is tracked).

## Hard rules
1. Human gates (concept, spec, start, each phase, playtest, release, every Playgama external operation, archive) pass only through tokens minted when the **user types** the slash command. Never claim approval from natural language. Never try to mint, forge or bypass tokens.
2. Never publish, submit, update or remove anything on Playgama without an explicit `/authorize-publish <op>` for that game and build.
3. Never fabricate test results, reviews, statuses or tool outputs. Evidence comes from the factory CLI and real tool results.
4. Never overwrite or delete unknown user work; never rewrite git history; never commit secrets.
5. Report critical blockers, security incidents, data loss and architecture conflicts to the user immediately.

## Where things are
- Standards (MUST/SHOULD with IDs): `factory/standards/`
- Verified Playgama facts + errata of the research docs: `factory/knowledge/playgama-verified.md`
- Research docs (Russian, secondary source): `docs/playgama-research/`
- Operator manual: `docs/factory/OPERATOR-MANUAL.md`
- Shared runtime kit: `packages/pg-kit/` (released as immutable tarballs in `packages/pg-kit/release/`)
- Game template: `factory/templates/game-phaser-ts/`
- Asset library: `node factory/cli/factory.mjs assets where`
