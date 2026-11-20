// @ts-check
/**
 * FX-12 — `assets preview`: a labelled contact sheet for images (library files and a remote preview image), waveforms
 * with duration / loudness / peak for audio (a remote member fetched over Range), a legend next to the png, write-back of
 * the measured duration into the index, temp files removed, nothing written into the library. Needs ffmpeg + ffprobe:
 * the tests are skipped with a clear message when they are missing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { buildZip, serve } from './helpers/fx-10-zip.mjs';
import { isolatedEnv, writeFixture, tree } from './helpers/fx-12-env.mjs';

const TMP = isolatedEnv('fx12p');
process.env.FACTORY_TEST_PREVIEW_HOSTS = '127.0.0.1'; // test-only override of the preview host allow-list (FX-13)
const LIB = `${TMP}/library`;
const ok = (bin) => spawnSync(bin, ['-version'], { encoding: 'utf8' }).status === 0;
const SKIP = ok('ffmpeg') && ok('ffprobe') ? false : 'ffmpeg/ffprobe not on PATH: assets preview cannot run here (install ffmpeg to run these tests)';

const { assetsCommand } = await import('../lib/assets.mjs');
const I = await import('../lib/asset-index.mjs');
const { parseEbur128 } = await import('../lib/asset-media.mjs');
const { imageSize } = await import('../lib/game.mjs');

/** @param {string[]} args */
const ff = (args) => assert.equal(spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]).status, 0, args.join(' '));

test('ebur128 summary parsing', () => {
  const text = 'noise\n  Summary:\n\n  Integrated loudness:\n    I:         -18.5 LUFS\n    Threshold: -28.6 LUFS\n\n  True peak:\n    Peak:       -1.2 dBFS\n';
  assert.deepEqual(parseEbur128(text), { lufs: -18.5, peak: -1.2 });
  assert.deepEqual(parseEbur128('nothing'), { lufs: null, peak: null });
});

test('preview: image contact sheet + audio waveforms, legend, index write-back, no library writes', { skip: SKIP }, async () => {
  const src = `${TMP}/src`;
  fs.mkdirSync(src, { recursive: true });
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=40x30', '-frames:v', '1', `${src}/red.png`]);
  ff(['-f', 'lavfi', '-i', 'color=c=blue:s=20x60', '-frames:v', '1', `${src}/blue.png`]);
  ff(['-f', 'lavfi', '-i', 'sine=f=440:d=0.5', `${src}/beep.wav`]);
  await assetsCommand(['ingest', src], { source: 'test', pack: 'p1', license: 'CC0-1.0', author: 'Ann', url: 'https://example.org/p1' });
  const remotePng = fs.readFileSync(`${src}/red.png`);
  const s = await serve({ '/preview.png': remotePng, '/shard.zip': buildZip([{ name: 'tone.wav', data: fs.readFileSync(`${src}/beep.wav`) }]) });
  try {
    writeFixture([
      { item_id: 'pic', member: 'pic.zip', type: 'pack', title: 'Pic pack', license: 'CC0-1.0', preview_urls: [`${s.base}/preview.png`], locator: { zip_url: `${s.base}/shard.zip`, member: 'none.zip' } },
      { item_id: 'tone', member: 'tone.wav', title: 'Tone', license: 'CC0-1.0', locator: { zip_url: `${s.base}/shard.zip`, member: 'tone.wav' } },
    ]);
    await assetsCommand(['sync', 'fixture'], {});
    const before = tree(LIB);
    const out = `${TMP}/out/sheet.png`;
    const msg = await assetsCommand(['preview', 'test/p1', 'fixture:pic/pic.zip', 'fixture:tone/tone.wav'], { out, cols: '2', size: '64' });
    assert.deepEqual(tree(LIB), before, 'nothing written into the library');
    assert.deepEqual(tree(`${TMP}/preview-cache`), [], 'temp files removed');
    assert.ok(fs.existsSync(out), msg);
    const dims = imageSize(out);
    assert.ok(dims && dims.w >= 2 * 64 && dims.h >= 2 * 64, `2 columns x 2 rows of 64 px cells: ${JSON.stringify(dims)}`);
    assert.ok(fs.existsSync(`${TMP}/out/sheet.audio.png`), 'waveform sheet next to the image sheet');
    const legend = fs.readFileSync(`${TMP}/out/sheet.legend.txt`, 'utf8').trim().split('\n');
    assert.equal(legend.length, 5);
    assert.match(legend[0], /^1\ttest\/p1\/beep\.wav\taudio\t0\.50 s, -?\d+\.\d LUFS, peak -?\d+\.\d dBTP$/);
    assert.ok(legend.some((l) => /^\d\ttest\/p1\/red\.png\timage\t40x30 \(file\)$/.test(l)), legend.join('\n'));
    assert.ok(legend.some((l) => /^\d\tfixture:pic\/pic\.zip\timage\tpage preview 40x30 \(file dims unknown\)$/.test(l)), legend.join('\n'));
    const tone = legend.find((l) => l.includes('fixture:tone/tone.wav')) || '';
    assert.match(tone, /\taudio\t0\.50 s, /);
    const n = tone.split('\t')[0].padStart(2, '0');
    assert.ok(fs.existsSync(`${TMP}/out/sheet.wave-${n}.png`), 'per-item waveform png');
    const db = I.openIndex();
    try {
      assert.equal(I.getItem(db, 'fixture:tone/tone.wav').duration, 0.5, 'duration written back to the index row');
      assert.equal(I.getItem(db, 'fixture:pic/pic.zip').w, null, 'a preview image does not describe the archive');
    } finally { db.close(); }
  } finally { await s.close(); }
});

test('preview refuses outputs inside the library or a game, and unknown ids', { skip: SKIP }, async () => {
  await assert.rejects(assetsCommand(['preview', 'test/p1'], { out: `${LIB}/x.png` }), /must not be inside the asset library, a game or a worktree/);
  await assert.rejects(assetsCommand(['preview', 'test/p1'], { out: `${TMP}/games/g/x.png` }), /must not be inside/);
  await assert.rejects(assetsCommand(['preview', 'test/p1'], { out: `${TMP}/x.jpg` }), /--out <file\.png> is required/);
  await assert.rejects(assetsCommand(['preview', 'nope/none'], { out: `${TMP}/x.png` }), /Unknown library asset or pack nope\/none/);
  await assert.rejects(assetsCommand(['preview', 'fixture:none'], { out: `${TMP}/x.png` }), /Unknown remote asset fixture:none/);
});
