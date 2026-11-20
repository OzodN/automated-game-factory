import * as Phaser from 'phaser';
import { GAME_CONFIG } from '../game/config';

/** Rounded button built from vector graphics (no emoji icons — rule 4.3.2). */
export function makeButton(scene: Phaser.Scene, label: string, onClick: () => void, width = 320, height = 88): Phaser.GameObjects.Container {
  const bg = scene.add.graphics();
  const draw = (color: number) => {
    bg.clear();
    bg.fillStyle(color, 1);
    bg.fillRoundedRect(-width / 2, -height / 2, width, height, 22);
  };
  draw(GAME_CONFIG.colors.accent);
  const text = scene.add.text(0, 0, label, { fontFamily: GAME_CONFIG.fontFamily, fontSize: '38px', color: '#ffffff', fontStyle: 'bold' }).setOrigin(0.5);
  const c = scene.add.container(0, 0, [bg, text]).setSize(width, height).setInteractive({ useHandCursor: true });
  c.on('pointerover', () => draw(GAME_CONFIG.colors.accentHover));
  c.on('pointerout', () => draw(GAME_CONFIG.colors.accent));
  c.on('pointerup', onClick);
  return c;
}

/** Speaker icon mute toggle drawn with graphics (rule 3.3.3: a mute button is required). */
export function makeMuteToggle(scene: Phaser.Scene, isMuted: () => boolean, toggle: () => void): Phaser.GameObjects.Container {
  const g = scene.add.graphics();
  const redraw = () => {
    g.clear();
    g.fillStyle(0xffffff, 1);
    g.fillRect(-18, -8, 10, 16);
    g.fillTriangle(-8, -8, 6, -20, 6, 20);
    g.fillTriangle(-8, -8, -8, 8, 6, 20);
    g.lineStyle(4, 0xffffff, 1);
    if (isMuted()) {
      g.lineBetween(12, -12, 28, 12);
      g.lineBetween(28, -12, 12, 12);
    } else {
      g.beginPath();
      g.arc(8, 0, 14, -0.8, 0.8);
      g.strokePath();
    }
  };
  redraw();
  const c = scene.add.container(0, 0, [g]).setSize(72, 72).setInteractive({ useHandCursor: true });
  c.on('pointerup', () => {
    toggle();
    redraw();
  });
  return c;
}
