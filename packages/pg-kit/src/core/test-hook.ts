import type { LifecycleController, LifecycleState } from './lifecycle.js';
import type { PlatformService } from './platform.js';

export interface TestHook {
  /** Game-defined snapshot (scene, score, etc.) for e2e assertions. */
  state: () => Record<string, unknown>;
  gameReadySent: () => boolean;
  audioAllowed: () => boolean;
  systemPaused: () => boolean;
  /** Drive lifecycle inputs exactly as Bridge/visibility events would. */
  simulate: (patch: Partial<LifecycleState>) => void;
  /** Game-defined actions for e2e scenarios (e.g. "win", "lose"). */
  actions: Record<string, (...args: any[]) => unknown>;
}

declare global {
  // eslint-disable-next-line no-var
  var __PG_TEST__: TestHook | undefined;
}

/**
 * Exposes a read/drive hook for Playwright ONLY when the page URL contains `pgtest=1`.
 * Production players never pass that parameter, and the hook grants no capabilities beyond what
 * the game UI already offers.
 */
export function exposeTestHook(
  deps: { lifecycle: LifecycleController; platform: PlatformService },
  state: () => Record<string, unknown>,
  actions: Record<string, (...args: any[]) => unknown> = {},
): void {
  if (typeof location === 'undefined' || !new URLSearchParams(location.search).has('pgtest')) return;
  globalThis.__PG_TEST__ = {
    state,
    gameReadySent: () => deps.platform.isGameReadySent,
    audioAllowed: () => deps.lifecycle.audioAllowed,
    systemPaused: () => deps.lifecycle.systemPaused,
    simulate: (patch) => deps.lifecycle.set(patch),
    actions,
  };
}
