# Contributing

## Changing the factory
The factory changes itself the same way it builds games: in isolation, with an independent review and a
deterministic check before anything reaches `main`.

1. The orchestrator opens a maintenance item:
   `node factory/cli/factory.mjs maint start <FX-ID> --agent <type> --reviewer <type> --brief <file>`.
   This creates the worktree `.worktrees/_factory/<FX-ID>` on branch `fx/<FX-ID>` and a work packet.
2. The implementing agent claims it (`maint claim <FX-ID>`), works only in that worktree, commits on the branch and
   writes its report into `.inbox/_factory/<FX-ID>/`.
3. A reviewer of a different role reviews the branch head and writes the review JSON; check a draft with
   `node factory/cli/factory.mjs review check <file> --task <FX-ID> --game _factory`.
4. `node factory/cli/factory.mjs maint merge <FX-ID>` merges the branch (`--no-ff`) only with a report, an ACCEPT
   review of the exact branch head, a clean worktree and a passing re-run of the factory tests.

Manual edits outside this flow are possible in your own fork, but run the test suite before you commit.

## Tests
```
node --test factory/cli/test/*.test.mjs
```
Pass the files, not the directory. The suite needs no network and uses its own temp directories. Each change adds
its own test file (`factory/cli/test/fx-NN.test.mjs`). The CLI has zero external dependencies; CLI files start with
`// @ts-check`.

Also useful: `node factory/cli/factory.mjs doctor`, `node factory/cli/factory.mjs template check game-phaser-ts`
(scaffolds a game from the template and runs its full verification) and `corepack pnpm test` in `packages/pg-kit`.

## Conventions
- Everything in the repository is English: code, comments, docs, artifacts, commit messages, agent prompts.
  Only the conversation with the human follows `humanLanguage`.
- Conventional commits: `<type>(<FX-ID>): <summary>`.
- Released pg-kit tarballs in `packages/pg-kit/release/` are immutable; bump the version for a new release.
- Agent model pins live in `factory/config.json` (`models`); regenerate the agent files with
  `node factory/cli/gen-agent-models.mjs`.
