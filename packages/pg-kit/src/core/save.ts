import type { BridgeLike } from './bridge-like.js';

export interface SaveSchema<T> {
  /** Storage key; keep stable for the life of the game (include a short game prefix). */
  key: string;
  /** Current schema version. Increment when the shape changes and extend `migrate`. */
  version: number;
  defaults: () => T;
  /** Convert any older/unknown persisted value into the current shape. Must never throw. */
  migrate: (raw: unknown, fromVersion: number | null) => T;
}

interface Envelope<T> {
  v: number;
  data: T;
  savedAt: number;
}

export interface SaveOptions {
  debounceMs?: number;
  /** Clock and timers are injectable so tests are deterministic. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

/**
 * Progress persistence through Bridge Storage ONLY (Playgama rule 3.2.1 forbids localStorage,
 * IndexedDB, cookies). Debounced writes, schema versioning + migration, explicit flush for
 * pause/hide/ad events (rule 3.2.3: progress survives reload, rotation and ads).
 */
export class SaveStore<T> {
  private state: T;
  private dirty = false;
  private timer: unknown = null;
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;
  private lastError: unknown = null;

  constructor(private readonly bridge: BridgeLike, private readonly schema: SaveSchema<T>, opts: SaveOptions = {}) {
    this.state = schema.defaults();
    this.debounceMs = opts.debounceMs ?? 1000;
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Load and migrate. Corrupt or missing data falls back to defaults (never crashes the game). */
  async load(): Promise<T> {
    try {
      const raw = await this.bridge.storage.get(this.schema.key, true);
      if (raw === null || raw === undefined || raw === '') {
        this.state = this.schema.defaults();
      } else {
        const parsed = typeof raw === 'string' ? safeParse(raw) : raw;
        const env = parsed as Partial<Envelope<unknown>> | null;
        if (env && typeof env === 'object' && 'v' in env && 'data' in env) {
          // migrate() also validates same-version data (defends against corrupted saves).
          this.state = this.schema.migrate(env.data, env.v ?? null);
        } else {
          this.state = this.schema.migrate(parsed, null);
        }
      }
    } catch (e) {
      this.lastError = e;
      this.state = this.schema.defaults();
    }
    return this.state;
  }

  get(): Readonly<T> {
    return this.state;
  }

  /** Replace state via an updater; schedules a debounced write. */
  update(fn: (draft: T) => T): void {
    this.state = fn(structuredClone(this.state));
    this.dirty = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  get hasPendingChanges(): boolean {
    return this.dirty;
  }

  get error(): unknown {
    return this.lastError;
  }

  /** Persist immediately (call on pause, visibility hidden, before ads, on level end). */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.dirty = false;
    const env: Envelope<T> = { v: this.schema.version, data: this.state, savedAt: this.now() };
    try {
      await this.bridge.storage.set(this.schema.key, JSON.stringify(env));
      this.lastError = null;
    } catch (e) {
      this.lastError = e;
      this.dirty = true; // retry on next flush
    }
  }

  /** Testing / "reset progress" option in settings. */
  async reset(): Promise<void> {
    this.state = this.schema.defaults();
    this.dirty = true;
    await this.flush();
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
