import type { SaveSchema } from '@factory/pg-kit';

/** Persistent progress. Bump `version` and extend `migrate` whenever the shape changes. */
export interface SaveData {
  best: number;
  plays: number;
  userMuted: boolean;
}

export const SAVE_SCHEMA: SaveSchema<SaveData> = {
  key: '__GAME_ID___save',
  version: 1,
  defaults: () => ({ best: 0, plays: 0, userMuted: false }),
  migrate: (raw) => {
    const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    return { best: num(o.best), plays: num(o.plays), userMuted: o.userMuted === true };
  },
};
