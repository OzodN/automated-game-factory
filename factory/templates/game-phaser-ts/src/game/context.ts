import type { GameContext } from '@factory/pg-kit';
import type { SaveData } from './save';

let ctx: GameContext<SaveData> | null = null;

/** Set once at boot; scenes read the shared platform/save/ads/i18n services through ctx(). */
export function setContext(c: GameContext<SaveData>): void {
  ctx = c;
}

export function getContext(): GameContext<SaveData> {
  if (!ctx) throw new Error('Game context used before boot completed');
  return ctx;
}
