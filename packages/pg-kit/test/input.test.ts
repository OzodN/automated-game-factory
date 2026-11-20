// Target path: packages/pg-kit/test/input.test.ts (new file, kit 0.1.1, FD-06).
// The kit runs vitest in the node environment without a DOM library, so this file carries a small
// event-dispatch model of the DOM Standard (section 2.9 "dispatching events"): capture path from
// window to the target, then bubble path back; each target's listener list is cloned per
// invocation; listeners are deduplicated by (type, callback, capture); removed listeners are
// skipped; stopPropagation, stopImmediatePropagation and cancelable preventDefault are honoured.
// The same scenario was also run in real Chrome (kit-0.1.1/chromium-check.cjs); the game e2e
// tests GD-061 and TD-045 (real Space) are the end-to-end proof.
import { describe, it, expect } from 'vitest';
import { installInputGuards, SCROLL_KEYS } from '../src/index.js';

type Cb = (e: FakeKeyEvent) => void;
interface Entry { type: string; cb: Cb; capture: boolean; removed: boolean }

class FakeKeyEvent {
  readonly type: string;
  readonly code: string;
  readonly key: string;
  readonly cancelable = true;
  defaultPrevented = false;
  stopped = false;
  stoppedNow = false;
  target: FakeNode | null = null;
  currentTarget: FakeNode | null = null;
  eventPhase = 0;
  constructor(type: string, code: string, key = code) {
    this.type = type;
    this.code = code;
    this.key = key;
  }
  preventDefault(): void { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation(): void { this.stopped = true; }
  stopImmediatePropagation(): void { this.stopped = true; this.stoppedNow = true; }
}

const captureOf = (o?: boolean | { capture?: boolean }): boolean => (typeof o === 'boolean' ? o : !!o?.capture);

class FakeNode {
  private list: Entry[] = [];
  constructor(readonly name: string, readonly parent: FakeNode | null = null) {}
  addEventListener(type: string, cb: Cb, o?: boolean | { capture?: boolean; passive?: boolean }): void {
    const capture = captureOf(o);
    if (this.list.some((l) => l.type === type && l.cb === cb && l.capture === capture)) return;
    this.list.push({ type, cb, capture, removed: false });
  }
  removeEventListener(type: string, cb: Cb, o?: boolean | { capture?: boolean }): void {
    const capture = captureOf(o);
    const i = this.list.findIndex((l) => l.type === type && l.cb === cb && l.capture === capture);
    if (i < 0) return;
    this.list[i]!.removed = true;
    this.list.splice(i, 1);
  }
  count(type: string): number { return this.list.filter((l) => l.type === type).length; }
  /** "inner invoke": clone the list, run matching listeners for this phase. */
  invoke(e: FakeKeyEvent, phase: 'capturing' | 'bubbling'): void {
    const clone = [...this.list];
    e.currentTarget = this;
    for (const l of clone) {
      if (l.type !== e.type || l.removed) continue;
      if (phase === 'capturing' && !l.capture) continue;
      if (phase === 'bubbling' && l.capture) continue;
      l.cb(e);
      if (e.stoppedNow) return;
    }
  }
  dispatchEvent(e: FakeKeyEvent): boolean {
    e.target = this;
    const path: FakeNode[] = [];
    for (let n: FakeNode | null = this; n; n = n.parent) path.push(n);
    for (let i = path.length - 1; i >= 0 && !e.stopped; i--) {
      e.eventPhase = i === 0 ? 2 : 1;
      path[i]!.invoke(e, 'capturing');
    }
    for (let i = 0; i < path.length && !e.stopped; i++) {
      e.eventPhase = i === 0 ? 2 : 3;
      path[i]!.invoke(e, 'bubbling');
    }
    e.eventPhase = 0;
    e.currentTarget = null;
    return !e.defaultPrevented;
  }
}

function page() {
  const win = new FakeNode('window');
  const doc = new FakeNode('document', win);
  const body = new FakeNode('body', doc);
  const canvas = new FakeNode('canvas', body);
  return { win, doc, body, canvas };
}

/** Same check and listener target/phase as Phaser 4.2.1 KeyboardManager.startListeners. */
function phaserLike(win: FakeNode) {
  const seen: Array<{ code: string; prevented: boolean }> = [];
  const queue: string[] = [];
  const onKeyDown = (e: FakeKeyEvent) => {
    seen.push({ code: e.code, prevented: e.defaultPrevented });
    if (e.defaultPrevented) return; // Phaser: "Do nothing if event already handled"
    queue.push(e.code);
  };
  win.addEventListener('keydown', onKeyDown, false);
  return { seen, queue };
}

const press = (n: FakeNode, code: string, key = code) => {
  const e = new FakeKeyEvent('keydown', code, key);
  n.dispatchEvent(e);
  return e;
};
const asWindow = (n: FakeNode) => n as unknown as Window;

describe('installInputGuards keys (rule 1.5.1, FD-06: scroll keys reach the game, page never scrolls)', () => {
  it('FD-06 Space and ArrowLeft reach a Phaser-style window listener un-prevented and end default-prevented', () => {
    const { win, canvas } = page();
    const dispose = installInputGuards(asWindow(win)); // boot order: guards before Phaser boots
    const phaser = phaserLike(win);
    for (const code of ['Space', 'ArrowLeft']) {
      const e = press(canvas, code, code === 'Space' ? ' ' : code);
      expect(e.defaultPrevented).toBe(true); // page scroll blocked
    }
    expect(phaser.seen).toEqual([{ code: 'Space', prevented: false }, { code: 'ArrowLeft', prevented: false }]);
    expect(phaser.queue).toEqual(['Space', 'ArrowLeft']);
    dispose();
  });

  it('FD-06 every SCROLL_KEYS key, including Tab, reaches the game and is default-prevented, on every press', () => {
    const { win, body } = page();
    const dispose = installInputGuards(asWindow(win));
    const phaser = phaserLike(win);
    for (let round = 0; round < 3; round++) {
      for (const code of SCROLL_KEYS) expect(press(body, code).defaultPrevented).toBe(true);
    }
    expect(phaser.seen.every((s) => !s.prevented)).toBe(true);
    expect(phaser.queue).toHaveLength(SCROLL_KEYS.size * 3);
    expect(win.count('keydown')).toBe(3); // guard capture + guard bubble + phaser: no listener build-up
    dispose();
  });

  it('FD-06 order independent: listeners registered before the guard, on document or on window capture also see the key un-prevented', () => {
    const { win, doc, canvas } = page();
    const early = phaserLike(win); // registered BEFORE the guard
    const dispose = installInputGuards(asWindow(win));
    const late = phaserLike(win);
    const other: boolean[] = [];
    doc.addEventListener('keydown', (e) => other.push(e.defaultPrevented), false);
    win.addEventListener('keydown', (e) => other.push(e.defaultPrevented), true);
    expect(press(canvas, 'ArrowRight').defaultPrevented).toBe(true);
    expect(early.seen).toEqual([{ code: 'ArrowRight', prevented: false }]);
    expect(late.seen).toEqual([{ code: 'ArrowRight', prevented: false }]);
    expect(other).toEqual([false, false]);
    dispose();
  });

  it('1.5.2 Escape and non-scroll keys are never default-prevented and still reach the game', () => {
    const { win, canvas } = page();
    const dispose = installInputGuards(asWindow(win));
    const phaser = phaserLike(win);
    for (const code of ['Escape', 'Enter', 'KeyP', 'KeyA']) expect(press(canvas, code).defaultPrevented).toBe(false);
    expect(phaser.queue).toEqual(['Escape', 'Enter', 'KeyP', 'KeyA']);
    dispose();
  });

  it('FD-06 the disposer removes every keydown listener; afterwards scroll keys are not prevented', () => {
    const { win, canvas } = page();
    const dispose = installInputGuards(asWindow(win));
    press(canvas, 'Space');
    dispose();
    expect(win.count('keydown')).toBe(0);
    expect(press(canvas, 'Space').defaultPrevented).toBe(false);
  });

  it('FD-06 regression guard: the 0.1.0 behaviour (prevent before the game listener) would fail the first test', () => {
    const { win, canvas } = page();
    win.addEventListener('keydown', (e) => { if (SCROLL_KEYS.has(e.code)) e.preventDefault(); }, false); // 0.1.0 guard
    const phaser = phaserLike(win);
    press(canvas, 'Space');
    expect(phaser.seen).toEqual([{ code: 'Space', prevented: true }]);
    expect(phaser.queue).toEqual([]);
  });
});
