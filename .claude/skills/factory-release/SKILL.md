---
name: factory-release
description: Orchestrator playbook for MODES E and F — release candidate and human playtest, release approval, packaging, archive validation, Playgama publication preparation and individually authorized Playgama operations. Load when a game is RC_READY or later.
---

# Modes E/F — Playtest, release and publication playbook

## E. Human playtest
1. `node factory/cli/factory.mjs playtest prepare --game <id>` — full release checks on develop, copies the build to `.factory/games/<id>/rc/<sha>`.
2. Dispatch `qa-engineer`: "Prepare the playtest package for game <id> release candidate (<rc dir>): final QA report + 5–10 test scenarios with expected results + known limitations → `.inbox/<id>/qa/playtest.md`. Use `get_local_game_qa_tool_link` with the served address if the Playgama tools are connected."
3. Start the local server in the background: the command printed by `node factory/cli/factory.mjs playtest serve --game <id>`.
4. Tell the human (in the human's language, see `Human language` in the session context): the URL, how to test on desktop and phone (same Wi-Fi is NOT enough: the server binds to localhost; for phone testing use the Playgama QA Tool link or Chrome device emulation), the scenarios, known limitations, QA verdict. Options: `/approve-playtest` or `/reject-playtest <issues>`.
5. `/reject-playtest` → `node factory/cli/factory.mjs playtest reject` (adds a corrective phase) → tech-architect plans fixes (`plan load --amend`) → dev loop → checkpoint → playtest again.

## F1. Release (after `/approve-playtest` → `factory gate approve-playtest`)
Ask the human to type `/approve-release <x.y.z>` (first release: 1.0.0). Then:
1. `node factory/cli/factory.mjs gate approve-release --version x.y.z --game <id>` — merges develop → main (no-ff) and tags.
2. `node factory/cli/factory.mjs release package --game <id>` — on the tag: full checks incl. audio/credits release gate, deterministic zip, archive validation, sha256 → `archive/<id>/<version>/`.
3. Covers: **you** run `node factory/cli/factory.mjs publish covers --game <id>` (orchestrator-only, mode PACKAGED). It serves the packaged archive (sha256-verified against the package record), opens it with the Playwright of the game's release worktree and writes real screenshots `square.png` (800x800), `portrait.png` (1080x1920), `landscape.png` (1920x1080) plus `covers.json` into `.inbox/<id>/publication/covers/`. The shot is taken after `game_ready`, following the optional `covers` scenario of the game's `factory.game.json` (query, steps). The `covers` block lives in `factory.game.json`, which game tasks may not change: a wrong scenario needs a factory-authorized change (factory maintenance), then re-package and re-run. Agents cannot write into that folder. If the output says no `game_ready` was observed (readySignal `canvas-only`), that is not necessarily a game defect: a game that bundles its own Bridge cannot be observed through the page hook, so enable `?pgtest=1&seed=12345` in the cover scenario (factory-authorized change). `publish prepare` refuses canvas-only covers unless you re-run the command with `--accept-canvas-only` after looking at the three shots yourself (recorded in covers.json and the event). Optional and out of scope: title overlays via the official `covers.mjs` (needs puppeteer); `publish prepare` accepts only the files this command produced.
4. Dispatch `release-manager`: release notes + publication packet whose `covers` reference exactly those three paths. Then `node factory/cli/factory.mjs publish prepare --game <id>` (it refuses covers from anywhere else, edited covers, and covers made for another build).

## F2. Publication — every external operation separately authorized
Explain each operation's consequence to the human (in the human's language) and wait for its token:
| Op | Command the human types | What happens |
|---|---|---|
| draft | `/authorize-publish draft` | Create the private application, fill the form, upload the archive and covers; build check runs. Not public. |
| sandbox | `/authorize-publish sandbox` | Public playable link (anyone with the link), no moderation. Optional. |
| catalog-update | `/authorize-publish catalog-update` | Push a new build to ALL live catalog players without moderation (updates only). |
| traffic | `/authorize-publish traffic` | Start a traffic campaign; cannot be undone. |
Submission to moderation, unpublishing and deletion: **manual in the Playgama console** — give the human the exact steps from the packet's `manualSteps`. Check `get_submission_state` first and report what moderation still needs.

After each op: report the real tool results (URLs exactly as answered). `node factory/cli/factory.mjs publish status` shows the recorded ops.

## F3. Archive
When the human types `/archive-game`: `node factory/cli/factory.mjs gate archive-game --game <id>` — copies production records into `archive/<id>/<version>/production/` and commits them to the game repo. (An abandoned draft game, see `/abandon-game`, is archived the same way into `archive/<id>/abandoned-<YYYYMMDD>/`.)
