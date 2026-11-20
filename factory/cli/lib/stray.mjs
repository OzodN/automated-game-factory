// @ts-check
/**
 * FX-16: caches and temp files must stay inside the factory. `factory doctor` uses these read-only checks to report
 * stray directories at the drive root of the factory (left by pnpm without a configured store, or by Git Bash POSIX
 * paths that native programs resolved against the drive root), the size of the factory temp root, and a pnpm store
 * variable that pnpm 11+ ignores. Nothing here deletes anything.
 */
import fs from 'node:fs';
import path from 'node:path';

const MKTEMP_RE = /^tmp\.[A-Za-z0-9]{6,}$/;
const FACTORY_MARKERS = new Set(['factory.game.json', 'pnpm-workspace.yaml', 'pg-kit', '.pnpm-store', 'ppg-diag']);
const MSYS_TOPS = ['Users', 'Windows', 'Program Files', 'ProgramData', 'tmp'];

/** @param {number} n */
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Total size of a directory tree (symlinks are not followed); stops after `limit` entries.
 * @param {string} dir @param {number} [limit]
 */
export function dirSize(dir, limit = 200000) {
  let bytes = 0;
  let entries = 0;
  const stack = [dir];
  while (stack.length && entries < limit) {
    const d = /** @type {string} */ (stack.pop());
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of list) {
      entries++;
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { try { bytes += fs.statSync(p).size; } catch { /* vanished */ } }
    }
  }
  return { bytes, entries, truncated: entries >= limit };
}

/** True when a factory marker name appears within `depth` levels of `dir`. @param {string} dir @param {number} depth */
function hasMarker(dir, depth) {
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of list) {
    if (FACTORY_MARKERS.has(e.name)) return true;
    if (depth > 1 && e.isDirectory() && hasMarker(path.join(dir, e.name), depth - 1)) return true;
  }
  return false;
}

/** @param {string} dir */
const names = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

/**
 * Known stray directories at `driveRoot`: `.pnpm-store`; single-letter dirs that mirror a Windows path (an MSYS
 * `/c/Users/...` resolved against the drive root) or the factory's own path; `tmp` holding `mktemp` dirs or factory
 * content. No rows when the factory itself sits at the drive root.
 * @param {{ root: string, driveRoot?: string, platform?: string }} o
 * @returns {{ path: string, reason: string, bytes: number, truncated: boolean }[]}
 */
export function findStrayDirs(o) {
  const root = path.resolve(o.root);
  const drive = path.resolve(o.driveRoot ?? path.parse(root).root);
  if (drive === root) return [];
  const firstSeg = path.relative(drive, root).split(/[\\/]/)[0];
  const found = [];
  const add = (name, reason) => {
    const p = path.join(drive, name);
    const s = dirSize(p);
    found.push({ path: p, reason, bytes: s.bytes, truncated: s.truncated });
  };
  for (const name of names(drive)) {
    const p = path.join(drive, name);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (name === '.pnpm-store') add(name, 'pnpm content store created by a pnpm call without a configured store dir');
    else if (/^[A-Za-z]$/.test(name)) {
      const inner = names(p);
      const hit = inner.find((n) => MSYS_TOPS.includes(n) || (firstSeg && n === firstSeg));
      if (hit) add(name, `mirrors a Windows path (${name}/${hit}/...): a Git Bash /${name.toLowerCase()}/... path passed to a native program`);
    } else if (name.toLowerCase() === 'tmp') {
      const inner = names(p);
      const mk = inner.filter((n) => MKTEMP_RE.test(n));
      if (mk.length || hasMarker(p, 3)) add(name, mk.length ? `${mk.length} mktemp dir(s) (${mk.slice(0, 3).join(', ')}): a Git Bash /tmp path passed to a native program` : 'factory content: a Git Bash /tmp path passed to a native program');
    }
  }
  return found;
}

/** @param {string} p @param {string} platform */
const cleanupHint = (p, platform) => (platform === 'win32' ? `rmdir /s /q "${p.replace(/\//g, '\\')}"` : `rm -rf '${p}'`);

/**
 * Doctor rows for stray directories (WARN per directory, with size and a manual cleanup hint).
 * @param {{ root: string, driveRoot?: string, platform?: string }} o
 */
export function strayDirRows(o) {
  const platform = o.platform ?? process.platform;
  const drive = path.resolve(o.driveRoot ?? path.parse(path.resolve(o.root)).root);
  const dirs = findStrayDirs(o);
  if (!dirs.length) return [{ ok: true, item: 'Stray dirs at drive root', detail: `none at ${drive}`, action: '' }];
  return dirs.map((d) => ({
    ok: 'warn', item: 'Stray dir at drive root',
    detail: `${d.path} (${formatBytes(d.bytes)}${d.truncated ? '+' : ''}): ${d.reason}`,
    action: `Check its content, then delete it by hand (the factory never deletes it): ${cleanupHint(d.path, platform)}`,
  }));
}

/**
 * Size of the factory temp root and its entries older than `staleDays` (information; cleanup is manual).
 * @param {{ dir: string, staleDays?: number, now?: number }} o
 */
export function tmpRootRow(o) {
  const staleDays = o.staleDays ?? 7;
  const now = o.now ?? Date.now();
  const item = 'Factory temp (.cache/tmp)';
  if (!fs.existsSync(o.dir)) return { ok: true, item, detail: `${o.dir} not created yet`, action: '' };
  const top = names(o.dir);
  const stale = top.filter((n) => {
    try { return now - fs.statSync(path.join(o.dir, n)).mtimeMs > staleDays * 86400000; } catch { return false; }
  });
  const s = dirSize(o.dir);
  return {
    ok: true, item,
    detail: `${o.dir}: ${formatBytes(s.bytes)}${s.truncated ? '+' : ''} in ${top.length} entr${top.length === 1 ? 'y' : 'ies'}; ${stale.length} older than ${staleDays} days`,
    action: stale.length ? `Delete the ${stale.length} entr${stale.length === 1 ? 'y' : 'ies'} older than ${staleDays} days in ${o.dir} by hand when no run is active (nothing there is factory state)` : '',
  };
}

/**
 * pnpm 11+ ignores `npm_config_store_dir`: warn where it is set without `pnpm_config_store_dir` (the process
 * environment and the `env` blocks of the Claude Code settings, which every agent shell inherits).
 * @param {Record<string, string | undefined>} env @param {Record<string, any>} settingsByFile
 */
export function pnpmStoreEnvRow(env, settingsByFile) {
  const sources = [['environment', env], ...Object.entries(settingsByFile).map(([k, s]) => [`${k} "env"`, s && typeof s.env === 'object' && s.env ? s.env : {}])];
  const bad = sources.filter(([, e]) => e.npm_config_store_dir && !e.pnpm_config_store_dir).map(([w]) => w);
  if (!bad.length) return { ok: true, item: 'pnpm store env', detail: 'no npm_config_store_dir without pnpm_config_store_dir', action: '' };
  return {
    ok: 'warn', item: 'pnpm store env',
    detail: `npm_config_store_dir without pnpm_config_store_dir in ${bad.join(', ')}; pnpm 11+ ignores it (direct pnpm calls outside a pnpm-workspace.yaml with storeDir fall back to <drive root>/.pnpm-store)`,
    action: `Add pnpm_config_store_dir with the same value next to npm_config_store_dir in ${bad.join(', ')} and restart Claude Code`,
  };
}
