import { test as base, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BRIDGE_RUNTIME = require.resolve('@playgama/bridge/dist/playgama-bridge.js');

export const VIEWPORTS = [
  { name: 'portrait-9x16', width: 375, height: 812 },
  { name: 'square-1x1', width: 600, height: 600 },
  { name: 'landscape-16x9', width: 1920, height: 1080 },
] as const;

export interface Harness {
  externalRequests: string[];
  consoleErrors: string[];
  open: (query?: string) => Promise<void>;
  hook: <T = unknown>(expr: string) => Promise<T>;
}

/**
 * Hermetic harness: the Bridge CDN script is served from the installed package (the production
 * artifact is tested unchanged); any other non-local request is recorded and aborted (rule 1.2.5).
 */
export const test = base.extend<{ h: Harness }>({
  h: async ({ page }, use) => {
    const externalRequests: string[] = [];
    const consoleErrors: string[] = [];
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return route.continue();
      if (url.hostname === 'bridge.playgama.com' && url.pathname.endsWith('/playgama-bridge.js')) {
        return route.fulfill({ path: BRIDGE_RUNTIME, contentType: 'text/javascript' });
      }
      externalRequests.push(url.href);
      return route.abort();
    });
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    const h: Harness = {
      externalRequests,
      consoleErrors,
      open: async (query = '') => {
        await page.goto(`/index.html?pgtest=1&seed=12345${query}`);
        await expect.poll(() => page.evaluate(() => Boolean(globalThis.__PG_TEST__?.gameReadySent())), { timeout: 10_000 }).toBe(true);
      },
      hook: (expr) => page.evaluate(expr) as never,
    };
    await use(h);
  },
});

export async function canvasBox(page: Page) {
  return page.locator('#game-container canvas').boundingBox();
}

export { expect };
