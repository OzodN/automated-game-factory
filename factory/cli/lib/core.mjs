// @ts-check
/**
 * Core utilities shared by the factory CLI and hooks.
 * Paths, atomic file I/O, directory locks, hashing, glob matching, process execution.
 * Zero external dependencies by design: the CLI must run on a bare Node >= 22 install.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Normalize a filesystem path to forward slashes (Windows-safe comparisons). */
export function norm(p) {
  return path.resolve(p).replace(/\\/g, '/');
}

/** Case-insensitive on Windows, case-sensitive elsewhere. */
export function samePathPrefix(child, parent) {
  const c = norm(child);
  const p = norm(parent).replace(/\/+$/, '');
  const win = process.platform === 'win32';
  const cc = win ? c.toLowerCase() : c;
  const pp = win ? p.toLowerCase() : p;
  return cc === pp || cc.startsWith(pp + '/');
}

/** Resolve all factory locations. Every location is overridable by env for tests. */
export function paths() {
  const root = norm(process.env.FACTORY_ROOT || path.resolve(HERE, '..', '..', '..'));
  const state = norm(process.env.FACTORY_STATE_DIR || path.join(root, '.factory'));
  return {
    root,
    state,
    gamesState: `${state}/games`,
    approvals: `${state}/approvals.jsonl`,
    consumed: `${state}/approvals-consumed.jsonl`,
    provenance: `${state}/provenance.jsonl`,
    agentMap: `${state}/agents.json`,
    agentRuns: `${state}/agent-runs.jsonl`,
    hookLog: `${state}/hook-decisions.jsonl`,
    focus: `${state}/focus.json`,
    config: norm(process.env.FACTORY_CONFIG || `${root}/factory/config.json`),
    games: norm(process.env.FACTORY_GAMES_DIR || path.join(root, 'games')),
    worktrees: norm(process.env.FACTORY_WORKTREES_DIR || path.join(root, '.worktrees')),
    inbox: norm(process.env.FACTORY_INBOX_DIR || path.join(root, '.inbox')),
    archive: norm(process.env.FACTORY_ARCHIVE_DIR || path.join(root, 'archive')),
    templates: norm(process.env.FACTORY_TEMPLATES_DIR || `${root}/factory/templates`),
    kit: norm(process.env.FACTORY_KIT_DIR || `${root}/packages/pg-kit`),
    tmp: norm(process.env.FACTORY_TMP_DIR || `${root}/.cache/tmp`),
    keyFile: norm(process.env.FACTORY_KEY_PATH || path.join(os.homedir(), '.game-factory', 'approval.key')),
  };
}

export function loadConfig() {
  const p = paths();
  const defaults = {
    maxAttempts: 3,
    concurrency: 3,
    maxActiveAgents: 4,
    approvalTtlHours: 24,
    draftTokenTtlHours: 2,
    packageManager: 'corepack pnpm',
    lockStaleMs: 120000,
    humanLanguage: 'auto',
  };
  const user = readJson(p.config, {});
  return { ...defaults, ...user };
}

export function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw e;
  }
}

/** Atomic JSON write: write temp file in same dir, then rename. */
export function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameWithRetry(tmp, file);
}

export function writeTextAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  renameWithRetry(tmp, file);
}

/** Windows can transiently refuse renames when another process has the target open. */
function renameWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (i >= 20) throw e;
      sleepMs(25 * (i + 1));
    }
  }
}

export function appendJsonl(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      // A torn final line (crash mid-append) is tolerated; anything else is corruption.
      if (i < lines.length - 2) throw new Error(`Corrupt JSONL at ${file}:${i + 1}`);
    }
  }
  return out;
}

export function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** mtime of a path, or null when it vanished meanwhile (ENOENT). @param {string} p */
function statMtimeMs(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch (e) {
    if (/** @type {any} */ (e).code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Cross-process lock using atomic mkdir. Stale locks (older than staleMs, or owned by a
 * dead pid) are broken. Returns a release function.
 */
export function acquireLock(lockDir, { staleMs = 120000, timeoutMs = 30000 } = {}) {
  const start = Date.now();
  ensureDir(path.dirname(lockDir));
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, ts: Date.now() }));
      return () => fs.rmSync(lockDir, { recursive: true, force: true });
    } catch (e) {
      if (/** @type {any} */ (e).code !== 'EEXIST') throw e;
      const owner = readJson(path.join(lockDir, 'owner.json'), null);
      // FX-13: the holder may release (rmSync) between our mkdir EEXIST and this stat; ENOENT means "free now": retry.
      const mtime = owner ? 0 : statMtimeMs(lockDir);
      if (!owner && mtime === null) continue;
      const age = owner ? Date.now() - owner.ts : Date.now() - /** @type {number} */ (mtime);
      if (age > staleMs || (owner && !pidAlive(owner.pid))) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for lock ${lockDir}`);
      sleepMs(50);
    }
  }
}

/** True while a process with this pid exists on this machine (EPERM: exists, owned by someone else). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {any} */ (e).code === 'EPERM';
  }
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

/** Deterministic hash of a directory tree (relative paths + contents), ignoring dot-dirs. */
export function hashTree(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = listFiles(dir).sort();
  const h = crypto.createHash('sha256');
  for (const rel of files) {
    h.update(rel + '\0');
    h.update(fs.readFileSync(path.join(dir, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}

/** Recursive relative file list with forward slashes. Skips node_modules and .git. */
export function listFiles(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(full, base, out);
    else out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

/** Convert a glob (supports **, *, ?, {a,b}) to a RegExp anchored on full relative path. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      re += '(?:' + glob.slice(i + 1, end).split(',').map(escapeRe).join('|') + ')';
      i = end;
    } else re += escapeRe(c);
  }
  return new RegExp('^' + re + '$');
}

function escapeRe(s) {
  return s.replace(/[.+^$()|[\]\\]/g, '\\$&');
}

export function matchesAny(relPath, globs) {
  return globs.some((g) => globToRegExp(g).test(relPath));
}

/** Literal prefix of a glob before its first wildcard; used for conservative overlap checks. */
export function globPrefix(glob) {
  const m = glob.search(/[*?{]/);
  return m === -1 ? glob : glob.slice(0, m);
}

/** Conservative: two globs may overlap if one literal prefix is a prefix of the other. */
export function globsMayOverlap(a, b) {
  const pa = globPrefix(a);
  const pb = globPrefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

/**
 * Run a command synchronously. `cmd` is a shell string (executed via the platform shell)
 * so configured verify steps like "corepack pnpm run typecheck" work unchanged.
 */
/**
 * Factory temp root (FX-16): `<root>/.cache/tmp` (env FACTORY_TMP_DIR), created on demand. Use it instead of
 * os.tmpdir() for output handed to native tools or kept after the call; nothing in it is state (doctor reports stale
 * entries, which may be deleted by hand).
 */
export function tmpRoot() {
  return ensureDir(paths().tmp);
}

/** A fresh unique directory under the factory temp root (the caller removes it). @param {string} prefix */
export function makeTmpDir(prefix) {
  return norm(fs.mkdtempSync(path.join(tmpRoot(), prefix.replace(/[^A-Za-z0-9._-]/g, '_'))));
}

/**
 * Package/browser caches and temp files default to the factory's .cache (C: has little space on this machine).
 * pnpm 11+ reads only `pnpm_config_*` variables (`npm_config_store_dir` is ignored and pnpm falls back to
 * `<drive root>/.pnpm-store`), so both spellings are set. TMPDIR/TEMP/TMP always point to the factory temp root
 * (native-path form) so spawned tools never write to a system or drive-root temp dir.
 */
export function cacheEnv() {
  const c = `${paths().root}/.cache`;
  const d = (k, v) => (process.env[k] ? {} : { [k]: v });
  const tmp = path.resolve(tmpRoot());
  return {
    ...d('COREPACK_HOME', `${c}/corepack`),
    ...d('npm_config_store_dir', process.env.pnpm_config_store_dir || `${c}/pnpm-store`),
    ...d('pnpm_config_store_dir', process.env.npm_config_store_dir || `${c}/pnpm-store`),
    ...d('pnpm_config_cache_dir', `${c}/pnpm-cache`),
    ...d('npm_config_cache', `${c}/npm-cache`),
    ...d('PLAYWRIGHT_BROWSERS_PATH', `${c}/ms-playwright`),
    ...d('PUPPETEER_CACHE_DIR', `${c}/puppeteer`),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
  };
}

export function run(cmd, { cwd, env, timeoutMs = 15 * 60 * 1000, input } = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, {
    cwd,
    env: { ...process.env, ...cacheEnv(), ...env },
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    input,
    windowsHide: true,
  });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  return {
    cmd,
    exitCode: r.status === null ? (r.error ? 127 : 124) : r.status,
    durationMs: Date.now() - t0,
    output,
    tail: output.split('\n').slice(-60).join('\n'),
    timedOut: r.error?.name === 'Error' && /ETIMEDOUT/.test(String(r.error)) ? true : r.signal === 'SIGTERM',
  };
}

/** Run git with argument array (no shell) and return trimmed stdout; throws on failure. */
export function git(args, cwd, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${r.stderr || r.stdout}`);
  }
  return allowFail ? { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() } : (r.stdout || '').trim();
}

export function nowIso() {
  return new Date().toISOString();
}

export class FactoryError extends Error {
  /** @param {string} message @param {string[]} [hints] */
  constructor(message, hints = []) {
    super(message);
    this.hints = hints;
  }
}

export const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
export const TASK_ID_RE = /^[A-Z0-9][A-Z0-9-]{1,40}$/;
