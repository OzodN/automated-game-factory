# Architecture

```
Human ────► game-orchestrator (main thread; .claude/agents/game-orchestrator.md)
                │  only actor allowed to run state-changing factory CLI commands
                ├─► specialist subagents (parallel, single-level; no Agent tool)
                │     designer · analyst · architect · developer · platform · assets · QA · reviewer · release
                ├─► factory CLI (factory/cli) — deterministic control plane
                │     event-sourced state · gates · task DAG · worktrees · verify · integrate · release · assets
                ├─► hooks (factory/hooks) — UserPromptSubmit mints signed human tokens; PreToolUse guard;
                │     SubagentStart/Stop tracking + token metrics; PostToolUse records Playgama results
                └─► official Playgama plugin (MCP + publish/bridge/video skills), write tools token-gated
```

## Principles
1. **LLMs produce, deterministic code judges.** Verification (scope, secrets, external URLs, typecheck, lint, unit, build, validator, e2e) is run by the CLI; reviews are accepted only from the reviewer agent type (write provenance tracked by the hook); inconsistent ACCEPTs are overridden. Publication covers are screenshots the CLI takes of the packaged build (`publish covers`); `publish prepare` accepts no others.
2. **Durable truth.** `.factory/games/<id>/events.jsonl` (append-only) → derived `state.json`; cross-process locks; any session can reconstruct everything.
3. **Human gates are cryptographic, not conversational.** HMAC-signed records minted only from typed commands, bound to artifact hashes, single use.
4. **Isolation.** Repo per game; one worktree + branch per task from `develop`; parallel tasks must have disjoint scopes (validated at plan load and enforced at verify); no-ff integration in a dedicated worktree with full regression and automatic revert.
5. **Reuse without coupling.** pg-kit released as immutable tarballs vendored per game; template contains infrastructure only.
6. **Pinned models.** Every subagent definition pins its model and effort (table: `factory/config.json` → `models`, applied by `factory/cli/gen-agent-models.mjs`); Agent calls never pass model/effort (guard). The main session is not pinned.
7. **One review contract.** A single strictly validated review schema (`factory/cli/lib/review-schema.mjs`) for game tasks and factory maintenance; reviewers get a generated review packet and self-check with `review check`.
8. **Claims are attempt-scoped.** Only the claiming agent of the current attempt may write a task worktree; a new attempt or `task release-claim` supersedes older claims, and only live claims count towards `maxActiveAgents`.
9. **Runs never collide and the environment is not the task's fault.** Each verify/integrate/checkpoint/release run reserves its own port (`E2E_PORT`) and a pid-bound marker (temp file + hard link); infrastructure failures (bounded by `infraRetriesPerAttempt`) do not consume attempts.
10. **The factory changes itself the same way.** Factory changes run in maintenance worktrees (`.worktrees/_factory/<FX-ID>`, branch `fx/<FX-ID>`), are reviewed independently and merged into `main` only by `maint merge` after the factory tests pass. Guard refusals are final for agents: they report them and never route around them.
11. **Plans change only through validated amendments.** `plan load --amend` adds tasks or modifies never-started PENDING tasks, re-validated as a whole (scopes, reviewer role, deps) and recorded with before/after.

## Game state machine
`IDEATION → CONCEPT_APPROVED* → SPEC_DRAFT → SPEC_APPROVED* → DEV_AUTHORIZED* → DEVELOPMENT (phases: RUNNING → CHECKPOINT → APPROVED*) → RC_READY → PLAYTEST → PLAYTEST_APPROVED* → RELEASE_APPROVED* → PACKAGED → PUBLICATION_PREPARED → ARCHIVED*` (+ PAUSED overlay, change requests). `*` = human token. Draft exit (FX-15): `IDEATION | CONCEPT_APPROVED | SPEC_DRAFT | SPEC_APPROVED → ABANDONED* → ARCHIVED*` (`/abandon-game <reason>`, then `/archive-game`).

## Task state machine
`PENDING → IN_PROGRESS → SUBMITTED → VERIFIED | VERIFY_FAILED → ACCEPTED | REJECTED → INTEGRATED | INTEGRATION_FAILED | NEEDS_REBASE`; failures retry with feedback in the next packet (attempts >= 2 are dispatched to the `<agent>-retry` variant on Opus, recorded in `task.started`); after 3 attempts → BLOCKED (human decides).

## Layout
See `CLAUDE.md`. Runtime dirs (gitignored): `.factory/`, `games/`, `.worktrees/`, `archive/`, `.cache/`. `.inbox/` is not gitignored (pilot records were committed deliberately).
