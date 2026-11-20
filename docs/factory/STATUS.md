# Project status

## Implemented
| Component | State | How to check |
|---|---|---|
| Control plane CLI (state machine, gates, task DAG, worktrees, verification, review, integration with auto-revert, blockers, recovery, release zip, plan amendments, factory maintenance) | implemented, covered by tests | `node --test factory/cli/test/*.test.mjs` (pass the files, not the directory) |
| Hooks (approval minting, guard, provenance, agent tracking, Playgama result logging, session context) | implemented, covered by tests | same suite |
| Pinned agent models (`factory/config.json` `models`, `-retry` variants) | implemented | `node factory/cli/gen-agent-models.mjs --check`; `factory doctor` |
| pg-kit (shared runtime kit) | implemented | `corepack pnpm test` in `packages/pg-kit` |
| Game template `game-phaser-ts` | implemented | `node factory/cli/factory.mjs template check game-phaser-ts` |
| Asset library CLI (ingest, licence policy, verify, search, pull, remote index) | implemented | `node factory/cli/factory.mjs assets help` |
| Agents, playbooks, gate commands, standards | used end to end on a pilot game through development phases | `.claude/agents/`, `.claude/skills/`, `factory/standards/` |
| Configurable human language (`humanLanguage`) | implemented | `factory doctor` row "Human language" |

The test command is the one `factory maint merge` re-runs: `node --test factory/cli/test/*.test.mjs`. It needs no
network; the authoritative count is the `tests` line of its output. Each change brings its own test file.

## Requires human action
- Playgama MCP: `/mcp` sign-in (browser OAuth).
- Asset library: choose a folder (`GAME_ASSET_LIBRARY` or `assetLibrary`) and seed it with CC0 packs you download
  yourself (asset sites block automated downloads).
- Moderation submission: in the Playgama console (not available through MCP).

## Known limitations
- Tested on Windows; macOS and Linux are supported on a best-effort basis.
- Shell guard limits (fail-closed or pre-existing; details in OPERATOR-MANUAL "Guard refusals and the agents' shell"):
  some checks still match the whole command text (dodgeable with quoting; false refusals of commit messages,
  workaround `git commit -F`); `git config` is not treated as a write; `tar --remove-files`, xcopy/robocopy and hard
  links are not modelled; scripts in files and git hooks are not inspected.
- Not yet available: automatic retry for host-load stalls, Firefox/Safari e2e, a pg-kit interstitial mock.
- Throughput is not measured at scale; measure with `factory metrics`. `concurrency` and `maxActiveAgents` in
  `factory/config.json` assume a host that can run several install/build/Playwright cycles at once.
