// @ts-check
/**
 * FX-04 (defect FD-09): the factory produces the publication covers.
 * Covered: the `covers` scenario schema, zip extraction, the whole `makeCovers` pipeline with an injected fake
 * browser (served build is byte-identical to the packaged archive, three exact-size PNGs, covers.json, the
 * publication.covers event), `preparePublication` refusing covers outside the folder / edited / made for another
 * build / not produced by the factory and accepting valid ones, the guard denying agent writes into the covers
 * folder, and a REAL Chrome run that is skipped when Playwright or Chrome is unavailable.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const CLI = path.resolve(HERE, '../factory.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-fx04-'));
const env = {
  FACTORY_STATE_DIR: `${TMP}/state`, FACTORY_GAMES_DIR: `${TMP}/games`, FACTORY_WORKTREES_DIR: `${TMP}/wt`,
  FACTORY_INBOX_DIR: `${TMP}/inbox`, FACTORY_ARCHIVE_DIR: `${TMP}/archive`, FACTORY_KEY_PATH: `${TMP}/key/approval.key`,
  FACTORY_CONFIG: `${TMP}/config.json`,
};
Object.assign(process.env, env);
fs.writeFileSync(env.FACTORY_CONFIG, JSON.stringify({ maxAttempts: 3, concurrency: 2, maxActiveAgents: 3, packageManager: 'corepack pnpm' }));

const { paths, sha256File, readJson } = await import('../lib/core.mjs');
const S = await import('../lib/state.mjs');
const G = await import('../lib/game.mjs');
const C = await import('../lib/covers.mjs');
const { zipDirectory, extractZip } = await import('../lib/zip.mjs');
const { decide, applyEffects } = await import('../lib/guard.mjs');

// ---------------------------------------------------------------- fixtures

/** Tiny zero-dependency PNG encoder: solid RGB image. */
function png(width, height, [r, g, b] = [20, 40, 60]) {
  const crcBuf = (buf) => { const b4 = Buffer.alloc(4); b4.writeUInt32BE(zlib.crc32(buf) >>> 0); return b4; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    return Buffer.concat([len, td, crcBuf(td)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const SIZES = { square: [800, 800], portrait: [1080, 1920], landscape: [1920, 1080] };
const INDEX_HTML = '<!doctype html><title>Cover Game</title><canvas width="10" height="10"></canvas>';

/** Register a game in PACKAGED mode with a real deterministic zip of a tiny build. */
function packagedGame(id, { gameCfg = {}, extraFiles = {} } = {}) {
  const dist = `${TMP}/dist-${id}`;
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(`${dist}/index.html`, INDEX_HTML);
  fs.writeFileSync(`${dist}/playgama-bridge-config.json`, '{"forciblySetPlatformId":""}');
  fs.mkdirSync(`${dist}/assets`, { recursive: true });
  fs.writeFileSync(`${dist}/assets/app.js`, `console.log(${JSON.stringify(id)});`);
  for (const [f, c] of Object.entries(extraFiles)) { fs.mkdirSync(path.dirname(`${dist}/${f}`), { recursive: true }); fs.writeFileSync(`${dist}/${f}`, c); }
  const out = `${paths().archive}/${id}/1.0.0`;
  fs.mkdirSync(out, { recursive: true });
  const zip = `${out}/${id}-1.0.0.zip`;
  const z = zipDirectory(dist, zip);
  const sha256 = sha256File(zip);
  const wt = C.releaseWorktree(id, '1.0.0');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(`${wt}/factory.game.json`, JSON.stringify({ template: 'x', ...gameCfg }));
  S.commit(id, [
    { type: 'game.created', data: { title: `Game ${id}` } },
    { type: 'release.approved', data: { version: '1.0.0', tag: 'v1.0.0', mainCommit: 'abc' } },
    { type: 'release.packaged', data: { zip, sha256, files: z.files, bytes: z.bytes, validation: { ok: true }, results: [], tag: 'v1.0.0' } },
  ]);
  return { zip, sha256, dist, wt, files: z.files };
}

/** A fake Playwright `chromium` that fetches the page from the served build and returns exact-size PNGs. */
function fakeChromium(log = {}) {
  log.pages = [];
  return {
    async launch() {
      return {
        version: () => 'fake-1.0',
        async close() {},
        async newContext({ viewport }) {
          return {
            async addInitScript() {},
            async route() {},
            async close() {},
            async newPage() {
              const rec = { viewport, actions: [], body: '' };
              log.pages.push(rec);
              return {
                on() {},
                async goto(url) {
                  rec.url = url;
                  rec.portReserved = fs.existsSync(`${paths().state}/ports/${new URL(url).port}.json`);
                  rec.body = await new Promise((res, rej) => http.get(url, (r) => { const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => res(Buffer.concat(chunks).toString())); }).on('error', rej));
                },
                async waitForFunction() { if (log.canvasOnly) throw new Error('timeout'); return { jsonValue: async () => 'game_ready' }; },
                async evaluate() { return true; },
                async waitForTimeout(ms) { rec.actions.push(`wait:${ms}`); },
                keyboard: { async press(k) { rec.actions.push(`press:${k}`); } },
                mouse: { async click(x, y) { rec.actions.push(`click:${x},${y}`); } },
                async screenshot() { return png(viewport.width, viewport.height, [viewport.width % 255, 90, 200]); },
              };
            },
          };
        },
      };
    },
  };
}

const rmWrite = (file) => {
  const r = decide({ tool_name: 'Write', agent_id: 'rm1', agent_type: 'release-manager', tool_input: { file_path: file }, cwd: TMP });
  if (r.decision === null) applyEffects(r.effects);
  return r;
};
function writePacket(id, covers, sha256) {
  const file = `${paths().inbox}/${id}/publication/packet.json`;
  const r = rmWrite(file);
  assert.equal(r.decision, null, r.reason);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    game: id, version: '1.0.0', archiveSha256: sha256,
    form: { title: `Game ${id}`, description: 'd'.repeat(120), howToPlayText: 'h'.repeat(120), category: 'arcade', supportedDevices: ['desktop'], supportedLanguages: ['en'] },
    covers,
  }));
}
const coverPaths = (id) => Object.fromEntries(Object.keys(SIZES).map((k) => [k, `${C.coversDir(id)}/${k}.png`]));

// ---------------------------------------------------------------- schema

test('covers schema: default, valid scenario and every kind of invalid one', () => {
  assert.deepEqual(C.validateCoversConfig(undefined), { query: '', readyTimeoutMs: 20000, settleMs: 800, steps: [], source: 'default' });
  const ok = C.validateCoversConfig({ query: '?cover=1', settleMs: 0, steps: [{ press: 'Space' }, { waitMs: 1500 }, { clickAt: [0.5, 0.6] }, { press: 'Shift+KeyA' }] });
  assert.equal(ok.source, 'factory.game.json');
  assert.equal(ok.steps.length, 4);
  const bad = [
    'x', [], { nope: 1 }, { query: 'cover=1' }, { query: '?a b' }, { query: '?<script>' }, { readyTimeoutMs: 10 }, { settleMs: -1 },
    { steps: 'x' }, { steps: Array.from({ length: 21 }, () => ({ waitMs: 1 })) }, { steps: [{}] }, { steps: [{ press: 'Space', waitMs: 1 }] },
    { steps: [{ jump: 1 }] }, { steps: [{ press: 'a;b' }] }, { steps: [{ waitMs: 10001 }] }, { steps: [{ waitMs: 'x' }] },
    { steps: [{ clickAt: [2, 0] }] }, { steps: [{ clickAt: [0.5] }] }, { steps: [{ waitMs: 10000 }, { waitMs: 10000 }, { waitMs: 10000 }, { waitMs: 1 }] },
  ];
  for (const b of bad) assert.throws(() => C.validateCoversConfig(b), /covers|Invalid/, JSON.stringify(b));
});

test('the template ships a valid default cover scenario', () => {
  const cfg = readJson(path.resolve(ROOT, 'factory/templates/game-phaser-ts/factory.game.json'));
  assert.ok(cfg.covers, 'template has a covers block');
  assert.equal(C.validateCoversConfig(cfg.covers).source, 'factory.game.json');
});

// ---------------------------------------------------------------- zip + server

test('extractZip round-trips a build and refuses entries that escape the folder', () => {
  const g = packagedGame('fx4-zip');
  const dest = `${TMP}/extract-zip`;
  const names = extractZip(g.zip, dest);
  assert.deepEqual(names, ['assets/app.js', 'index.html', 'playgama-bridge-config.json']);
  assert.equal(fs.readFileSync(`${dest}/index.html`, 'utf8'), INDEX_HTML);
  // hand-built stored zip with a traversal name
  const name = Buffer.from('../evil.txt');
  const data = Buffer.from('x');
  const crc = zlib.crc32(data) >>> 0;
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(1, 18); lh.writeUInt32LE(1, 22); lh.writeUInt16LE(name.length, 26);
  const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(1, 20); ch.writeUInt32LE(1, 24); ch.writeUInt16LE(name.length, 28);
  const cd = Buffer.concat([ch, name]);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(lh.length + name.length + 1, 16);
  fs.writeFileSync(`${TMP}/evil.zip`, Buffer.concat([lh, name, data, cd, eocd]));
  assert.throws(() => extractZip(`${TMP}/evil.zip`, `${TMP}/extract-evil`), /Unsafe entry name/);
  assert.equal(fs.existsSync(`${TMP}/evil.txt`), false);
});

test('static server uses a free OS-chosen port and refuses traversal', async () => {
  const dir = `${TMP}/srv`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/index.html`, 'hi');
  fs.writeFileSync(`${TMP}/secret.txt`, 'secret');
  const a = await C.startStaticServer(dir);
  const b = await C.startStaticServer(dir);
  try {
    assert.notEqual(a.port, b.port);
    const get = (url) => new Promise((res) => http.get(url, (r) => { r.resume(); res(r.statusCode); }));
    assert.equal(await get(`${a.url}/`), 200);
    assert.equal(await get(`${a.url}/nope`), 404);
    assert.equal(await get(`${a.url}/..%2fsecret.txt`), 403);
  } finally { await a.close(); await b.close(); }
});

// ---------------------------------------------------------------- makeCovers (fake browser)

test('makeCovers: serves the packaged archive, writes 3 exact-size PNGs + covers.json, records the event', async () => {
  const id = 'fx4-make';
  const g = packagedGame(id, { gameCfg: { covers: { query: '?cover=1', settleMs: 50, steps: [{ press: 'Space' }, { clickAt: [0.5, 0.6] }, { waitMs: 100 }] } } });
  const log = {};
  const r = await C.makeCovers(id, { chromium: fakeChromium(log), title: 'Cover Title' });
  assert.equal(r.dir, C.coversDir(id));
  assert.equal(log.pages.length, 3);
  for (const p of log.pages) {
    assert.equal(p.body, INDEX_HTML, 'the page served is the packaged index.html byte for byte');
    assert.equal(p.portReserved, true, 'the served port is a factory-reserved free port (FX-03 reservePort)');
    assert.match(p.url, /^http:\/\/127\.0\.0\.1:\d+\/index\.html\?cover=1$/);
  }
  assert.deepEqual(log.pages[0].actions, ['wait:50', 'press:Space', 'click:400,480', 'wait:100']);
  const m = readJson(C.coversManifestPath(id));
  assert.equal(m.build.sha256, g.sha256);
  assert.equal(m.title, 'Cover Title');
  assert.equal(m.readySignal, 'game_ready');
  assert.equal(m.scenario.query, '?cover=1');
  assert.equal(m.scenario.source, 'factory.game.json');
  for (const [slot, [w, h]] of Object.entries(SIZES)) {
    const file = `${C.coversDir(id)}/${slot}.png`;
    assert.deepEqual(C.pngSize(fs.readFileSync(file)), { w, h });
    assert.equal(m.covers[slot].sha256, sha256File(file));
    assert.deepEqual([m.covers[slot].width, m.covers[slot].height], [w, h]);
  }
  const s = S.loadState(id);
  assert.equal(s.publication.covers.buildSha256, g.sha256);
  assert.equal(s.publication.covers.manifestSha256, sha256File(C.coversManifestPath(id)));
  assert.equal(s.mode, 'PACKAGED');
  const leftover = fs.existsSync(`${paths().state}/ports`) ? fs.readdirSync(`${paths().state}/ports`) : [];
  assert.deepEqual(leftover, [], 'the port reservation is released');
  const tmpLeft = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(`factory-covers-${id}-`));
  assert.deepEqual(tmpLeft, [], 'temporary extraction is removed');
});

test('makeCovers refuses a wrong mode, a changed archive and a bad scenario', async () => {
  S.commit('fx4-ideation', [{ type: 'game.created', data: { title: 'Idea' } }]);
  await assert.rejects(() => C.makeCovers('fx4-ideation', { chromium: fakeChromium() }), /requires PACKAGED/);
  const g = packagedGame('fx4-tamper');
  fs.appendFileSync(g.zip, 'tamper');
  await assert.rejects(() => C.makeCovers('fx4-tamper', { chromium: fakeChromium() }), /changed after packaging/);
  packagedGame('fx4-badcfg', { gameCfg: { covers: { steps: [{ jump: 1 }] } } });
  await assert.rejects(() => C.makeCovers('fx4-badcfg', { chromium: fakeChromium() }), /Invalid "covers" block/);
  assert.equal(S.loadState('fx4-badcfg').publication.covers, undefined);
});

test('CLI: publish covers is documented and refuses outside PACKAGED with a clear message', () => {
  const help = spawnSync(process.execPath, [CLI, 'help'], { env: { ...process.env }, encoding: 'utf8' });
  assert.match(help.stdout, /publish covers/);
  const r = spawnSync(process.execPath, [CLI, 'publish', 'covers', '--game', 'fx4-ideation'], { env: { ...process.env }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /requires PACKAGED/);
});

// ---------------------------------------------------------------- preparePublication

test('preparePublication accepts the covers produced by the factory', async () => {
  const id = 'fx4-ok';
  const g = packagedGame(id);
  await C.makeCovers(id, { chromium: fakeChromium() });
  writePacket(id, coverPaths(id), g.sha256);
  const s = G.preparePublication(id);
  assert.equal(s.mode, 'PUBLICATION_PREPARED');
});

test('canvas-only covers (no game_ready seen) are recorded and refused by prepare unless explicitly accepted', async () => {
  const id = 'fx4-canvas';
  const g = packagedGame(id, { gameCfg: { covers: { readyTimeoutMs: 1000 } } });
  const r = await C.makeCovers(id, { chromium: fakeChromium({ canvasOnly: true }) });
  assert.equal(r.manifest.readySignal, 'canvas-only');
  assert.equal(r.manifest.acceptedCanvasOnly, false);
  assert.match(r.warnings.join(' '), /prepare" will refuse/);
  assert.equal(S.loadState(id).publication.covers.readySignal, 'canvas-only');
  writePacket(id, coverPaths(id), g.sha256);
  assert.throws(() => G.preparePublication(id), /without a game_ready signal.*--accept-canvas-only/s);
  assert.equal(S.loadState(id).mode, 'PACKAGED');
  // explicit orchestrator acceptance: recorded in covers.json and the event, then prepare passes
  const r2 = await C.makeCovers(id, { chromium: fakeChromium({ canvasOnly: true }), acceptCanvasOnly: true });
  assert.equal(r2.manifest.readySignal, 'canvas-only');
  assert.equal(r2.manifest.acceptedCanvasOnly, true);
  assert.match(r2.warnings.join(' '), /--accept-canvas-only was given/);
  const ev = S.loadState(id).publication.covers;
  assert.equal(ev.acceptedCanvasOnly, true);
  writePacket(id, coverPaths(id), g.sha256);
  assert.equal(G.preparePublication(id).mode, 'PUBLICATION_PREPARED');
  // a game_ready run does not need the flag, and the flag does not mark it as accepted
  const id2 = 'fx4-ready-flag';
  packagedGame(id2);
  const r3 = await C.makeCovers(id2, { chromium: fakeChromium(), acceptCanvasOnly: true });
  assert.equal(r3.manifest.acceptedCanvasOnly, false);
});

test('CLI: --accept-canvas-only is a documented flag of publish covers', () => {
  const help = spawnSync(process.execPath, [CLI, 'help'], { env: { ...process.env }, encoding: 'utf8' });
  assert.ok(help.stdout.includes('publish covers [--title "..."] [--accept-canvas-only]'));
});

test('preparePublication refuses covers outside <inbox>/<game>/publication/covers/', async () => {
  const id = 'fx4-outside';
  const g = packagedGame(id);
  await C.makeCovers(id, { chromium: fakeChromium() });
  const elsewhere = `${TMP}/pg-covers-out`;
  fs.mkdirSync(elsewhere, { recursive: true });
  const moved = {};
  for (const k of Object.keys(SIZES)) { moved[k] = `${elsewhere}/${k}.png`; fs.copyFileSync(`${C.coversDir(id)}/${k}.png`, moved[k]); }
  writePacket(id, moved, g.sha256);
  assert.throws(() => G.preparePublication(id), (e) => /outside/.test(e.message) && /factory publish covers/.test(e.message) && e.message.includes('cover square') && e.message.includes('cover landscape'));
  // a sibling folder with the same prefix is not inside the folder either
  fs.mkdirSync(`${C.coversDir(id)}-extra`, { recursive: true });
  const sib = {};
  for (const k of Object.keys(SIZES)) { sib[k] = `${C.coversDir(id)}-extra/${k}.png`; fs.copyFileSync(`${C.coversDir(id)}/${k}.png`, sib[k]); }
  writePacket(id, sib, g.sha256);
  assert.throws(() => G.preparePublication(id), /outside/);
  assert.equal(S.loadState(id).mode, 'PACKAGED');
});

test('preparePublication refuses a cover whose sha256 differs from covers.json (right size, edited content)', async () => {
  const id = 'fx4-edited';
  const g = packagedGame(id);
  await C.makeCovers(id, { chromium: fakeChromium() });
  fs.writeFileSync(`${C.coversDir(id)}/portrait.png`, png(1080, 1920, [255, 0, 0]));
  writePacket(id, coverPaths(id), g.sha256);
  assert.throws(() => G.preparePublication(id), (e) => /cover portrait was modified/.test(e.message) && !/cover square/.test(e.message));
});

test('preparePublication refuses a cover swapped into another slot and a forged covers.json', async () => {
  const id = 'fx4-forged';
  const g = packagedGame(id);
  await C.makeCovers(id, { chromium: fakeChromium() });
  // swap: square slot points at portrait file (wrong size and wrong slot)
  const p = coverPaths(id);
  writePacket(id, { ...p, square: p.portrait }, g.sha256);
  assert.throws(() => G.preparePublication(id), /cover square/);
  // forge: edit the image AND covers.json to match; the recorded event still exposes it
  const evil = png(800, 800, [1, 2, 3]);
  fs.writeFileSync(p.square, evil);
  const m = readJson(C.coversManifestPath(id));
  m.covers.square.sha256 = sha256File(p.square);
  fs.writeFileSync(C.coversManifestPath(id), JSON.stringify(m));
  writePacket(id, p, g.sha256);
  assert.throws(() => G.preparePublication(id), /covers\.json differs from what "factory publish covers" recorded/);
});

test('preparePublication refuses covers made for another build and requires covers to exist', async () => {
  const id = 'fx4-build';
  const g = packagedGame(id);
  // no covers produced at all
  writePacket(id, coverPaths(id), g.sha256);
  assert.throws(() => G.preparePublication(id), /no covers were produced by the factory.*factory publish covers/s);
  // covers for build A, then the release is re-packaged (build B)
  await C.makeCovers(id, { chromium: fakeChromium() });
  const shaB = 'b'.repeat(64);
  S.commit(id, [{ type: 'release.packaged', data: { ...S.loadState(id).release.package, sha256: shaB } }]);
  writePacket(id, coverPaths(id), shaB);
  assert.throws(() => G.preparePublication(id), /covers were made for another build/);
  assert.equal(S.loadState(id).mode, 'PACKAGED');
  // and makeCovers for the new build is refused because the archive no longer matches its record
  await assert.rejects(() => C.makeCovers(id, { chromium: fakeChromium() }), /changed after packaging/);
});

test('preparePublication still checks dimensions of produced covers', async () => {
  const id = 'fx4-dims';
  const g = packagedGame(id);
  await C.makeCovers(id, { chromium: fakeChromium() });
  // a (hypothetically produced) manifest that records a wrong-size image is still refused by the size check
  const p = coverPaths(id);
  const wrong = png(700, 700);
  fs.writeFileSync(p.square, wrong);
  const m = readJson(C.coversManifestPath(id));
  m.covers.square.sha256 = sha256File(p.square);
  fs.writeFileSync(C.coversManifestPath(id), JSON.stringify(m));
  S.commit(id, [{ type: 'publication.covers', data: { ...S.loadState(id).publication.covers, manifestSha256: sha256File(C.coversManifestPath(id)), covers: { ...S.loadState(id).publication.covers.covers, square: sha256File(p.square) } } }]);
  writePacket(id, p, g.sha256);
  assert.throws(() => G.preparePublication(id), /cover square must be exactly 800x800 \(got 700x700\)/);
});

// ---------------------------------------------------------------- guard

test('guard: agents cannot write into publication/covers/, the packet stays writable', () => {
  const dir = C.coversDir('fx4-guard');
  assert.equal(rmWrite(`${dir}/square.png`).decision, 'deny');
  assert.match(rmWrite(`${dir}/covers.json`).reason, /factory publish covers/);
  assert.equal(rmWrite(`${paths().inbox}/fx4-guard/publication/packet.json`).decision, null);
  assert.equal(rmWrite(`${paths().inbox}/fx4-guard/publication/shoot.mjs`).decision, null);
  const other = decide({ tool_name: 'Write', agent_id: 'q1', agent_type: 'qa-engineer', tool_input: { file_path: `${dir}/x.png` }, cwd: TMP });
  assert.equal(other.decision, 'deny');
});

// ---------------------------------------------------------------- real browser (skipped when unavailable)

/** Find a directory that has Playwright installed (a game's worktree) and check that Chrome launches. */
async function realBrowser() {
  const cands = [process.env.FX04_PLAYWRIGHT_FROM, ...[`${ROOT}/.worktrees`, path.resolve(ROOT, '../../../.worktrees')].flatMap((w) => {
    if (!fs.existsSync(w)) return [];
    return fs.readdirSync(w).flatMap((game) => {
      const d = path.join(w, game);
      return fs.existsSync(d) && fs.statSync(d).isDirectory() ? fs.readdirSync(d).map((x) => path.join(d, x)) : [];
    });
  })].filter(Boolean);
  for (const dir of cands) {
    if (!fs.existsSync(path.join(dir, 'node_modules'))) continue;
    try {
      const pw = C.loadPlaywright(/** @type {string} */ (dir));
      const channel = process.env.PW_CHANNEL === 'bundled' ? undefined : (process.env.PW_CHANNEL || 'chrome');
      const b = await pw.chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
      await b.close();
      return dir;
    } catch { /* try the next candidate */ }
  }
  return null;
}
const REAL = await realBrowser();

test('real Chrome: game_ready is observed through the Bridge and exact-size screenshots are taken', { skip: REAL ? false : 'Playwright or Chrome is not available' }, async () => {
  const id = 'fx4-real';
  const page = `<!doctype html><title>Real</title><style>html,body{margin:0;background:#123}canvas{display:block;width:100vw;height:100vh;background:linear-gradient(#f80,#08f)}</style>
<canvas></canvas><script>
window.bridge = { platform: { sendMessage(m) { return Promise.resolve(m); } } };
setTimeout(() => { window.bridge.platform.sendMessage('game_ready'); }, 300);
</script>`;
  const g = packagedGame(id, { gameCfg: { covers: { settleMs: 100, steps: [{ waitMs: 100 }] } } });
  fs.writeFileSync(`${g.dist}/index.html`, page);
  // re-package with the real page
  const zip = g.zip;
  const z = zipDirectory(g.dist, zip);
  const sha256 = sha256File(zip);
  S.commit(id, [{ type: 'release.packaged', data: { zip, sha256, files: z.files, bytes: z.bytes, validation: { ok: true }, results: [], tag: 'v1.0.0' } }]);
  const r = await C.makeCovers(id, { playwrightFrom: /** @type {string} */ (REAL) });
  assert.equal(r.manifest.readySignal, 'game_ready');
  for (const [slot, [w, h]] of Object.entries(SIZES)) {
    const buf = fs.readFileSync(`${C.coversDir(id)}/${slot}.png`);
    assert.deepEqual(C.pngSize(buf), { w, h });
    assert.ok(buf.length > 1000);
  }
  writePacket(id, coverPaths(id), sha256);
  assert.equal(G.preparePublication(id).mode, 'PUBLICATION_PREPARED');
});

after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });
