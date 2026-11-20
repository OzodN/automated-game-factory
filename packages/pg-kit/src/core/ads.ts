import { AD_STATE, EVENTS, type BridgeLike } from './bridge-like.js';
import { Emitter } from './emitter.js';

export type InterstitialResult = 'shown' | 'failed' | 'unsupported';

/**
 * Advertising per Playgama rules:
 * - Interstitials at natural pauses only; NO game-side frequency timers (Bridge enforces the
 *   minimum delay itself and may skip the call — that resolves as 'failed'/no-op quickly).
 * - Rewarded: player-initiated; reward granted ONLY when the REWARDED state is observed
 *   (closing early never rewards).
 * - Emits adOpen(true/false) so the lifecycle controller mutes audio and pauses gameplay.
 */
export class AdService {
  readonly events = new Emitter<{ adOpen: [boolean] }>();
  private busy = false;

  constructor(private readonly bridge: BridgeLike, private readonly timeoutMs = 45000) {}

  get rewardedSupported(): boolean {
    return this.bridge.advertisement.isRewardedSupported;
  }

  get interstitialSupported(): boolean {
    return this.bridge.advertisement.isInterstitialSupported;
  }

  /** Call at level end / game over / return to menu. Resolves when the ad flow is over. */
  showInterstitial(placement: string): Promise<InterstitialResult> {
    if (!this.interstitialSupported) return Promise.resolve('unsupported');
    if (this.busy) return Promise.resolve('failed');
    return this.run(EVENTS.INTERSTITIAL_STATE_CHANGED, () => this.bridge.advertisement.showInterstitial(placement)).then((r) =>
      r.opened ? 'shown' : 'failed',
    );
  }

  /** Resolves true only if the platform reported the REWARDED state. */
  showRewarded(placement: string): Promise<boolean> {
    if (!this.rewardedSupported || this.busy) return Promise.resolve(false);
    return this.run(EVENTS.REWARDED_STATE_CHANGED, () => this.bridge.advertisement.showRewarded(placement)).then((r) => r.rewarded);
  }

  private run(eventName: string, start: () => void): Promise<{ opened: boolean; rewarded: boolean }> {
    this.busy = true;
    return new Promise((resolve) => {
      let opened = false;
      let rewarded = false;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        this.bridge.advertisement.off(eventName, onState);
        this.busy = false;
        if (opened) this.events.emit('adOpen', false);
        resolve({ opened, rewarded });
      };
      const onState = (state: string) => {
        if (state === AD_STATE.OPENED && !opened) {
          opened = true;
          this.events.emit('adOpen', true);
        } else if (state === AD_STATE.REWARDED) {
          rewarded = true;
        } else if (state === AD_STATE.CLOSED || state === AD_STATE.FAILED) {
          finish();
        }
      };
      // Safety net: never leave the game frozen if the platform never answers.
      const guard = setTimeout(finish, this.timeoutMs);
      this.bridge.advertisement.on(eventName, onState);
      try {
        start();
      } catch {
        finish();
      }
    });
  }
}

/** Rule 2.2.4: a revive may be offered at most once per attempt. */
export class ReviveGate {
  private used = false;
  get available(): boolean {
    return !this.used;
  }
  consume(): boolean {
    if (this.used) return false;
    this.used = true;
    return true;
  }
  /** Call when a new attempt (run/level) starts. */
  resetForNewAttempt(): void {
    this.used = false;
  }
}
