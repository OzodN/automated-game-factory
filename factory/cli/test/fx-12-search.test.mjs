// @ts-check
/**
 * FX-12 — search quality and FX-11 follow-ups: grouped results (best member, formats, file count) and the stated
 * tie-break, the per-file view, OGA size labels -> approximate bytes, absolute preview URLs, item titles, exact sizes
 * from cached shard directories, the collision plain-name fallback, CC-BY attribution on every row, Windows reserved
 * names, the metadata decompression cap, probed values kept across a re-sync, and the Drive cache doctor row.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isolatedEnv } from './helpers/fx-12-env.mjs';
import { zst, oga, file, hfMimic, CC0_FILES, CC0_RECORDS, SHA } from './helpers/fx-11-hf.mjs';

const TMP = isolatedEnv('fx12s');
const I = await import('../lib/asset-index.mjs');
const O = await import('../lib/asset-sources/oga-hf.mjs');
const { getSource, makeContext, syncSource } = await import('../lib/asset-sources/index.mjs');
const { remoteSearchCommand } = await import('../lib/asset-remote.mjs');
const { assetsCommand } = await import('../lib/assets.mjs');
const { driveCacheRow, parseRegContentCache } = await import('../lib/doctor.mjs');

const row = (id, over) => ({ id: `s:${id}`, item_id: id.split('/')[0], title: 'Coin', description: 'a coin sound', tags: ['coin'], type: 'audio', ext: id.split('.').pop(), license: 'CC0-1.0', author: 'Ann', attribution: null, page_url: null, preview_urls: [], locator: null, bytes: null, w: null, h: null, duration: null, pack: null, post_date: null, ...over });

test('grouped search: one hit per item, best member first, formats + count; tie-break cc0 before by, then smaller bytes', () => {
  const db = I.openIndex({ file: `${TMP}/g/index.sqlite` });
  try {
    I.replaceSource(db, 's', 'r1', [
      row('by/a.wav', { license: 'CC-BY-4.0', attribution: 'x', bytes: 10 }), row('by/a.flac', { license: 'CC-BY-4.0', attribution: 'x', bytes: 1 }),
      row('by/a.mp3', { license: 'CC-BY-4.0', attribution: 'x', bytes: 5 }), row('by/a.ogg', { license: 'CC-BY-4.0', attribution: 'x', bytes: 9 }),
      row('big/b.ogg', { bytes: 5000 }), row('small/c.mp3', { bytes: 50 }), row('unknown/d.ogg'),
      row('bell/e.ogg', { title: 'Bell', description: 'ding', tags: ['coin'] }),
      row('sprites/s.zip', { type: 'pack', title: 'Coin sprites', description: 'x', tags: ['x'] }), row('sprites/s.jpg', { type: 'sprite', title: 'Coin sprites', description: 'x', tags: ['x'] }),
      row('sprites/s.png', { type: 'sprite', title: 'Coin sprites', description: 'x', tags: ['x'] }),
    ]);
    const g = I.searchIndex(db, { text: 'coin', group: true, type: 'audio' });
    assert.equal(g.total, 5, 'five audio items');
    assert.deepEqual(g.hits.map((h) => h.id), ['s:small/c.mp3', 's:big/b.ogg', 's:unknown/d.ogg', 's:by/a.ogg', 's:bell/e.ogg'],
      'equal bm25: cc0 first, smaller bytes first, unknown size last; then the attribution item; a tags-only hit ranks lower');
    const by = g.hits.find((h) => h.item_id === 'by');
    assert.deepEqual([by.files, by.formats], [4, ['ogg', 'mp3', 'wav', 'flac']], 'ogg > mp3 > wav > flac');
    const sp = I.searchIndex(db, { text: 'sprites', group: true }).hits[0];
    assert.deepEqual([sp.id, sp.formats], ['s:sprites/s.png', ['png', 'jpg', 'zip']], 'single files before archives, png > jpg');
    assert.equal(I.searchIndex(db, { text: 'coin' }).total, 11, 'flat view counts files');
    const denied = I.searchIndex(db, { text: 'coin', group: true, deny: { ids: ['s:by', 's:big/b.ogg'], authors: [] } });
    assert.ok(!denied.hits.some((h) => ['by', 'big'].includes(h.item_id)), 'denied item id and member id are skipped');
    assert.equal(I.searchIndex(db, { text: 'coin', group: true, deny: { ids: [], authors: ['ann'] } }).total, 0, 'author deny is case-insensitive');
  } finally { db.close(); }
});

test('CLI output: grouped by default with formats column, --files per file, help states the ranking rule', async () => {
  const db = I.openIndex();
  I.replaceSource(db, 's', 'r1', [row('it/x.ogg', { bytes: 30720, bytes_approx: true }), row('it/x.mp3', { bytes: 2048 })]);
  db.close();
  const out = await remoteSearchCommand({ text: 'coin' });
  const lines = out.split('\n');
  assert.match(lines[0], /^1 matching item\(s\) in the remote index \(grouped by item; --files for one line per file\)$/);
  assert.equal(lines[1], 'id\ttype\tlicense\ttitle\tfile\tformats\tsize\tpack / author');
  assert.equal(lines[2], 's:it/x.ogg\taudio\tCC0-1.0\tCoin\tx.ogg\t2 file(s): ogg,mp3\t~30 KB\tAnn', 'best member ogg even though the mp3 is smaller');
  const files = (await remoteSearchCommand({ text: 'coin', files: true })).split('\n');
  assert.match(files[0], /^2 matching file\(s\) in the remote index \(per file\)$/);
  assert.equal(files[2], 's:it/x.mp3\taudio\tCC0-1.0\tCoin\tx.mp3\t2 KB\tAnn', 'per file: equal bm25, smaller bytes first');
  const help = await assetsCommand(['search'], { help: true });
  assert.match(help, /ranking: bm25 \(weights: title 10, tags 4, author 2, pack 2, description 1\); ties: more query words in title > tags > description, then CC0-like before attribution licenses, then smaller bytes/);
  assert.match(await assetsCommand(['help'], {}), /acquire <remote-id\.\.\.> \[--pack-as <source>\/<pack>\] \[--max-mb n<=256\]/);
});

test('pure helpers: size labels, preview URLs, reserved device names, metadata cap', () => {
  assert.deepEqual(['30 Kb', '1.2 Mb', '2 Gb', '512 bytes', '7 B', '1,5 Mb', null, 'big', ''].map(O.parseHumanSize), [30720, 1258291, 2147483648, 512, 7, 1572864, null, null, null]);
  assert.equal(O.previewUrl('/sites/default/files/a.png'), 'https://opengameart.org/sites/default/files/a.png');
  assert.equal(O.previewUrl('//opengameart.org/x.png'), 'https://opengameart.org/x.png');
  assert.equal(O.previewUrl('http://opengameart.org/x.png'), 'https://opengameart.org/x.png');
  assert.equal(O.previewUrl('https://cdn.example/x.png'), 'https://cdn.example/x.png');
  assert.equal(O.previewUrl('javascript:alert(1)'), null);
  for (const [i, o] of [['CON', 'CON_'], ['con.png', 'con_.png'], ['Nul.tar.gz', 'Nul_.tar.gz'], ['COM1.ogg', 'COM1_.ogg'], ['lpt9', 'lpt9_'], ['aux.', 'aux_'],
    ['console.png', 'console.png'], ['com10.png', 'com10.png'], ['prn_x.png', 'prn_x.png']]) assert.equal(O.safeFileName(i), o, i);
  const blob = zst(Array.from({ length: 200 }, (_, k) => ({ k, pad: 'x'.repeat(100) })));
  assert.equal(O.parseJsonlZst(blob).length, 200);
  assert.throws(() => O.parseJsonlZst(blob, 1000), /Metadata file decompresses to more than 0 MB; refused/);
  assert.equal(O.MAX_METADATA_BYTES, 256 * 1024 * 1024);
  assert.throws(() => O.parseJsonlZst(Buffer.from('not zstd')), /could not be decompressed/);
});

test('oga sync: item titles, approximate bytes from labels, plain-name collision fallback, exact sizes once a shard dir is cached', async () => {
  const files = CC0_FILES();
  files['2D_Art.jsonl.zst'] = zst([...CC0_RECORDS['2D_Art'], oga('shared-three', { files: [file('shared.png')] }), oga('rel-preview', { preview_images: ['/sites/default/files/p.png'], files: [file('a.png')] })]);
  const hf = await hfMimic([{ repo: 'OpenGameArt-CC0', sha: SHA, files }]);
  const db = I.openIndex({ file: `${TMP}/oga/index.sqlite` });
  try {
    const ctx = makeContext({ index: db, fetch: hf.fetch });
    const a = getSource('oga-cc0');
    await syncSource(db, a, ctx);
    const two = I.getItem(db, 'oga-cc0:two-files/a.png');
    assert.deepEqual([two.title, I.getItem(db, 'oga-cc0:two-files/b.png').title], ['Letters', 'Letters'], 'one title per item');
    const hero = I.getItem(db, 'oga-cc0:hero-sheet/hero.png');
    assert.deepEqual([hero.bytes, hero.bytes_approx], [1024, true], '"1 Kb" label -> ~1024 bytes');
    // 3rd reference to shared.png: the dataset has no shared.2.png, so the plain name is used (same bytes).
    assert.equal(I.getItem(db, 'oga-cc0:shared-three/shared.png').locator.member, 'shared.png');
    assert.deepEqual(I.getItem(db, 'oga-cc0:rel-preview/a.png').preview_urls, ['https://opengameart.org/sites/default/files/p.png']);
    await a.fetch(hero, `${TMP}/dl`, ctx);
    await syncSource(db, a, ctx);
    const exact = I.getItem(db, 'oga-cc0:hero-sheet/hero.png');
    assert.deepEqual([exact.bytes, exact.bytes_approx, typeof exact.locator.crc32], [8, false, 'number'], 'cached shard directory gives exact size + crc');
  } finally { db.close(); await hf.close(); }
});

test('every CC-BY row carries its attribution text', async () => {
  const shard = (await import('./helpers/fx-10-zip.mjs')).buildZip([{ name: 'a.png', data: 'A' }, { name: 'b.ogg', data: 'B' }]);
  const recs = [oga('one', { title: 'One', author: 'Dee', licenses: ['CC-BY 4.0'], files: [file('a.png'), file('b.ogg')] }), oga('two', { title: 'Two', author: null, licenses: ['CC-BY 4.0'], files: [file('b.ogg')] })];
  const hf = await hfMimic([{ repo: 'OpenGameArt-CC-BY-4.0', sha: SHA, files: { '2D_Art.jsonl.zst': zst(recs), '2D_Art_00.zip': shard } }]);
  const db = I.openIndex({ file: `${TMP}/by/index.sqlite` });
  try {
    await syncSource(db, getSource('oga-cc-by-4'), makeContext({ index: db, fetch: hf.fetch }));
    const rows = db.prepare("SELECT id, attribution FROM items WHERE license LIKE 'CC-BY%'").all();
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => typeof r.attribution === 'string' && r.attribution.includes('licensed CC-BY-4.0')), JSON.stringify(rows));
  } finally { db.close(); await hf.close(); }
});

test('probed w/h/duration survive a re-sync unless the exact bytes changed', () => {
  const db = I.openIndex({ file: `${TMP}/carry/index.sqlite` });
  try {
    I.replaceSource(db, 's', 'r1', [row('k/a.ogg', { bytes: 100 }), row('k/b.png', { type: 'sprite', bytes: 5 })]);
    assert.equal(I.updateMedia(db, 's:k/a.ogg', { duration: 1.25, bytes: 100 }), true);
    I.updateMedia(db, 's:k/b.png', { w: 4, h: 2 });
    assert.equal(I.updateMedia(db, 's:missing', { w: 1 }), false);
    I.replaceSource(db, 's', 'r2', [row('k/a.ogg', { bytes: 100 }), row('k/b.png', { type: 'sprite', bytes: 6 })]);
    assert.equal(I.getItem(db, 's:k/a.ogg').duration, 1.25);
    assert.equal(I.getItem(db, 's:k/b.png').w, null, 'exact size changed -> measurements dropped');
  } finally { db.close(); }
});

test('doctor: Drive cache volume from the registry value, %LOCALAPPDATA% fallback, warning under 10 GB', () => {
  const reg = '\r\nHKEY_CURRENT_USER\\Software\\Google\\DriveFS\r\n    ContentCachePath    REG_SZ    D:\\progs\\google\\drivefs\r\n\r\n';
  assert.equal(parseRegContentCache(reg), 'D:\\progs\\google\\drivefs');
  assert.equal(parseRegContentCache('    ContentCachePath    REG_EXPAND_SZ    %LOCALAPPDATA%\\X', { LOCALAPPDATA: 'C:\\L' }), 'C:\\L\\X');
  assert.equal(parseRegContentCache('ERROR: not found'), null);
  const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
  const low = driveCacheRow({ platform: 'win32', env, registryPath: 'D:\\progs\\google\\drivefs', exists: () => true, freeGb: () => 4 });
  assert.equal(low?.ok, 'warn');
  assert.match(low?.detail || '', /^D:\\progs\\google\\drivefs \(registry ContentCachePath\): 4 GB free \(< 10 GB\)$/);
  assert.equal(low?.action, 'Drive for desktop → Settings → Advanced → Local cached files directory → a folder on a volume with free space');
  const seen = [];
  const ok = driveCacheRow({ platform: 'win32', env, registryPath: null, exists: () => true, freeGb: (p) => { seen.push(p); return 50; } });
  assert.equal(ok?.ok, true);
  assert.match(String(seen[0]), /Google[\\/]DriveFS$/, 'fallback: %LOCALAPPDATA%\\Google\\DriveFS volume');
  assert.match(ok?.detail || '', /%LOCALAPPDATA%\\Google\\DriveFS\): 50 GB free$/);
  assert.equal(driveCacheRow({ platform: 'win32', env, registryPath: null, exists: () => false, freeGb: () => 1 }), null, 'no Drive for desktop -> no row');
  assert.equal(driveCacheRow({ platform: 'linux', registryPath: 'x', freeGb: () => 1 }), null, 'non-Windows -> skipped');
});
