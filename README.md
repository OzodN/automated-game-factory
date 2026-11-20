# Automated Game Factory

A [Claude Code](https://claude.com/claude-code) project that turns a game idea into an original HTML5 game published
on [Playgama](https://playgama.com). A **game-orchestrator** agent (the main session) talks to you, specialist
subagents (designer, analyst, architect, developers, QA, asset producer, reviewer, release manager) do the work, a
deterministic **factory CLI** is the single source of truth for production state, and every decision that matters
passes a **signed human gate** that only a command you type can open.

## How it works
- **Lifecycle:** `IDEATION -> CONCEPT_APPROVED -> SPEC_DRAFT -> SPEC_APPROVED -> DEV_AUTHORIZED -> DEVELOPMENT
  (phases) -> RC_READY -> PLAYTEST -> PLAYTEST_APPROVED -> RELEASE_APPROVED -> PACKAGED -> PUBLICATION_PREPARED ->
  ARCHIVED`. A draft game can be dropped (`ABANDONED`) before development.
- **State:** append-only event logs in `.factory/`, changed only by `node factory/cli/factory.mjs ...`. Any session
  rebuilds the full state from them; nothing depends on chat history.
- **Isolation:** each game is its own git repo in `games/<id>/`; each task runs in its own worktree and branch
  (`.worktrees/<id>/<task>/`); parallel tasks have disjoint file scopes.
- **Independent review:** every task is reviewed by a different agent role against measurable acceptance criteria,
  using one strictly validated review schema.
- **Deterministic verification:** the CLI (not an LLM) runs scope checks, secret and external-URL scans, typecheck,
  lint, unit tests, build, the build validator and Playwright e2e before anything is integrated.
- **Human gates:** a hook signs a single-use approval when you type a gate command; the CLI refuses the transition
  without it. Agreement in plain chat ("yes, go ahead") is never an approval.

| You type | What it authorizes |
|---|---|
| `/game-new <idea>` | start ideation for a new game (not a gate) |
| `/approve-concept` | the Game Concept Brief |
| `/approve-spec` | the specification set (GDD, tech design, art/audio, Playgama integration, test plan) |
| `/start-development` | freeze the spec, scaffold the game repo, load the phase plan |
| `/approve-phase` · `/reject-phase <reason>` · `/request-changes <text>` | a phase checkpoint |
| `/retry-task <ID>` · `/abandon-task <ID>` · `/modify-requirements <text>` · `/approve-spec-change` | blocked tasks and requirement changes |
| `/approve-playtest` · `/reject-playtest <issues>` | the release candidate after your playtest |
| `/approve-release <x.y.z>` | the release (merge `develop` -> `main`, tag); packaging and archive validation follow |
| `/authorize-publish <op>` | one Playgama operation (`draft`, `store-config`, `sandbox`, `catalog-update`, `traffic`, `referral`) |
| `/archive-game` · `/abandon-game <reason>` | archive a game; drop a draft game |
| `/pause` · `/resume` | pause or resume a game (no new tasks start while paused) |

Other commands: `/game-status`, `/game-focus <id>`, `/factory-metrics`, `/prepare-publication`. Moderation
submission is done by you in the Playgama console (it is not available to agents).

## Prerequisites
- Claude Code.
- Node.js >= 22, git, and pnpm through corepack (the factory runs `corepack pnpm ...`).
- Google Chrome, or Playwright's bundled Chromium (`PW_CHANNEL=bundled`), for e2e tests and cover screenshots.
- ffmpeg (audio processing).
- The Playgama Developer Cabinet plugin. It is declared in `.claude/settings.json` (marketplace
  `Playgama/playgama-plugins`); sign in with `/mcp` -> `plugin:playgama-developer-cabinet:playgama` -> Authenticate.
- A local filesystem with hard links (NTFS, APFS, ext4 and similar; not FAT/exFAT or a network share).

## Quick start
1. Clone the repository and open Claude Code in the cloned folder. Trust the project and its plugin when asked; the
   session starts as the game-orchestrator.
2. Run `node factory/cli/factory.mjs doctor` and fix every `FAIL` (see the operator manual for `WARN` rows).
3. Asset library: point `GAME_ASSET_LIBRARY` (environment variable) or `"assetLibrary"` in `factory/config.json` at
   any local folder (a synced drive works too). Without it a local fallback under `.cache/` is used;
   `node factory/cli/factory.mjs assets where` shows which. Seed it with CC0 packs you downloaded yourself (Kenney,
   OpenGameArt) by asking the orchestrator to ingest them; every pack is licence-checked.
4. Type `/game-new <your idea>`.

## Configuration
- `factory/config.json` `humanLanguage`: the language of the human <-> orchestrator conversation. `auto` (default)
  replies in the language you write in; a code such as `en` or `ru` fixes it. Env `FACTORY_HUMAN_LANGUAGE` overrides
  it. Artifacts, code, commits and subagent prompts are always English.
- `factory/config.json` `models`: the pinned model and effort of every subagent, plus the stronger `-retry` variants.
  Apply changes with `node factory/cli/gen-agent-models.mjs`; `doctor` checks that the agent files match.
- Limits such as `concurrency`, `maxActiveAgents`, `maxAttempts` and the release size budget are in the same file.
- Environment overrides (`FACTORY_*`): `FACTORY_ROOT`, `FACTORY_STATE_DIR`, `FACTORY_CONFIG`, `FACTORY_GAMES_DIR`,
  `FACTORY_WORKTREES_DIR`, `FACTORY_INBOX_DIR`, `FACTORY_ARCHIVE_DIR`, `FACTORY_TEMPLATES_DIR`, `FACTORY_KIT_DIR`,
  `FACTORY_TMP_DIR`, `FACTORY_KEY_PATH` (the approval signing key, default `~/.game-factory/approval.key`).

## Platform note
Developed and tested on Windows. macOS and Linux are supported on a best-effort basis.

## Repository layout
| Path | Contents |
|---|---|
| `.claude/agents/`, `.claude/skills/` | agent definitions, gate commands and playbooks |
| `factory/cli/` | the factory CLI (`factory.mjs`), its library and tests |
| `factory/hooks/` | Claude Code hooks: approval minting, guard, provenance, session context |
| `factory/standards/` | MUST/SHOULD rules with IDs (engineering, quality, Playgama compliance, security, assets) |
| `factory/knowledge/` | verified Playgama facts and Claude Code capabilities |
| `factory/templates/game-phaser-ts/` | game template (Phaser 4, TypeScript, Vite, Playgama Bridge) |
| `packages/pg-kit/` | shared runtime kit, released as immutable tarballs |
| `docs/factory/` | [operator manual](docs/factory/OPERATOR-MANUAL.md), [architecture](docs/factory/ARCHITECTURE.md), [status](docs/factory/STATUS.md) |
| `docs/playgama-research/` | background research on Playgama (Russian, secondary source) |

Runtime folders (`.factory/`, `games/`, `.worktrees/`, `.inbox/`, `archive/`, `.cache/`) are created locally and are
not part of the repository.

## Disclaimers
- This project is not affiliated with, endorsed by or sponsored by Playgama.
- You are responsible for the licences of the assets you use and for everything you publish.
- Agents never publish on their own: every Playgama operation needs an explicit `/authorize-publish <op>` typed by
  you for that game and build.

## Contributing
See [CONTRIBUTING.md](CONTRIBUTING.md).

## License
MIT, see [LICENSE](LICENSE).
