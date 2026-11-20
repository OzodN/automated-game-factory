// @ts-check
/**
 * Run infrastructure for factory-executed steps (FX-03, FD-08):
 *  - a free TCP port per run, allocated by the OS (bind port 0 on 127.0.0.1) and reserved in
 *    `<state>/ports/<port>.json` while the run lasts, passed to every step of the run as `E2E_PORT`;
 *  - a verification run marker per task (`<state>/games/<g>/runs/verify-<task>.json`: pid, host, start,
 *    task, attempt) so a second verify/submit of the same task is refused while the first one is alive,
 *    and `recover` can tell a running verification from an interrupted one;
 *  - known infrastructure-failure signatures (data, not scattered regexes) that let `task verify` tell an
 *    environment problem (port in use, missing browser, disk full, install network error) from a defect.
 * The CLI is synchronous, so the port probe runs in a short child process.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { paths, ensureDir, readJson, nowIso, pidAlive, FactoryError, loadConfig } from './core.mjs';
import { gameDir } from './state.mjs';

/**
 * Markers/reservations older than this are stale even if their pid looks alive (Windows reuses pids).
 * A full verify is at most ~7 steps x 15 min, so 3 h is a safe upper bound for a live run.
 */
export const RUN_MAX_AGE_MS = 3 * 3600 * 1000;
/** A run file younger than this is always live (it may be in the middle of being created or replaced). */
export const RUN_FILE_GRACE_MS = 5000;

// ---------------------------------------------------------------- liveness

/**
 * Is the process that wrote `rec` ({pid, host, ts}) still running? Another host cannot be probed: it counts
 * as alive until RUN_MAX_AGE_MS has passed.
 */
export function recordAlive(rec) {
  if (!rec || typeof rec !== 'object') return false;
  const age = Date.now() - Date.parse(rec.ts || rec.startedAt || '');
  if (!Number.isFinite(age) || age > RUN_MAX_AGE_MS) return false;
  if (rec.host && rec.host !== os.hostname()) return true;
  return pidAlive(rec.pid);
}

/**
 * State of a run file (marker or port reservation). Conservative: a file younger than RUN_FILE_GRACE_MS or
 * one that cannot be parsed counts as live (until RUN_MAX_AGE_MS by mtime), so a concurrent reader never
 * deletes a run that is being created.
 * @returns {{ state: 'none'|'live'|'stale', rec: any }}
 */
export function runFileState(file) {
  let st;
  try { st = fs.statSync(file); } catch { return { state: 'none', rec: null }; }
  const age = Date.now() - st.mtimeMs;
  const rec = readJson(file, null);
  if (age < RUN_FILE_GRACE_MS) return { state: 'live', rec };
  if (!rec || typeof rec !== 'object') return { state: age > RUN_MAX_AGE_MS ? 'stale' : 'live', rec };
  return { state: recordAlive(rec) ? 'live' : 'stale', rec };
}

/** Create `file` with JSON content atomically and exclusively (temp + hard link). False if it already exists. */
export function createExclusiveJson(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    if (/** @type {any} */ (e).code === 'EEXIST') return false;
    throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Remove a run file judged stale, without ever deleting a live one created meanwhile: rename it aside (only
 * one process can win the rename), re-check what was moved, and put it back if it turned out to be live.
 * @returns {boolean} true when a stale file was removed
 */
export function removeStaleRunFile(file) {
  const aside = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.stale`;
  try { fs.renameSync(file, aside); } catch { return false; }
  const rec = readJson(aside, null);
  if (rec && recordAlive(rec)) {
    // Lost a race: a fresh run replaced the stale file between our check and the rename. Restore it.
    try { fs.linkSync(aside, file); } catch { /* someone else created a new one: theirs wins */ }
    fs.rmSync(aside, { force: true });
    return false;
  }
  fs.rmSync(aside, { force: true });
  return true;
}

// ---------------------------------------------------------------- ports

const PROBE = `
const net = require('node:net');
const excluded = new Set(JSON.parse(process.argv[1] || '[]'));
const held = [];
function next(i) {
  if (i > 64) { console.error('no free port found'); process.exit(1); }
  const s = net.createServer();
  s.once('error', (e) => { console.error(String(e)); process.exit(1); });
  s.listen(0, '127.0.0.1', () => {
    const port = s.address().port;
    held.push(s);
    if (excluded.has(port)) return next(i + 1);
    let open = held.length;
    for (const h of held) h.close(() => { if (--open === 0) process.stdout.write(String(port)); });
  });
}
next(0);
`;

/** Ask the OS for a free port on 127.0.0.1 that is not in `exclude` (bind 0, read, close; in a child process). */
export function allocatePort(exclude = []) {
  const r = spawnSync(process.execPath, ['-e', PROBE, JSON.stringify([...exclude])], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const port = Number(String(r.stdout || '').trim());
  if (r.status !== 0 || !Number.isInteger(port) || port <= 0) {
    throw new FactoryError(`Could not allocate a free TCP port: ${(r.stderr || r.error || '').toString().trim() || `exit ${r.status}`}`);
  }
  return port;
}

export const portsDir = () => `${paths().state}/ports`;

/** Ports reserved by live factory runs; stale reservations (dead pid / too old) are removed safely. */
export function liveReservedPorts() {
  const dir = portsDir();
  if (!fs.existsSync(dir)) return [];
  const live = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^\d+\.json$/.test(x))) {
    const file = path.join(dir, f);
    const st = runFileState(file);
    if (st.state === 'live') live.push(Number(f.slice(0, -5)));
    else if (st.state === 'stale') removeStaleRunFile(file);
  }
  return live;
}

/**
 * Reserve a free port for one run (all steps of the run share it). Returns `{ port, env, release }`;
 * `env` is `{ E2E_PORT }` for the steps, `release()` drops the reservation (call it in `finally`).
 * @param {string} purpose e.g. "verify game/P2-CORE-01 a1"
 */
export function reservePort(purpose) {
  const dir = ensureDir(portsDir());
  for (let i = 0; i < 16; i++) {
    const port = allocatePort(liveReservedPorts());
    const file = `${dir}/${port}.json`;
    const rec = { port, pid: process.pid, host: os.hostname(), ts: nowIso(), purpose };
    if (!createExclusiveJson(file, rec)) {
      // Taken between probe and reservation, or a leftover: drop it if stale, then try another port.
      if (runFileState(file).state === 'stale') removeStaleRunFile(file);
      continue;
    }
    let released = false;
    return {
      port,
      env: { E2E_PORT: String(port) },
      release() {
        if (released) return;
        released = true;
        const cur = readJson(file, null);
        if (cur && cur.pid === rec.pid && cur.ts === rec.ts) fs.rmSync(file, { force: true });
      },
    };
  }
  throw new FactoryError('Could not reserve a free TCP port after 16 tries.');
}

/** Run `fn(reservation)` with a reserved port and always release it. */
export function withRunPort(purpose, fn) {
  const res = reservePort(purpose);
  try {
    return fn(res);
  } finally {
    res.release();
  }
}

// ---------------------------------------------------------------- verification marker

export const verifyMarkerPath = (g, taskId) => `${gameDir(g)}/runs/verify-${taskId}.json`;

/** @returns {{ state: 'none'|'live'|'stale', marker: any, file: string }} */
export function verifyMarkerState(g, taskId) {
  const file = verifyMarkerPath(g, taskId);
  const st = runFileState(file);
  return { state: st.state, marker: st.rec, file };
}

export function describeMarker(m) {
  if (!m) return 'marker being written or unreadable';
  return `pid ${m.pid ?? '?'}${m.host && m.host !== os.hostname() ? ` on ${m.host}` : ''}, started ${m.ts ?? '?'}${m.attempt ? `, attempt ${m.attempt}` : ''}`;
}

/** Operator escape hatch for a marker whose pid was reused by an unrelated process (orchestrator-only `recover`). */
export const clearMarkerHint = (g, taskId) =>
  `if that pid is not a factory node process (pid reused after a hard kill), clear it: factory recover --apply --clear-verify-marker ${taskId} --game ${g}`;

/** Throw when a verification of this task is running in another live process. */
export function assertNoLiveVerify(g, taskId) {
  const st = verifyMarkerState(g, taskId);
  if (st.state === 'live') {
    throw new FactoryError(`Verification of ${taskId} already running (${describeMarker(st.marker)}); wait for it to finish.`,
      [`factory recover shows it as "verifying" until the process exits; then re-run: factory task verify ${taskId} --game ${g}`, clearMarkerHint(g, taskId)]);
  }
  return st;
}

/**
 * Write the marker (atomically, exclusively) before any verification step runs. A stale marker (dead pid)
 * is moved aside first. Returns `release()`, which removes the marker only if it is still ours.
 */
export function acquireVerifyMarker(g, taskId, attempt) {
  const file = verifyMarkerPath(g, taskId);
  const rec = { pid: process.pid, host: os.hostname(), ts: nowIso(), task: taskId, attempt };
  for (let i = 0; i < 3; i++) {
    const st = assertNoLiveVerify(g, taskId);
    if (st.state === 'stale') removeStaleRunFile(file);
    if (createExclusiveJson(file, rec)) {
      return () => {
        const cur = readJson(file, null);
        if (cur && cur.pid === rec.pid && cur.ts === rec.ts) fs.rmSync(file, { force: true });
      };
    }
  }
  assertNoLiveVerify(g, taskId);
  throw new FactoryError(`Could not create the verification marker ${file}.`);
}

/**
 * Forcibly clear a task's verification marker (operator decision after checking the pid). The marker is
 * kept for the record under runs/cleared/. Returns the archived path, or null when there was no marker.
 */
export function clearVerifyMarker(g, taskId) {
  const file = verifyMarkerPath(g, taskId);
  if (!fs.existsSync(file)) return null;
  const dest = `${path.dirname(file)}/cleared/verify-${taskId}-${Date.now()}.json`;
  ensureDir(path.dirname(dest));
  fs.renameSync(file, dest);
  return dest;
}


// ---------------------------------------------------------------- infrastructure failures

/**
 * Known environment failure signatures. A failed verify step whose output matches one of these is an
 * infrastructure failure: it does not consume an attempt. `steps: null` = any step; otherwise only the
 * named steps. Patterns are case-insensitive regex sources. Deliberately absent: test failures, assertion
 * errors and test/step timeouts (they are defects or flakiness and must stay visible).
 * @type {ReadonlyArray<{id: string, description: string, steps: string[]|null, patterns: string[]}>}
 */
export const INFRA_SIGNATURES = Object.freeze([
  {
    id: 'port-in-use',
    description: 'TCP port already in use (another server or test run holds the port)',
    steps: null,
    patterns: ['\\bEADDRINUSE\\b', 'address already in use', 'is already used, make sure that nothing is running on the port', '\\bport \\d+ is (?:already )?in use\\b'],
  },
  {
    id: 'browser-unavailable',
    description: 'browser executable missing or failed to launch',
    steps: null,
    patterns: ["Executable doesn't exist at", 'browserType\\.launch:', 'Failed to launch (?:the )?(?:browser|chrom)', 'Please run the following command to download new browsers', "Chromium distribution '[^']*' is not found"],
  },
  {
    id: 'disk-full',
    description: 'no space left on device',
    steps: null,
    patterns: ['\\bENOSPC\\b', 'no space left on device'],
  },
  {
    id: 'install-network',
    description: 'dependency install failed with a network error',
    steps: ['install', 'scaffoldInstall'],
    patterns: ['\\bECONNRESET\\b', '\\bECONNREFUSED\\b', '\\bETIMEDOUT\\b', '\\bENOTFOUND\\b', '\\bEAI_AGAIN\\b', '\\bENETUNREACH\\b', 'ERR_PNPM_META_FETCH_FAIL', 'ERR_PNPM_FETCH_\\d+', 'socket hang up', 'network (?:error|request failed)'],
  },
]);

/**
 * Only the end of a failed step's output is its failure region: a runner prints the error that made it exit
 * last. An EADDRINUSE logged early by a test that later passed must not turn a real failure into "infra".
 */
export const FAILURE_REGION_LINES = 30;

/** The failure region of a step's output: its last FAILURE_REGION_LINES non-empty lines. */
export function failureRegion(output, lines = FAILURE_REGION_LINES) {
  return String(output || '').split(/\r?\n/).filter((l) => l.trim()).slice(-lines).join('\n');
}

/** Default number of infrastructure-classified verify runs allowed per attempt (config: infraRetriesPerAttempt). */
export const DEFAULT_INFRA_RETRIES_PER_ATTEMPT = 2;

/** Config `infraRetriesPerAttempt` (non-negative integer), default DEFAULT_INFRA_RETRIES_PER_ATTEMPT. */
export function infraRetryLimit(cfg = loadConfig()) {
  const v = cfg.infraRetriesPerAttempt;
  return Number.isInteger(v) && v >= 0 ? v : DEFAULT_INFRA_RETRIES_PER_ATTEMPT;
}

/**
 * Classify one failed step by its failure region. Returns `{ id, description, match }` of the first matching
 * signature, or null (an ordinary failure: a defect, a flaky test or a timeout).
 * @param {string} step @param {string} output
 */
export function classifyFailure(step, output, signatures = INFRA_SIGNATURES) {
  const text = failureRegion(output);
  for (const sig of signatures) {
    if (sig.steps && !sig.steps.includes(step)) continue;
    for (const p of sig.patterns) {
      const m = text.match(new RegExp(p, 'i'));
      if (m) return { id: sig.id, description: sig.description, match: m[0] };
    }
  }
  return null;
}
