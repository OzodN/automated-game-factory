import * as Phaser from 'phaser';
import { computeLayout } from '@factory/pg-kit';
import { getContext } from '../game/context';
import { GAME_CONFIG } from '../game/config';
import { trackScene } from '../game/test-state';

const TAPS_TO_FINISH = 3;

/**
 * PLACEHOLDER gameplay loop proving the platform wiring (gameplay_started/stopped, saves, layout).
 * The game's first implementation tasks replace this scene entirely.
 */
export class PlayScene extends Phaser.Scene {
  private taps = 0;
  private target!: Phaser.GameObjects.Arc;
  private hint!: Phaser.GameObjects.Text;

  constructor() {
    super('Play');
  }

  create(): void {
    const ctx = getContext();
    this.taps = 0;
    void ctx.platform.gameplayStarted();
    this.hint = this.add.text(0, 0, ctx.i18n.t('tap_hint', { n: TAPS_TO_FINISH }), { fontFamily: GAME_CONFIG.fontFamily, color: GAME_CONFIG.colors.text, fontSize: '36px' }).setOrigin(0.5);
    this.target = this.add.circle(0, 0, 90, GAME_CONFIG.colors.accent).setInteractive({ useHandCursor: true });
    this.target.on('pointerdown', () => this.hit());
    this.events.on('test:finish', () => this.finish());
    trackScene(this);
    this.layout();
    this.scale.on('resize', this.layout, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.layout, this));
  }

  private hit(): void {
    this.taps += 1;
    const { rng } = getContext();
    const { width, height } = this.scale;
    this.target.setPosition(rng.int(Math.floor(width * 0.2), Math.floor(width * 0.8)), rng.int(Math.floor(height * 0.35), Math.floor(height * 0.8)));
    if (this.taps >= TAPS_TO_FINISH) this.finish();
  }

  private finish(): void {
    const ctx = getContext();
    void ctx.platform.gameplayStopped();
    const score = this.taps * 10;
    ctx.save.update((d) => ({ ...d, plays: d.plays + 1, best: Math.max(d.best, score) }));
    void ctx.save.flush();
    this.scene.start('GameOver', { score });
  }

  private layout(): void {
    const { width, height } = this.scale;
    const l = computeLayout(width, height, GAME_CONFIG.designWidth, GAME_CONFIG.designHeight);
    this.hint.setPosition(width / 2, height * 0.18).setScale(Math.min(1.3, Math.max(0.6, l.fitScale * 1.2)));
    if (this.taps === 0) this.target.setPosition(width / 2, height * 0.55);
  }
}
