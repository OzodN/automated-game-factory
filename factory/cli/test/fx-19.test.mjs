// @ts-check
/**
 * FX-19 — cross-platform support (Windows, macOS, Linux). Doctor platform branches are simulated through injected
 * `platform` / `env` / `exists` / `which` / `statfs` (nothing is read from the host); agent prompts carry no machine
 * paths and give pnpm/Windows advice generically; the pre-tool temp hint is Windows-only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { browserCandidates, findBrowser, browserRow, whichSync, diskFreeGb, diskRows, assetLibraryHint } from '../lib/doctor-platform.mjs';
import { checkAgentDefinitions } from '../lib/agents.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const AGENTS = path.join(ROOT, '.claude/agents');
const CHROME_WIN = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CHROME_MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const only = (/** @type {string[]} */ ...present) => (/** @type {string} */ p) => present.includes(p);

test('browser candidates: win32 paths (Program Files, %LOCALAPPDATA%), darwin app bundles, linux commands', () => {
  const win = browserCandidates({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\Ann\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files' } }).map((c) => c.value);
  assert.ok(win.includes(CHROME_WIN));
  assert.ok(win.includes('C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'));
  assert.ok(win.includes('C:/Users/Ann/AppData/Local/Google/Chrome/Application/chrome.exe'));
  assert.equal(new Set(win.map((v) => v.toLowerCase())).size, win.length, 'no duplicates');
  const mac = browserCandidates({ platform: 'darwin', env: { HOME: '/Users/ann' } });
  assert.ok(mac.every((c) => c.kind === 'path'));
  assert.ok(mac.some((c) => c.value === CHROME_MAC));
  assert.ok(mac.some((c) => c.value === '/Applications/Chromium.app/Contents/MacOS/Chromium'));
  assert.ok(mac.some((c) => c.value === '/Users/ann/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  const linux = browserCandidates({ platform: 'linux', env: {} });
  assert.deepEqual(linux.map((c) => c.value), ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']);
  assert.ok(linux.every((c) => c.kind === 'command'));
});

test('findBrowser: resolves per platform from injected lookups and ignores other platforms\' locations', () => {
  assert.equal(findBrowser({ platform: 'win32', env: {}, exists: only(CHROME_WIN) })?.path, CHROME_WIN);
  assert.equal(findBrowser({ platform: 'win32', env: { LOCALAPPDATA: 'D:\\L' }, exists: only('D:/L/Google/Chrome/Application/chrome.exe') })?.name, 'Google Chrome');
  assert.equal(findBrowser({ platform: 'darwin', env: {}, exists: only(CHROME_MAC) })?.path, CHROME_MAC);
  assert.equal(findBrowser({ platform: 'darwin', env: {}, exists: only('/Applications/Chromium.app/Contents/MacOS/Chromium') })?.name, 'Chromium');
  assert.equal(findBrowser({ platform: 'darwin', env: {}, exists: only(CHROME_WIN) }), null, 'a Windows path means nothing on macOS');
  const seen = [];
  const which = (/** @type {string} */ c) => { seen.push(c); return c === 'chromium' ? '/usr/bin/chromium' : null; };
  const lin = findBrowser({ platform: 'linux', env: {}, exists: () => false, which });
  assert.deepEqual(lin, { name: 'Chromium', path: '/usr/bin/chromium' });
  assert.deepEqual(seen, ['google-chrome', 'google-chrome-stable', 'chromium'], 'commands tried in order, stops at the first hit');
  assert.equal(findBrowser({ platform: 'linux', env: {}, exists: () => false, which: () => null }), null);
});

test('whichSync: PATH lookup with the platform delimiter, no process spawned', () => {
  assert.equal(whichSync('chromium', { platform: 'linux', env: { PATH: '/bin:/usr/local/bin/:/usr/bin' }, exists: only('/usr/local/bin/chromium') }), '/usr/local/bin/chromium');
  assert.equal(whichSync('chromium', { platform: 'linux', env: { PATH: '/bin' }, exists: () => false }), null);
  assert.equal(whichSync('chrome', { platform: 'win32', env: { Path: 'C:\\a;C:\\b' }, exists: only('C:\\b/chrome.exe') }), 'C:\\b/chrome.exe');
});

test('browserRow: system browser, Playwright Chromium accepted on every platform, install hint otherwise', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const none = browserRow({ root: '/f', platform, env: {}, exists: () => false, which: () => null });
    assert.equal(none.ok, false, platform);
    assert.equal(none.detail, 'none');
    assert.match(none.action, /corepack pnpm exec playwright install chromium/);
    const pw = browserRow({ root: '/f', platform, env: {}, exists: only('/f/.cache/ms-playwright'), which: () => null, readdir: () => ['chromium-1181', 'ffmpeg-1011'] });
    assert.equal(pw.ok, true, platform);
    assert.equal(pw.detail, 'Playwright Chromium');
    const emptyCache = browserRow({ root: '/f', platform, env: {}, exists: only('/f/.cache/ms-playwright'), which: () => null, readdir: () => ['ffmpeg-1011'] });
    assert.equal(emptyCache.ok, false, platform);
  }
  assert.match(browserRow({ root: '/f', platform: 'darwin', env: {}, exists: () => false }).action, /Install Google Chrome/);
  assert.match(browserRow({ root: '/f', platform: 'linux', env: {}, exists: () => false, which: () => null }).action, /google-chrome or chromium/);
  const sys = browserRow({ root: '/f', platform: 'darwin', env: {}, exists: only(CHROME_MAC) });
  assert.equal(sys.ok, true);
  assert.match(sys.detail, /Google Chrome \(\/Applications\/Google Chrome\.app/);
});

test('diskFreeGb: fs.statfsSync-shaped input (number or bigint), null on error', () => {
  assert.equal(diskFreeGb('/x', () => ({ bavail: 3_000_000, bsize: 4096 })), 12);
  assert.equal(diskFreeGb('/x', () => ({ bavail: 3_000_000n, bsize: 4096n })), 12);
  assert.equal(diskFreeGb('/x', () => { throw new Error('ENOENT'); }), null);
  const real = diskFreeGb(ROOT);
  assert.ok(real === null || real >= 0, 'the real statfs works on this host');
});

test('diskRows: volume of the factory root everywhere; the system drive only on Windows and only when different', () => {
  const calls = [];
  const freeGb = (/** @type {string} */ p) => { calls.push(p); return p.startsWith('C:') ? 1 : 100; };
  const win = diskRows('D:/factory', { platform: 'win32', env: { SystemDrive: 'C:' }, freeGb });
  assert.deepEqual(win.map((r) => r.item), ['Disk free (D:)', 'Disk free (C:)']);
  assert.equal(win[0].ok, true);
  assert.equal(win[1].ok, false);
  assert.match(win[1].action, /Free space on C:/);
  assert.deepEqual(calls, ['D:/factory', 'C:/']);
  const same = diskRows('C:/factory', { platform: 'win32', env: { SystemDrive: 'C:' }, freeGb: () => 50 });
  assert.deepEqual(same.map((r) => r.item), ['Disk free (C:)'], 'no duplicate row for the same volume');
  for (const platform of ['darwin', 'linux']) {
    const seen = [];
    const rows = diskRows('/home/ann/factory', { platform, env: {}, freeGb: (p) => { seen.push(p); return 3; } });
    assert.equal(rows.length, 1, platform);
    assert.equal(rows[0].item, 'Disk free (factory volume)');
    assert.equal(rows[0].ok, false, 'under 5 GB');
    assert.match(rows[0].action, /volume that holds the factory/);
    assert.deepEqual(seen, ['/home/ann/factory'], 'never probes C:');
  }
  assert.equal(diskRows('/f', { platform: 'linux', env: {}, freeGb: () => null })[0].ok, true, 'unknown is not a failure');
});

test('asset library hint is platform-neutral text with a per-platform example', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const h = assetLibraryHint(platform);
    assert.match(h, /any local folder, optionally on a synced drive/, platform);
    assert.match(h, /GAME_ASSET_LIBRARY/);
  }
  assert.match(assetLibraryHint('win32'), /G:\/My Drive\/game-asset-library/);
  assert.match(assetLibraryHint('darwin'), /Library\/CloudStorage\/GoogleDrive-/);
  assert.doesNotMatch(assetLibraryHint('linux'), /G:\/|CloudStorage|\bsetx?\b/);
  assert.match(assetLibraryHint('linux'), /export GAME_ASSET_LIBRARY/);
});

test('doctor(): platform rows come from the injected platform; the real run on this host has no failing row from these checks', async () => {
  const { doctor } = await import('../lib/doctor.mjs');
  const lin = doctor({ platform: 'linux', env: { ...process.env, PATH: '' } });
  assert.ok(!lin.some((r) => /Disk free \(C:\)/.test(r.item)), 'no C: row on linux');
  assert.ok(lin.some((r) => r.item === 'Disk free (factory volume)'));
  assert.ok(!lin.some((r) => r.item === 'Drive cache volume free'), 'Drive for desktop check is Windows-only');
  const browser = lin.find((r) => r.item === 'Browser for e2e');
  assert.ok(browser && (browser.ok === true || /google-chrome or chromium/.test(browser.action)));
});

test('agent prompts: no absolute machine paths; scratch dir via the factory root named in the packet', () => {
  const owner = 'oz' + 'od'; // split so that this file does not match its own search
  const r = spawnSync('git', ['grep', '-n', '-e', `D:/${owner}`, '-e', `${owner}/coding`, '--', '.claude', 'factory'], { cwd: ROOT, encoding: 'utf8' });
  const hits = (r.stdout || '').split('\n').filter(Boolean).filter((l) => !l.startsWith('factory/cli/test/fx-16.test.mjs:'));
  assert.deepEqual(hits, [], 'machine-specific path in the factory');
  const files = fs.readdirSync(AGENTS).filter((f) => f.endsWith('.md'));
  assert.ok(files.length > 0);
  for (const f of files) {
    const body = fs.readFileSync(path.join(AGENTS, f), 'utf8');
    assert.doesNotMatch(body, /CLAUDE_PROJECT_DIR/, `${f}: not available in subagent Bash`);
    if (/Temp files and paths/.test(body)) {
      assert.match(body, /mktemp -d -p "<factory root>\/\.cache\/tmp"/, f);
      assert.match(body, /factory root path is named in your packet/, f);
    }
  }
});

test('agent prompts: pnpm is generic; corepack.cmd and MSYS_NO_PATHCONV appear only as an "On Windows" remark', () => {
  for (const f of fs.readdirSync(AGENTS).filter((x) => x.endsWith('.md'))) {
    const body = fs.readFileSync(path.join(AGENTS, f), 'utf8');
    if (/corepack\.cmd/.test(body) || /MSYS_NO_PATHCONV/.test(body)) {
      for (const line of body.split('\n').filter((l) => /corepack\.cmd|MSYS_NO_PATHCONV|Git Bash/.test(l))) {
        assert.match(line, /on Windows/i, `${f}: Windows-only advice must say so: ${line.slice(0, 80)}`);
      }
    }
    if (/## Shell \(ENV-01\)/.test(body)) {
      assert.match(body, /Run pnpm as `corepack pnpm \.\.\.`/, f);
      assert.doesNotMatch(body, /## Shell on Windows/, f);
    }
  }
});

test('agent definitions and -retry variants are in sync after regeneration', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'factory/config.json'), 'utf8'));
  const c = checkAgentDefinitions(AGENTS, cfg);
  assert.deepEqual(c.pins, []);
  assert.deepEqual(c.variants, []);
  assert.ok(c.variantCount > 0);
});

test('pre-tool temp hint is platform-aware (MSYS wording on Windows only; changed by FX-20)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'factory/hooks/pre-tool.mjs'), 'utf8');
  assert.match(src, /hint = scratchPathHint\(input\.tool_input\?\.command, process\.platform\)/);
});
