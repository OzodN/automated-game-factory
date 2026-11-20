import * as Phaser from 'phaser';
import { bindLoaderProgress } from '@factory/pg-kit/phaser';
import { getContext } from '../game/context';

/** Loads all assets (bundled, relative paths only) and reports progress to the platform. */
export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  preload(): void {
    const { platform } = getContext();
    bindLoaderProgress(this.load, platform);
    const bar = document.getElementById('boot-progress');
    this.load.on('progress', (p: number) => {
      if (bar) bar.style.width = `${Math.max(3, Math.round(p * 100))}%`;
    });
    // Asset loading goes here, e.g.: this.load.audio('click', ['assets/audio/click.ogg', 'assets/audio/click.mp3']);
  }

  create(): void {
    const loader = document.getElementById('boot-loader');
    if (loader) {
      loader.style.opacity = '0';
      window.setTimeout(() => loader.remove(), 250);
    }
    getContext().platform.setLoadingProgress(100);
    this.scene.start('Menu');
  }
}
