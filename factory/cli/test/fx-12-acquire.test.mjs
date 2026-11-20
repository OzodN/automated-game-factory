// @ts-check
/**
 * FX-12 — `assets acquire` end to end against a local Range server + the fixture adapter: provenance per file,
 * append-only packs, idempotence per remote id, denylist, a nested pack zip admitted file by file, traversal refused,
 * executables under media names refused, CC-BY attribution required, --max-mb bounds, index write-back; guard
 * classification of the new subcommands.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildZip, serve } from './helpers/fx-10-zip.mjs';
import { isolatedEnv, fakePng, writeFixture, tree } from './helpers/fx-12-env.mjs';

const TMP = isolatedEnv('fx12a');
const LIB = `${TMP}/library`;
const { assetsCommand } = await import('../lib/assets.mjs');
const I = await import('../lib/asset-index.mjs');
const { packSlug } = await import('../lib/asset-acquire.mjs');
const { decide } = await import('../lib/guard.mjs');

const inner = buildZip([
  { name: 'sprites/a.png', data: fakePng(16, 8), method: 8 }, { name: 'sfx/b.ogg', data: 'OggS b' }, { name: 'LICENSE.txt', data: 'CC0' },
  { name: 'tool.exe', data: 'MZ...' }, { name: '__MACOSX/sprites/._a.png', data: 'x' }, { name: 'sprites/fake.png', data: 'MZ disguised' },
]);
const evil = buildZip([{ name: 'ok.png', data: fakePng(1, 1) }, { name: '../escape.png', data: fakePng(1, 1) }]);
const SHARD = buildZip([
  { name: 'hero.png', data: fakePng(40, 30) }, { name: 'coin.ogg', data: 'OggS coin', method: 8 }, { name: 'pack.zip', data: inner },
  { name: 'evil.zip', data: evil }, { name: 'con.png', data: fakePng(2, 2) }, { name: 'tune.ogg', data: 'OggS tune' }, { name: 'big.ogg', data: Buffer.alloc(3000, 1) },
]);
const s = await serve({ '/shard.zip': SHARD });
test.after(() => s.close());
const loc = (member) => ({ zip_url: `${s.base}/shard.zip`, member });
const base = { license: 'CC0-1.0', author: 'Ann', description: 'test item', tags: 'test' };
writeFixture([
  { ...base, item_id: 'hero-sheet', member: 'hero.png', title: 'Hero', page_url: 'https://example.org/hero', locator: loc('hero.png') },
  { ...base, item_id: 'coin-sfx', member: 'coin.ogg', title: 'Coin', page_url: 'https://example.org/coin', locator: loc('coin.ogg') },
  { ...base, item_id: 'big-pack', member: 'pack.zip', title: 'Big pack', page_url: 'https://example.org/pack', locator: loc('pack.zip') },
  { ...base, item_id: 'evil-pack', member: 'evil.zip', title: 'Evil', locator: loc('evil.zip') },
  { ...base, item_id: 'Con Item!', member: 'con.png', title: 'Con', author: 'Rip Per', locator: loc('con.png') },
  { ...base, item_id: 'by-tune', member: 'tune.ogg', title: 'Tune', license: 'CC-BY-4.0', author: 'Bob', attribution: '"Tune" by Bob, CC-BY-4.0', page_url: 'https://example.org/tune', locator: loc('tune.ogg') },
  { ...base, item_id: 'by-bare', member: 'tune.ogg', title: 'Bare', license: 'CC-BY-4.0', author: 'Bob', locator: loc('tune.ogg') },
  { ...base, item_id: 'big-file', member: 'big.ogg', title: 'Big', locator: loc('big.ogg') },
]);
await assetsCommand(['sync', 'fixture'], {});
const pack = (key) => JSON.parse(fs.readFileSync(`${LIB}/packs/${key}/PACK.json`, 'utf8'));
const catalog = () => fs.readFileSync(`${LIB}/catalog/catalog.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('acquire one member: pack from the item slug, per-file provenance, catalog line, index write-back', async () => {
  const out = await assetsCommand(['acquire', 'fixture:hero-sheet/hero.png'], {});
  assert.match(out, /Acquired 1 file\(s\) into fixture\/hero-sheet \(license CC0-1\.0, verification: declared\)/);
  assert.match(out, /Next: open https:\/\/example\.org\/hero, confirm the license.*assets verify fixture\/hero-sheet/s);
  const p = pack('fixture/hero-sheet');
  assert.equal(p.verification, 'declared');
  assert.equal(p.files.length, 1);
  const e = p.files[0];
  assert.equal(e.id, 'fixture/hero-sheet/hero.png');
  assert.equal(e.sha256.length, 64);
  assert.equal(e.bytes, fakePng(40, 30).length);
  assert.deepEqual([e.w, e.h], [40, 30]);
  assert.equal(e.url, 'https://example.org/hero');
  assert.deepEqual(e.provenance, {
    source: 'fixture', remote_id: 'fixture:hero-sheet/hero.png', member: null, page_url: 'https://example.org/hero',
    source_rev: e.provenance.source_rev, license: 'CC0-1.0', author: 'Ann', attribution: null, verification: 'declared',
  });
  assert.match(e.provenance.source_rev, /^[0-9a-f]{12}$/, 'pinned source revision');
  assert.deepEqual(catalog().map((c) => c.id), ['fixture/hero-sheet/hero.png'], 'catalog line appended like ingest');
  assert.deepEqual(tree(`${LIB}/_quarantine`), [], 'quarantine removed');
  const db = I.openIndex();
  try {
    const row = I.getItem(db, 'fixture:hero-sheet/hero.png');
    assert.deepEqual([row.w, row.h, row.bytes, row.bytes_approx], [40, 30, e.bytes, false], 'measured values written back');
  } finally { db.close(); }
});

test('acquire is idempotent per remote id and packs are append-only', async () => {
  const again = await assetsCommand(['acquire', 'fixture:hero-sheet/hero.png'], {});
  assert.match(again, /already in the library as pack fixture\/hero-sheet \(not downloaded again\)/);
  const hits = s.hits['/shard.zip'];
  await assetsCommand(['acquire', 'fixture:hero-sheet'], {});
  assert.equal(s.hits['/shard.zip'], hits, 'no download for an id already in the library (item id expands to its members)');
  await assert.rejects(assetsCommand(['acquire', 'fixture:coin-sfx/coin.ogg'], { 'pack-as': 'fixture/hero-sheet' }), /Pack fixture\/hero-sheet already exists; packs are append-only/);
  assert.equal(catalog().length, 1);
});

test('nested pack zip: extracted in quarantine, media admitted file by file, docs kept uncatalogued, executables refused', async () => {
  const out = await assetsCommand(['acquire', 'fixture:big-pack/pack.zip'], {});
  assert.match(out, /Acquired 2 file\(s\) into fixture\/big-pack/);
  assert.match(out, /Rejected 3: fixture:big-pack\/pack\.zip!/);
  assert.deepEqual(tree(`${LIB}/packs/fixture/big-pack`), ['LICENSE.txt', 'PACK.json', 'sfx/b.ogg', 'sprites/a.png']);
  const p = pack('fixture/big-pack');
  assert.deepEqual(p.files.map((f) => [f.id, f.provenance.member, f.provenance.remote_id]).sort(), [
    ['fixture/big-pack/sfx/b.ogg', 'sfx/b.ogg', 'fixture:big-pack/pack.zip'], ['fixture/big-pack/sprites/a.png', 'sprites/a.png', 'fixture:big-pack/pack.zip'],
  ]);
  assert.deepEqual(p.files.find((f) => f.ext === 'png') && [p.files.find((f) => f.ext === 'png').w, p.files.find((f) => f.ext === 'png').h], [16, 8]);
  assert.deepEqual(p.rejected.map((r) => r.split('!')[1]).sort(), ['__MACOSX/sprites/._a.png', 'sprites/fake.png', 'tool.exe']);
  const db = I.openIndex();
  try { assert.equal(I.getItem(db, 'fixture:big-pack/pack.zip').bytes, inner.length, 'zip row gets its exact archive size'); } finally { db.close(); }
});

test('traversal inside a fetched zip refuses the whole acquire and leaves nothing behind', async () => {
  await assert.rejects(assetsCommand(['acquire', 'fixture:evil-pack/evil.zip'], {}), /Unsafe entry name in archive: \.\.\/escape\.png/);
  assert.ok(!fs.existsSync(`${LIB}/packs/fixture/evil-pack`));
  assert.ok(!fs.existsSync(`${TMP}/library/packs/escape.png`) && !fs.existsSync(`${TMP}/library/escape.png`));
  assert.deepEqual(tree(`${LIB}/_quarantine`), []);
});

test('denylist: deny by author and by id; search and acquire skip them', async () => {
  await assert.rejects(assetsCommand(['deny', 'Rip Per'], {}), /--reason is required/);
  assert.match(await assetsCommand(['deny', 'rip per', '--reason'], { reason: 'ripped sprites from a commercial game' }), /Denylisted author rip per/);
  assert.match(await assetsCommand(['deny', 'fixture:coin-sfx'], { reason: 'license changed on the live page' }), /Denylisted id fixture:coin-sfx/);
  assert.match(await assetsCommand(['deny', 'fixture:coin-sfx'], { reason: 'again, same thing' }), /already denylisted/);
  const lines = fs.readFileSync(`${LIB}/catalog/denylist.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.kind, l.value]), [['author', 'rip per'], ['id', 'fixture:coin-sfx']]);
  await assert.rejects(assetsCommand(['acquire', 'fixture:Con Item!/con.png'], {}), /Refused fixture:Con Item!\/con\.png: author rip per is denylisted: ripped sprites/);
  await assert.rejects(assetsCommand(['acquire', 'fixture:coin-sfx/coin.ogg'], {}), /id fixture:coin-sfx is denylisted/);
  const found = await assetsCommand(['search'], { remote: true, limit: '100' });
  assert.ok(!/coin-sfx|Con Item/.test(found), found);
  assert.match(found, /hero-sheet/);
});

test('CC-BY needs attribution text; packs never mix licenses; --max-mb bounds and warning', async () => {
  await assert.rejects(assetsCommand(['acquire', 'fixture:by-bare/tune.ogg'], {}), /is CC-BY-4\.0 but has no attribution text/);
  await assert.rejects(assetsCommand(['acquire', 'fixture:by-tune/tune.ogg', 'fixture:big-file/big.ogg'], { 'pack-as': 'mixed/one' }), /would mix licenses/);
  const out = await assetsCommand(['acquire', 'fixture:by-tune/tune.ogg'], {});
  assert.match(out, /Acquired 1 file/);
  const e = pack('fixture/by-tune').files[0];
  assert.equal(e.attribution, '"Tune" by Bob, CC-BY-4.0');
  assert.equal(e.provenance.attribution, '"Tune" by Bob, CC-BY-4.0');
  for (const v of ['0', '257', 'x']) await assert.rejects(assetsCommand(['acquire', 'fixture:big-file/big.ogg'], { 'max-mb': v }), /--max-mb must be a number in 1\.\.256/);
  const big = await assetsCommand(['acquire', 'fixture:big-file/big.ogg'], { 'max-mb': '100' });
  assert.match(big, /WARNING: --max-mb 100 raises the per-member cap\. A shipped file must stay <= 10 MB \(AS-08\) and audio must be converted.*\(AS-06\)/);
  await assert.rejects(assetsCommand(['acquire', 'nope:x/y.png'], {}), /Unknown remote asset nope:x\/y\.png/);
  await assert.rejects(assetsCommand(['acquire', 'fixture/hero-sheet/hero.png'], {}), /is not a remote index id/);
  await assert.rejects(assetsCommand(['acquire', 'fixture:hero-sheet/hero.png'], { 'pack-as': '../x' }), /--pack-as must be <source>\/<pack>/);
});

test('reserved device names are renamed on acquire; pack slugs; verify marks the per-file provenance', async () => {
  assert.equal(packSlug('Con Item!'), 'con-item');
  assert.equal(packSlug('---'), 'item');
  fs.rmSync(`${LIB}/catalog/denylist.jsonl`);
  await assetsCommand(['acquire', 'fixture:Con Item!/con.png'], {});
  assert.deepEqual(pack('fixture/con-item').files.map((f) => f.file), ['packs/fixture/con-item/con_.png']);
  await assetsCommand(['verify', 'fixture/con-item'], { evidence: 'page checked: CC0 statement on the item page' });
  const p = pack('fixture/con-item');
  assert.equal(p.verification, 'verified');
  assert.equal(p.files[0].provenance.verification, 'verified');
  assert.equal(p.testOnly, true, 'packs from the fixture source are test-only');
});

test('guard: acquire, preview and deny are asset-producer commands', () => {
  const run = (role, cmd) => decide({ tool_name: 'Bash', agent_id: `a-${role}`, agent_type: role, tool_input: { command: cmd }, cwd: TMP });
  for (const sub of ['acquire oga-cc0:x/y.png', 'preview oga-cc0:x/y.png --out /tmp/a.png', 'deny someone --reason because']) {
    assert.equal(run('asset-producer', `node factory/cli/factory.mjs assets ${sub}`).decision, null, sub);
    assert.equal(run('game-developer', `node factory/cli/factory.mjs assets ${sub}`).decision, 'deny', sub);
  }
});
