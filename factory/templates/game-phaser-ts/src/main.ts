/**
 * Boot order (factory standard GE-BOOT, do not reorder):
 * 1. Bridge + lifecycle + save + i18n (bootGame)  2. Phaser game with responsive scale
 * 3. BootScene loads assets (progress -> platform)  4. MenuScene becomes interactive -> game_ready
 */
import * as Phaser from 'phaser';
import bridge from '@playgama/bridge';
import { bootGame, exposeTestHook, type BridgeLike } from '@factory/pg-kit';
import { bindPhaserLifecycle } from '@factory/pg-kit/phaser';
import { DICTIONARIES } from './i18n';
import { SAVE_SCHEMA } from './game/save';
import { setContext } from './game/context';
import { GAME_CONFIG } from './game/config';
import { BootScene } from './scenes/BootScene';
import { MenuScene } from './scenes/MenuScene';
import { PlayScene } from './scenes/PlayScene';
import { GameOverScene } from './scenes/GameOverScene';
import { snapshot, testActions } from './game/test-state';

async function start(): Promise<void> {
  const ctx = await bootGame({ bridge: bridge as unknown as BridgeLike, dictionaries: DICTIONARIES, save: SAVE_SCHEMA });
  setContext(ctx);
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game-container',
    backgroundColor: GAME_CONFIG.background,
    scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.NO_CENTER, width: window.innerWidth, height: window.innerHeight },
    render: { antialias: true, pixelArt: false },
    disableContextMenu: true,
    scene: [BootScene, MenuScene, PlayScene, GameOverScene],
  });
  bindPhaserLifecycle(game as unknown as Parameters<typeof bindPhaserLifecycle>[0], ctx.lifecycle);
  exposeTestHook(ctx, () => snapshot(game), testActions(game));
}

start().catch((err: unknown) => {
  console.error('Fatal boot error', err);
});
