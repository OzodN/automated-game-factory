// @ts-check
/**
 * OpenGameArt mirrors on Hugging Face (FX-11): `oga-cc0`, `oga-cc-by-3`, `oga-cc-by-4` (datasets
 * nyuuzyou/OpenGameArt-CC0, -CC-BY-3.0, -CC-BY-4.0). One shared implementation, three configs. SA/GPL/OGA-BY/Mixed
 * datasets are deliberately NOT registered.
 *
 * Dataset layout (verified 2026-11-14, see the FX-11 report):
 *  - metadata: `<Type>.jsonl.zst` at the repo root (zstd JSONL), one record per OGA page with
 *    url, title, author, author_url, post_date, art_type, tags, licenses, collections, preview_images, description,
 *    files[{url,name,size}];
 *  - bytes: shards `<Type>_NN.zip` (~500 members each, flat names, no folders). A member is named after the BASENAME of
 *    `files[].url` (percent-decoded). If two items point at the same URL, the builder stores the later copies as
 *    `stem.1.ext`, `stem.2.ext` (same bytes: it is the same OGA file), so the plain name always exists;
 *  - `archive_index.csv` ("Archive","Filename") maps every member name to its shard (CC0 and CC-BY-3.0 only; CC-BY-4.0 has
 *    none). Its names are mojibake for non-ASCII (UTF-8 bytes read as cp437) while the zip entries are correct UTF-8.
 *
 * Mapping used here: member = decoded URL basename (or its `.N` copy), shard = archive_index.csv lookup (exact name, then
 * the cp437-mojibake name). Datasets without that csv read the central directories of their media shards instead
 * (cached in `zip_dirs`; this also yields crc32 and size for the locator). Everything is built from the PINNED commit sha
 * (`resolve/<sha>/...`), never from `main`, so a later push to the dataset cannot change what an index row points at.
 *
 * Optional env HF_TOKEN (Authorization header; sent to huggingface.co only: the CDN redirect drops it; never logged).
 */
import fs from 'node:fs';
import path from 'node:path';
import { TYPE_BY_EXT } from '../asset-policy.mjs';
import { csvSpelling, memberFromUrl, collisionName, decideLicense, attributionFor, parsePostDate, parseArchiveIndex, parseJsonlZst, safeFileName, parseHumanSize, previewUrl } from './oga-hf-util.mjs';
export { csvSpelling, memberFromUrl, collisionName, ogaLicenseToSpdx, decideLicense, attributionFor, parsePostDate, parseArchiveIndex, MAX_METADATA_BYTES, parseJsonlZst, safeFileName, parseHumanSize, previewUrl } from './oga-hf-util.mjs';
import { readRemoteMember, remoteZipDirectory } from '../remote-zip.mjs';
import { zipDirGet } from '../asset-index.mjs';
import { unsafeEntryName } from '../zip.mjs';
import { FactoryError, ensureDir } from '../core.mjs';
import { safeUrl } from './http.mjs';

export const HF_BASE = 'https://huggingface.co';
/** Metadata files / shard prefixes that are indexed. `Document` (text assets such as names and stories) is skipped. */
export const MEDIA_TYPES = ['2D_Art', '3D_Art', 'Concept_Art', 'Music', 'Sound_Effect', 'Texture'];
const SHARD_RE = /^(?:2D_Art|3D_Art|Concept_Art|Document|Music|Sound_Effect|Texture)_\d+\.zip$/;
const SHA_RE = /^[0-9a-f]{40}$/;
/** Archives (.zip) are kept as `pack` rows: most sound/sprite packs on OGA exist only as a zip. */
const EXTRA_TYPE_BY_EXT = /** @type {Record<string, string>} */ ({ zip: 'pack' });

// ---------------------------------------------------------------- network helpers

/** @param {any} ctx */
function authHeaders(ctx) {
  const t = ctx.token ? ctx.token('HF_TOKEN') : null;
  return t ? { authorization: `Bearer ${t}` } : {};
}

/** @param {any} ctx @param {string} url @returns {Promise<Buffer>} */
async function getBuffer(ctx, url) {
  const res = await ctx.fetch(url, { headers: authHeaders(ctx) });
  if (!res.ok) {
    await res.body?.cancel();
    const e = new FactoryError(`GET ${safeUrl(url)} failed: HTTP ${res.status}${res.status === 401 || res.status === 403 ? ' (set HF_TOKEN if the dataset became gated)' : ''}`);
    /** @type {any} */ (e).status = res.status;
    throw e;
  }
  return Buffer.from(await res.arrayBuffer());
}

const resolveUrl = (repo, sha, file) => `${HF_BASE}/datasets/${repo}/resolve/${sha}/${file}`;

// ---------------------------------------------------------------- adapter

/**
 * @param {{ id: string, repoName: string, spdx: string, title: string }} cfg
 */
export function makeOgaAdapter(cfg) {
  const repo = `nyuuzyou/${cfg.repoName}`;

  /** name -> { shard, crc32?, size? } for every media member of the pinned revision. @param {any} ctx @param {string} sha @param {string[]} files */
  async function memberIndex(ctx, sha, files) {
    /** @type {Map<string, { shard: string, crc32?: number, size?: number }>} */
    const map = new Map();
    if (files.includes('archive_index.csv')) {
      for (const [name, shard] of parseArchiveIndex((await getBuffer(ctx, resolveUrl(repo, sha, 'archive_index.csv'))).toString('utf8'))) {
        if (SHARD_RE.test(shard) && !shard.startsWith('Document_')) map.set(name, { shard });
      }
      fillFromCachedDirs(ctx, sha, map);
      return map;
    }
    // No archive_index.csv in this dataset: read the central directory of each media shard (one ~64 KB tail request each).
    for (const shard of files.filter((f) => SHARD_RE.test(f) && !f.startsWith('Document_')).sort()) {
      const dir = await remoteZipDirectory(resolveUrl(repo, sha, shard), { index: ctx.index || undefined, rev: sha, fetch: ctx.fetch, headers: authHeaders(ctx) });
      for (const e of dir.entries) if (!map.has(e.name)) map.set(e.name, { shard, crc32: e.crc, size: e.size });
    }
    return map;
  }

  /** Exact crc32/size from shard directories already cached in the index (by an earlier fetch); no network. @param {any} ctx @param {string} sha @param {Map<string, any>} map */
  function fillFromCachedDirs(ctx, sha, map) {
    if (!ctx.index) return;
    for (const shard of new Set([...map.values()].map((v) => v.shard))) {
      const dir = zipDirGet(ctx.index, resolveUrl(repo, sha, shard), sha);
      for (const e of dir?.entries || []) {
        const v = map.get(e.name);
        if (v && v.shard === shard) Object.assign(v, { crc32: e.crc, size: e.size });
      }
    }
  }

  /** @param {any} ctx */
  async function* sync(ctx) {
    const info = JSON.parse((await getBuffer(ctx, `${HF_BASE}/api/datasets/${repo}`)).toString('utf8'));
    if (typeof info.sha !== 'string' || !SHA_RE.test(info.sha)) throw new FactoryError(`${cfg.id}: the Hugging Face API returned no commit sha for ${repo}`);
    const sha = info.sha;
    if (info.gated) throw new FactoryError(`${cfg.id}: ${repo} is gated; set HF_TOKEN to an access token that was granted access`);
    ctx.setRev(sha);
    const files = (info.siblings || []).map((s) => s.rfilename).filter((x) => typeof x === 'string');
    const members = await memberIndex(ctx, sha, files);
    const lookup = (/** @type {string} */ name) => members.get(name) || members.get(csvSpelling(name));
    const seenNames = new Map();
    for (const type of MEDIA_TYPES) {
      const file = `${type}.jsonl.zst`;
      if (!files.includes(file)) continue;
      for (const rec of parseJsonlZst(await getBuffer(ctx, resolveUrl(repo, sha, file)))) {
        yield* itemRows(rec, ctx, lookup, seenNames, sha);
      }
    }
  }

  /** @param {any} rec @param {any} ctx @param {(n: string) => any} lookup @param {Map<string, number>} seenNames @param {string} sha */
  function* itemRows(rec, ctx, lookup, seenNames, sha) {
    const slug = rec && typeof rec.url === 'string' ? /\/content\/([^/?#]+)/.exec(rec.url)?.[1] : null;
    const title = rec && typeof rec.title === 'string' ? rec.title.trim() : '';
    if (!slug || !title || !Array.isArray(rec.files)) { ctx.drop('invalid'); return; }
    // The builder numbered repeated file names across ALL items of the dataset, so count before any drop.
    // ASSUMPTION (FX-11 review): the builder stored the k-th later reference to the same name as `stem.k.ext`, counting
    // in the order of MEDIA_TYPES and records used here. Document files are never downloaded, so if the builder counted
    // in another order k could differ. That is harmless: every `stem.N.ext` copy holds the same bytes (it is the same
    // OGA file), and when the numbered name is absent the plain name is used (fallback below).
    const named = rec.files.map((f) => {
      const name = memberFromUrl(f?.url);
      const k = name ? seenNames.get(name) || 0 : 0;
      if (name) seenNames.set(name, k + 1);
      return { name, k, approx: parseHumanSize(f?.size) };
    });
    const lic = decideLicense(rec.licenses, cfg.spdx);
    if ('drop' in lic) { ctx.drop(lic.drop); return; }
    const pageUrl = String(rec.url).split('#')[0].split('?')[0];
    const author = typeof rec.author === 'string' && rec.author.trim() ? rec.author.trim() : null;
    const picked = [];
    for (const { name, k, approx } of named) {
      if (!name || unsafeEntryName(name)) { ctx.drop('file:unsafe-name'); continue; }
      // The k-th reference to the same file name is stored as `stem.k.ext` (same bytes; the plain name always exists).
      const ext = (name.split('.').pop() || '').toLowerCase();
      const type = /** @type {Record<string, string>} */ (TYPE_BY_EXT)[ext] || EXTRA_TYPE_BY_EXT[ext];
      if (!type || type === 'doc') { ctx.drop('file:non-media'); continue; }
      const alt = k > 0 ? collisionName(name, k) : null;
      // Numbered copy first; plain-name fallback when the dataset has no `stem.k.ext` for this reference.
      const hit = (alt && lookup(alt) && { member: alt, ...lookup(alt) }) || (lookup(name) && { member: name, ...lookup(name) });
      if (!hit) { ctx.drop('file:unmapped'); continue; }
      picked.push({ type, ext, hit, approx });
    }
    if (!picked.length) { ctx.drop('item:no-usable-files'); return; }
    const preview = (Array.isArray(rec.preview_images) ? rec.preview_images : []).map(previewUrl).filter(Boolean);
    for (const { type, hit, approx } of picked) {
      yield {
        item_id: slug,
        member: hit.member,
        title, // the item title for every member; the file name is the member part of the id
        description: typeof rec.description === 'string' ? rec.description : null,
        tags: Array.isArray(rec.tags) ? rec.tags.filter((t) => typeof t === 'string') : [],
        type,
        license: lic.license,
        author,
        attribution: attributionFor(lic.license, { title, author, page_url: pageUrl }),
        page_url: pageUrl,
        preview_urls: preview,
        post_date: parsePostDate(rec.post_date),
        pack: picked.length > 1 ? title : null,
        bytes: hit.size ?? approx ?? null,
        bytes_approx: hit.size === undefined && approx !== null,
        locator: { kind: 'hf-zip-member', repo, sha, shard: hit.shard, member: hit.member, ...(hit.crc32 !== undefined ? { crc32: hit.crc32, size: hit.size } : {}) },
      };
    }
  }

  /**
   * Download the bytes of one chosen item into destDir (CRC32 and size verified by the zip reader, and against the
   * locator's crc32/size when sync recorded them). Returns the written path.
   * @param {any} item normalized index item @param {string} destDir @param {any} ctx
   */
  async function fetchItem(item, destDir, ctx) {
    const loc = item?.locator;
    if (!loc || loc.kind !== 'hf-zip-member' || loc.repo !== repo || !SHA_RE.test(String(loc.sha)) || !SHARD_RE.test(String(loc.shard)) || typeof loc.member !== 'string') {
      throw new FactoryError(`${cfg.id}: item ${item?.id} has no valid hf-zip-member locator for ${repo}`);
    }
    const url = resolveUrl(repo, loc.sha, loc.shard);
    const { data, entry } = await readRemoteMember(url, loc.member, { index: ctx.index || undefined, rev: loc.sha, fetch: ctx.fetch, headers: authHeaders(ctx), maxBytes: ctx.maxMemberBytes });
    if ((loc.crc32 !== undefined && loc.crc32 !== entry.crc) || (loc.size !== undefined && loc.size !== entry.size)) {
      throw new FactoryError(`${cfg.id}: member ${loc.member} of ${loc.shard} no longer matches the CRC/size recorded at sync time`);
    }
    ensureDir(destDir);
    const out = path.join(destDir, safeFileName(path.basename(loc.member)));
    fs.writeFileSync(out, data);
    return out;
  }

  return {
    id: cfg.id,
    title: cfg.title,
    license: { allowed: [cfg.spdx] },
    available: () => true,
    sync,
    fetch: fetchItem,
  };
}

export const ogaCc0 = makeOgaAdapter({ id: 'oga-cc0', repoName: 'OpenGameArt-CC0', spdx: 'CC0-1.0', title: 'OpenGameArt CC0 (Hugging Face mirror nyuuzyou/OpenGameArt-CC0)' });
export const ogaCcBy3 = makeOgaAdapter({ id: 'oga-cc-by-3', repoName: 'OpenGameArt-CC-BY-3.0', spdx: 'CC-BY-3.0', title: 'OpenGameArt CC-BY 3.0 (Hugging Face mirror nyuuzyou/OpenGameArt-CC-BY-3.0)' });
export const ogaCcBy4 = makeOgaAdapter({ id: 'oga-cc-by-4', repoName: 'OpenGameArt-CC-BY-4.0', spdx: 'CC-BY-4.0', title: 'OpenGameArt CC-BY 4.0 (Hugging Face mirror nyuuzyou/OpenGameArt-CC-BY-4.0)' });
