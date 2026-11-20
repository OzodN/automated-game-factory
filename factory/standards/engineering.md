# Software engineering standards (ENG)

| ID | Level | Rule | Check |
|---|---|---|---|
| ENG-01 | MUST | TypeScript `strict` with `noUncheckedIndexedAccess`; no `any` (use `unknown` + narrowing). | type, lint |
| ENG-02 | MUST | Game rules/state live in `src/game/` as pure, framework-free modules; scenes only render state and forward input. | review |
| ENG-03 | MUST | Interfaces shared by parallel tasks are defined first in a `contracts` task and only changed by tasks that list them in scope. | cli (scope), review |
| ENG-04 | MUST | No silent failures: every caught error is handled (fallback, user-visible state or `console.warn` with context). Never swallow errors in game logic. | review |
| ENG-05 | MUST | Async flows (ads, storage, loading) handle failure and timeout paths; the game never freezes waiting for the platform. | unit, review |
| ENG-06 | MUST | Events: typed emitters only (`Emitter<…>` from pg-kit or Phaser events with constants); every subscription created in a scene is removed on `shutdown`. | review |
| ENG-07 | MUST | Naming: files `PascalCase.ts` for classes/scenes, `kebab-case.ts` otherwise; types `PascalCase`; constants `UPPER_SNAKE`; telemetry events `snake_case`. | review |
| ENG-08 | MUST | Randomness only via the seeded `ctx.rng` (`Math.random` forbidden). | lint |
| ENG-09 | MUST | No new runtime dependency without a tech-design justification (size, license, maintenance); dependency tasks set `allowDeps`; lockfile committed. | cli, review |
| ENG-10 | MUST | Unit tests for every pure rule/formula in `src/game/`; tests deterministic (no real time, no unseeded randomness). | unit, review |
| ENG-11 | MUST | Commits: `<type>(<TASK-ID>): <summary>`; one task per branch; no unrelated changes. | cli (scope), review |
| ENG-12 | SHOULD | Modules ≤ 300 lines, functions ≤ 50 lines; prefer composition over inheritance except Phaser scenes. | review |
| ENG-13 | SHOULD | Public functions/classes have a one-line doc comment stating intent (why, not what). | review |
| ENG-14 | SHOULD | Magic numbers that designers tune live in `src/game/config.ts` / balance tables referenced by requirement IDs. | review |
| ENG-15 | MUST | Shared kit code (`@factory/pg-kit`) is never copied/forked into a game; missing capabilities are reported for a kit release. | review |
