/**
 * Phaser adapter (works with Phaser 3.60+ and Phaser 4; only structural types are used so the kit
 * does not bundle or pin Phaser — each game owns its Phaser version).
 */
import type { LifecycleController } from '../core/lifecycle.js';
import type { PlatformService } from '../core/platform.js';

interface SoundManagerLike {
  mute: boolean;
  pauseAll?: () => void;
  resumeAll?: () => void;
}
interface GameLike {
  sound: SoundManagerLike;
  loop: { sleep: () => void; wake: () => void };
}
interface LoaderLike {
  on(event: 'progress', fn: (p: number) => void): unknown;
}

/** Mute/unmute Phaser sound per the lifecycle matrix; freeze the loop on system pause. Returns disposer. */
export function bindPhaserLifecycle(game: GameLike, lifecycle: LifecycleController): () => void {
  const applyAudio = (allowed: boolean) => {
    game.sound.mute = !allowed;
    if (allowed) game.sound.resumeAll?.();
    else game.sound.pauseAll?.();
  };
  const applyPause = (paused: boolean) => (paused ? game.loop.sleep() : game.loop.wake());
  applyAudio(lifecycle.audioAllowed);
  const offA = lifecycle.events.on('audio', applyAudio);
  const offP = lifecycle.events.on('systemPause', applyPause);
  return () => {
    offA();
    offP();
  };
}

/** Forward Phaser loader progress to the platform loading indicator. */
export function bindLoaderProgress(loader: LoaderLike, platform: PlatformService): void {
  loader.on('progress', (p: number) => platform.setLoadingProgress(p * 100));
}

/** Recommended Phaser scale config: canvas fills the viewport in every aspect (no black bars). */
export function responsiveScaleConfig(parent: string): Record<string, unknown> {
  return {
    parent,
    mode: 3, // Phaser.Scale.RESIZE
    autoCenter: 0, // Phaser.Scale.NO_CENTER
    width: '100%',
    height: '100%',
  };
}
