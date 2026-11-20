import { defineConfig, devices } from '@playwright/test';
import { createHash } from 'node:crypto';

// The factory passes a free port per run as E2E_PORT (one port for all steps of the run). By hand, set a random
// E2E_PORT too (see GAME_CONVENTIONS.md). Fallback: stable per working directory (the config is evaluated in
// several processes), which collides when two runs share a worktree.
const PORT = Number(process.env.E2E_PORT || 4100 + (parseInt(createHash('sha1').update(process.cwd()).digest('hex').slice(0, 6), 16) % 800));

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'off', screenshot: 'only-on-failure' },
  webServer: {
    command: `node scripts/serve-dist.mjs dist --port ${PORT}`,
    url: `http://localhost:${PORT}/index.html`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
  // Default: the installed Google Chrome (no browser download needed). PW_CHANNEL=bundled uses
  // Playwright's own Chromium (`pnpm exec playwright install chromium`).
  projects: [{
    name: 'chromium',
    use: { ...devices['Desktop Chrome'], ...(process.env.PW_CHANNEL === 'bundled' ? {} : { channel: process.env.PW_CHANNEL || 'chrome' }) },
  }],
});
