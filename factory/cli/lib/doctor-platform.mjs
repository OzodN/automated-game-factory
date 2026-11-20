// @ts-check
/**
 * FX-19: platform-aware checks for `factory doctor` (Windows, macOS, Linux). Every lookup is injectable
 * (`platform`, `env`, `exists`, `which`, `readdir`, `statfs`, `freeGb`) so tests can simulate a platform without
 * touching the host.
 */
import fs from 'node:fs';

/** @typedef {{ platform?: string, env?: Record<string, string | undefined>, exists?: (p: string) => boolean, which?: (cmd: string) => string | null }} BrowserLookup */

const LINUX_BROWSER_COMMANDS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];

/**
 * First existing executable for `cmd` on PATH (no process is spawned). @param {string} cmd
 * @param {{ platform?: string, env?: Record<string, string | undefined>, exists?: (p: string) => boolean }} [o]
 */
export function whichSync(cmd, o = {}) {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const exists = o.exists ?? fs.existsSync;
  const delimiter = platform === 'win32' ? ';' : ':';
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of String(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = `${dir.replace(/[\\/]+$/, '')}/${cmd}${ext}`;
      if (exists(p)) return p;
    }
  }
  return null;
}

/**
 * Chrome / Chromium locations to try, in order, for one platform: absolute paths (win32, darwin) or bare command
 * names looked up on PATH (linux).
 * @param {{ platform?: string, env?: Record<string, string | undefined> }} [o]
 * @returns {{ kind: 'path' | 'command', value: string }[]}
 */
export function browserCandidates(o = {}) {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const abs = (/** @type {string[]} */ list) => list.map((value) => ({ kind: /** @type {const} */ ('path'), value }));
  if (platform === 'win32') {
    const dirs = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA, 'C:/Program Files', 'C:/Program Files (x86)'].filter(Boolean);
    const seen = new Set();
    const list = [];
    for (const d of /** @type {string[]} */ (dirs)) {
      for (const rel of ['Google/Chrome/Application/chrome.exe', 'Chromium/Application/chrome.exe']) {
        const p = `${d.replace(/\\/g, '/').replace(/\/+$/, '')}/${rel}`;
        if (!seen.has(p.toLowerCase())) { seen.add(p.toLowerCase()); list.push(p); }
      }
    }
    return abs(list);
  }
  if (platform === 'darwin') {
    const apps = ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Chromium.app/Contents/MacOS/Chromium'];
    return abs([...apps.map((a) => `/Applications/${a}`), ...(env.HOME ? apps.map((a) => `${env.HOME}/Applications/${a}`) : [])]);
  }
  return LINUX_BROWSER_COMMANDS.map((value) => ({ kind: /** @type {const} */ ('command'), value }));
}

/**
 * The first installed Chrome/Chromium for the platform, or null.
 * @param {BrowserLookup} [o]
 * @returns {{ name: string, path: string } | null}
 */
export function findBrowser(o = {}) {
  const platform = o.platform ?? process.platform;
  const exists = o.exists ?? fs.existsSync;
  const which = o.which ?? ((/** @type {string} */ c) => whichSync(c, { platform, env: o.env, exists }));
  for (const c of browserCandidates({ platform, env: o.env })) {
    const found = c.kind === 'path' ? (exists(c.value) ? c.value : null) : which(c.value);
    if (found) return { name: /chromium/i.test(c.value) ? 'Chromium' : 'Google Chrome', path: found };
  }
  return null;
}

/** Install hint per platform. @param {string} platform */
function browserInstallHint(platform) {
  const pw = 'corepack pnpm exec playwright install chromium';
  if (platform === 'win32') return `Install Google Chrome or run: ${pw}`;
  if (platform === 'darwin') return `Install Google Chrome (or: brew install --cask chromium) or run: ${pw}`;
  return `Install google-chrome or chromium from your package manager, or run: ${pw}`;
}

/**
 * Browser for e2e: a system Chrome/Chromium for the platform, or a Playwright Chromium downloaded into the factory
 * cache (accepted on every platform).
 * @param {{ root: string, readdir?: (p: string) => string[] } & BrowserLookup} o
 */
export function browserRow(o) {
  const platform = o.platform ?? process.platform;
  const exists = o.exists ?? fs.existsSync;
  const readdir = o.readdir ?? ((/** @type {string} */ d) => fs.readdirSync(d));
  const browser = findBrowser({ ...o, platform, exists });
  const pwDir = o.env?.PLAYWRIGHT_BROWSERS_PATH || `${o.root}/.cache/ms-playwright`;
  let bundled = false;
  try { bundled = exists(pwDir) && readdir(pwDir).some((d) => d.startsWith('chromium')); } catch { /* unreadable -> none */ }
  return {
    ok: !!browser || bundled, item: 'Browser for e2e',
    detail: browser ? `${browser.name} (${browser.path})` : bundled ? 'Playwright Chromium' : 'none',
    action: browser || bundled ? '' : browserInstallHint(platform),
  };
}

/**
 * Free whole GB on the volume holding `dir`, or null when it cannot be read (fs.statfsSync, Node 18.15+, all
 * platforms). @param {string} dir
 * @param {(p: string) => { bavail: number | bigint, bsize: number | bigint }} [statfs]
 */
export function diskFreeGb(dir, statfs = (p) => fs.statfsSync(p)) {
  try {
    const s = statfs(dir);
    return Math.round((Number(s.bavail) * Number(s.bsize)) / 1e9);
  } catch {
    return null;
  }
}

/** Drive letter ("D:") of a Windows path, else null. @param {string} p */
const driveOf = (p) => (/^[A-Za-z]:/.test(p) ? p.slice(0, 2).toUpperCase() : null);

/**
 * Disk-free rows: the volume holding the factory root (every platform) and, on Windows only, the system drive when it
 * is a different volume (little space there is common; caches already go to the factory `.cache`).
 * @param {string} root factory root
 * @param {{ platform?: string, env?: Record<string, string | undefined>, freeGb?: (p: string) => number | null }} [o]
 */
export function diskRows(root, o = {}) {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const freeGb = o.freeGb ?? ((/** @type {string} */ p) => diskFreeGb(p));
  const rows = [];
  const free = freeGb(root);
  const rootDrive = platform === 'win32' ? driveOf(root) : null;
  rows.push({
    ok: free === null || free > 5, item: `Disk free (${rootDrive ?? 'factory volume'})`, detail: free === null ? 'unknown' : `${free} GB`,
    action: free !== null && free <= 5 ? 'Free space on the volume that holds the factory (worktrees, caches and builds live there)' : '',
  });
  if (platform === 'win32') {
    const sys = (env.SystemDrive || 'C:').toUpperCase();
    if (sys !== rootDrive) {
      const cfree = freeGb(`${sys}/`);
      rows.push({
        ok: cfree === null || cfree > 2, item: `Disk free (${sys})`, detail: cfree === null ? 'unknown' : `${cfree} GB`,
        action: cfree !== null && cfree <= 2 ? `Free space on ${sys} (caches already go to the factory .cache)` : '',
      });
    }
  }
  return rows;
}

/**
 * Setup hint when no asset library is configured: any local folder works, optionally on a synced drive.
 * @param {string} [platform]
 */
export function assetLibraryHint(platform = process.platform) {
  const example = platform === 'win32' ? '"G:/My Drive/game-asset-library"'
    : platform === 'darwin' ? '"$HOME/Library/CloudStorage/GoogleDrive-<account>/My Drive/game-asset-library" or "$HOME/game-asset-library"'
      : '"$HOME/game-asset-library"';
  const setEnv = platform === 'win32' ? 'set the user environment variable GAME_ASSET_LIBRARY to it'
    : 'export GAME_ASSET_LIBRARY=<folder> in your shell profile';
  return `Choose any local folder, optionally on a synced drive (e.g. Google Drive for desktop), such as ${example}; ${setEnv}, restart Claude Code`;
}
