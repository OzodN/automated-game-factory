/** Keys that scroll the host page inside an iframe or move focus out of it (rule 1.5.1). */
export const SCROLL_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Tab']);

/**
 * Browser-level input hygiene for iframe games:
 * - prevents page scrolling by keys / touch, focus leaving the game by Tab, text selection,
 *   context menu and long-press callouts (1.4.5, 1.5.1)
 * - Escape is NEVER used by the game (1.5.2: platforms reserve it) — it is ignored here and games
 *   must not bind it (lint rule enforces this in game code).
 *
 * Key handling (kit 0.1.1, FD-06): the scroll-key `preventDefault` runs LAST in the dispatch, after
 * every bubble-phase listener on `target`, so the game (Phaser's KeyboardManager listens on `window`
 * in the bubble phase and ignores events with `defaultPrevented === true`) still receives the keys.
 * How: a capture-phase listener on `target` re-appends the bubble-phase `onKeyLate` listener at the
 * end of `target`'s listener list for every keydown. The DOM dispatch algorithm clones a target's
 * listener list separately for the capture and the bubble invocation, so the re-appended listener
 * runs after all bubble listeners registered on `target` before the event, whatever their
 * registration order relative to this guard. Default actions (scroll, focus move) run only after
 * dispatch ends, so preventing at the end still blocks them.
 * Limitation: a listener that calls stopPropagation()/stopImmediatePropagation() on a scroll key
 * before the bubble phase reaches `target` also stops the guard (Phaser does not do this).
 * Returns a disposer.
 */
export function installInputGuards(target: Window = window): () => void {
  const onKeyLate = (e: KeyboardEvent) => {
    if (e.code === 'Escape' || e.key === 'Escape') return;
    if (SCROLL_KEYS.has(e.code)) e.preventDefault();
  };
  const onKeyEarly = () => {
    // Move onKeyLate to the end of the bubble-phase list for this dispatch (remove first: an
    // identical add is otherwise ignored and would keep the old position).
    target.removeEventListener('keydown', onKeyLate, false);
    target.addEventListener('keydown', onKeyLate, { capture: false, passive: false });
  };
  const prevent = (e: Event) => e.preventDefault();
  const onTouchMove = (e: TouchEvent) => {
    if (e.touches.length > 1 || e.cancelable) e.preventDefault();
  };
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey) e.preventDefault();
  };
  target.addEventListener('keydown', onKeyEarly, { capture: true });
  target.addEventListener('keydown', onKeyLate, { capture: false, passive: false });
  target.addEventListener('contextmenu', prevent);
  target.addEventListener('selectstart', prevent);
  target.addEventListener('dragstart', prevent);
  target.addEventListener('touchmove', onTouchMove, { passive: false });
  target.addEventListener('wheel', onWheel, { passive: false });
  return () => {
    target.removeEventListener('keydown', onKeyEarly, true);
    target.removeEventListener('keydown', onKeyLate, false);
    target.removeEventListener('contextmenu', prevent);
    target.removeEventListener('selectstart', prevent);
    target.removeEventListener('dragstart', prevent);
    target.removeEventListener('touchmove', onTouchMove);
    target.removeEventListener('wheel', onWheel);
  };
}
