import * as Phaser from 'phaser';
import { computeLayout } from '@factory/pg-kit';
import { getContext } from '../game/context';
import { GAME_CONFIG } from '../game/config';
import { dedupeKeyEvents } from '../ui/key-dedupe';
import { trackScene } from '../game/test-state';
import { makeButton, makeMuteToggle } from '../ui/widgets';

/** First interactive screen: sends game_ready once it is visible and usable. */
export class MenuScene extends Phaser.Scene {
  private title!: Phaser.GameObjects.Text;
  private best!: Phaser.GameObjects.Text;
  private playBtn!: Phaser.GameObjects.Container;
  private mute!: Phaser.GameObjects.Container;

  constructor() {
    super('Menu');
  }

  create(): void {
    const ctx = getContext();
    const style = { fontFamily: GAME_CONFIG.fontFamily, color: GAME_CONFIG.colors.text };
    this.title = this.add.text(0, 0, ctx.i18n.t('title'), { ...style, fontSize: '64px', fontStyle: 'bold' }).setOrigin(0.5);
    this.best = this.add.text(0, 0, ctx.i18n.t('best', { n: ctx.save.get().best }), { ...style, fontSize: '34px' }).setOrigin(0.5);
    const play = () => this.scene.start('Play');
    this.playBtn = makeButton(this, ctx.i18n.t('play'), play);
    this.mute = makeMuteToggle(this, () => ctx.save.get().userMuted, () => {
      const muted = !ctx.save.get().userMuted;
      ctx.save.update((d) => ({ ...d, userMuted: muted }));
      ctx.lifecycle.set({ userMuted: muted });
    });
    // Phaser 4.2.1 replays queued key events (D-03): every keyboard handler that transitions goes through the helper.
    const onEnter = dedupeKeyEvents((): void => {
      play();
    });
    this.input.keyboard?.on('keydown-ENTER', onEnter);
    this.events.on('test:play', play);
    trackScene(this);
    this.layout();
    this.scale.on('resize', this.layout, this);
    this.events.once('shutdown', () => {
      this.scale.off('resize', this.layout, this);
      this.input.keyboard?.off('keydown-ENTER', onEnter);
    });
    void ctx.platform.gameReady();
  }

  private layout(): void {
    const { width, height } = this.scale;
    const l = computeLayout(width, height, GAME_CONFIG.designWidth, GAME_CONFIG.designHeight);
    const s = Math.min(1.4, Math.max(0.55, l.fitScale * 1.2));
    this.title.setPosition(width / 2, height * 0.3).setScale(s);
    this.best.setPosition(width / 2, height * 0.42).setScale(s);
    this.playBtn.setPosition(width / 2, height * 0.6).setScale(s);
    this.mute.setPosition(width - 56 * s, 56 * s).setScale(s);
  }
}
