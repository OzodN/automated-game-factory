# Game engineering standards (GE)

| ID | Level | Rule | Check |
|---|---|---|---|
| GE-BOOT | MUST | Boot order: `bootGame` (Bridge → lifecycle → input guards → i18n → save) → Phaser → Boot scene loads assets with progress → first interactive screen calls `ctx.platform.gameReady()` once. | e2e, review |
| GE-01 | MUST | Scene flow is explicit (Boot → Menu → Play → Result …); every scene cleans up listeners/timers on shutdown. | review |
| GE-02 | MUST | Canvas fills the viewport (Phaser `Scale.RESIZE`); layout recomputed on `resize`; content fitted with `computeLayout()`; backgrounds cover — no black bars at 375×812, 600×600, 1920×1080 or during rotation. | e2e |
| GE-03 | MUST | Input works with touch, mouse and keyboard where the design uses keys; touch targets ≥ 44 CSS px; no hover-only affordances; Escape never bound; pause key `P` + on-screen pause. | lint, e2e, review |
| GE-04 | MUST | Game-time logic uses Phaser time/delta (frame-rate independent); no `setInterval` for gameplay. | review |
| GE-05 | MUST | Physics/collision: use Arcade physics or explicit math with unit tests for edge cases (tunneling, simultaneous hits) defined in the spec. | unit, review |
| GE-06 | MUST | Saves: versioned schema, `migrate()` handles every older version and corrupt data; flush on level end, pause, hide and before ads (kit does the last three). | unit, e2e |
| GE-07 | MUST | Audio: all sounds through Phaser sound with the lifecycle binding; music loops; user mute persisted in the save. | e2e, review |
| GE-08 | MUST | Loading: every asset bundled and loaded by relative path in Boot (or lazily per scene with a visible indicator); no network. | validator, e2e |
| GE-09 | MUST | Progression state machine (levels/unlocks/currency) is pure and unit-tested; no progress loss on reload, rotation or ad. | unit, e2e |
| GE-10 | MUST | The `__PG_TEST__` hook exposes enough state/actions for e2e tests of every core flow (start, win, lose, revive, result). | e2e |
| GE-11 | SHOULD | Object pooling for frequently spawned objects; avoid per-frame allocations in hot paths. | review |
| GE-12 | SHOULD | Texture atlases for sprites; ≤ 2048×2048 per atlas page. | review |
| GE-13 | SHOULD | Handle WebGL context loss gracefully (Phaser default) and test a resize storm (rapid resizes) without errors. | e2e |
