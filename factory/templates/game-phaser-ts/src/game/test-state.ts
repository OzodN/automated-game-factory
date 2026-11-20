import type * as Phaser from 'phaser';
import { getContext } from './context';

/** Test-probe data (only filled with ?pgtest=1; production registers nothing). */
const keysSeen: string[] = [];
let keysTotal = 0;
const sceneStarts: Record<string, number> = {};
const seenEvents = new WeakSet<object>();

/**
 * Test probe (FX-08). Scenes call it from create(); it does nothing unless the page has ?pgtest=1, so production adds no
 * listener. It records (1) every distinct keydown a Phaser scene keyboard plugin receives, once per event object (Phaser
 * 4.2.1 replays queued events, D-03) as the recent codes `keysSeen` and the running total `keysTotal`, and (2) how often
 * each scene was created (`sceneStarts`). Phaser ignores keydown events whose defaultPrevented is already true, so a kit
 * regression that prevents scroll keys before Phaser (pg-kit 0.1.0, FD-06) makes the real-key e2e test fail.
 */
export function trackScene(scene: Phaser.Scene): void {
  if (typeof location === 'undefined' || !new URLSearchParams(location.search).has('pgtest')) return;
  const key = scene.scene.key;
  sceneStarts[key] = (sceneStarts[key] ?? 0) + 1;
  scene.input.keyboard?.on('keydown', (e: KeyboardEvent) => {
    if (seenEvents.has(e)) return;
    seenEvents.add(e);
    keysTotal += 1;
    keysSeen.push(e.code);
    if (keysSeen.length > 64) keysSeen.shift();
  });
}

/** Snapshot for e2e tests (exposed only with ?pgtest=1). */
export function snapshot(game: Phaser.Game): Record<string, unknown> {
  const active = game.scene.getScenes(true).map((s) => s.scene.key);
  const canvas = game.canvas;
  return {
    scenes: active,
    save: getContext().save.get(),
    canvas: canvas ? { w: canvas.clientWidth, h: canvas.clientHeight } : null,
    language: getContext().i18n.language,
    keysSeen: [...keysSeen],
    keysTotal,
    sceneStarts: { ...sceneStarts },
  };
}

/** Scripted actions for e2e scenarios. Games extend these when they replace the placeholder loop. */
export function testActions(game: Phaser.Game): Record<string, () => unknown> {
  return {
    play: () => game.scene.getScene('Menu')?.events.emit('test:play'),
    finish: () => game.scene.getScene('Play')?.events.emit('test:finish'),
  };
}
