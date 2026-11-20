import { AD_STATE, EVENTS, type BridgeLike, type Listener } from '../core/bridge-like.js';

export type AdScript = 'complete' | 'close-early' | 'fail' | 'never-answer';

export interface BridgeMockOptions {
  language?: string;
  audioEnabled?: boolean;
  paused?: boolean;
  deviceType?: 'desktop' | 'mobile' | 'tablet' | 'tv';
  interstitialSupported?: boolean;
  rewardedSupported?: boolean;
  externalLinksAllowed?: boolean;
  storage?: Record<string, unknown>;
  failStorage?: boolean;
}

class Bus {
  private m = new Map<string, Set<Listener>>();
  on(e: string, f: Listener) { (this.m.get(e) ?? this.m.set(e, new Set()).get(e)!).add(f); }
  off(e: string, f?: Listener) { if (!f) this.m.delete(e); else this.m.get(e)?.delete(f); }
  emit(e: string, ...a: unknown[]) { for (const f of [...(this.m.get(e) ?? [])]) f(...a); }
}

export interface BridgeMock extends BridgeLike {
  readonly messages: string[];
  readonly storageData: Map<string, unknown>;
  readonly adCalls: Array<{ kind: 'interstitial' | 'rewarded'; placement: string | null | undefined }>;
  readonly analyticsEvents: Array<{ name: string; data?: Record<string, unknown> }>;
  nextAd: AdScript;
  setPlatformPaused(p: boolean): void;
  setPlatformAudio(enabled: boolean): void;
}

/** Deterministic in-memory Bridge for unit tests. Ad flows complete on a microtask chain. */
export function createBridgeMock(o: BridgeMockOptions = {}): BridgeMock {
  const platformBus = new Bus();
  const adBus = new Bus();
  const storageBus = new Bus();
  const state = { initialized: false, paused: o.paused ?? false, audio: o.audioEnabled ?? true, inter: 'closed', rew: 'closed' };
  const messages: string[] = [];
  const storageData = new Map<string, unknown>(Object.entries(o.storage ?? {}));
  const adCalls: BridgeMock['adCalls'] = [];
  const analyticsEvents: BridgeMock['analyticsEvents'] = [];
  const flow = async (bus: Bus, ev: string, script: AdScript, rewarded: boolean, set: (s: string) => void) => {
    const step = async (s: string) => { await Promise.resolve(); set(s); bus.emit(ev, s); };
    await step(AD_STATE.LOADING);
    if (script === 'fail') return step(AD_STATE.FAILED);
    if (script === 'never-answer') return;
    await step(AD_STATE.OPENED);
    if (rewarded && script === 'complete') await step(AD_STATE.REWARDED);
    await step(AD_STATE.CLOSED);
  };
  const mock: BridgeMock = {
    get isInitialized() { return state.initialized; },
    async initialize() { state.initialized = true; },
    setGameLoadingProgress() {},
    platform: {
      id: 'mock',
      language: o.language ?? 'en',
      get isAudioEnabled() { return state.audio; },
      get isPaused() { return state.paused; },
      isExternalLinksAllowed: o.externalLinksAllowed ?? false,
      async sendMessage(m: string) { messages.push(m); },
      on: (e, f) => platformBus.on(e, f),
      off: (e, f) => platformBus.off(e, f),
    },
    storage: {
      async get(key: string | string[]) {
        if (o.failStorage) throw new Error('STORAGE_NOT_AVAILABLE');
        return Array.isArray(key) ? key.map((k) => storageData.get(k) ?? null) : storageData.get(key) ?? null;
      },
      async set(key: string | string[], value: unknown) {
        if (o.failStorage) throw new Error('STORAGE_NOT_AVAILABLE');
        if (Array.isArray(key)) key.forEach((k, i) => storageData.set(k, (value as unknown[])[i])); else storageData.set(key, value);
      },
      async delete(key: string | string[]) { for (const k of [key].flat()) storageData.delete(k); },
      on: (e, f) => storageBus.on(e, f),
      off: (e, f) => storageBus.off(e, f),
    },
    advertisement: {
      isInterstitialSupported: o.interstitialSupported ?? true,
      isRewardedSupported: o.rewardedSupported ?? true,
      get interstitialState() { return state.inter; },
      get rewardedState() { return state.rew; },
      showInterstitial(placement) { adCalls.push({ kind: 'interstitial', placement }); void flow(adBus, EVENTS.INTERSTITIAL_STATE_CHANGED, mock.nextAd, false, (s) => { state.inter = s; }); },
      showRewarded(placement) { adCalls.push({ kind: 'rewarded', placement }); void flow(adBus, EVENTS.REWARDED_STATE_CHANGED, mock.nextAd, true, (s) => { state.rew = s; }); },
      on: (e, f) => adBus.on(e, f),
      off: (e, f) => adBus.off(e, f),
    },
    device: { type: o.deviceType ?? 'desktop' },
    analytics: { send(name, data) { analyticsEvents.push({ name, data }); } },
    messages,
    storageData,
    adCalls,
    analyticsEvents,
    nextAd: 'complete',
    setPlatformPaused(p) { state.paused = p; platformBus.emit(EVENTS.PAUSE_STATE_CHANGED, p); },
    setPlatformAudio(en) { state.audio = en; platformBus.emit(EVENTS.AUDIO_STATE_CHANGED, en); },
  };
  return mock;
}

/** Minimal visibility-capable document stub for lifecycle tests. */
export function createDocumentStub() {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: (_: string, f: () => void) => listeners.add(f),
    removeEventListener: (_: string, f: () => void) => listeners.delete(f),
    setHidden(hidden: boolean) { doc.visibilityState = hidden ? 'hidden' : 'visible'; for (const f of listeners) f(); },
  };
  return doc;
}
