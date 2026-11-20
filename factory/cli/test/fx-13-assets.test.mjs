// @ts-check
/**
 * FX-13 — asset flow fixes: acquire keeps a consistent library when the index write-back fails (catalog lines last,
 * write-back best effort), `assets pull` refuses denylisted ids/authors and pulls a verified acquired pack (effective
 * verification from PACK.json), `assets stats` per source / per pack, `--help` for every assets subcommand and every
 * agent, the index schema version in sync / sources / doctor. Network-free.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isolatedEnv, fakePng, writeFixture } from './helpers/fx-12-env.mjs';

const TMP = isolatedEnv('fx13a');
const LIB = `${TMP}/library`;
const { assetsCommand } = await import('../lib/assets.mjs');
const I = await import('../lib/asset-index.mjs');
const { decide } = await import('../lib/guard.mjs');
const { assetIndexRows } = await import('../lib/doctor.mjs');

const dir = `${TMP}/fixture`;
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(`${dir}/hero.png`, fakePng(40, 30));
fs.writeFileSync(`${dir}/coin.png`, fakePng(8, 8));
fs.writeFileSync(`${dir}/gem.png`, fakePng(16, 16));
const base = { license: 'CC0-1.0', page_url: 'https://example.org/p', tags: 'test' };
writeFixture([
  { ...base, item_id: 'hero', member: 'hero.png', title: 'Hero', author: 'Ann', locator: { file: 'hero.png' } },
  { ...base, item_id: 'coin', member: 'coin.png', title: 'Coin', author: 'Ann', locator: { file: 'coin.png' } },
  { ...base, item_id: 'gem', member: 'gem.png', title: 'Gem', author: 'Rip Per', locator: { file: 'gem.png' } },
]);
const syncOut = await assetsCommand(['sync', 'fixture'], {});
const catalog = () => fs.readFileSync(`${LIB}/catalog/catalog.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

/** A registered game whose task T-1 is IN_PROGRESS in worktree `${TMP}/wt/g/T-1` (snapshot + one event). */
function fakeGame() {
  const gdir = `${TMP}/state/games/g`;
  const wt = `${TMP}/wt/g/T-1`;
  fs.mkdirSync(gdir, { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(`${gdir}/events.jsonl`, `${JSON.stringify({ seq: 1, ts: 'x', type: 'game.registered', actor: 't', data: {} })}\n`);
  fs.writeFileSync(`${gdir}/state.json`, JSON.stringify({ id: 'g', lastSeq: 1, tasks: { 'T-1': { status: 'IN_PROGRESS', worktree: wt } } }));
  return wt;
}

test('sync, sources and doctor state the index schema version', async () => {
  assert.match(syncOut, new RegExp(`^index: .+ \\(schema v${I.SCHEMA_VERSION}\\)\\nfixture: 3 item\\(s\\)`));
  assert.match(await assetsCommand(['sources'], {}), new RegExp(`\\(schema v${I.SCHEMA_VERSION}\\)`));
  const row = assetIndexRows({ root: LIB, fallback: true }).find((r) => r.item === 'Remote asset index');
  assert.match(String(row?.detail), new RegExp(`\\(schema v${I.SCHEMA_VERSION}\\), updated`));
});

test('acquire: a failed index write-back (SQLITE_BUSY) keeps pack and catalog consistent and warns', async () => {
  const { DatabaseSync } = /** @type {any} */ (process.getBuiltinModule('node:sqlite'));
  const other = new DatabaseSync(I.indexFile());
  other.exec('BEGIN IMMEDIATE'); // a concurrent writer (e.g. `assets sync`) holds the index write lock
  let out;
  try { out = await assetsCommand(['acquire', 'fixture:hero/hero.png'], {}); } finally { other.exec('ROLLBACK'); other.close(); }
  assert.match(out, /^WARNING: measured sizes were not written back to the index \(.*(locked|busy).*\); the pack is kept\./i);
  assert.match(out, /Acquired 1 file\(s\) into fixture\/hero/);
  assert.ok(fs.existsSync(`${LIB}/packs/fixture/hero/hero.png`));
  assert.deepEqual(catalog().map((e) => e.id), ['fixture/hero/hero.png'], 'catalog line written after the pack');
  assert.match(await assetsCommand(['acquire', 'fixture:hero/hero.png'], {}), /already in the library as pack fixture\/hero/);
});

test('acquire: a failure before the catalog step leaves neither pack nor catalog line', async () => {
  fs.mkdirSync(`${LIB}/packs/fixture/coin-taken`, { recursive: true });
  await assert.rejects(assetsCommand(['acquire', 'fixture:coin/coin.png'], { 'pack-as': 'fixture/coin-taken' }), /already exists; packs are append-only/);
  fs.rmSync(`${LIB}/packs/fixture/coin-taken`, { recursive: true });
  writeFixture([{ ...base, item_id: 'gone', member: 'gone.png', title: 'Gone', author: 'Ann', locator: { file: 'gone.png' } }]);
  await assetsCommand(['sync', 'fixture'], {});
  await assert.rejects(assetsCommand(['acquire', 'fixture:gone/gone.png'], {}));
  assert.equal(fs.existsSync(`${LIB}/packs/fixture/gone`), false, 'pack removed');
  assert.ok(!catalog().some((e) => e.pack === 'fixture/gone'), 'no catalog line for the removed pack');
});

test('pull: a verified acquired pack pulls (effective verification from PACK.json); denylisted ids and authors are refused', async () => {
  writeFixture([
    { ...base, item_id: 'coin', member: 'coin.png', title: 'Coin', author: 'Ann', locator: { file: 'coin.png' } },
    { ...base, item_id: 'gem', member: 'gem.png', title: 'Gem', author: 'Rip Per', locator: { file: 'gem.png' } },
  ]);
  await assetsCommand(['sync', 'fixture'], {});
  await assetsCommand(['acquire', 'fixture:coin/coin.png', 'fixture:gem/gem.png'], {});
  for (const p of ['fixture/hero', 'fixture/coin', 'fixture/gem']) await assetsCommand(['verify', p], { evidence: 'page_url checked: CC0 statement on the page, original art' });
  assert.equal(catalog().find((e) => e.id === 'fixture/coin/coin.png').provenance.verification, 'declared', 'catalog lines stay append-only');
  assert.equal(JSON.parse(await assetsCommand(['show', 'fixture/coin/coin.png'], {})).provenance.verification, 'verified', 'effective value from PACK.json');
  const wt = fakeGame();
  const flags = { task: 'T-1', game: 'g', 'allow-test-only': true };
  assert.match(await assetsCommand(['pull', 'fixture/coin/coin.png'], flags), /Pulled 1 asset\(s\)/);
  assert.ok(fs.existsSync(`${wt}/public/assets/coin.png`));
  await assetsCommand(['deny', 'fixture:hero'], { reason: 'ripped from a commercial game' });
  await assetsCommand(['deny', 'Rip Per'], { reason: 'author rips sprites', author: true });
  await assert.rejects(assetsCommand(['pull', 'fixture/coin/coin.png', 'fixture/hero/hero.png'], flags),
    /Asset fixture\/hero\/hero\.png is refused: id fixture:hero is denylisted: ripped from a commercial game/);
  assert.equal(fs.existsSync(`${wt}/public/assets/hero.png`), false);
  await assert.rejects(assetsCommand(['pull', 'fixture/gem/gem.png'], flags), /refused: author Rip Per is denylisted/);
});

test('stats: per source and per pack with the verified / declared split', async () => {
  await assetsCommand(['ingest', `${TMP}/fixture`], { source: 'manual', pack: 'm1', license: 'CC0-1.0', author: 'Kim', url: 'https://example.org/m1' });
  const out = await assetsCommand(['stats'], {});
  assert.match(out, /^by source \(packs, files: verified \/ declared\):$/m);
  assert.match(out, /^ {2}fixture\t3 pack\(s\), 3 file\(s\), 3 verified, 0 declared$/m);
  assert.match(out, /^ {2}manual\t1 pack\(s\), 3 file\(s\), 0 verified, 3 declared$/m);
  assert.match(out, /^ {2}fixture\/gem\t1 file\(s\), 1 verified, 0 declared\tCC0-1\.0\tRip Per$/m);
  assert.match(out, /^ {2}manual\/m1\t3 file\(s\), 0 verified, 3 declared\tCC0-1\.0\tKim$/m);
});

test('--help works for every assets subcommand and is allowed for every agent; admin commands stay restricted', async () => {
  for (const sub of [[], ['acquire'], ['sync'], ['reindex'], ['pull'], ['deny']]) {
    assert.match(await assetsCommand([...sub], { help: true }), /^factory assets <cmd>/, sub.join(' '));
  }
  assert.match(await assetsCommand(['search'], { help: true }), /search --remote/);
  const run = (role, args) => decide({ tool_name: 'Bash', agent_id: `a-${role}`, agent_type: role, tool_input: { command: `node factory/cli/factory.mjs ${args}` }, cwd: TMP });
  for (const role of ['game-developer', 'qa-engineer', 'asset-producer']) {
    for (const args of ['assets', 'assets --help', 'assets search --help', 'assets acquire --help', 'assets sync --help', 'assets help', 'assets stats 2>&1']) {
      assert.notEqual(run(role, args).decision, 'deny', `${role}: ${args}`);
    }
  }
  for (const args of ['assets reindex', 'assets sync all', 'assets sync all --help', 'assets acquire fixture:x --help']) {
    assert.equal(run('game-developer', args).decision, 'deny', args);
  }
});
