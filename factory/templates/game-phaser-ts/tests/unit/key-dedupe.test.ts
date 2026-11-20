import { describe, it, expect, vi } from 'vitest';
import { dedupeKeyEvents } from '../../src/ui/key-dedupe';

describe('dedupeKeyEvents (Phaser 4.2.1 key replay guard)', () => {
  it('runs the handler once for the same event object and passes that object', () => {
    const inner = vi.fn();
    const wrapped = dedupeKeyEvents(inner);
    const e = { code: 'Enter' };
    wrapped(e);
    wrapped(e);
    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledWith(e);
  });

  it('runs the handler for each distinct event object', () => {
    const inner = vi.fn();
    const wrapped = dedupeKeyEvents(inner);
    wrapped({ code: 'Enter' });
    wrapped({ code: 'Enter' });
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('keeps a separate seen set per wrapper (a restarted scene starts clean)', () => {
    const inner = vi.fn();
    const a = dedupeKeyEvents(inner);
    const b = dedupeKeyEvents(inner);
    const e = {};
    a(e);
    b(e);
    a(e);
    expect(inner).toHaveBeenCalledTimes(2);
  });
});
