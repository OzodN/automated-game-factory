// @ts-check
/** Environment readiness check for the factory (no side effects). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { paths, readJson, cacheEnv } from './core.mjs';
import { libraryRoot } from './assets.mjs';
import { indexFile, openIndex, sourceStates, schemaVersionOf } from './asset-index.mjs';
import { checkAgentDefinitions, MODEL_ENV_OVERRIDES } from './agents.mjs';
import { humanLanguageRow } from './language.mjs';
import { strayDirRows, tmpRootRow, pnpmStoreEnvRow } from './stray.mjs';
import { browserRow, diskRows, diskFreeGb, assetLibraryHint } from './doctor-platform.mjs';

/**
 * @param {{ platform?: string, env?: Record<string, string | undefined> }} [o] platform/environment used for the platform-specific
 *   rows (default: the running process); tests simulate other platforms through the helpers in doctor-platform.mjs
 */
export function doctor(o = {}) {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const p = paths();
  const rows = [];
  const add = (ok, item, detail, action = '') => rows.push({ ok, item, detail, action });
  const ver = (cmd, args) => {
    const r = spawnSync(`${cmd} ${args.join(' ')}`, { encoding: 'utf8', shell: true, env: { ...process.env, ...cacheEnv() } });
    return r.status === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] : null;
  };
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add(nodeMajor >= 22, 'Node.js', process.versions.node, nodeMajor >= 22 ? '' : 'Install Node 22+');
  const g = ver('git', ['--version']);
  add(!!g, 'git', g || 'missing', g ? '' : 'Install git');
  const pn = ver('corepack', ['pnpm', '--version']);
  add(!!pn, 'pnpm (corepack)', pn || 'missing', pn ? '' : 'Run: corepack pnpm --version (needs network once)');
  rows.push(browserRow({ root: p.root, platform, env }));
  const ff = ver('ffmpeg', ['-version']);
  add(!!ff, 'ffmpeg (audio processing)', ff ? ff.slice(0, 40) : 'missing', ff ? '' : 'Install ffmpeg');
  const kitDir = `${p.kit}/release`;
  const kits = fs.existsSync(kitDir) ? fs.readdirSync(kitDir).filter((f) => f.endsWith('.tgz')) : [];
  add(kits.length > 0, 'pg-kit release', kits.join(', ') || 'none', kits.length ? '' : 'Run: node factory/cli/factory.mjs kit pack');
  const settings = readJson(`${p.root}/.claude/settings.json`, {});
  add(settings.agent === 'game-orchestrator', 'Main agent', settings.agent || 'not set');
  rows.push(...modelRows());
  rows.push(humanLanguageRow());
  const pluginOn = !!settings.enabledPlugins?.['playgama-developer-cabinet@playgama-plugins'];
  const precheck = findPrecheck();
  add(pluginOn && !!precheck, 'Playgama plugin', pluginOn ? `enabled; precheck ${precheck ? 'found' : 'missing'}` : 'not enabled',
    pluginOn ? '' : 'claude plugin install playgama-developer-cabinet@playgama-plugins --scope project');
  add(null, 'Playgama MCP sign-in', 'cannot be checked from the CLI', 'In Claude Code run /mcp → plugin:playgama-developer-cabinet:playgama → Authenticate (browser OAuth)');
  const lib = libraryRoot();
  add(!lib.fallback, 'Asset library', lib.root + (lib.fallback ? ' (local fallback)' : ''),
    lib.fallback ? assetLibraryHint(platform) : '');
  rows.push(...assetIndexRows(lib));
  const drive = driveCacheRow({ platform, env });
  if (drive) rows.push(drive);
  rows.push(...diskRows(p.root, { platform, env }));
  rows.push(...strayDirRows({ root: p.root }));
  rows.push(tmpRootRow({ dir: p.tmp }));
  rows.push(pnpmStoreEnvRow(process.env, { '.claude/settings.json': settings, '.claude/settings.local.json': readJson(`${p.root}/.claude/settings.local.json`, {}) }));
  rows.push(hardLinkRow(p.state));
  add(fs.existsSync(p.keyFile) ? true : null, 'Approval key', fs.existsSync(p.keyFile) ? 'present (created on first human approval)' : 'not yet created (created automatically on the first gate command)');
  return rows;
}

/**
 * Pinned-model checks: agent definitions vs the table in factory/config.json, retry variants in sync,
 * the main-session default, and environment variables that would silently override the pins.
 * `ok` is true | false | null (unknown) | 'warn'.
 * @param {Record<string, string | undefined>} [env]
 * @param {{ settings?: any, local?: any }} [opts] parsed settings objects (default: read from `.claude/`)
 */
export function modelRows(env = process.env, opts = {}) {
  const p = paths();
  const rows = [];
  const add = (ok, item, detail, action = '') => rows.push({ ok, item, detail, action });
  const regen = 'Edit factory/config.json "models" (or the base definition), run: node factory/cli/gen-agent-models.mjs, review the diff';
  let c;
  try {
    c = checkAgentDefinitions();
  } catch (e) {
    add(false, 'Agent model pins', `check failed: ${/** @type {any} */ (e).message}`, regen);
    return rows;
  }
  add(c.pins.length === 0, 'Agent model pins', c.pins.length ? c.pins.join('; ') : `${c.pinned} definitions match factory/config.json "models"`, c.pins.length ? regen : '');
  add(c.variants.length === 0, 'Retry agent variants', c.variants.length ? c.variants.join('; ') : `${c.variantCount} -retry variants in sync`, c.variants.length ? regen : '');
  const settings = opts.settings ?? readJson(`${p.root}/.claude/settings.json`, {});
  const local = opts.local ?? readJson(`${p.root}/.claude/settings.local.json`, {});
  const effort = settings.modelSettings?.[settings.model]?.effortLevel;
  add(!!settings.model, 'Main session default', `${settings.model || 'no "model" in .claude/settings.json'}${effort ? `, effort ${effort}` : ''}` +
    `${local.model ? `; overridden by .claude/settings.local.json model ${local.model}` : ''} (not pinned: /model and /effort change it per session)`);
  rows.push(envOverrideRow(env, { '.claude/settings.json': settings, '.claude/settings.local.json': local }));
  return rows;
}

/**
 * Model/effort env overrides from the process environment and from the `env` blocks of the Claude Code settings
 * files (Claude Code applies those to every session, so they override the pins just like a user variable).
 * @param {Record<string, string | undefined>} env
 * @param {Record<string, any>} settingsByFile file label -> parsed settings object
 */
export function envOverrideRow(env, settingsByFile) {
  const found = [];
  for (const k of MODEL_ENV_OVERRIDES) if (env[k]) found.push({ k, v: env[k], where: 'environment' });
  for (const [where, s] of Object.entries(settingsByFile)) {
    const block = s && typeof s.env === 'object' && s.env ? s.env : {};
    for (const k of MODEL_ENV_OVERRIDES) if (block[k]) found.push({ k, v: block[k], where: `${where} "env"` });
  }
  if (!found.length) return { ok: true, item: 'Model env overrides', detail: 'none set (environment, settings env blocks)', action: '' };
  const fix = [...new Set(found.map((f) => f.where === 'environment' ? `the user/system environment (${f.k})` : `${f.where} (${f.k})`))];
  return {
    ok: 'warn', item: 'Model env overrides',
    detail: `${found.map((f) => `${f.k}=${f.v} [${f.where}]`).join(', ')} overrides the pinned subagent model/effort`,
    action: `Remove it from ${fix.join(', ')} and restart Claude Code`,
  };
}

/**
 * Run markers and port reservations are created with temp file + hard link (runs.mjs createExclusiveJson);
 * FAT/exFAT volumes and some network shares refuse hard links (EPERM/ENOTSUP), which breaks every verify run.
 * @param {string} dir the factory state directory
 */
export function hardLinkRow(dir) {
  const item = 'Hard links in state dir';
  const base = path.join(dir, `.doctor-link-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${base}.tmp`, 'probe');
    fs.linkSync(`${base}.tmp`, `${base}.lnk`);
    return { ok: true, item, detail: `supported (${dir})`, action: '' };
  } catch (e) {
    const code = /** @type {any} */ (e).code || /** @type {any} */ (e).message;
    return {
      ok: false, item, detail: `cannot create a hard link in ${dir} (${code}); run markers and port reservations need them`,
      action: 'Keep the factory (or FACTORY_STATE_DIR) on an NTFS/ext4/APFS local disk, not FAT/exFAT or a network share',
    };
  } finally {
    fs.rmSync(`${base}.tmp`, { force: true });
    fs.rmSync(`${base}.lnk`, { force: true });
  }
}

/**
 * Asset library mount (warning when the configured root is missing, e.g. Google Drive for desktop not running) and
 * the remote asset index: presence, age and per-source item counts (information only).
 * @param {{ root: string, fallback: boolean }} lib
 * @param {string} [file] index file (default: GAME_ASSET_INDEX or .cache/asset-index/index.sqlite)
 */
export function assetIndexRows(lib, file = indexFile()) {
  const rows = [];
  const mounted = fs.existsSync(lib.root);
  rows.push({
    ok: mounted ? true : lib.fallback ? null : 'warn', item: 'Asset library mounted',
    detail: mounted ? `${lib.root} exists` : `${lib.root} not found${lib.fallback ? ' (local fallback; created on first ingest)' : ''}`,
    action: mounted || lib.fallback ? '' : 'Mount the library folder (e.g. start Google Drive for desktop) or fix GAME_ASSET_LIBRARY; library commands fail until it is available',
  });
  if (!fs.existsSync(file)) {
    rows.push({ ok: null, item: 'Remote asset index', detail: `not built yet (${file})`, action: 'asset-producer runs: node factory/cli/factory.mjs assets sync all' });
    return rows;
  }
  const days = ((Date.now() - fs.statSync(file).mtimeMs) / 86400000).toFixed(1);
  let detail;
  try {
    const db = openIndex({ file, readonly: true });
    const st = sourceStates(db);
    const ver = schemaVersionOf(db);
    db.close();
    const per = Object.entries(st).map(([id, s]) => `${id}=${s.count}`).join(', ');
    detail = `${file} (schema v${ver ?? '?'}), updated ${days} day(s) ago; ${per || 'no sources synced'}`;
  } catch (e) {
    detail = `${file} unreadable: ${/** @type {any} */ (e).message}`;
  }
  rows.push({ ok: true, item: 'Remote asset index', detail, action: '' });
  return rows;
}

const DRIVE_HINT = 'Drive for desktop → Settings → Advanced → Local cached files directory → a folder on a volume with free space';
const DRIVE_MIN_GB = 10;

/** ContentCachePath from `reg query` output (REG_SZ / REG_EXPAND_SZ; %VARS% expanded), or null. @param {string} text @param {Record<string, string | undefined>} [env] */
export function parseRegContentCache(text, env = process.env) {
  const m = /^\s*ContentCachePath\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/im.exec(String(text || ''));
  if (!m) return null;
  return m[1].replace(/%([^%]+)%/g, (all, k) => env[k] ?? env[k.toUpperCase()] ?? all);
}

function readDriveCacheRegistry() {
  const r = spawnSync('reg', ['query', 'HKCU\\Software\\Google\\DriveFS', '/v', 'ContentCachePath'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? parseRegContentCache(r.stdout) : null;
}

/**
 * Free space on the Google Drive for desktop content cache volume (FX-12). The cache path is the registry value
 * HKCU\Software\Google\DriveFS ContentCachePath when set, else %LOCALAPPDATA%\Google\DriveFS when it exists; no row
 * off Windows or without Drive for desktop. Under 10 GB free -> WARN (streaming a big asset needs cache space).
 * Every input is injectable for tests.
 * @param {{ platform?: string, env?: Record<string, string | undefined>, registryPath?: string | null, exists?: (p: string) => boolean, freeGb?: (p: string) => number | null }} [o]
 */
export function driveCacheRow(o = {}) {
  if ((o.platform ?? process.platform) !== 'win32') return null;
  const env = o.env ?? process.env;
  const exists = o.exists ?? fs.existsSync;
  const reg = o.registryPath !== undefined ? o.registryPath : readDriveCacheRegistry();
  const local = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Google', 'DriveFS') : null;
  const cache = reg || (local && exists(local) ? local : null);
  if (!cache) return null;
  const from = reg ? 'registry ContentCachePath' : '%LOCALAPPDATA%\\Google\\DriveFS';
  const free = (o.freeGb ?? diskFree)(cache);
  const low = free !== null && free < DRIVE_MIN_GB;
  return {
    ok: free === null ? null : low ? 'warn' : true, item: 'Drive cache volume free',
    detail: `${cache} (${from}): ${free === null ? 'free space unknown' : `${free} GB free`}${low ? ` (< ${DRIVE_MIN_GB} GB)` : ''}`,
    action: low || free === null ? DRIVE_HINT : '',
  };
}

function findPrecheck() {
  const root = path.join(os.homedir(), '.claude', 'plugins');
  const cands = [path.join(root, 'marketplaces', 'playgama-plugins', 'skills', 'playgama-publish', 'scripts', 'precheck.mjs')];
  return cands.find((c) => fs.existsSync(c)) || null;
}

const diskFree = (/** @type {string} */ dir) => diskFreeGb(dir);

export function renderDoctor(rows) {
  const tag = (ok) => (ok === 'warn' ? 'WARN' : ok === null ? ' ?  ' : ok ? ' ok ' : 'FAIL');
  return rows.map((r) => `${tag(r.ok)}  ${r.item.padEnd(28)} ${r.detail}${r.action ? `\n        -> ${r.action}` : ''}`).join('\n');
}
