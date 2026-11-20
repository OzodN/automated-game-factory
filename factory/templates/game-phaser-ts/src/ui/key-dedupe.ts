/**
 * Runs `handler` at most once per event object. Phaser 4.2.1 KeyboardPlugin.update replays its queued key events
 * on the frame after they were first emitted, so one physical Enter press reaches a 'keydown-ENTER' listener
 * twice with the same event object (pilot defect D-03). No Phaser import, so it is unit-testable in node.
 * Create one wrapper per scene create() so a restarted scene begins with an empty set.
 */
export function dedupeKeyEvents<E extends object>(handler: (event: E) => void): (event: E) => void {
  const seen = new WeakSet<object>();
  return (event: E): void => {
    if (seen.has(event)) return;
    seen.add(event);
    handler(event);
  };
}
