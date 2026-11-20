# @factory/pg-kit changelog

## 0.1.1 (2026-11-13)

- Fix FD-06: `installInputGuards` no longer hides the scroll keys (Space, arrows, PageUp/PageDown, Home, End, Tab)
  from the game. The `preventDefault` now runs at the end of the keydown dispatch, after every bubble-phase listener
  on the guard target (Phaser 4.2.1's KeyboardManager listens on `window` and ignores `defaultPrevented` events).
  Host-page scroll and Tab focus loss stay blocked (rule 1.5.1); Escape is still never prevented (1.5.2).
- The disposer returned by `installInputGuards` now also removes the `wheel` listener.
- New kit test `test/input.test.ts`.
- Public API unchanged.

## 0.1.0

- First release.
