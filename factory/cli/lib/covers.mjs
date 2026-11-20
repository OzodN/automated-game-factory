// @ts-check
/**
 * Publication covers produced by the factory (FX-04, defect FD-09).
 *
 * `factory publish covers` serves the PACKAGED release archive (extracted from the zip whose sha256 the
 * `release.packaged` event recorded, so the build is byte-identical to what will be published), opens it with the
 * Playwright already installed in that game's release worktree and takes real screenshots at the three Playgama
 * sizes. Output lives in `<inbox>/<game>/publication/covers/` together with `covers.json` (sha256 of every image,
 * the build sha256, the scenario). The same hashes are recorded in the `publication.covers` event, which agents
 * cannot write, so `preparePublication` can refuse covers that were not produced by this command for this build.
 *
 * Zero dependencies: Playwright is resolved from the game's release worktree with `createRequire`.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import {
  paths, readJson, writeJsonAtomic, ensureDir, sha256File, nowIso, norm, samePathPrefix, FactoryError, makeTmpDir,
} from './core.mjs';
import { loadState, commit } from './state.mjs';
import { extractZip } from './zip.mjs';
import { reservePort } from './runs.mjs';

/** The three Playgama cover slots (rule PG-MEDIA). */
export const COVER_SLOTS = /** @type {const} */ ({
  square: { width: 800, height: 800 },
  portrait: { width: 1080, height: 1920 },
  landscape: { width: 1920, height: 1080 },
});
export const MAX_COVER_BYTES = 10 * 1048576;

export const coversDir = (g) => `${paths().inbox}/${g}/publication/covers`;
export const coversManifestPath = (g) => `${coversDir(g)}/covers.json`;
export const releaseWorktree = (g, version) => `${paths().worktrees}/${g}/_release-${version}`;

// ---------------------------------------------------------------- scenario schema

/** Default scenario: wait for game_ready, let animations settle, shoot. */
export const DEFAULT_SCENARIO = Object.freeze({ query: '', readyTimeoutMs: 20000, settleMs: 800, steps: /** @type {any[]} */ ([]) });

const KEY_RE = /^[A-Za-z0-9]{1,20}(\+[A-Za-z0-9]{1,20}){0,3}$/;
const QUERY_RE = /^\?[A-Za-z0-9_=&.%:,-]{0,200}$/;
const STEP_KEYS = ['press', 'waitMs', 'clickAt'];

/**
 * Validate the optional `covers` block of factory.game.json and return the normalized scenario.
 *
 *   "covers": {
 *     "query": "?pgtest=1&seed=12345",          // appended to index.html (optional, '?' + [A-Za-z0-9_=&.%:,-])
 *     "readyTimeoutMs": 20000,                  // wait for game_ready (1000..60000)
 *     "settleMs": 800,                          // wait after ready, before the steps (0..10000)
 *     "steps": [                                // at most 20; each step has exactly ONE key
 *       { "press": "Space" },                   // keyboard.press (Playwright key name, e.g. "Space", "Shift+KeyA")
 *       { "clickAt": [0.5, 0.6] },              // click at viewport fractions [x, y] in 0..1 (works at every cover size)
 *       { "waitMs": 1500 }                      // 0..10000 each, 30000 in total
 *     ]
 *   }
 * @param {any} raw @returns {{query: string, readyTimeoutMs: number, settleMs: number, steps: any[], source: 'factory.game.json'|'default'}}
 */
export function validateCoversConfig(raw) {
  if (raw === undefined || raw === null) return { ...DEFAULT_SCENARIO, steps: [], source: 'default' };
  const errors = [];
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new FactoryError('factory.game.json "covers" must be an object.');
  for (const k of Object.keys(raw)) if (!['query', 'readyTimeoutMs', 'settleMs', 'steps'].includes(k)) errors.push(`unknown key "${k}"`);
  const out = { query: '', readyTimeoutMs: DEFAULT_SCENARIO.readyTimeoutMs, settleMs: DEFAULT_SCENARIO.settleMs, steps: /** @type {any[]} */ ([]) };
  if (raw.query !== undefined) {
    if (typeof raw.query !== 'string' || (raw.query !== '' && !QUERY_RE.test(raw.query))) errors.push('query must be "" or start with "?" followed by [A-Za-z0-9_=&.%:,-] (max 200)');
    else out.query = raw.query;
  }
  const int = (key, lo, hi) => {
    if (raw[key] === undefined) return;
    if (!Number.isInteger(raw[key]) || raw[key] < lo || raw[key] > hi) errors.push(`${key} must be an integer in ${lo}..${hi}`);
    else out[key] = raw[key];
  };
  int('readyTimeoutMs', 1000, 60000);
  int('settleMs', 0, 10000);
  if (raw.steps !== undefined) {
    if (!Array.isArray(raw.steps)) errors.push('steps must be an array');
    else if (raw.steps.length > 20) errors.push('at most 20 steps');
    else {
      let waited = 0;
      raw.steps.forEach((st, i) => {
        const keys = st && typeof st === 'object' && !Array.isArray(st) ? Object.keys(st) : [];
        if (keys.length !== 1 || !STEP_KEYS.includes(keys[0])) { errors.push(`steps[${i}] must have exactly one of: ${STEP_KEYS.join(', ')}`); return; }
        const [k] = keys;
        const v = st[k];
        if (k === 'press') {
          if (typeof v !== 'string' || !KEY_RE.test(v)) { errors.push(`steps[${i}].press must be a key name such as "Space" or "Shift+KeyA"`); return; }
        } else if (k === 'waitMs') {
          if (!Number.isInteger(v) || v < 0 || v > 10000) { errors.push(`steps[${i}].waitMs must be an integer in 0..10000`); return; }
          waited += v;
        } else if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === 'number' && n >= 0 && n <= 1)) {
          errors.push(`steps[${i}].clickAt must be [x, y] with both in 0..1`); return;
        }
        out.steps.push({ [k]: v });
      });
      if (waited > 30000) errors.push('steps wait more than 30000 ms in total');
    }
  }
  if (errors.length) throw new FactoryError(`Invalid "covers" block in factory.game.json:\n - ${errors.join('\n - ')}`);
  return { ...out, source: 'factory.game.json' };
}

// ---------------------------------------------------------------- png

/** PNG dimensions (IHDR) or null if the buffer is not a PNG. */
export function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// ---------------------------------------------------------------- static server

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.gif': 'image/gif', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.txt': 'text/plain',
};

/**
 * Serve `dir` on 127.0.0.1. `port` is a free port reserved by the factory (FX-03 `reservePort`); 0 lets the OS choose.
 * Path traversal is refused. @param {string} dir @param {number} [port] @returns {Promise<{port: number, url: string, close: () => Promise<void>}>}
 */
export function startStaticServer(dir, port = 0) {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]); } catch { res.writeHead(400); return res.end(); }
    let file = path.resolve(root, `.${rel.startsWith('/') ? rel : `/${rel}`}`);
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const { port: bound } = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({ port: bound, url: `http://127.0.0.1:${bound}`, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }) });
    });
  });
}

// ---------------------------------------------------------------- playwright

/**
 * Load Playwright from the game's own worktree (no dependency of the factory). The returned object has `chromium`.
 * @param {string} fromDir directory that has the game's node_modules
 */
export function loadPlaywright(fromDir) {
  const req = createRequire(path.join(fromDir, 'package.json'));
  const tried = [];
  for (const name of ['@playwright/test', 'playwright', 'playwright-core']) {
    try {
      const mod = req(name);
      if (mod?.chromium) return { chromium: mod.chromium, from: name, req };
    } catch (e) { tried.push(`${name}: ${String(e?.code || e?.message || e).split('\n')[0]}`); }
  }
  throw new FactoryError(`Playwright is not installed in ${fromDir} (tried ${tried.join('; ')}).`, [`Install the game's dependencies there (the release worktree is created by "factory release package")`]);
}

/** Runs in every page before its scripts: remembers that the game sent game_ready through the Bridge. */
const READY_HOOK = `(() => {
  window.__coverGameReady = false;
  const t = setInterval(() => {
    try {
      const b = window.bridge; if (!b || b.isInitialized === false) return;
      const p = b.platform;
      if (p && typeof p.sendMessage === 'function' && !p.__coverWrapped) {
        const orig = p.sendMessage.bind(p);
        p.sendMessage = function (m, ...rest) { if (m === 'game_ready') window.__coverGameReady = true; return orig(m, ...rest); };
        p.__coverWrapped = true;
        clearInterval(t);
      }
    } catch (e) { clearInterval(t); }
  }, 5);
})();`;

/** In the page: a canvas is laid out and the boot loader (if any) is gone. */
const SHOWING = `(() => {
  const c = document.querySelector('canvas');
  if (!c || c.getBoundingClientRect().width <= 0) return false;
  const l = document.getElementById('boot-loader');
  if (l && l.isConnected) { const cs = getComputedStyle(l); if (cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0) return false; }
  return true;
})()`;

/** In the page: the first interactive screen is showing AND the game said so. Returns the signal name or false. */
const READY_PROBE = `(() => {
  if (!${SHOWING}) return false;
  if (window.__coverGameReady) return 'game_ready';
  const pg = globalThis.__PG_TEST__;
  if (pg && typeof pg.gameReadySent === 'function' && pg.gameReadySent()) return 'pgtest';
  return false;
})()`;

// ---------------------------------------------------------------- produce

/**
 * Take the three covers for the PACKAGED build of game `g`.
 * @param {string} g
 * @param {{title?: string, acceptCanvasOnly?: boolean, chromium?: any, playwrightFrom?: string, now?: () => string}} [opts] `acceptCanvasOnly`: the orchestrator explicitly accepts shots taken without a game_ready signal; `chromium` and `playwrightFrom` are for tests
 */
export async function makeCovers(g, opts = {}) {
  const s = loadState(g);
  if (s.mode !== 'PACKAGED') throw new FactoryError(`Cannot make covers: game ${g} is in ${s.mode}; requires PACKAGED (covers come before "publish prepare").`, ['factory status']);
  if (s.paused) throw new FactoryError(`Game ${g} is paused.`, ['User types /resume']);
  const pkg = s.release?.package;
  if (!pkg?.zip || !pkg.sha256) throw new FactoryError('No packaged build recorded for this game.');
  if (!fs.existsSync(pkg.zip)) throw new FactoryError(`Packaged archive ${pkg.zip} is missing.`);
  const actual = sha256File(pkg.zip);
  if (actual !== pkg.sha256) throw new FactoryError(`Packaged archive ${pkg.zip} changed after packaging (sha256 ${actual.slice(0, 12)} != recorded ${pkg.sha256.slice(0, 12)}); covers must show the packaged build. Re-run "factory release package".`);

  const wt = releaseWorktree(g, s.release.version);
  const cfgFile = `${wt}/factory.game.json`;
  const gameCfg = fs.existsSync(cfgFile) ? readJson(cfgFile) : {};
  const scenario = validateCoversConfig(gameCfg.covers);

  const pw = opts.chromium ? { chromium: opts.chromium, from: 'injected', req: createRequire(path.join(wt, 'package.json')) } : loadPlaywright(opts.playwrightFrom || wt);
  const tmp = makeTmpDir(`factory-covers-${g}-`); // factory temp root (FX-16): the build is served to a native browser
  let server = null;
  let browser = null;
  /** @type {ReturnType<typeof reservePort> | null} */
  let reservation = null;
  try {
    // Free port reserved by the factory (the same allocation every verification run uses), held until we are done.
    reservation = reservePort(`covers ${g}`);
    const buildDir = path.join(tmp, 'build');
    const names = extractZip(pkg.zip, buildDir);
    if (typeof pkg.files === 'number' && names.length !== pkg.files) throw new FactoryError(`Extracted ${names.length} files but the package records ${pkg.files}; the archive does not match the packaged build.`);
    if (!names.includes('index.html')) throw new FactoryError('The packaged archive has no index.html.');

    server = await startStaticServer(buildDir, reservation.port);
    const channel = process.env.PW_CHANNEL === 'bundled' ? undefined : (process.env.PW_CHANNEL || 'chrome');
    try {
      browser = await pw.chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    } catch (e) {
      throw new FactoryError(`Could not launch the browser (${channel || 'bundled chromium'}): ${String(e?.message || e).split('\n')[0]}`, ['Install Google Chrome, or set PW_CHANNEL=bundled after "playwright install chromium" in the release worktree']);
    }

    let bridgeRuntime = null;
    try { bridgeRuntime = pw.req.resolve('@playgama/bridge/dist/playgama-bridge.js'); } catch { /* the build's own fallback script is used */ }

    const outDir = ensureDir(coversDir(g));
    const covers = {};
    const signals = new Set();
    const blocked = new Set();
    const pageErrors = [];
    for (const [slot, { width, height }] of Object.entries(COVER_SLOTS)) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: 'en-US', serviceWorkers: 'block' });
      try {
        await context.addInitScript(READY_HOOK);
        await context.route('**/*', async (route) => {
          const u = new URL(route.request().url());
          if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return route.continue();
          if (u.hostname === 'bridge.playgama.com' && u.pathname.endsWith('/playgama-bridge.js') && bridgeRuntime) return route.fulfill({ path: bridgeRuntime, contentType: 'text/javascript' });
          blocked.add(u.href);
          return route.abort();
        });
        const page = await context.newPage();
        page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
        page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text().slice(0, 300)); });
        await page.goto(`${server.url}/index.html${scenario.query}`, { waitUntil: 'load' });
        let signal;
        try {
          const h = await page.waitForFunction(READY_PROBE, undefined, { timeout: scenario.readyTimeoutMs, polling: 100 });
          signal = await h.jsonValue();
        } catch {
          // No game_ready seen. If a canvas is up and the loader is gone, shoot anyway but say so in covers.json.
          if (!(await page.evaluate(SHOWING).catch(() => false))) {
            throw new FactoryError(`The game did not show a first interactive screen within ${scenario.readyTimeoutMs} ms at ${width}x${height} (no canvas, or the boot loader is still visible).`, ['Check the build in "factory playtest serve"; raise "covers.readyTimeoutMs" in factory.game.json if the game is slow to start']);
          }
          signal = 'canvas-only';
        }
        signals.add(signal);
        if (scenario.settleMs) await page.waitForTimeout(scenario.settleMs);
        for (const st of scenario.steps) {
          if ('press' in st) await page.keyboard.press(st.press);
          else if ('waitMs' in st) await page.waitForTimeout(st.waitMs);
          else await page.mouse.click(st.clickAt[0] * width, st.clickAt[1] * height);
        }
        const png = await page.screenshot({ type: 'png' });
        const dim = pngSize(png);
        if (!dim || dim.w !== width || dim.h !== height) throw new FactoryError(`Screenshot for ${slot} is ${dim ? `${dim.w}x${dim.h}` : 'not a PNG'}, expected ${width}x${height}.`);
        if (png.length > MAX_COVER_BYTES) throw new FactoryError(`Screenshot for ${slot} is ${(png.length / 1048576).toFixed(1)} MB; covers must be <= 10 MB.`);
        fs.writeFileSync(`${outDir}/${slot}.png`, png);
        covers[slot] = { file: `${slot}.png`, sha256: sha256File(`${outDir}/${slot}.png`), bytes: png.length, width, height };
      } finally {
        await context.close().catch(() => {});
      }
    }

    const readySignal = signals.has('canvas-only') ? 'canvas-only' : signals.has('pgtest') ? 'pgtest' : 'game_ready';
    const manifest = {
      version: 1,
      game: g,
      title: opts.title || s.title,
      build: { sha256: pkg.sha256, release: s.release.version, tag: pkg.tag ?? s.release.tag ?? null, files: names.length },
      scenario: { source: scenario.source, query: scenario.query, readyTimeoutMs: scenario.readyTimeoutMs, settleMs: scenario.settleMs, steps: scenario.steps },
      readySignal,
      acceptedCanvasOnly: readySignal === 'canvas-only' && !!opts.acceptCanvasOnly,
      browser: { name: 'chromium', channel: channel || 'bundled', version: browser.version(), playwright: pw.from },
      blockedExternalRequests: [...blocked].slice(0, 20),
      pageErrors: pageErrors.slice(0, 10),
      createdAt: (opts.now || nowIso)(),
      covers,
    };
    writeJsonAtomic(coversManifestPath(g), manifest);
    const state = commit(g, [{
      type: 'publication.covers',
      data: {
        dir: outDir, buildSha256: pkg.sha256, manifestSha256: sha256File(coversManifestPath(g)), title: manifest.title,
        readySignal, acceptedCanvasOnly: manifest.acceptedCanvasOnly, covers: Object.fromEntries(Object.entries(covers).map(([k, v]) => [k, v.sha256])),
      },
    }], { actor: 'orchestrator', guard: (st) => { if (st.mode !== 'PACKAGED' || st.release?.package?.sha256 !== pkg.sha256) throw new FactoryError('The packaged build changed while the covers were being made; run again.'); } });
    return { dir: outDir, manifest, state, warnings: readySignal === 'canvas-only' && !opts.acceptCanvasOnly ? ['No game_ready signal was observed; the shot was taken once the canvas was visible. "factory publish prepare" will refuse these covers. Either enable pgtest in the cover scenario (query "?pgtest=1&seed=12345"; a game that bundles its own Bridge cannot be observed through the page hook) through a factory-authorized change, or, if the shots are right, re-run with --accept-canvas-only (recorded in covers.json and the event).'] : readySignal === 'canvas-only' ? ['No game_ready signal was observed; --accept-canvas-only was given and is recorded in covers.json and the publication.covers event.'] : [] };
  } finally {
    await browser?.close().catch(() => {});
    await server?.close().catch(() => {});
    reservation?.release();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- check (used by preparePublication)

/**
 * Check the covers named in packet.json: they must live in the covers folder, match covers.json and the
 * `publication.covers` event byte for byte, and have been produced for the CURRENT packaged build.
 * Returns the list of problems (empty = valid).
 * @param {string} g @param {any} s loaded game state @param {any} pkt packet.json contents
 */
export function checkPacketCovers(g, s, pkt) {
  const errors = [];
  const dir = coversDir(g);
  const hint = `produce them with "factory publish covers" (the orchestrator runs it) and reference the files it wrote in ${dir}`;
  const buildSha = s.release?.package?.sha256;
  const ev = s.publication?.covers;
  const manifest = fs.existsSync(coversManifestPath(g)) ? readJson(coversManifestPath(g), null) : null;
  if (!ev || !manifest) {
    errors.push(`no covers were produced by the factory for this game; ${hint}`);
    return errors;
  }
  if (ev.readySignal === 'canvas-only' && !ev.acceptedCanvasOnly) {
    errors.push('covers were taken without a game_ready signal (readySignal "canvas-only"); enable pgtest in the cover scenario and re-run "factory publish covers", or have the orchestrator re-run it with --accept-canvas-only after checking the shots');
  }
  if (ev.buildSha256 !== buildSha) errors.push(`covers were made for another build (${String(ev.buildSha256).slice(0, 12)}, packaged build is ${String(buildSha).slice(0, 12)}); re-run "factory publish covers"`);
  if (manifest.build?.sha256 !== buildSha) errors.push('covers.json was made for another build than the packaged one; re-run "factory publish covers"');
  if (sha256File(coversManifestPath(g)) !== ev.manifestSha256) errors.push('covers.json differs from what "factory publish covers" recorded; re-run "factory publish covers"');
  const realDir = fs.existsSync(dir) ? fs.realpathSync(dir) : dir;
  for (const [slot, { width, height }] of Object.entries(COVER_SLOTS)) {
    const c = pkt.covers?.[slot];
    if (typeof c !== 'string' || !c) { errors.push(`cover ${slot} missing in packet.covers; ${hint}`); continue; }
    const abs = path.resolve(c);
    if (!samePathPrefix(abs, dir)) { errors.push(`cover ${slot} (${c}) is outside ${dir}; covers are accepted only from there, ${hint}`); continue; }
    if (!fs.existsSync(abs)) { errors.push(`cover ${slot} missing (${c})`); continue; }
    if (!samePathPrefix(fs.realpathSync(abs), realDir)) { errors.push(`cover ${slot} (${c}) resolves outside ${dir}`); continue; }
    const entry = manifest.covers?.[slot];
    if (!entry) { errors.push(`covers.json has no entry for ${slot}`); continue; }
    if (norm(path.resolve(dir, entry.file)).toLowerCase() !== norm(abs).toLowerCase()) errors.push(`cover ${slot} (${c}) is not the file "factory publish covers" made for this slot (${entry.file})`);
    const sha = sha256File(abs);
    if (sha !== entry.sha256 || sha !== ev.covers?.[slot]) errors.push(`cover ${slot} was modified after "factory publish covers" (sha256 mismatch with covers.json); re-run "factory publish covers"`);
    const buf = fs.readFileSync(abs);
    const dim = pngSize(buf);
    if (!dim || dim.w !== width || dim.h !== height) errors.push(`cover ${slot} must be exactly ${width}x${height} (got ${dim ? `${dim.w}x${dim.h}` : 'unreadable'})`);
    if (buf.length > MAX_COVER_BYTES) errors.push(`cover ${slot} exceeds 10 MB`);
  }
  return errors;
}
