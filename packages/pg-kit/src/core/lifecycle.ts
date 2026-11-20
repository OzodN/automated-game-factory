import { EVENTS, type BridgeLike } from './bridge-like.js';
import { Emitter } from './emitter.js';

/** The part of `document` the lifecycle needs (visibility). */
export interface VisibilitySource {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface LifecycleState {
  userMuted: boolean;
  platformAudioEnabled: boolean;
  platformPaused: boolean;
  adOpen: boolean;
  hidden: boolean;
  userPaused: boolean;
}

/**
 * Single source of truth for "may sound play?" and "must gameplay pause?".
 * Sound plays iff: !userMuted && platformAudioEnabled && !platformPaused && !adOpen && !hidden
 * Gameplay pauses iff: platformPaused || adOpen || hidden || userPaused
 * (Playgama rules 2.1.3, 3.3.4, 3.3.5)
 */
export class LifecycleController {
  readonly events = new Emitter<{ audio: [boolean]; pause: [boolean]; systemPause: [boolean]; change: [LifecycleState] }>();
  private s: LifecycleState;
  private lastAudio: boolean | null = null;
  private lastPause: boolean | null = null;
  private lastSystemPause: boolean | null = null;
  private readonly unbind: Array<() => void> = [];

  constructor(initial: Partial<LifecycleState> = {}) {
    this.s = {
      userMuted: false,
      platformAudioEnabled: true,
      platformPaused: false,
      adOpen: false,
      hidden: false,
      userPaused: false,
      ...initial,
    };
  }

  /** Wire Bridge platform events and document visibility. */
  attach(bridge: BridgeLike, doc: VisibilitySource | null = (globalThis.document as unknown as VisibilitySource) ?? null): this {
    this.set({ platformAudioEnabled: bridge.platform.isAudioEnabled, platformPaused: bridge.platform.isPaused });
    const onAudio = (enabled: boolean) => this.set({ platformAudioEnabled: enabled === true });
    const onPause = (paused: boolean) => this.set({ platformPaused: paused === true });
    bridge.platform.on(EVENTS.AUDIO_STATE_CHANGED, onAudio);
    bridge.platform.on(EVENTS.PAUSE_STATE_CHANGED, onPause);
    this.unbind.push(() => bridge.platform.off(EVENTS.AUDIO_STATE_CHANGED, onAudio), () => bridge.platform.off(EVENTS.PAUSE_STATE_CHANGED, onPause));
    if (doc) {
      const onVis = () => this.set({ hidden: doc.visibilityState === 'hidden' });
      doc.addEventListener('visibilitychange', onVis);
      this.unbind.push(() => doc.removeEventListener('visibilitychange', onVis));
      onVis();
    }
    return this;
  }

  detach(): void {
    for (const u of this.unbind.splice(0)) u();
  }

  get state(): Readonly<LifecycleState> {
    return this.s;
  }

  get audioAllowed(): boolean {
    const s = this.s;
    return !s.userMuted && s.platformAudioEnabled && !s.platformPaused && !s.adOpen && !s.hidden;
  }

  get paused(): boolean {
    const s = this.s;
    return s.platformPaused || s.adOpen || s.hidden || s.userPaused;
  }

  /** Paused by something outside the game's own UI (platform, ad, hidden tab): freeze the loop. */
  get systemPaused(): boolean {
    const s = this.s;
    return s.platformPaused || s.adOpen || s.hidden;
  }

  set(patch: Partial<LifecycleState>): void {
    this.s = { ...this.s, ...patch };
    this.events.emit('change', this.s);
    const sp = this.systemPaused;
    if (sp !== this.lastSystemPause) {
      this.lastSystemPause = sp;
      this.events.emit('systemPause', sp);
    }
    const a = this.audioAllowed;
    if (a !== this.lastAudio) {
      this.lastAudio = a;
      this.events.emit('audio', a);
    }
    const p = this.paused;
    if (p !== this.lastPause) {
      this.lastPause = p;
      this.events.emit('pause', p);
    }
  }
}
