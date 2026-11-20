// @ts-check
/**
 * FX-10 — remote asset index core: remote zip reader over HTTP Range (stored/deflated/ZIP64, CRC, refusals, directory
 * cache, server without Range), fixture adapter sync + FTS5 ranking and filters, reindex from PACK.json manifests
 * without touching media files, guard classification of the new subcommands, doctor rows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildZip, serve } from './helpers/fx-10-zip.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '../factory.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-fx10-'));
Object.assign(process.env, {
  FACTORY_STATE_DIR: `${TMP}/state`, FACTORY_GAMES_DIR: `${TMP}/games`, FACTORY_WORKTREES_DIR: `${TMP}/wt`,
  FACTORY_INBOX_DIR: `${TMP}/inbox`, FACTORY_ARCHIVE_DIR: `${TMP}/archive`, FACTORY_KEY_PATH: `${TMP}/key/approval.key`,
  FACTORY_CONFIG: `${TMP}/config.json`, GAME_ASSET_LIBRARY: `${TMP}/library`, GAME_ASSET_INDEX: `${TMP}/index/index.sqlite`,
  GAME_ASSET_FIXTURE: `${TMP}/fixture/items.jsonl`,
});
fs.writeFileSync(`${TMP}/config.json`, JSON.stringify({ maxAttempts: 3, packageManager: 'corepack pnpm' }));

const { readRemoteMember } = await import('../lib/remote-zip.mjs');
const { readZipEntries, extractZip } = await import('../lib/zip.mjs');
const I = await import('../lib/asset-index.mjs');
const { getSource, makeContext, syncSource } = await import('../lib/asset-sources/index.mjs');
const { assetsCommand } = await import('../lib/assets.mjs');
const { decide } = await import('../lib/guard.mjs');
const { assetIndexRows } = await import('../lib/doctor.mjs');

const cli = (...args) => spawnSync(process.execPath, [CLI, 'assets', ...args], { env: { ...process.env }, encoding: 'utf8' });
const big = Buffer.from('pixel '.repeat(4000));

test('remote zip: stored, deflated and ZIP64 members over Range; directory cached per url+rev', async () => {
  const plain = buildZip([{ name: 'a/readme.txt', data: 'hello stored' }, { name: 'a/big.txt', data: big, method: 8 }], { comment: 'pack comment' });
  const z64 = buildZip([{ name: 'x.bin', data: 'zip64 body', method: 8 }, { name: 'y.txt', data: 'second' }], { zip64: true });
  fs.writeFileSync(`${TMP}/z64.zip`, z64);
  assert.deepEqual(readZipEntries(`${TMP}/z64.zip`).map((e) => [e.name, e.size]), [['x.bin', 10], ['y.txt', 6]], 'local parser reads ZIP64 too');
  assert.deepEqual(extractZip(`${TMP}/z64.zip`, `${TMP}/z64-out`), ['x.bin', 'y.txt']);
  const s = await serve({ '/p.zip': plain, '/z.zip': z64 });
  try {
    const db = I.openIndex();
    const a = await readRemoteMember(`${s.base}/p.zip`, 'a/readme.txt', { index: db, rev: 'r1' });
    assert.equal(a.data.toString(), 'hello stored');
    assert.equal(a.cachedDirectory, false);
    const before = s.hits['/p.zip'];
    const b = await readRemoteMember(`${s.base}/p.zip`, 'a/big.txt', { index: db, rev: 'r1' });
    assert.ok(b.data.equals(big));
    assert.equal(b.cachedDirectory, true, 'second read uses the cached central directory');
    assert.equal(s.hits['/p.zip'] - before, 2, 'cache hit: only local header + data requests');
    assert.equal((await readRemoteMember(`${s.base}/p.zip`, 'a/readme.txt', { index: db, rev: 'r2' })).cachedDirectory, false, 'new rev re-reads');
    assert.equal((await readRemoteMember(`${s.base}/z.zip`, 'x.bin')).data.toString(), 'zip64 body');
    assert.equal((await readRemoteMember(`${s.base}/z.zip`, 'y.txt')).data.toString(), 'second');
    assert.ok(s.uas.every((u) => u === 'game-factory-asset-index'), 'factory User-Agent');
    db.close();
  } finally { await s.close(); }
});

test('remote zip: refuses corrupt CRC, traversal names, encryption, other methods, oversize members, and 200-without-Range', async () => {
  const bad = buildZip([
    { name: 'crc.txt', data: 'payload', badCrc: true }, { name: '../evil.txt', data: 'x' }, { name: 'enc.txt', data: 'x', flags: 1 },
    { name: 'bz.txt', data: 'x', method: 12 }, { name: 'huge.txt', data: big, method: 8 },
  ]);
  const s = await serve({ '/b.zip': bad });
  const nr = await serve({ '/b.zip': bad }, { range: false });
  try {
    const url = `${s.base}/b.zip`;
    await assert.rejects(readRemoteMember(url, 'crc.txt'), /CRC mismatch/);
    await assert.rejects(readRemoteMember(url, '../evil.txt'), /Unsafe member name/);
    await assert.rejects(readRemoteMember(url, 'enc.txt'), /encrypted/);
    await assert.rejects(readRemoteMember(url, 'bz.txt'), /unsupported compression method 12/);
    await assert.rejects(readRemoteMember(url, 'huge.txt', { maxBytes: 1000 }), /over the 1000-byte cap/);
    await assert.rejects(readRemoteMember(url, 'missing.txt'), /No member "missing.txt"/);
    await assert.rejects(readRemoteMember(`${nr.base}/b.zip`, 'crc.txt'), /ignored the Range request.*HTTP 200 instead of 206/);
    await assert.rejects(readRemoteMember(`${s.base}/none.zip?key=SECRET`, 'a'), (e) => /HTTP 404/.test(e.message) && !/SECRET/.test(e.message));
  } finally { await s.close(); await nr.close(); }
});

const ITEMS = [
  { item_id: 'a1', title: 'Coin pickup', description: 'short blip', type: 'audio', license: 'CC0-1.0', author: 'Ann', pack: 'retro-sfx', duration: 0.4, tags: 'coin,ui' },
  { item_id: 'b2', title: 'Chime', description: 'a coin like chime for menus', type: 'audio', license: 'CC-BY-4.0', author: 'Bob', pack: 'menu-sounds', attribution: 'Chime by Bob' },
  { item_id: 'c3', member: 'tiles/grass.png', title: 'Grass tile', type: 'sprite', license: 'CC0-1.0', author: 'Ann', pack: 'retro-tiles', w: 16, h: 16, locator: { zip_url: 'http://x/p.zip', member: 'tiles/grass.png' } },
  { item_id: 'd4', title: 'Coin share alike', type: 'audio', license: 'CC-BY-SA-4.0' },
  { item_id: 'e5', title: 'Coin gpl', type: 'audio', license: 'GPL-3.0' },
  { item_id: 'f6', title: 'Coin unknown', type: 'audio' },
  { item_id: 'a1', title: 'Coin pickup duplicate', type: 'audio', license: 'CC0-1.0' },
];
const writeFixture = (items) => {
  fs.mkdirSync(path.dirname(String(process.env.GAME_ASSET_FIXTURE)), { recursive: true });
  fs.writeFileSync(String(process.env.GAME_ASSET_FIXTURE), items.map((x) => JSON.stringify(x)).join('\n') + '\nnot json\n');
};

test('fixture sync: disallowed licenses dropped and counted; FTS ranking; filters; re-sync replaces rows', async () => {
  writeFixture(ITEMS);
  const db = I.openIndex();
  const r = await syncSource(db, getSource('fixture'), makeContext({ index: db }));
  assert.equal(r.count, 3);
  assert.deepEqual(r.dropped, { 'license:CC-BY-SA-4.0': 1, 'license:GPL-3.0': 1, 'license:missing': 1, duplicate: 1, invalid: 1 });
  const coin = I.searchIndex(db, { text: 'coin' });
  assert.deepEqual(coin.hits.map((h) => h.id), ['fixture:a1', 'fixture:b2'], 'title hit beats description hit');
  assert.deepEqual(I.searchIndex(db, { text: 'coin', license: 'cc0' }).hits.map((h) => h.id), ['fixture:a1']);
  assert.deepEqual(I.searchIndex(db, { type: 'sprite' }).hits.map((h) => h.id), ['fixture:c3/tiles/grass.png']);
  assert.deepEqual(I.searchIndex(db, { pack: 'retro' }).hits.map((h) => h.id).sort(), ['fixture:a1', 'fixture:c3/tiles/grass.png']);
  assert.equal(I.searchIndex(db, { source: 'other' }).total, 0);
  assert.deepEqual(I.searchIndex(db, { author: 'bob' }).hits.map((h) => h.id), ['fixture:b2']);
  assert.deepEqual(I.searchIndex(db, { tags: 'ui' }).hits.map((h) => h.id), ['fixture:a1']);
  assert.deepEqual(I.searchIndex(db, { text: 'coin grass' }).hits.map((h) => h.id).sort(), ['fixture:a1', 'fixture:b2', 'fixture:c3/tiles/grass.png'], 'no AND hit -> any word');
  assert.equal(I.searchIndex(db, { text: '" OR * NEAR(' }).total, 0, 'FTS operators are quoted as words, not injected (no syntax error)');
  assert.deepEqual(I.getItem(db, 'fixture:c3/tiles/grass.png').locator, { zip_url: 'http://x/p.zip', member: 'tiles/grass.png' });
  const rev1 = r.rev;
  writeFixture([{ item_id: 'z9', title: 'New coin', type: 'audio', license: 'MIT', attribution: 'x' }]);
  const r2 = await syncSource(db, getSource('fixture'), makeContext({ index: db }));
  assert.notEqual(r2.rev, rev1);
  assert.deepEqual(I.searchIndex(db, {}).hits.map((h) => h.id), ['fixture:z9'], 'old rows replaced');
  assert.equal(I.sourceStates(db).fixture.count, 1);
  db.close();
});

test('CLI: sync, sources, search --remote, show <source:item>; clean output (no ExperimentalWarning)', () => {
  writeFixture(ITEMS);
  const sy = cli('sync', 'fixture');
  assert.equal(sy.status, 0, sy.stderr);
  assert.match(sy.stdout, /fixture: 3 item\(s\), rev [0-9a-f]{12}; dropped/);
  assert.equal(sy.stderr, '');
  const src = cli('sources');
  assert.match(src.stdout, /fixture\t.*3 item\(s\), 5 dropped/);
  const se = cli('search', '--remote', '--text', 'coin', '--type', 'audio');
  assert.equal(se.stderr, '');
  assert.deepEqual(se.stdout.trim().split('\n'), [
    '2 matching item(s) in the remote index (grouped by item; --files for one line per file)',
    'id\ttype\tlicense\ttitle\tfile\tformats\tsize\tpack / author',
    'fixture:a1\taudio 0.4s\tCC0-1.0\tCoin pickup\t-\t1 file(s)\t?\tretro-sfx / Ann',
    'fixture:b2\taudio\tCC-BY-4.0\tChime\t-\t1 file(s)\t?\tmenu-sounds / Bob',
  ]);
  assert.match(cli('search', '--remote', '--type', 'sprite').stdout, /fixture:c3\/tiles\/grass\.png\tsprite 16x16\tCC0-1.0\tGrass tile/);
  const sh = cli('show', 'fixture:c3/tiles/grass.png');
  assert.equal(JSON.parse(sh.stdout).locator.member, 'tiles/grass.png');
  assert.match(cli('show', 'fixture:nope').stderr, /Unknown remote asset fixture:nope/);
  assert.match(cli('search', '--type', 'sprite').stdout, /^0 match\(es\) in /, 'library search unchanged');
});

test('reindex rebuilds catalog.jsonl from PACK.json entries only; never opens, stats or hashes media files', async () => {
  const lib = String(process.env.GAME_ASSET_LIBRARY);
  const src = `${TMP}/ingest-src`;
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(`${src}/hero.png`, Buffer.from('89504e470d0a1a0a0000000d4948445200000010000000200806000000', 'hex'));
  fs.writeFileSync(`${src}/jump.ogg`, 'OggS fake');
  await assetsCommand(['ingest', src], { source: 'kenney', pack: 'p1', license: 'CC0-1.0', author: 'Kenney', url: 'https://kenney.nl/p1' });
  const manifest = JSON.parse(fs.readFileSync(`${lib}/packs/kenney/p1/PACK.json`, 'utf8'));
  assert.equal(manifest.files.length, 2);
  assert.equal(manifest.fileCount, 2);
  // An old-style pack (count only) and its catalog line.
  fs.mkdirSync(`${lib}/packs/old/p0`, { recursive: true });
  fs.writeFileSync(`${lib}/packs/old/p0/PACK.json`, JSON.stringify({ source: 'old', pack: 'p0', license: 'CC0-1.0', files: 1 }));
  fs.writeFileSync(`${lib}/packs/old/p0/a.png`, 'x');
  fs.appendFileSync(`${lib}/catalog/catalog.jsonl`, JSON.stringify({ id: 'old/p0/a.png', pack: 'old/p0', file: 'packs/old/p0/a.png', type: 'sprite' }) + '\n');
  // Media files become unreadable (directories); a spy records every media access.
  for (const f of ['hero.png', 'jump.ogg']) { fs.rmSync(`${lib}/packs/kenney/p1/${f}`); fs.mkdirSync(`${lib}/packs/kenney/p1/${f}`); }
  const touched = [];
  const spied = ['readFileSync', 'openSync', 'statSync', 'lstatSync', 'createReadStream', 'readdirSync'];
  const orig = Object.fromEntries(spied.map((k) => [k, fs[k]]));
  for (const k of spied) fs[k] = (p, ...rest) => { if (/\.(png|ogg)$/i.test(String(p))) touched.push(`${k} ${p}`); return orig[k].call(fs, p, ...rest); };
  let out;
  try { out = await assetsCommand(['reindex'], {}); } finally { Object.assign(fs, orig); }
  assert.deepEqual(touched, [], 'no media file was opened, stat-ed or listed');
  assert.match(out, /reindexed 3 assets from 1 pack manifest\(s\)\n1 pack\(s\) need re-ingest .*: old\/p0/);
  const cat = fs.readFileSync(`${lib}/catalog/catalog.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(cat.filter((e) => e.pack === 'kenney/p1'), manifest.files);
  assert.deepEqual(cat.filter((e) => e.pack === 'old/p0').map((e) => e.id), ['old/p0/a.png'], 'old pack lines kept');
});

test('guard: sources/search --remote/show for every subagent; sync/acquire/preview/find-live for asset-producer only; index writes refused', () => {
  const run = (command, type) => decide({ tool_name: 'Bash', agent_id: `a-${type}`, agent_type: type, tool_input: { command }, cwd: TMP });
  for (const c of ['assets sources', 'assets search --remote --text coin', 'assets show fixture:a1']) {
    for (const t of ['game-developer', 'code-reviewer', 'asset-producer']) assert.equal(run(`node factory/cli/factory.mjs ${c}`, t).decision, null, `${t}: ${c}`);
  }
  for (const c of ['assets sync all', 'assets acquire fixture:a1 --pack-as x/y', 'assets preview fixture:a1 --out a.png', 'assets find-live coin']) {
    assert.equal(run(`node factory/cli/factory.mjs ${c}`, 'asset-producer').decision, null, c);
    assert.match(run(`node factory/cli/factory.mjs ${c}`, 'game-developer').reason || '', /Only the orchestrator may run/, c);
  }
  const idx = `${path.dirname(String(process.env.GAME_ASSET_INDEX))}/index.sqlite`;
  assert.match(decide({ tool_name: 'Write', tool_input: { file_path: idx }, cwd: TMP }).reason || '', /written only by the factory CLI/);
  assert.match(run('echo x > .cache/asset-index/index.sqlite', 'asset-producer').reason || '', /written only by the factory CLI/);
  assert.match(run(`cp a.sqlite "${idx}"`, 'asset-producer').reason || '', /written only by the factory CLI/);
});

test('doctor: library mount warning and index presence/age/source counts', () => {
  const missing = assetIndexRows({ root: `${TMP}/no-drive`, fallback: false }, `${TMP}/none.sqlite`);
  assert.equal(missing[0].ok, 'warn');
  assert.match(missing[1].detail, /not built yet/);
  const ok = assetIndexRows({ root: TMP, fallback: false });
  assert.equal(ok[0].ok, true);
  assert.match(ok[1].detail, /updated \d+\.\d day\(s\) ago; fixture=3/);
});
