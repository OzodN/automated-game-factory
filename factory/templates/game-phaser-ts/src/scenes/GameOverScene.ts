import * as Phaser from 'phaser';
import { computeLayout } from '@factory/pg-kit';
import { getContext } from '../game/context';
import { GAME_CONFIG } from '../game/config';
import { makeButton } from '../ui/widgets';

/** Natural pause: interstitial is requested here (Bridge decides frequency; no game timers). */
export class GameOverScene extends Phaser.Scene {
  private items: Phaser.GameObjects.GameObject[] = [];
  private score = 0;

  constructor() {
    super('GameOver');
  }

  init(data: { score?: number }): void {
    this.score = data.score ?? 0;
  }

  create(): void {
    const ctx = getContext();
    const style = { fontFamily: GAME_CONFIG.fontFamily, color: GAME_CONFIG.colors.text };
    const title = this.add.text(0, 0, ctx.i18n.t('game_over'), { ...style, fontSize: '60px', fontStyle: 'bold' }).setOrigin(0.5);
    const score = this.add.text(0, 0, ctx.i18n.t('score', { n: this.score }), { ...style, fontSize: '40px' }).setOrigin(0.5);
    const retry = makeButton(this, ctx.i18n.t('retry'), () => this.scene.start('Play'));
    const menu = makeButton(this, ctx.i18n.t('menu'), () => this.scene.start('Menu'));
    this.items = [title, score, retry, menu];
    if (ctx.ads.rewardedSupported) {
      // Opt-in rewarded: reward only when the platform confirms the REWARDED state.
      const doubleBtn = makeButton(this, ctx.i18n.t('double_reward'), () => {
        doubleBtn.disableInteractive().setAlpha(0.5);
        void ctx.ads.showRewarded('double_reward').then((rewarded) => {
          if (!rewarded) return;
          this.score *= 2;
          score.setText(ctx.i18n.t('score', { n: this.score }));
          ctx.save.update((d) => ({ ...d, best: Math.max(d.best, this.score) }));
        });
      });
      this.items.push(doubleBtn);
    }
    this.layout();
    this.scale.on('resize', this.layout, this);
    this.events.once('shutdown', () => this.scale.off('resize', this.layout, this));
    void ctx.ads.showInterstitial('game_over');
  }

  private layout(): void {
    const { width, height } = this.scale;
    const l = computeLayout(width, height, GAME_CONFIG.designWidth, GAME_CONFIG.designHeight);
    const s = Math.min(1.3, Math.max(0.55, l.fitScale * 1.2));
    this.items.forEach((o, i) => {
      (o as unknown as Phaser.GameObjects.Components.Transform).setPosition(width / 2, height * (0.22 + i * 0.14));
      (o as unknown as Phaser.GameObjects.Components.Transform).setScale(s);
    });
  }
}
