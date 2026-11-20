import type { BridgeLike } from './bridge-like.js';
import { PlatformService, type PlatformInfo } from './platform.js';
import { LifecycleController } from './lifecycle.js';
import { AdService } from './ads.js';
import { SaveStore, type SaveSchema } from './save.js';
import { I18n, type Dictionary } from './i18n.js';
import { Telemetry } from './telemetry.js';
import { installInputGuards } from './input.js';
import { Rng } from './rng.js';

export interface BootOptions<T extends { userMuted?: boolean }> {
  bridge: BridgeLike;
  dictionaries: Record<string, Dictionary>;
  save: SaveSchema<T>;
  /** Seed for gameplay RNG; defaults to time-based. Tests pass a fixed seed (?seed=123). */
  seed?: number;
  installGuards?: boolean;
}

export interface GameContext<T> {
  bridge: BridgeLike;
  info: PlatformInfo;
  platform: PlatformService;
  lifecycle: LifecycleController;
  ads: AdService;
  save: SaveStore<T>;
  i18n: I18n;
  telemetry: Telemetry;
  rng: Rng;
}

/**
 * Standard boot order (do not reorder):
 * 1. Bridge initialize  2. lifecycle (audio/pause/visibility) BEFORE any sound
 * 3. input guards  4. i18n from platform.language  5. load save (restores user mute)
 * The game must call `ctx.platform.gameReady()` itself when its first interactive screen shows.
 */
export async function bootGame<T extends { userMuted?: boolean }>(opts: BootOptions<T>): Promise<GameContext<T>> {
  const platform = new PlatformService(opts.bridge);
  const info = await platform.initialize();
  const lifecycle = new LifecycleController().attach(opts.bridge);
  if (opts.installGuards !== false && typeof window !== 'undefined') installInputGuards(window);
  const i18n = new I18n(opts.dictionaries, info.language);
  const save = new SaveStore(opts.bridge, opts.save);
  const data = await save.load();
  lifecycle.set({ userMuted: data.userMuted === true });
  const ads = new AdService(opts.bridge);
  ads.events.on('adOpen', (open) => {
    lifecycle.set({ adOpen: open });
    if (open) void save.flush();
  });
  lifecycle.events.on('systemPause', (p) => {
    if (p) void save.flush();
  });
  const seed = opts.seed ?? readSeedFromUrl() ?? (Date.now() >>> 0);
  return { bridge: opts.bridge, info, platform, lifecycle, ads, save, i18n, telemetry: new Telemetry(opts.bridge), rng: new Rng(seed) };
}

function readSeedFromUrl(): number | undefined {
  if (typeof location === 'undefined') return undefined;
  const v = new URLSearchParams(location.search).get('seed');
  return v && /^\d+$/.test(v) ? Number(v) : undefined;
}
