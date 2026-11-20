# Game conventions (template game-phaser-ts)

This repository was scaffolded by the Game Production Factory. The full standards live in the factory at
`factory/standards/`; this file is the in-repo summary every task agent must follow.

## Layout
- `src/main.ts` — boot order (Bridge → lifecycle → save → i18n → Phaser). Do not reorder.
- `src/game/` — game state, config, save schema, rules. Pure logic goes here and is unit-tested.
- `src/scenes/` — Phaser scenes. Scenes are thin: they render state and forward input.
- `src/ui/` — reusable widgets (vector-drawn; never emoji as icons).
- `src/i18n/` — dictionaries. English is mandatory; every key exists in every language.
- `public/assets/` — shipped assets (Latin file names, relative paths). Every third-party file is in `assets/LICENSES.json`.
- `tests/unit/` — Vitest, deterministic (seeded `ctx.rng`, no timers without fakes).
- `tests/e2e/` — Playwright on the production build (`dist/`), hermetic (no network).

## Non-negotiables (enforced by lint, tests or validators)
- Saves only via `getContext().save` (Bridge storage). No localStorage/IndexedDB/cookies.
- No network requests, no external URLs, no third-party analytics. Telemetry via `ctx.telemetry`.
- No code-synthesized sound. Audio = ogg/mp3 files played through Phaser sound.
- Never use the Escape key. Pause key is `P`; touch has an on-screen pause button.
- Interstitials only at natural pauses via `ctx.ads.showInterstitial(placement)` — no game-side timers.
- Rewarded ads only on explicit player action; grant the reward only if `showRewarded()` resolves `true`; revive at most once per attempt (`ReviveGate`).
- `ctx.platform.gameReady()` exactly when the first interactive screen is shown.
- `gameplayStarted()` / `gameplayStopped()` around real gameplay.
- Randomness via `ctx.rng` only (seeded; `?seed=N` in tests).
- Layout must work at 375×812, 600×600 and 1920×1080 with no black bars (canvas fills the viewport).

### Keyboard handlers go through `dedupeKeyEvents` (pilot defect D-03)
Phaser 4.2.1 `KeyboardPlugin.update` replays its per-step key queue, so one physical key press can reach a
`keydown-*` listener twice with the same event object (one Enter fired a transition and its click sound twice).
Every Phaser keyboard handler that triggers a transition, a sound, a save or any other side effect MUST be wrapped
with `dedupeKeyEvents` from `src/ui/key-dedupe.ts`, which runs the handler at most once per event object:

```ts
const onEnter = dedupeKeyEvents((): void => {
  play();
});
this.input.keyboard?.on('keydown-ENTER', onEnter);
this.events.once('shutdown', () => this.input.keyboard?.off('keydown-ENTER', onEnter));
```

Create the wrapper inside the scene's `create()` (one per scene start) and remove the listener on shutdown.
The dedupe is per scene: each wrapper has its own set, so a scene that Enter just started must not also act on the
replayed Enter (give that scene no Enter handler, or ignore events already handled by the previous scene, e.g. require a
fresh event or a short input lock after the transition). `MenuScene` is the reference.

The e2e test "one real Enter on the Menu starts Play exactly once" checks only the template wiring. It CANNOT detect a
missing `dedupeKeyEvents`: headless Chrome never reproduced the Phaser replay, so that test also passes without the
wrapper. The helper itself is covered by `tests/unit/key-dedupe.test.ts`; reviewers check the wrapper by reading the
code.
The template e2e suite also checks that Space, arrows, PageDown and Escape do not change the scene, so the template menu
binds Enter only.

### Phaser delta-time cap: game time is not wall time
During the first ~120 frames after boot or after the tab regains focus, Phaser caps the per-step delta time. On hosts
below 60 Hz (slow CI machines, 30 Hz throttled displays) that cap makes game time run slower than wall time for those
frames. Consequences:
- Tests MUST measure game-time quantities (countdowns, hold times, cooldowns, spawn intervals) in game time, read from
  the scene clock or model state, never against `Date.now()` / `page.waitForTimeout` wall-clock upper bounds
  (pilot defect GD-101: a 1600 ms wall-clock bound flaked while the game-time countdown was correct).
- Wall-clock assertions are allowed only as generous lower bounds or after normalising by the measured pacing.
- Timing-critical games (rhythm, reaction, precise holds) should consider the `fps.smoothStep` option of the Phaser
  game config (for example `fps: { smoothStep: false }`) and verify the effect on a sub-60 Hz host before relying on
  it; record the decision in the spec/tech notes.

## Publication covers
The factory takes the Playgama covers from the packaged build (`factory publish covers`) after `game_ready`, following the
`covers` block of `factory.game.json` (protected file): `query` (e.g. `?pgtest=1&seed=12345`), `settleMs`, `readyTimeoutMs`
and `steps` (`press`, `clickAt` as viewport fractions, `waitMs`). The default clicks the menu Play button (`[0.5, 0.6]`) and
waits, so the shot shows gameplay. Keep the first seconds of play visually representative and free of debug overlays.

## Commands
`pnpm run verify` runs typecheck, lint, unit, build, validate and e2e — the same suite the factory runs.

## Testing (e2e)
- **Real-key reach test for every key the game uses.** "The key does not scroll the page" is not enough (FD-06: pg-kit 0.1.0
  called `preventDefault` before Phaser, so Phaser dropped every scroll key while the old e2e stayed green). For each key the
  game binds (Space, arrows, WASD, P, Enter, ...), the e2e suite MUST press the REAL key with `page.keyboard.press` (never
  `dispatchEvent` or a hook action that skips the browser) and assert that a Phaser handler in the running game received it.
  The template does this in `tests/e2e/platform.spec.ts` ("real Space, ArrowLeft and ArrowRight reach a Phaser handler"): the
  probe `trackScene(scene)` in `src/game/test-state.ts` (active only with `?pgtest=1`) records each distinct key event into
  `__PG_TEST__.state()` as `keysSeen` (recent codes) and `keysTotal` (running total), and counts scene creates in `sceneStarts`.
  Call it from every scene that takes keys, extend the test with each new key, and assert the gameplay effect of the key once the game has one.
  The same test checks that scroll keys end up default-prevented (final `defaultPrevented`, observed in a `setTimeout(0)`).
- **No fixed sleeps.** Never `page.waitForTimeout`; wait for a condition with `expect.poll` / web-first assertions on the
  `__PG_TEST__` hook or on storage (the template waits for the save to land in storage before reloading).
- **Split suites by area (lesson L-01).** Do not grow one monolithic acceptance/e2e spec. Keep separate spec files per area,
  at minimum: `flows` (game flows and scenarios), `viewports` (375x812, 600x600, 1920x1080, resize, touch) and `quality`
  (performance, platform/compliance checks). Plan them as separate tasks with disjoint file scopes so they can run in parallel.

### E2E port (never collide with factory runs)
Every factory run (task verify, integration regression, phase checkpoint, playtest/release, template check) gets a free
port allocated by the factory and passed as `E2E_PORT`; `playwright.config.ts` honors it. Without `E2E_PORT` the config
falls back to a port derived from the working directory, which is exactly the port another run in the same worktree may use.
Anyone running Playwright by hand (agents, reviewers, QA) MUST set a random `E2E_PORT`:

```sh
E2E_PORT=$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})") corepack pnpm exec playwright test
```

(same prefix for `corepack pnpm run test:e2e` or `corepack pnpm run verify`). A failure that says the port "is already used"
or `EADDRINUSE` is an infrastructure failure: the factory records it without consuming an attempt; re-run, do not "fix" tests for it.
