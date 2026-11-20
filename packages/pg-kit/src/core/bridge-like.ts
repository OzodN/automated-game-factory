/**
 * The subset of the Playgama Bridge v2 API the kit depends on. Production code passes the real
 * `bridge` (from `@playgama/bridge`); tests pass `createBridgeMock()` from `@factory/pg-kit/testing`.
 * Member names mirror @playgama/bridge@2.4.1 type definitions exactly.
 */
export type Listener = (...args: any[]) => void;

export interface EmitterLike {
  on(eventName: string, callback: Listener): void;
  off(eventName: string, callback?: Listener): void;
}

export interface BridgeLike {
  readonly isInitialized: boolean;
  initialize(options?: Record<string, unknown>): Promise<void>;
  setGameLoadingProgress(percent: number): void;
  readonly platform: EmitterLike & {
    readonly id: string;
    readonly language: string;
    readonly isAudioEnabled: boolean;
    readonly isPaused: boolean;
    readonly isExternalLinksAllowed: boolean;
    sendMessage(message: string, options?: Record<string, unknown> | null): Promise<unknown>;
  };
  readonly storage: EmitterLike & {
    get(key: string | string[], tryParseJson?: boolean): Promise<unknown>;
    set(key: string | string[], value: unknown): Promise<void>;
    delete(key: string | string[]): Promise<void>;
  };
  readonly advertisement: EmitterLike & {
    readonly isInterstitialSupported: boolean;
    readonly isRewardedSupported: boolean;
    readonly interstitialState: string;
    readonly rewardedState: string;
    showInterstitial(placement?: string | null): void;
    showRewarded(placement?: string | null): void;
  };
  readonly device: { readonly type: string };
  readonly analytics?: { send(eventName: string, data?: Record<string, unknown>): void };
}

/** Event / state names (identical to @playgama/bridge EVENT_NAME / *_STATE constants). */
export const EVENTS = {
  INTERSTITIAL_STATE_CHANGED: 'interstitial_state_changed',
  REWARDED_STATE_CHANGED: 'rewarded_state_changed',
  AUDIO_STATE_CHANGED: 'audio_state_changed',
  PAUSE_STATE_CHANGED: 'pause_state_changed',
  VISIBILITY_STATE_CHANGED: 'visibility_state_changed',
  PLATFORM_STORAGE_AVAILABILITY_CHANGED: 'platform_storage_availability_changed',
} as const;

export const AD_STATE = {
  LOADING: 'loading',
  OPENED: 'opened',
  CLOSED: 'closed',
  FAILED: 'failed',
  REWARDED: 'rewarded',
} as const;

export const MESSAGES = {
  GAME_READY: 'game_ready',
  GAMEPLAY_STARTED: 'gameplay_started',
  GAMEPLAY_STOPPED: 'gameplay_stopped',
  LEVEL_STARTED: 'level_started',
  LEVEL_COMPLETED: 'level_completed',
  LEVEL_FAILED: 'level_failed',
} as const;
