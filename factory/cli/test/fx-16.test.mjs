// @ts-check
/**
 * FX-16 — caches and temp files stay inside the factory: the factory temp root (`paths().tmp`, `makeTmpDir`),
 * `cacheEnv()` (TMPDIR/TEMP/TMP, pnpm 11+ `pnpm_config_store_dir`), `pnpm-workspace.yaml` storeDir resolution with
 * the real pnpm (skipped without corepack pnpm), doctor stray-dir / temp-root / env rows on a fake drive root (nothing
 * deleted) and the advisory guard hint for `mktemp` / `/tmp`. Every temp dir is removed afterwards.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-fx16-'));
const SAVED = { ...process.env };
process.env.FACTORY_TMP_DIR = `${T}/factory-tmp`;
after(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
  fs.rmSync(T, { recursive: true, force: true });
});

const { paths, tmpRoot, makeTmpDir, cacheEnv, run, norm } = await import('../lib/core.mjs');
const { renderTemplate } = await import('../lib/game.mjs');
const { findStrayDirs, strayDirRows, tmpRootRow, pnpmStoreEnvRow, dirSize } = await import('../lib/stray.mjs');
const { scratchPathHint } = await import('../lib/tmp-hint.mjs');

const STORE_VARS = ['npm_config_store_dir', 'pnpm_config_store_dir', 'NPM_CONFIG_STORE_DIR', 'PNPM_CONFIG_STORE_DIR'];
/** Every variable cacheEnv() sets only when absent: a run through core.run() (e.g. the maint merge runner) pre-sets them. */
const CACHE_VARS = [...STORE_VARS, 'COREPACK_HOME', 'pnpm_config_cache_dir', 'npm_config_cache', 'PLAYWRIGHT_BROWSERS_PATH', 'PUPPETEER_CACHE_DIR'];
/** Run fn with the given env vars removed, restoring them afterwards. @param {string[]} keys @param {() => void} fn */
function without(keys, fn) {
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try { fn(); } finally { for (const [k, v] of Object.entries(old)) if (v !== undefined) process.env[k] = v; }
}

test('paths().tmp defaults to <root>/.cache/tmp and FACTORY_TMP_DIR overrides it; tmpRoot/makeTmpDir create on demand', () => {
  without(['FACTORY_TMP_DIR'], () => assert.equal(paths().tmp, `${paths().root}/.cache/tmp`));
  assert.equal(paths().tmp, norm(`${T}/factory-tmp`));
  process.env.FACTORY_TMP_DIR = `${T}/fresh-tmp`;
  try {
    assert.equal(fs.existsSync(`${T}/fresh-tmp`), false);
    assert.equal(tmpRoot(), norm(`${T}/fresh-tmp`));
    assert.ok(fs.statSync(`${T}/fresh-tmp`).isDirectory());
    const d = makeTmpDir('covers-g/x:');
    assert.ok(d.startsWith(`${norm(`${T}/fresh-tmp`)}/covers-g_x_`), d);
    assert.ok(fs.statSync(d).isDirectory());
  } finally {
    process.env.FACTORY_TMP_DIR = `${T}/factory-tmp`;
  }
});

test('cacheEnv(): TMPDIR/TEMP/TMP point to the factory temp root; pnpm store set under both spellings', () => {
  without(CACHE_VARS, () => {
    const e = cacheEnv();
    const tmp = path.resolve(`${T}/factory-tmp`);
    assert.equal(e.TMPDIR, tmp);
    assert.equal(e.TEMP, tmp);
    assert.equal(e.TMP, tmp);
    const store = `${paths().root}/.cache/pnpm-store`;
    assert.equal(e.pnpm_config_store_dir, store);
    assert.equal(e.npm_config_store_dir, store);
    assert.equal(e.pnpm_config_cache_dir, `${paths().root}/.cache/pnpm-cache`);
    assert.equal(e.COREPACK_HOME, `${paths().root}/.cache/corepack`);
    assert.equal(e.npm_config_cache, `${paths().root}/.cache/npm-cache`);
    assert.equal(e.PLAYWRIGHT_BROWSERS_PATH, `${paths().root}/.cache/ms-playwright`);
    assert.equal(e.PUPPETEER_CACHE_DIR, `${paths().root}/.cache/puppeteer`);
  });
  without(CACHE_VARS, () => {
    process.env.npm_config_store_dir = 'X:/custom-store';
    const e = cacheEnv();
    assert.equal(e.npm_config_store_dir, undefined, 'an existing value is not overridden');
    assert.equal(e.pnpm_config_store_dir, 'X:/custom-store', 'the pnpm spelling follows an existing npm value');
    delete process.env.npm_config_store_dir;
  });
});

test('run() hands the factory temp root to spawned commands (os.tmpdir() of the child)', () => {
  const r = run('node -e "process.stdout.write(require(\'os\').tmpdir())"');
  assert.equal(r.exitCode, 0, r.output);
  assert.equal(path.resolve(r.output.trim()), path.resolve(`${T}/factory-tmp`));
});

test('pnpm-workspace.yaml storeDir of the root, pg-kit and the template resolves inside <root>/.cache/pnpm-store', () => {
  const store = (/** @type {string} */ dir) => {
    const m = /^storeDir:\s*(\S+)\s*$/m.exec(fs.readFileSync(`${dir}/pnpm-workspace.yaml`, 'utf8'));
    assert.ok(m, `${dir}/pnpm-workspace.yaml has storeDir`);
    return path.resolve(dir, m[1]);
  };
  const want = path.resolve(REPO, '.cache', 'pnpm-store');
  assert.equal(store(REPO), want);
  assert.equal(store(`${REPO}/packages/pg-kit`), want);
  assert.equal(store(`${REPO}/factory/templates/game-phaser-ts`), want);
  // The same committed file in every depth-3 checkout below a factory root.
  const tpl = fs.readFileSync(`${REPO}/factory/templates/game-phaser-ts/pnpm-workspace.yaml`, 'utf8');
  for (const rel of ['.worktrees/g/P1-X-01', '.worktrees/g/_integration', '.cache/template-check/run-1']) {
    const dir = path.join(T, 'root', rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/pnpm-workspace.yaml`, tpl);
    assert.equal(store(dir), path.join(T, 'root', '.cache', 'pnpm-store'), rel);
  }
});

const PNPM = spawnSync('corepack pnpm --version', { shell: true, encoding: 'utf8', cwd: `${REPO}/packages/pg-kit`, env: { ...process.env, ...cacheEnv() } });
const NO_PNPM = PNPM.status === 0 ? false : `corepack pnpm is not available here (${(PNPM.stderr || PNPM.stdout || '').trim().split('\n')[0]}); pnpm store resolution not checked`;

/** `pnpm store path` in dir without any store env variable (what a direct call by an agent sees). @param {string} dir */
function storePath(dir) {
  const env = { ...process.env, ...cacheEnv() };
  for (const k of STORE_VARS) delete env[k];
  const r = spawnSync('corepack pnpm store path', { shell: true, encoding: 'utf8', cwd: dir, env });
  assert.equal(r.status, 0, `${dir}: ${r.stdout}${r.stderr}`);
  return path.resolve(r.stdout.trim().split('\n').pop() || '');
}

test('real pnpm: store path of a scaffolded template game (depth 3), the factory root and pg-kit is inside <root>/.cache', { skip: NO_PNPM }, () => {
  const base = path.join(T, 'factory');
  const game = path.join(base, '.worktrees', 'g', 'P1-X-01');
  renderTemplate(`${REPO}/factory/templates/game-phaser-ts`, game, 'fx16-game', 'FX16');
  const inCache = (/** @type {string} */ p, /** @type {string} */ root) => assert.ok(p.toLowerCase().startsWith(path.join(root, '.cache').toLowerCase() + path.sep), `${p} not inside ${root}/.cache`);
  inCache(storePath(game), base);
  inCache(storePath(REPO), REPO);
  inCache(storePath(`${REPO}/packages/pg-kit`), REPO);
  assert.equal(fs.existsSync(path.join(base, '.cache', 'pnpm-store')), false, 'store path does not create the store');
});

/** A fake drive with a factory below it and the three observed stray dirs plus look-alikes that must not be reported. */
function fakeDrive() {
  const drive = path.join(T, 'drive');
  const root = path.join(drive, 'user', 'factory');
  const w = (/** @type {string} */ rel, /** @type {string} */ data) => { const f = path.join(drive, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
  fs.mkdirSync(root, { recursive: true });
  w('.pnpm-store/v11/files/00/abc', 'x'.repeat(1000));
  w('c/Users/user/AppData/Local/Temp/ppg-diag/.git/HEAD', 'ref: refs/heads/main\n');
  w('d/user/progs/x.txt', 'yy');
  w('tmp/tmp.Ab12Cd34/g/factory.game.json', '{}');
  w('e/photos/1.jpg', 'z'); // single-letter dir with unrelated content
  w('projects/tmp.Ab12Cd34/readme', 'q'); // mktemp-looking name outside tmp
  w('notes.txt', 'n');
  return { drive, root };
}

test('doctor: stray dirs at a fake drive root are reported with size and a manual cleanup hint; nothing is deleted', () => {
  const { drive, root } = fakeDrive();
  const before = dirSize(drive);
  const found = findStrayDirs({ root, driveRoot: drive });
  assert.deepEqual(found.map((f) => path.basename(f.path)).sort(), ['.pnpm-store', 'c', 'd', 'tmp']);
  assert.equal(found.find((f) => path.basename(f.path) === '.pnpm-store')?.bytes, 1000);
  const rows = strayDirRows({ root, driveRoot: drive, platform: 'win32' });
  assert.equal(rows.length, 4);
  for (const r of rows) {
    assert.equal(r.ok, 'warn');
    assert.match(r.detail, /\(\d+(\.\d+)? (B|KB|MB|GB)\+?\)/);
    assert.match(r.action, /delete it by hand .*rmdir \/s \/q "/);
  }
  assert.match(rows.find((r) => r.detail.includes(`${path.sep}tmp `))?.detail || '', /mktemp dir/);
  assert.deepEqual(dirSize(drive), before, 'nothing deleted or changed');
  assert.deepEqual(strayDirRows({ root, driveRoot: path.join(T, 'clean-drive') }).map((r) => r.ok), [true]);
  assert.deepEqual(findStrayDirs({ root: drive, driveRoot: drive }), [], 'factory at the drive root: no check');
});

test('doctor: factory temp root size and stale entries (older than 7 days) are reported, never deleted', () => {
  const dir = path.join(T, 'tmp-row');
  assert.match(tmpRootRow({ dir }).detail, /not created yet/);
  fs.mkdirSync(`${dir}/old`, { recursive: true });
  fs.writeFileSync(`${dir}/old/f`, 'x'.repeat(2048));
  fs.mkdirSync(`${dir}/new`);
  const old = (Date.now() - 10 * 86400000) / 1000;
  fs.utimesSync(`${dir}/old`, old, old);
  const r = tmpRootRow({ dir });
  assert.equal(r.ok, true);
  assert.match(r.detail, /2\.0 KB in 2 entries; 1 older than 7 days/);
  assert.match(r.action, /Delete the 1 entry older than 7 days/);
  assert.ok(fs.existsSync(`${dir}/old/f`));
});

test('doctor: npm_config_store_dir without pnpm_config_store_dir warns and names where', () => {
  assert.equal(pnpmStoreEnvRow({}, {}).ok, true);
  assert.equal(pnpmStoreEnvRow({ npm_config_store_dir: 'a', pnpm_config_store_dir: 'a' }, {}).ok, true);
  const r = pnpmStoreEnvRow({}, { '.claude/settings.local.json': { env: { npm_config_store_dir: 'D:/x' } }, '.claude/settings.json': {} });
  assert.equal(r.ok, 'warn');
  assert.match(r.detail, /settings\.local\.json "env"/);
  assert.match(r.action, /pnpm_config_store_dir/);
});

test('guard hint: bare mktemp and /tmp or $TMPDIR arguments of native tools; no hint for safe lines', () => {
  const hit = [
    'd=$(mktemp -d) && node scaffold.mjs "$d"',
    'mktemp -d -t foo.XXXX',
    'mktemp -d -p /tmp',
    'mktemp /tmp/x.XXXXXX',
    'cd D:/w && node build.mjs --out /tmp/out',
    'git clone repo /tmp/ppg-diag',
    'FOO=1 corepack.cmd pnpm install --dir "$TMPDIR/g"',
    'ls && git -C /tmp/x status',
  ];
  for (const c of hit) assert.ok(scratchPathHint(c), `expected a hint: ${c}`);
  const safe = [
    'mktemp -d -p "C:/Users/user/factory/.cache/tmp"',
    'mktemp -d --tmpdir=D:/f/.cache/tmp',
    'mktemp -d ./scratch.XXXX',
    'ls /tmp && cat /tmp/x.log',
    'node --test factory/cli/test/*.test.mjs',
    'git log --oneline -5',
    'grep -rn "/tmp" factory/cli',
    'echo mktemp-free',
  ];
  for (const c of safe) assert.equal(scratchPathHint(c), null, `no hint expected: ${c}`);
});

test('pre-tool hook: the hint is advisory (additionalContext, no permission decision)', () => {
  const r = spawnSync(process.execPath, [`${REPO}/factory/hooks/pre-tool.mjs`], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'd=$(mktemp -d) && echo "$d"' }, cwd: T, session_id: 'fx16', hook_event_name: 'PreToolUse' }),
    encoding: 'utf8', env: { ...process.env, FACTORY_STATE_DIR: `${T}/state`, FACTORY_INBOX_DIR: `${T}/inbox`, FACTORY_WORKTREES_DIR: `${T}/wt`, FACTORY_GAMES_DIR: `${T}/games` },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout || '{}');
  assert.equal(out.hookSpecificOutput?.permissionDecision, undefined, r.stdout);
  assert.match(out.hookSpecificOutput?.additionalContext || '', /^\[factory\] Hint \(FX-16, not a refusal\)/);
});
