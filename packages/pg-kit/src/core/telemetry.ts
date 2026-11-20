import type { BridgeLike } from './bridge-like.js';

const NAME = /^[a-z][a-z0-9_]{2,47}$/;

/**
 * Custom telemetry through Bridge analytics only (rule 1.2.4: no third-party analytics).
 * Event names are snake_case; payload values are primitives (no personal data, rule 4.4).
 */
export class Telemetry {
  constructor(private readonly bridge: BridgeLike) {}

  send(event: string, data: Record<string, string | number | boolean> = {}): void {
    if (!NAME.test(event)) throw new Error(`Telemetry: invalid event name "${event}" (snake_case, 3-48 chars)`);
    for (const [k, v] of Object.entries(data)) {
      if (!['string', 'number', 'boolean'].includes(typeof v)) throw new Error(`Telemetry: field ${k} must be a primitive`);
    }
    try {
      this.bridge.analytics?.send(event, data);
    } catch {
      /* analytics must never break gameplay */
    }
  }
}
