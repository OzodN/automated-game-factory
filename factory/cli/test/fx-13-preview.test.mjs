// @ts-check
/**
 * FX-13 — `assets preview` fixes: contact sheets are never blank whatever the source PNG is (palette, alpha, gray,
 * 16-bit, odd sizes; every cell's pixel variance is checked), the legend names the source of each cell (`file` vs
 * `page preview`, file dims when known), small image members are previewed from the file itself, and preview downloads
 * are host-restricted and streamed with a byte cap. Network-free (local fixture server, fake fetch).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { serve } from './helpers/fx-10-zip.mjs';
import { isolatedEnv, writeFixture } from './helpers/fx-12-env.mjs';
import { FORMATS, patternPng, cellStdev, imageStdev } from './helpers/fx-13-img.mjs';

const TMP = isolatedEnv('fx13p');
const ok = (bin) => spawnSync(bin, ['-version'], { encoding: 'utf8' }).status === 0;
const SKIP = ok('ffmpeg') && ok('ffprobe') ? false : 'ffmpeg/ffprobe not on PATH: assets preview cannot run here (install ffmpeg to run these tests)';

const { assetsCommand } = await import('../lib/assets.mjs');
const I = await import('../lib/asset-index.mjs');
const { previewHostAllowed, downloadPreview } = await import('../lib/asset-preview.mjs');
const { findFont, LABEL_STRIP } = await import('../lib/asset-media.mjs');

const STRIP = findFont() ? LABEL_STRIP : 0;
const SIZES = [[37, 23], [300, 7], [5, 5], [64, 200], [33, 33], [129, 64], [8, 3]];

test('contact sheet of PNGs in every pixel format is not blank (each cell has pixel variance)', { skip: SKIP }, async () => {
  const src = `${TMP}/fmt`;
  fs.mkdirSync(src, { recursive: true });
  FORMATS.forEach((f, i) => patternPng(`${src}/${String(i).padStart(2, '0')}-${f}.png`, f, SIZES[i][0], SIZES[i][1]));
  await assetsCommand(['ingest', src], { source: 'test', pack: 'fmt', license: 'CC0-1.0', author: 'Ann', url: 'https://example.org/fmt' });
  const out = `${TMP}/out/fmt.png`;
  const cols = 4;
  await assetsCommand(['preview', 'test/fmt'], { out, cols: String(cols), size: '64' });
  const legend = fs.readFileSync(`${TMP}/out/fmt.legend.txt`, 'utf8').trim().split('\n');
  assert.equal(legend.length, FORMATS.length, legend.join('\n'));
  assert.ok(legend.every((l) => /\timage\t\d+x\d+ \(file\)$/.test(l)), legend.join('\n'));
  assert.ok(imageStdev(out) > 10, 'the whole sheet has contrast');
  const order = legend.map((l) => l.split('\t')[1]);
  for (const [i, id] of order.entries()) {
    const sd = cellStdev(out, i, { cols, w: 64, h: 64, strip: STRIP });
    assert.ok(sd > 8, `cell ${i + 1} (${id}) is not flat: stdev ${sd.toFixed(2)}`);
  }
});

test('remote images: small member previewed from the file, large one from the page preview, off-host preview refused', { skip: SKIP }, async () => {
  process.env.FACTORY_TEST_PREVIEW_HOSTS = '127.0.0.1';
  const dir = `${TMP}/fixture`;
  fs.mkdirSync(dir, { recursive: true });
  patternPng(`${dir}/small.png`, 'pal8', 37, 23);
  patternPng(`${TMP}/page.png`, 'rgba', 64, 48);
  const s = await serve({ '/page.png': fs.readFileSync(`${TMP}/page.png`) });
  try {
    const base = { license: 'CC0-1.0', author: 'Ann', page_url: 'https://example.org/x', preview_urls: [`${s.base}/page.png`] };
    writeFixture([
      { ...base, item_id: 'small', member: 'small.png', title: 'Small', bytes: 900, locator: { file: 'small.png' } },
      { ...base, item_id: 'big', member: 'big.png', title: 'Big', bytes: 5 * 1024 * 1024, w: 2048, h: 1024, locator: { file: 'missing.png' } },
      { ...base, item_id: 'evil', member: 'evil.zip', type: 'pack', title: 'Evil', preview_urls: ['https://evil.example.com/p.png'], locator: { file: 'none.zip' } },
    ]);
    await assetsCommand(['sync', 'fixture'], {});
    const out = `${TMP}/out/remote.png`;
    await assetsCommand(['preview', 'fixture:small/small.png', 'fixture:big/big.png', 'fixture:evil/evil.zip'], { out, cols: '3', size: '64' });
    const legend = fs.readFileSync(`${TMP}/out/remote.legend.txt`, 'utf8').trim().split('\n');
    assert.equal(legend[0], '1\tfixture:small/small.png\timage\t37x23 (file)');
    assert.equal(legend[1], '2\tfixture:big/big.png\timage\tpage preview 64x48 (file 2048x1024)');
    assert.match(legend[2], /^3\tfixture:evil\/evil\.zip\timage\t\t\(fetch failed: preview host refused: https:\/\/evil\.example\.com\/p\.png/);
    assert.equal(s.hits['/page.png'], 1, 'the page preview is fetched only for the large member');
    for (const i of [0, 1]) assert.ok(cellStdev(out, i, { cols: 3, w: 64, h: 64, strip: STRIP }) > 8, `cell ${i + 1} not flat`);
    const db = I.openIndex();
    try {
      const small = I.getItem(db, 'fixture:small/small.png');
      assert.deepEqual([small.w, small.h], [37, 23], 'the fetched member was measured and written back');
      assert.deepEqual([I.getItem(db, 'fixture:big/big.png').w], [2048], 'page preview dims never overwrite the file dims');
    } finally { db.close(); }
  } finally {
    await s.close();
    delete process.env.FACTORY_TEST_PREVIEW_HOSTS;
  }
});

test('preview host allow-list: opengameart.org + subdomains and the HF hub/CDN over https only; test override', () => {
  const env = {};
  for (const u of ['https://opengameart.org/sites/a.png', 'https://www.opengameart.org/a.png', 'https://huggingface.co/x', 'https://cdn-lfs.hf.co/x', 'https://cas-bridge.xethub.hf.co/x']) {
    assert.equal(previewHostAllowed(u, env), true, u);
  }
  for (const u of ['http://opengameart.org/a.png', 'https://evilopengameart.org/a.png', 'https://opengameart.org.evil.com/a.png', 'https://127.0.0.1:8080/a.png', 'file:///etc/passwd', 'nonsense']) {
    assert.equal(previewHostAllowed(u, env), false, u);
  }
  assert.equal(previewHostAllowed('http://127.0.0.1:8080/a.png', { FACTORY_TEST_PREVIEW_HOSTS: '127.0.0.1' }), true);
});

/** Fake fetch: a sequence of responses; records urls. @param {(url: string) => Response} make */
function fakeCtx(make) {
  const urls = [];
  return { urls, fetch: async (/** @type {string} */ url) => { urls.push(url); return make(url); } };
}

/** A body of `n` chunks of `size` bytes that counts how many chunks were pulled. @param {number} n @param {number} size */
function chunked(n, size) {
  const stat = { pulled: 0 };
  const body = new ReadableStream({
    pull(c) { if (stat.pulled >= n) { c.close(); return; } stat.pulled++; c.enqueue(new Uint8Array(size).fill(7)); },
  });
  return { body, stat };
}

test('preview download: streamed with a byte cap (aborted early, partial file removed), content-length checked, redirects re-checked', async () => {
  const dest = `${TMP}/dl.png`;
  const big = chunked(100, 1000);
  const a = fakeCtx(() => new Response(big.body, { status: 200 }));
  await assert.rejects(downloadPreview(a, 'https://opengameart.org/p.png', dest, 2500), /preview image over 2500 bytes/);
  assert.ok(big.stat.pulled <= 5, `stopped at the cap, pulled ${big.stat.pulled} of 100 chunks`);
  assert.equal(fs.existsSync(dest), false, 'partial file removed');

  const b = fakeCtx(() => new Response('x'.repeat(10), { status: 200, headers: { 'content-length': '999999' } }));
  await assert.rejects(downloadPreview(b, 'https://opengameart.org/p.png', dest, 2500), /over 2500 bytes/);

  const c = fakeCtx(() => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/p.png' } }));
  await assert.rejects(downloadPreview(c, 'https://opengameart.org/p.png', dest), /preview host refused: https:\/\/evil\.example\.com\/p\.png/);
  assert.deepEqual(c.urls, ['https://opengameart.org/p.png'], 'the off-host redirect target is never fetched');

  const d = fakeCtx((u) => (u.includes('/p.png') ? new Response(null, { status: 301, headers: { location: '/files/q.png' } }) : new Response('PNGDATA', { status: 200 })));
  assert.equal(await downloadPreview(d, 'https://opengameart.org/p.png', dest), dest);
  assert.deepEqual(d.urls, ['https://opengameart.org/p.png', 'https://opengameart.org/files/q.png']);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'PNGDATA');

  await assert.rejects(downloadPreview(fakeCtx(() => new Response('x')), 'https://example.org/p.png', dest), /preview host refused/);
});
