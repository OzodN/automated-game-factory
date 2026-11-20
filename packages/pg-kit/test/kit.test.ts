import { describe, it, expect, vi } from 'vitest';
import {
  SaveStore, AdService, ReviveGate, LifecycleController, I18n, findMissingTranslations, Rng, PlatformService,
  computeLayout, Telemetry, bootGame,
} from '../src/index.js';
import { createBridgeMock, createDocumentStub } from '../src/testing/index.js';

interface Save { best: number; userMuted: boolean }
const schema = {
  key: 'test_save',
  version: 2,
  defaults: (): Save => ({ best: 0, userMuted: false }),
  migrate: (raw: unknown, from: number | null): Save => {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const best = from === 1 ? Number(o.highScore ?? 0) : Number(o.best ?? 0);
    return { best: Number.isFinite(best) && best >= 0 ? best : 0, userMuted: o.userMuted === true };
  },
};

describe('SaveStore (rule 3.2: Bridge storage only, survives reload)', () => {
  it('round-trips through bridge storage across a reload', async () => {
    const b = createBridgeMock();
    const s1 = new SaveStore(b, schema, { debounceMs: 0 });
    await s1.load();
    s1.update((d) => ({ ...d, best: 42 }));
    await s1.flush();
    const s2 = new SaveStore(b, schema);
    expect((await s2.load()).best).toBe(42);
  });

  it('migrates v1 saves and repairs corrupt data without throwing', async () => {
    const b = createBridgeMock({ storage: { test_save: JSON.stringify({ v: 1, data: { highScore: 7 }, savedAt: 1 }) } });
    expect((await new SaveStore(b, schema).load()).best).toBe(7);
    const c = createBridgeMock({ storage: { test_save: '{not json' } });
    expect(await new SaveStore(c, schema).load()).toEqual({ best: 0, userMuted: false });
    const d = createBridgeMock({ storage: { test_save: JSON.stringify({ v: 2, data: { best: -5 } }) } });
    expect((await new SaveStore(d, schema).load()).best).toBe(0);
  });

  it('debounces writes and keeps dirty state when storage fails', async () => {
    const b = createBridgeMock();
    const timers: Array<() => void> = [];
    const s = new SaveStore(b, schema, { setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
    await s.load();
    s.update((d) => ({ ...d, best: 1 }));
    s.update((d) => ({ ...d, best: 2 }));
    expect(b.storageData.has('test_save')).toBe(false);
    await s.flush();
    expect(JSON.parse(String(b.storageData.get('test_save'))).data.best).toBe(2);
    const f = createBridgeMock({ failStorage: true });
    const sf = new SaveStore(f, schema);
    await sf.load();
    sf.update((d) => ({ ...d, best: 3 }));
    await sf.flush();
    expect(sf.hasPendingChanges).toBe(true);
    expect(sf.error).toBeTruthy();
  });
});

describe('AdService (rules 2.1, 2.2)', () => {
  it('rewards only when the REWARDED state is observed', async () => {
    const b = createBridgeMock();
    const ads = new AdService(b);
    expect(await ads.showRewarded('revive')).toBe(true);
    b.nextAd = 'close-early';
    expect(await ads.showRewarded('revive')).toBe(false);
    b.nextAd = 'fail';
    expect(await ads.showRewarded('revive')).toBe(false);
    expect(b.adCalls.map((c) => c.placement)).toEqual(['revive', 'revive', 'revive']);
  });

  it('emits adOpen around an interstitial and adds no game-side frequency timer', async () => {
    const b = createBridgeMock();
    const ads = new AdService(b);
    const seen: boolean[] = [];
    ads.events.on('adOpen', (o) => seen.push(o));
    expect(await ads.showInterstitial('level_end')).toBe('shown');
    expect(await ads.showInterstitial('level_end')).toBe('shown');
    expect(seen).toEqual([true, false, true, false]);
  });

  it('never freezes the game when the platform never answers', async () => {
    vi.useFakeTimers();
    const b = createBridgeMock();
    b.nextAd = 'never-answer';
    const p = new AdService(b, 1000).showInterstitial('x');
    await vi.advanceTimersByTimeAsync(1001);
    expect(await p).toBe('failed');
    vi.useRealTimers();
  });

  it('reports unsupported formats and caps revives once per attempt', async () => {
    const ads = new AdService(createBridgeMock({ interstitialSupported: false, rewardedSupported: false }));
    expect(await ads.showInterstitial('x')).toBe('unsupported');
    expect(await ads.showRewarded('x')).toBe(false);
    const g = new ReviveGate();
    expect(g.consume()).toBe(true);
    expect(g.consume()).toBe(false);
    g.resetForNewAttempt();
    expect(g.available).toBe(true);
  });
});

describe('LifecycleController (rules 2.1.3, 3.3.4, 3.3.5)', () => {
  it('allows audio only when all five conditions hold', () => {
    const b = createBridgeMock();
    const doc = createDocumentStub();
    const l = new LifecycleController().attach(b, doc);
    expect(l.audioAllowed).toBe(true);
    const cases: Array<[Record<string, boolean>, boolean]> = [[{ userMuted: true }, false], [{ adOpen: true }, false], [{ userPaused: true }, true]];
    for (const [patch, expected] of cases) {
      const l2 = new LifecycleController();
      l2.set(patch);
      expect(l2.audioAllowed).toBe(expected);
    }
    b.setPlatformAudio(false);
    expect(l.audioAllowed).toBe(false);
    b.setPlatformAudio(true);
    b.setPlatformPaused(true);
    expect(l.audioAllowed).toBe(false);
    expect(l.systemPaused).toBe(true);
    b.setPlatformPaused(false);
    doc.setHidden(true);
    expect(l.audioAllowed).toBe(false);
    doc.setHidden(false);
    expect(l.audioAllowed).toBe(true);
  });

  it('starts muted when the platform reports audio disabled at startup', () => {
    const l = new LifecycleController().attach(createBridgeMock({ audioEnabled: false }), createDocumentStub());
    expect(l.audioAllowed).toBe(false);
  });

  it('emits audio changes only on transitions', () => {
    const l = new LifecycleController();
    const ev: boolean[] = [];
    l.events.on('audio', (a) => ev.push(a));
    l.set({ adOpen: true });
    l.set({ hidden: true });
    l.set({ adOpen: false });
    l.set({ hidden: false });
    expect(ev).toEqual([false, true]);
  });
});

describe('I18n (rules 3.4.x)', () => {
  const dicts = { en: { play: 'Play', score: 'Score: {n}' }, ru: { play: 'Igrat', score: 'Schet: {n}' } };
  it('uses the platform language with English fallback', () => {
    expect(new I18n(dicts, 'ru').t('play')).toBe('Igrat');
    expect(new I18n(dicts, 'de').language).toBe('en');
    expect(new I18n(dicts, 'pt-BR').language).toBe('en');
    expect(new I18n(dicts, 'en').t('score', { n: 5 })).toBe('Score: 5');
  });
  it('detects missing keys and placeholder mismatches', () => {
    expect(findMissingTranslations(dicts)).toEqual([]);
    expect(findMissingTranslations({ en: { a: 'x {n}' }, ru: { a: 'y' } })).toContain('ru: placeholders differ for "a"');
    expect(() => new I18n({ ru: {} } as never, 'ru')).toThrow(/English/);
  });
});

describe('Platform, Rng, layout, telemetry, boot', () => {
  it('sends game_ready once and alternates gameplay messages', async () => {
    const b = createBridgeMock();
    const p = new PlatformService(b);
    await p.initialize();
    await p.gameReady();
    await p.gameReady();
    await p.gameplayStarted();
    await p.gameplayStarted();
    await p.gameplayStopped();
    await p.gameplayStopped();
    expect(b.messages).toEqual(['game_ready', 'gameplay_started', 'gameplay_stopped']);
  });

  it('rng is deterministic per seed', () => {
    const a = new Rng(123);
    const b = new Rng(123);
    expect([a.next(), a.int(1, 6), a.next()]).toEqual([b.next(), b.int(1, 6), b.next()]);
    expect(new Rng(1).next()).not.toBe(new Rng(2).next());
  });

  it('layout covers all reference viewports without bars', () => {
    const cases: Array<[number, number, string]> = [[375, 812, 'portrait'], [600, 600, 'square'], [1920, 1080, 'landscape']];
    for (const [w, h, o] of cases) {
      const l = computeLayout(w, h, 720, 1280);
      expect(l.orientation).toBe(o);
      expect(l.content.width).toBeLessThanOrEqual(w + 1e-6);
      expect(720 * l.coverScale).toBeGreaterThanOrEqual(w - 1e-6);
      expect(1280 * l.coverScale).toBeGreaterThanOrEqual(h - 1e-6);
    }
  });

  it('telemetry validates names and payloads', () => {
    const b = createBridgeMock();
    const t = new Telemetry(b);
    t.send('level_complete', { level: 3 });
    expect(b.analyticsEvents).toEqual([{ name: 'level_complete', data: { level: 3 } }]);
    expect(() => t.send('Bad Name')).toThrow();
    expect(() => t.send('ok_name', { x: {} as never })).toThrow();
  });

  it('boot restores user mute, mutes during ads and flushes saves when an ad opens', async () => {
    const b = createBridgeMock({ storage: { test_save: JSON.stringify({ v: 2, data: { best: 1, userMuted: true } }) } });
    const ctx = await bootGame({ bridge: b, dictionaries: { en: {} }, save: schema, seed: 7, installGuards: false });
    expect(ctx.lifecycle.audioAllowed).toBe(false);
    ctx.lifecycle.set({ userMuted: false });
    ctx.save.update((d) => ({ ...d, best: 99 }));
    const states: boolean[] = [];
    ctx.lifecycle.events.on('audio', (a) => states.push(a));
    await ctx.ads.showInterstitial('game_over');
    expect(states).toEqual([false, true]);
    expect(JSON.parse(String(b.storageData.get('test_save'))).data.best).toBe(99);
    expect(ctx.rng.seed).toBe(7);
  });
});
