// @ts-check
/**
 * FX-11 — Hugging Face OpenGameArt adapters (oga-cc0, oga-cc-by-3, oga-cc-by-4), network-free: a local server mimics
 * the HF API and the `resolve/<sha>/<file>` 302 redirect to a Range-capable CDN. Plus the FX-10 follow-ups: literal
 * `%`/`_` in LIKE filters and remote-zip paths that need a separate central-directory / ZIP64-record fetch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildZip, serve } from './helpers/fx-10-zip.mjs';
import { SHA, SHA4, zst, csvOf, oga, file, hfMimic, CC0_FILES } from './helpers/fx-11-hf.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-fx11-'));
process.env.GAME_ASSET_INDEX = `${TMP}/default/index.sqlite`;

const I = await import('../lib/asset-index.mjs');
const { getSource, makeContext, syncSource, SOURCES } = await import('../lib/asset-sources/index.mjs');
const O = await import('../lib/asset-sources/oga-hf.mjs');
const { readRemoteMember, remoteZipDirectory } = await import('../lib/remote-zip.mjs');
const { ZIP_TAIL_BYTES, crc32 } = await import('../lib/zip.mjs');

const TOKEN = 'hf_secret_token_value';

test('pure helpers: cp437 csv spelling, member names, collision names, license ids, post dates, csv parsing', () => {
  assert.equal(O.csvSpelling('Tonton el Cañon.png'), 'Tonton el Ca├▒on.png', 'matches the real archive_index.csv mojibake');
  assert.equal(O.csvSpelling('plain.png'), 'plain.png');
  assert.equal(O.memberFromUrl('https://opengameart.org/sites/default/files/Tonton%20el%20Ca%C3%B1on.png?x=1#y'), 'Tonton el Cañon.png');
  assert.equal(O.memberFromUrl('https://x/%E0%A4%A.png'), '%E0%A4%A.png', 'undecodable names stay raw');
  assert.equal(O.collisionName('walking_elf2.fla_.png', 1), 'walking_elf2.fla_.1.png');
  assert.equal(O.collisionName('noext', 2), 'noext.2');
  assert.deepEqual(['CC0', 'CC-BY 3.0', 'CC-BY 4.0', 'CC-BY-SA 3.0', 'GPL 3.0', 'OGA-BY 3.0', ''].map(O.ogaLicenseToSpdx), ['CC0-1.0', 'CC-BY-3.0', 'CC-BY-4.0', 'CC-BY-SA-3.0', 'GPL-3.0', 'OGA-BY-3.0', null]);
  assert.deepEqual(O.decideLicense(['CC0'], 'CC0-1.0'), { license: 'CC0-1.0' });
  assert.deepEqual(O.decideLicense(['CC0', 'CC-BY 4.0'], 'CC0-1.0'), { license: 'CC0-1.0' }, 'every listed license is allowed');
  assert.deepEqual(O.decideLicense(['CC0', 'CC-BY-SA 3.0'], 'CC0-1.0'), { drop: 'license:CC-BY-SA-3.0' }, 'a dual listing with SA is dropped');
  assert.deepEqual(O.decideLicense(['CC-BY-NC 3.0'], 'CC-BY-3.0'), { drop: 'license:CC-BY-NC-3.0' });
  assert.deepEqual(O.decideLicense(['OGA-BY 3.0'], 'CC-BY-3.0'), { drop: 'license:OGA-BY-3.0' }, 'OGA-BY is not in factory policy');
  assert.deepEqual(O.decideLicense(['CC-BY 4.0'], 'CC-BY-3.0'), { drop: 'license:mismatch' });
  assert.deepEqual(O.decideLicense([], 'CC0-1.0'), { drop: 'license:missing' });
  assert.equal(O.attributionFor('CC0-1.0', { title: 't', author: 'a', page_url: 'u' }), null);
  assert.equal(O.attributionFor('CC-BY-4.0', { title: 'T', author: null, page_url: 'https://u' }), '"T" by unknown author (https://u), licensed CC-BY-4.0');
  assert.equal(O.parsePostDate('Wednesday, July 4, 2018 - 06:34'), '2018-07-04T06:34');
  assert.equal(O.parsePostDate('Monday, April 10, 2023'), '2023-04-10');
  assert.equal(O.parsePostDate('soon'), null);
  assert.equal(O.safeFileName('a:b?c"d.png'), 'a_b_c_d.png');
  assert.equal(O.safeFileName('...'), 'asset');
  const m = O.parseArchiveIndex('"Archive","Filename"\n"A_00.zip","he said ""hi"".png"\r\n"A_01.zip","b.png"\nnot a row\n');
  assert.deepEqual([...m], [['he said "hi".png', 'A_00.zip'], ['b.png', 'A_01.zip']]);
  assert.deepEqual(Object.keys(SOURCES).filter((k) => k.startsWith('oga-')), ['oga-cc0', 'oga-cc-by-3', 'oga-cc-by-4'], 'only the three permissive mirrors are registered');
});

test('oga-cc0: sync from the pinned sha (csv mapping, mojibake names, collisions), drops counted, no Document download', async () => {
  const hf = await hfMimic([{ repo: 'OpenGameArt-CC0', sha: SHA, files: CC0_FILES() }]);
  const db = I.openIndex({ file: `${TMP}/cc0/index.sqlite` });
  try {
    const ctx = makeContext({ index: db, fetch: hf.fetch, env: { HF_TOKEN: TOKEN } });
    const r = await syncSource(db, getSource('oga-cc0'), ctx);
    assert.equal(r.rev, SHA, 'index revision is the pinned dataset commit');
    assert.deepEqual(r.dropped, {
      'file:non-media': 3, 'file:unmapped': 1, 'file:unsafe-name': 1, 'license:CC-BY-SA-3.0': 1, 'license:mismatch': 1, 'license:GPL-3.0': 1,
      'item:no-usable-files': 1, invalid: 2,
    });
    const ids = I.searchIndex(db, {}).hits.map((h) => h.id).sort();
    assert.deepEqual(ids, [
      'oga-cc0:canon/Cañon.png', 'oga-cc0:coin-sfx/coin.ogg', 'oga-cc0:hero-sheet/hero.png', 'oga-cc0:sfx-pack/sfx pack.zip',
      'oga-cc0:shared-one/shared.png', 'oga-cc0:shared-two/shared.1.png', 'oga-cc0:two-files/a.png', 'oga-cc0:two-files/b.png', 'oga-cc0:broken-sfx/bad.ogg',
    ].sort(), 'name collision -> second item maps to shared.1.png; mojibake csv name resolved');
    const hero = I.getItem(db, 'oga-cc0:hero-sheet/hero.png');
    assert.equal(hero.title, 'Hero "sheet"');
    assert.equal(hero.license, 'CC0-1.0');
    assert.equal(hero.attribution, null);
    assert.equal(hero.type, 'sprite');
    assert.equal(hero.author, 'Ann');
    assert.equal(hero.page_url, 'https://opengameart.org/content/hero-sheet');
    assert.deepEqual(hero.preview_urls, ['https://opengameart.org/sites/default/files/hero-sheet.png']);
    assert.equal(hero.post_date, '2018-07-04T06:34');
    assert.deepEqual(hero.tags, ['coin', 'ui']);
    assert.equal(hero.pack, null, 'single-file item has no pack');
    assert.deepEqual(hero.locator, { kind: 'hf-zip-member', repo: 'nyuuzyou/OpenGameArt-CC0', sha: SHA, shard: '2D_Art_00.zip', member: 'hero.png' });
    const two = I.getItem(db, 'oga-cc0:two-files/b.png');
    assert.equal(two.pack, 'Letters');
    assert.equal(two.title, 'Letters', 'every member carries the item title (the file name is the member part of the id)');
    assert.equal(I.getItem(db, 'oga-cc0:sfx-pack/sfx pack.zip').type, 'pack');
    assert.equal(I.getItem(db, 'oga-cc0:canon/Cañon.png').locator.member, 'Cañon.png', 'locator holds the real (UTF-8) zip entry name');
    // Pinned sha: every non-API request is addressed to resolve/<sha>/..., never main; Document metadata is never requested.
    const urls = hf.hfSeen.map((x) => x.url);
    assert.ok(urls.includes('/api/datasets/nyuuzyou/OpenGameArt-CC0'));
    for (const u of urls.filter((x) => !x.startsWith('/api/'))) assert.match(u, new RegExp(`^/datasets/nyuuzyou/OpenGameArt-CC0/resolve/${SHA}/`), u);
    assert.ok(!urls.some((u) => /Document|\/main\//.test(u)));
    assert.ok(hf.hfSeen.every((x) => x.auth === `Bearer ${TOKEN}`), 'HF_TOKEN is sent to the API host');
    assert.deepEqual(hf.cdnSeen.filter((x) => /.zip$/.test(x.url)), [], 'sync reads no shard bytes (metadata + csv only)');
  } finally { db.close(); await hf.close(); }
});

test('oga-cc0: fetch reads the member through the redirect, verifies CRC, keeps the token off the CDN and out of errors', async () => {
  const hf = await hfMimic([{ repo: 'OpenGameArt-CC0', sha: SHA, files: CC0_FILES() }]);
  const db = I.openIndex({ file: `${TMP}/cc0f/index.sqlite` });
  try {
    const ctx = makeContext({ index: db, fetch: hf.fetch, env: { HF_TOKEN: TOKEN } });
    const a = getSource('oga-cc0');
    await syncSource(db, a, ctx);
    const dest = `${TMP}/dl`;
    const p = await a.fetch(I.getItem(db, 'oga-cc0:canon/Cañon.png'), dest, ctx);
    assert.equal(path.basename(p), 'Cañon.png');
    assert.equal(fs.readFileSync(p, 'utf8'), 'PNG canon');
    assert.equal(fs.readFileSync(await a.fetch(I.getItem(db, 'oga-cc0:shared-two/shared.1.png'), dest, ctx), 'utf8'), 'PNG shared');
    assert.equal(fs.readFileSync(await a.fetch(I.getItem(db, 'oga-cc0:coin-sfx/coin.ogg'), dest, ctx), 'utf8'), 'OggS coin');
    assert.ok(hf.cdnSeen.length > 0 && hf.cdnSeen.every((x) => x.auth === ''), 'Authorization is dropped on the cross-origin CDN redirect');
    assert.ok(hf.cdnSeen.every((x) => x.url.includes(`/${SHA}/`)), 'CDN paths carry the pinned sha');
    assert.ok(db.prepare('SELECT count(*) AS n FROM zip_dirs').get().n >= 2, 'shard directories are cached in zip_dirs');
    // CRC failure.
    await assert.rejects(a.fetch(I.getItem(db, 'oga-cc0:broken-sfx/bad.ogg'), dest, ctx), /Corrupt member bad\.ogg \(size or CRC mismatch\)/);
    assert.ok(!fs.existsSync(`${dest}/bad.ogg`), 'nothing written for a corrupt member');
    // Locators are validated: wrong repo, bad sha, bad shard, no locator.
    const good = I.getItem(db, 'oga-cc0:hero-sheet/hero.png');
    for (const patch of [{ repo: 'evil/OpenGameArt-CC0' }, { sha: 'main' }, { shard: '../x.zip' }, { kind: 'url' }, { member: 5 }]) {
      await assert.rejects(a.fetch({ ...good, locator: { ...good.locator, ...patch } }, dest, ctx), /no valid hf-zip-member locator/);
    }
    await assert.rejects(a.fetch({ id: 'x', locator: null }, dest, ctx), /no valid hf-zip-member locator/);
    await assert.rejects(a.fetch({ ...good, locator: { ...good.locator, member: '../evil.png' } }, dest, ctx), /Unsafe member name/);
    await assert.rejects(a.fetch({ ...good, locator: { ...good.locator, member: 'missing.png' } }, dest, ctx), /No member "missing\.png"/);
    // A missing pinned shard: the error never includes the token.
    await assert.rejects(a.fetch({ ...good, locator: { ...good.locator, shard: '2D_Art_09.zip' } }, dest, ctx), (e) => /HTTP 404/.test(e.message) && !e.message.includes(TOKEN));
  } finally { db.close(); await hf.close(); }
});

// ---------------------------------------------------------------- CC-BY-4.0 (no archive_index.csv: shard directories)
test('oga-cc-by-4: no csv -> central directories give shard + crc32/size; CC-BY attribution text; stale locator refused', async () => {
  const shard = buildZip([{ name: 'tune.ogg', data: 'OggS tune', method: 8 }, { name: 'tile.png', data: 'PNG tile' }, { name: 'tune.1.ogg', data: 'OggS tune' }]);
  const records = {
    Music: [
      oga('forest-theme', { title: 'Forest Theme', author: 'Bob', art_type: 'Music', licenses: ['CC-BY 4.0'], post_date: 'Monday, April 10, 2023 - 17:52', files: [file('tune.ogg')] }),
      oga('forest-theme-copy', { title: 'Forest Theme (copy)', author: 'Bob', art_type: 'Music', licenses: ['CC-BY 4.0'], files: [file('tune.ogg')] }),
      oga('third', { licenses: ['CC-BY 3.0'], files: [file('tile.png')] }),
    ],
    '2D_Art': [oga('tiles', { title: 'Tiles', author: 'Cy', licenses: ['CC-BY 4.0', 'CC0'], files: [file('tile.png')] })],
  };
  const files = { 'Music.jsonl.zst': zst(records.Music), '2D_Art.jsonl.zst': zst(records['2D_Art']), 'Music_00.zip': shard, 'Document_00.zip': Buffer.from('never read') };
  const hf = await hfMimic([{ repo: 'OpenGameArt-CC-BY-4.0', sha: SHA4, files }]);
  const db = I.openIndex({ file: `${TMP}/by4/index.sqlite` });
  try {
    const ctx = makeContext({ index: db, fetch: hf.fetch });
    const a = getSource('oga-cc-by-4');
    const r = await syncSource(db, a, ctx);
    assert.equal(r.rev, SHA4);
    assert.deepEqual(r.dropped, { 'license:mismatch': 1 });
    const forest = I.getItem(db, 'oga-cc-by-4:forest-theme/tune.ogg');
    assert.equal(forest.license, 'CC-BY-4.0');
    assert.equal(forest.attribution, '"Forest Theme" by Bob (https://opengameart.org/content/forest-theme), licensed CC-BY-4.0');
    assert.equal(forest.post_date, '2023-04-10T17:52');
    assert.deepEqual(forest.locator, { kind: 'hf-zip-member', repo: 'nyuuzyou/OpenGameArt-CC-BY-4.0', sha: SHA4, shard: 'Music_00.zip', member: 'tune.ogg', crc32: crc32(Buffer.from('OggS tune')), size: 9 });
    assert.equal(forest.bytes, 9);
    assert.equal(I.getItem(db, 'oga-cc-by-4:forest-theme-copy/tune.1.ogg').locator.member, 'tune.1.ogg');
    const tiles = I.getItem(db, 'oga-cc-by-4:tiles/tile.png');
    assert.equal(tiles.locator.shard, 'Music_00.zip', 'the member is found in whichever media shard holds it');
    assert.equal(tiles.attribution, '"Tiles" by Cy (https://opengameart.org/content/tiles), licensed CC-BY-4.0');
    assert.ok(!hf.hfSeen.some((x) => /Document/.test(x.url)) && !hf.cdnSeen.some((x) => /Document/.test(x.url)), 'Document shard/metadata are never read');
    // fetch: ok, then a locator whose crc/size no longer match is refused.
    const out = await a.fetch(forest, `${TMP}/dl4`, ctx);
    assert.equal(fs.readFileSync(out, 'utf8'), 'OggS tune');
    await assert.rejects(a.fetch({ ...forest, locator: { ...forest.locator, crc32: 1 } }, `${TMP}/dl4`, ctx), /no longer matches the CRC\/size/);
    await assert.rejects(a.fetch({ ...forest, locator: { ...forest.locator, size: 10 } }, `${TMP}/dl4`, ctx), /no longer matches the CRC\/size/);
  } finally { db.close(); await hf.close(); }
});

test('oga-cc-by-3: attribution recorded exactly per item; gated or sha-less API answers fail loudly', async () => {
  const shard = buildZip([{ name: 'sword.png', data: 'PNG sword' }]);
  const files = {
    '2D_Art.jsonl.zst': zst([oga('sword', { title: 'Sword', author: 'Dee', licenses: ['CC-BY 3.0'], files: [file('sword.png')] })]),
    'archive_index.csv': Buffer.from(csvOf([['2D_Art_00.zip', 'sword.png']])), '2D_Art_00.zip': shard,
  };
  const hf = await hfMimic([{ repo: 'OpenGameArt-CC-BY-3.0', sha: SHA, files }, { repo: 'OpenGameArt-CC0', sha: 'main', files: {} }]);
  const db = I.openIndex({ file: `${TMP}/by3/index.sqlite` });
  try {
    const ctx = makeContext({ index: db, fetch: hf.fetch });
    const r = await syncSource(db, getSource('oga-cc-by-3'), ctx);
    assert.equal(r.count, 1);
    assert.equal(I.getItem(db, 'oga-cc-by-3:sword/sword.png').attribution, '"Sword" by Dee (https://opengameart.org/content/sword), licensed CC-BY-3.0');
    assert.equal(I.getItem(db, 'oga-cc-by-3:sword/sword.png').license, 'CC-BY-3.0');
    await assert.rejects(syncSource(db, getSource('oga-cc0'), makeContext({ index: db, fetch: hf.fetch })), /returned no commit sha/);
    assert.equal(I.sourceStates(db)['oga-cc0'], undefined, 'a failed sync leaves no source row');
  } finally { db.close(); await hf.close(); }
  const gated = await hfMimic([{ repo: 'OpenGameArt-CC0', sha: SHA, files: {}, apiExtra: { gated: 'manual' } }]);
  const db2 = I.openIndex({ file: `${TMP}/gated/index.sqlite` });
  try {
    await assert.rejects(syncSource(db2, getSource('oga-cc0'), makeContext({ index: db2, fetch: gated.fetch })), /is gated; set HF_TOKEN/);
  } finally { db2.close(); await gated.close(); }
});

// ---------------------------------------------------------------- FX-10 follow-ups
test('search filters treat % and _ literally (pack, author, tags)', async () => {
  const db = I.openIndex({ file: `${TMP}/like/index.sqlite` });
  try {
    const mk = (id, over) => ({ id: `s:${id}`, item_id: id, title: `T ${id}`, description: null, tags: [], type: 'sprite', ext: 'png', license: 'CC0-1.0', author: null, attribution: null, page_url: null, preview_urls: [], locator: null, bytes: null, w: null, h: null, duration: null, pack: null, post_date: null, ...over });
    I.replaceSource(db, 's', 'r1', [
      mk('1', { pack: 'a_b', author: '100%', tags: ['x_y'] }), mk('2', { pack: 'axb', author: '100 percent', tags: ['xzy'] }),
      mk('3', { pack: 'back\\slash', author: 'q', tags: ['50%off'] }),
    ]);
    const ids = (q) => I.searchIndex(db, q).hits.map((h) => h.id).sort();
    assert.deepEqual(ids({ pack: 'a_b' }), ['s:1'], '_ is not a wildcard');
    assert.deepEqual(ids({ pack: '_' }), ['s:1']);
    assert.deepEqual(ids({ author: '%' }), ['s:1'], '% is not a wildcard');
    assert.deepEqual(ids({ author: '100%' }), ['s:1']);
    assert.deepEqual(ids({ tags: 'x_y' }), ['s:1']);
    assert.deepEqual(ids({ tags: '%' }), ['s:3']);
    assert.deepEqual(ids({ pack: 'k\\s' }), ['s:3'], 'backslash is literal');
    assert.deepEqual(ids({ pack: 'AX' }), ['s:2'], 'still case-insensitive substring');
  } finally { db.close(); }
});

test('index file from schema v1 gains the post_date and bytes_approx columns on open', async () => {
  const file = `${TMP}/v1/index.sqlite`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE items (id TEXT PRIMARY KEY, source TEXT NOT NULL, item_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, tags TEXT, type TEXT, ext TEXT, license TEXT NOT NULL, author TEXT, attribution TEXT, page_url TEXT, preview_urls TEXT, locator TEXT, bytes INTEGER, w INTEGER, h INTEGER, duration REAL, pack TEXT, source_rev TEXT, synced_at TEXT)');
  old.close();
  const db = I.openIndex({ file });
  try {
    assert.ok(db.prepare('PRAGMA table_info(items)').all().some((c) => c.name === 'post_date'));
    assert.equal(db.prepare("SELECT v FROM meta WHERE k = 'schema'").get().v, '3');
    assert.ok(db.prepare('PRAGMA table_info(items)').all().some((c) => c.name === 'bytes_approx'), 'v3 adds bytes_approx');
  } finally { db.close(); }
});

const longName = (i) => `dir/${String(i).padStart(5, '0')}-${'long-member-name-'.repeat(4)}.txt`;
const manyMembers = (n) => Array.from({ length: n }, (_, i) => ({ name: longName(i), data: `body ${i}` }));

test('remote zip: central directory larger than the tail window is fetched separately (plain archive)', async () => {
  const members = manyMembers(1200);
  const zip = buildZip(members);
  const s = await serve({ '/big.zip': zip });
  try {
    const url = `${s.base}/big.zip`;
    const dir = await remoteZipDirectory(url);
    assert.equal(dir.entries.length, 1200);
    const cdBytes = dir.entries.reduce((n, e) => n + 46 + Buffer.byteLength(e.name), 0);
    assert.ok(cdBytes > ZIP_TAIL_BYTES, `central directory (${cdBytes} B) exceeds the tail window (${ZIP_TAIL_BYTES} B)`);
    assert.equal(s.hits['/big.zip'], 2, 'tail request + separate central directory request');
    for (const i of [0, 599, 1199]) {
      const before = s.hits['/big.zip'];
      const r = await readRemoteMember(url, longName(i));
      assert.equal(r.data.toString(), `body ${i}`);
      assert.equal(s.hits['/big.zip'] - before, 4, 'tail + central directory + local header + data');
    }
  } finally { await s.close(); }
});

test('remote zip: ZIP64 end record before the tail window is fetched separately, then the central directory', async () => {
  const members = manyMembers(1200);
  const z = buildZip(members, { zip64: true });
  // Layout: ... central dir | zip64 EOCD (56) | zip64 locator (20) | EOCD (22). Pad the ZIP64 record with a 70 KB
  // "extensible data sector" so the locator's target lies before the tail window.
  const end = z.subarray(z.length - 22);
  const loc = z.subarray(z.length - 42, z.length - 22);
  const rec = Buffer.from(z.subarray(z.length - 98, z.length - 42));
  assert.equal(rec.readUInt32LE(0), 0x06064b50);
  const pad = 70000;
  rec.writeBigUInt64LE(BigInt(44 + pad), 4);
  const padded = Buffer.concat([z.subarray(0, z.length - 98), rec, Buffer.alloc(pad, 0x61), loc, end]);
  const s = await serve({ '/z64.zip': padded });
  try {
    const url = `${s.base}/z64.zip`;
    const r = await readRemoteMember(url, longName(777));
    assert.equal(r.data.toString(), 'body 777');
    assert.equal(r.cachedDirectory, false);
    assert.equal(s.hits['/z64.zip'], 5, 'tail + ZIP64 end record + central directory + local header + data');
  } finally { await s.close(); }
});
