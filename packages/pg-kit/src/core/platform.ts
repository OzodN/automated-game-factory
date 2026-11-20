import { type BridgeLike, MESSAGES } from './bridge-like.js';

export interface PlatformInfo {
  id: string;
  language: string;
  deviceType: string;
  externalLinksAllowed: boolean;
}

/**
 * Wraps Bridge initialization and the lifecycle messages Playgama requires.
 * - `gameReady()` is idempotent and must be called once the first interactive screen is shown
 *   (never during a loading screen).
 * - gameplay started/stopped messages are de-duplicated so they always alternate.
 */
export class PlatformService {
  private readySent = false;
  private inGameplay = false;

  constructor(private readonly bridge: BridgeLike) {}

  async initialize(): Promise<PlatformInfo> {
    if (!this.bridge.isInitialized) await this.bridge.initialize();
    return this.info();
  }

  info(): PlatformInfo {
    return {
      id: this.bridge.platform.id,
      language: this.bridge.platform.language,
      deviceType: this.bridge.device.type,
      externalLinksAllowed: this.bridge.platform.isExternalLinksAllowed,
    };
  }

  setLoadingProgress(percent: number): void {
    this.bridge.setGameLoadingProgress(Math.max(0, Math.min(100, Math.round(percent))));
  }

  get isGameReadySent(): boolean {
    return this.readySent;
  }

  async gameReady(): Promise<void> {
    if (this.readySent) return;
    this.readySent = true;
    await this.bridge.platform.sendMessage(MESSAGES.GAME_READY);
  }

  async gameplayStarted(): Promise<void> {
    if (this.inGameplay) return;
    this.inGameplay = true;
    await this.bridge.platform.sendMessage(MESSAGES.GAMEPLAY_STARTED);
  }

  async gameplayStopped(): Promise<void> {
    if (!this.inGameplay) return;
    this.inGameplay = false;
    await this.bridge.platform.sendMessage(MESSAGES.GAMEPLAY_STOPPED);
  }

  /** Rule 1.2.6: links out are shown only when the platform allows them. */
  canShowExternalLinks(): boolean {
    return this.bridge.platform.isExternalLinksAllowed === true;
  }
}
