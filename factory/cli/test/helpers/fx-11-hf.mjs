// @ts-check
/**
 * FX-11 test helpers (moved out of fx-11.test.mjs for ENG-12): a Hugging Face mimic (API + resolve/<sha> 302 redirect
 * to a Range-capable CDN) and the CC0 dataset fixture (metadata, archive_index.csv, shards).
 */
import http from 'node:http';
import zlib from 'node:zlib';
import { buildZip } from './fx-10-zip.mjs';
import { httpFetch } from '../../lib/asset-sources/http.mjs';
import { csvSpelling } from '../../lib/asset-sources/oga-hf-util.mjs';

export const SHA = '0123456789abcdef0123456789abcdef01234567';
export const SHA4 = 'fedcba9876543210fedcba9876543210fedcba98';

export const zst = (records) => zlib.zstdCompressSync(Buffer.from(records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n'));
export const csvOf = (rows) => '"Archive","Filename"\n' + rows.map(([a, f]) => `"${a}","${f.replace(/"/g, '""')}"`).join('\n') + '\n';
export const oga = (slug, o) => ({
  url: `https://opengameart.org/content/${slug}`, title: slug, author: 'Ann', author_url: 'https://opengameart.org/users/ann', post_date: 'Wednesday, July 4, 2018 - 06:34',
  art_type: '2D Art', tags: ['Coin', 'UI'], licenses: ['CC0'], collections: [], preview_images: [`https://opengameart.org/sites/default/files/${slug}.png`], description: `About ${slug}`,
  files: [], ...o,
});
export const file = (name) => ({ url: `https://opengameart.org/sites/default/files/${encodeURIComponent(name)}`, name, size: '1 Kb' });

/**
 * HF mimic: `/api/datasets/<repo>` (sha + siblings), `/datasets/<repo>/resolve/<rev>/<file>` -> 302 -> CDN with Range.
 * @param {{ repo: string, sha: string, files: Record<string, Buffer>, apiExtra?: object }[]} repos
 */
export async function hfMimic(repos) {
  const hfSeen = /** @type {{ url: string, auth: string }[]} */ ([]);
  const cdnSeen = /** @type {{ url: string, auth: string }[]} */ ([]);
  const cdn = http.createServer((req, res) => {
    cdnSeen.push({ url: String(req.url), auth: String(req.headers.authorization || '') });
    const [, , repo, rev, ...rest] = String(req.url).split('/');
    const r = repos.find((x) => x.repo === repo);
    const buf = r && rev === r.sha ? r.files[decodeURIComponent(rest.join('/'))] : undefined;
    if (!buf) { res.writeHead(404).end(); return; }
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (!m) { res.writeHead(200, { 'content-length': buf.length }).end(buf); return; }
    const start = m[1] === '' ? Math.max(0, buf.length - Number(m[2])) : Number(m[1]);
    const end = m[1] === '' || m[2] === '' ? buf.length - 1 : Math.min(Number(m[2]), buf.length - 1);
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${buf.length}`, 'content-length': end - start + 1 }).end(buf.subarray(start, end + 1));
  });
  await new Promise((r) => cdn.listen(0, '127.0.0.1', () => r(undefined)));
  const cdnBase = `http://127.0.0.1:${/** @type {any} */ (cdn.address()).port}`;
  const hf = http.createServer((req, res) => {
    const url = String(req.url);
    hfSeen.push({ url, auth: String(req.headers.authorization || '') });
    const api = /^\/api\/datasets\/nyuuzyou\/([^/]+)$/.exec(url);
    const r1 = api && repos.find((x) => x.repo === api[1]);
    if (r1) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sha: r1.sha, gated: false, siblings: Object.keys(r1.files).map((rfilename) => ({ rfilename })), ...r1.apiExtra }));
      return;
    }
    const rz = /^\/datasets\/nyuuzyou\/([^/]+)\/resolve\/([^/]+)\/(.+)$/.exec(url);
    if (rz) { res.writeHead(302, { location: `${cdnBase}/blob/${rz[1]}/${rz[2]}/${rz[3]}` }).end(); return; }
    res.writeHead(404).end();
  });
  await new Promise((r) => hf.listen(0, '127.0.0.1', () => r(undefined)));
  const hfBase = `http://127.0.0.1:${/** @type {any} */ (hf.address()).port}`;
  return {
    hfSeen, cdnSeen,
    /** fetch that sends https://huggingface.co requests to the mimic */
    fetch: (/** @type {string} */ url, /** @type {any} */ opts) => httpFetch(url.replace('https://huggingface.co', hfBase), { retries: 0, ...opts }),
    close: () => Promise.all([new Promise((r) => hf.close(r)), new Promise((r) => cdn.close(r))]),
  };
}

// ---------------------------------------------------------------- CC0 dataset fixture (archive_index.csv path)
export const SHARD_2D = buildZip([
  { name: 'hero.png', data: 'PNG hero' }, { name: 'Cañon.png', data: 'PNG canon', method: 8 }, { name: 'shared.png', data: 'PNG shared' }, { name: 'shared.1.png', data: 'PNG shared' },
  { name: 'a.png', data: 'PNG a' }, { name: 'b.png', data: 'PNG b' }, { name: 'sa.png', data: 'x' }, { name: 'mism.png', data: 'x' }, { name: 'gpl.png', data: 'x' }, { name: 'tex.png', data: 'x' },
]);
export const SHARD_SFX = buildZip([
  { name: 'coin.ogg', data: 'OggS coin', method: 8 }, { name: 'sfx pack.zip', data: 'PK pack' }, { name: 'bad.ogg', data: 'OggS bad', badCrc: true },
]);
export const CC0_RECORDS = {
  '2D_Art': [
    oga('hero-sheet', { title: 'Hero "sheet"', files: [file('hero.png'), file('notes.txt'), file('hero.blend'), file('ghost.png'), { url: 'https://opengameart.org/sites/default/files/..%2Fevil.png', name: 'evil.png' }] }),
    oga('dual-sa', { licenses: ['CC0', 'CC-BY-SA 3.0'], files: [file('sa.png')] }),
    oga('wrong-license', { licenses: ['CC-BY 4.0'], files: [file('mism.png')] }),
    oga('gpl-thing', { licenses: ['GPL 3.0'], files: [file('gpl.png')] }),
    oga('canon', { title: 'Cañon', files: [file('Cañon.png')] }),
    oga('shared-one', { files: [file('shared.png')] }),
    oga('shared-two', { files: [file('shared.png')] }),
    oga('two-files', { title: 'Letters', tags: ['abc'], files: [file('a.png'), file('b.png')] }),
    oga('no-files-usable', { files: [file('only.psd')] }),
    '{ not json',
    { title: 'no url', files: [] },
  ],
  Sound_Effect: [
    oga('coin-sfx', { art_type: 'Sound Effect', title: 'Coin pickup', files: [file('coin.ogg')] }),
    oga('sfx-pack', { art_type: 'Sound Effect', title: 'SFX pack', files: [file('sfx pack.zip')] }),
    oga('broken-sfx', { art_type: 'Sound Effect', title: 'Broken', files: [file('bad.ogg')] }),
  ],
};
export const CC0_FILES = () => ({
  '2D_Art.jsonl.zst': zst(CC0_RECORDS['2D_Art']), 'Sound_Effect.jsonl.zst': zst(CC0_RECORDS.Sound_Effect),
  'Document.jsonl.zst': Buffer.from('must never be requested'),
  'archive_index.csv': Buffer.from(csvOf([
    ['2D_Art_00.zip', 'hero.png'], ['2D_Art_00.zip', csvSpelling('Cañon.png')], ['2D_Art_00.zip', 'shared.png'], ['2D_Art_00.zip', 'shared.1.png'],
    ['2D_Art_00.zip', 'a.png'], ['2D_Art_00.zip', 'b.png'], ['2D_Art_00.zip', 'sa.png'], ['2D_Art_00.zip', 'mism.png'], ['2D_Art_00.zip', 'gpl.png'],
    ['Sound_Effect_00.zip', 'coin.ogg'], ['Sound_Effect_00.zip', 'sfx pack.zip'], ['Sound_Effect_00.zip', 'bad.ogg'],
  ])),
  '2D_Art_00.zip': SHARD_2D, 'Sound_Effect_00.zip': SHARD_SFX,
});
