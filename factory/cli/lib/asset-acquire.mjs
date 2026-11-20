// @ts-check
/**
 * `assets acquire <remote-id...> [--pack-as <source>/<pack>] [--max-mb n]` (FX-12, asset-producer only).
 *
 * Fetches chosen remote index rows through their source adapter into a fresh `<library>/_quarantine/...` folder
 * (SEC-04: untrusted bytes; only media/data types are admitted, nothing is executed; a fetched `.zip` member is
 * extracted with the safe extractor, which refuses traversal names, and its media files are admitted one by one),
 * then writes an append-only library pack `packs/<source>/<pack>/` with a PACK.json holding per-file entries and
 * provenance, and appends catalog lines exactly like `assets ingest`. The pack starts as `verification: "declared"`;
 * `assets verify` stays the human-evidence step (live page_url checked: license unchanged, no ripped content, AS-04).
 *
 * Verification authority: PACK.json. `assets verify` rewrites PACK.json (pack + per-file provenance); the append-only
 * catalog lines keep `provenance.verification` from acquire time, and loadCatalog (assets.mjs) overrides it from PACK.json,
 * so search, show and pull always see the effective value.
 *
 * Idempotent per remote id: rows already in the library are reported with their pack and not downloaded again.
 * Denylisted ids/authors are refused. `<source>:<item_id>` (no member) acquires every member of that item.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonl, writeJsonAtomic, ensureDir, listFiles, sha256File, FactoryError, nowIso } from './core.mjs';
import { LICENSES, TYPE_BY_EXT, licenseAllowed } from './asset-policy.mjs';
import { openIndex, getItem, getItemMembers, updateMedia } from './asset-index.mjs';
import { getSource, makeContext } from './asset-sources/index.mjs';
import { safeFileName } from './asset-sources/oga-hf-util.mjs';
import { extractZip } from './zip.mjs';
import { loadDeny, deniedReason, REMOTE_ID_RE } from './asset-denylist.mjs';
import { probeMedia } from './asset-media.mjs';
import { DEFAULT_MAX_MEMBER_BYTES } from './remote-zip.mjs';

const MB = 1024 * 1024;
export const MAX_ACQUIRE_MB = 256;
const SHIP_LIMIT = 10 * MB;
/** A nested pack zip may inflate to at most this many times the per-member cap in total (zip-bomb bound, SEC-04). */
const ZIP_TOTAL_FACTOR = 4;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i;
/** Executable / script signatures refused even under a media extension (PE, ELF, Mach-O, shebang). */
const EXEC_MAGIC = [Buffer.from('MZ'), Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from('#!')];

/** Pack id from an item id: lower-case slug. @param {string} itemId */
export function packSlug(itemId) {
  const s = itemId.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '');
  return s || 'item';
}

/** @param {string} file */
function looksExecutable(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(4);
  try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
  return EXEC_MAGIC.some((m) => head.subarray(0, m.length).equals(m));
}

/** @param {Record<string, any>} f */
function maxBytesOf(f) {
  if (f['max-mb'] === undefined) return { maxBytes: DEFAULT_MAX_MEMBER_BYTES, warn: [] };
  const n = Number(f['max-mb']);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_ACQUIRE_MB) throw new FactoryError(`--max-mb must be a number in 1..${MAX_ACQUIRE_MB}`);
  return {
    maxBytes: Math.round(n * MB),
    warn: [`WARNING: --max-mb ${n} raises the per-member cap. A shipped file must stay <= 10 MB (AS-08) and audio must be converted to ogg + mp3, loudness-normalized (AS-06) before a game uses it.`],
  };
}

/** Rows for the requested ids (an item id without member expands to all members). @param {any} db @param {string[]} ids */
function resolveRows(db, ids) {
  const rows = [];
  for (const id of ids) {
    if (!REMOTE_ID_RE.test(id)) throw new FactoryError(`${id} is not a remote index id (<source>:<item>[/<member>])`);
    const one = getItem(db, id);
    if (one) { rows.push(one); continue; }
    const [source, rest] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
    const members = rest.includes('/') ? [] : getItemMembers(db, source, rest);
    if (!members.length) throw new FactoryError(`Unknown remote asset ${id} (search with: factory assets search --remote ...)`);
    rows.push(...members);
  }
  return [...new Map(rows.map((r) => [r.id, r])).values()];
}

/**
 * @param {string} root library root @param {string[]} ids @param {Record<string, any>} f
 * @returns {Promise<string>}
 */
export async function acquireCommand(root, ids, f) {
  if (!ids.length) throw new FactoryError('acquire <remote-id...> [--pack-as <source>/<pack>] [--max-mb n]');
  const { maxBytes, warn } = maxBytesOf(f);
  if (f['pack-as'] !== undefined && (typeof f['pack-as'] !== 'string' || !/^[^/]+\/[^/]+$/.test(f['pack-as']) || !f['pack-as'].split('/').every((x) => SLUG_RE.test(x)))) {
    throw new FactoryError('--pack-as must be <source>/<pack> (simple slugs)');
  }
  const db = openIndex();
  try {
    const rows = resolveRows(db, ids);
    const deny = loadDeny(root);
    for (const r of rows) { const why = deniedReason(deny, r); if (why) throw new FactoryError(`Refused ${r.id}: ${why}`); }
    const have = new Map();
    for (const e of readJsonl(`${root}/catalog/catalog.jsonl`)) if (e?.provenance?.remote_id) have.set(e.provenance.remote_id, e.pack);
    const out = [...warn];
    const todo = rows.filter((r) => { if (!have.has(r.id)) return true; out.push(`${r.id}: already in the library as pack ${have.get(r.id)} (not downloaded again)`); return false; });
    const groups = new Map();
    for (const r of todo) {
      const key = typeof f['pack-as'] === 'string' ? f['pack-as'] : `${r.source}/${packSlug(r.item_id)}`;
      groups.set(key, [...(groups.get(key) || []), r]);
    }
    for (const [key, list] of groups) out.push(await acquirePack(root, db, key, list, maxBytes));
    return out.join('\n');
  } finally {
    db.close();
  }
}

/** License + attribution checks for one pack's rows. @param {string} key @param {any[]} rows */
function checkLicense(key, rows) {
  const lic = [...new Set(rows.map((r) => r.license))];
  if (lic.length !== 1) throw new FactoryError(`Pack ${key} would mix licenses (${lic.join(', ')}); acquire them into separate packs`);
  if (!licenseAllowed(lic[0])) throw new FactoryError(`License ${lic[0]} is not allowed by factory policy (AS-02)`);
  const needs = LICENSES[/** @type {keyof typeof LICENSES} */ (lic[0])].attribution;
  const bare = rows.find((r) => needs && !r.attribution);
  if (bare) throw new FactoryError(`${bare.id} is ${lic[0]} but has no attribution text in the index; refused`);
  return lic[0];
}

/**
 * Fetch every row into quarantine and collect admitted files: [{ abs, rel, row, member }].
 * @param {any} db @param {any[]} rows @param {string} quarantine @param {number} maxBytes
 */
async function fetchIntoQuarantine(db, rows, quarantine, maxBytes) {
  const files = [];
  const rejected = [];
  for (const [n, row] of rows.entries()) {
    const ctx = /** @type {any} */ (makeContext({ index: db }));
    ctx.maxMemberBytes = maxBytes;
    const got = await getSource(row.source).fetch(row, `${quarantine}/fetch-${n}`, ctx);
    const ext = path.extname(got).slice(1).toLowerCase();
    if (ext === 'zip') {
      const dir = `${quarantine}/unzip-${n}`;
      extractZip(got, dir, { maxEntryBytes: maxBytes, maxTotalBytes: ZIP_TOTAL_FACTOR * maxBytes });
      for (const rel of listFiles(dir)) files.push({ abs: `${dir}/${rel}`, rel, row, member: rel, fromZip: got });
    } else files.push({ abs: got, rel: path.basename(got), row, member: null, fromZip: null });
  }
  const admitted = files.filter((x) => {
    const ext = x.rel.split('.').pop()?.toLowerCase() || '';
    const ok = !!(/** @type {Record<string, string>} */ (TYPE_BY_EXT)[ext]) && !/(^|\/)(__MACOSX|\.DS_Store)/.test(x.rel) && !looksExecutable(x.abs);
    if (!ok) rejected.push(x.member ? `${x.row.id}!${x.rel}` : x.row.id);
    return ok;
  });
  return { admitted, rejected };
}

/** Pack-relative safe path, unique within the pack. @param {string} rel @param {Set<string>} used */
function safeRel(rel, used) {
  const base = rel.split('/').map((seg) => safeFileName(seg.replace(/[^A-Za-z0-9._-]+/g, '_'))).join('/');
  let out = base;
  for (let k = 1; used.has(out.toLowerCase()); k++) out = base.replace(/(\.[^./]+)?$/, (m) => `.${k}${m}`);
  used.add(out.toLowerCase());
  return out;
}

/** @param {string} root @param {any} db @param {string} key @param {any[]} rows @param {number} maxBytes */
async function acquirePack(root, db, key, rows, maxBytes) {
  const [src, pack] = key.split('/');
  if (!SLUG_RE.test(src) || !SLUG_RE.test(pack)) throw new FactoryError(`Pack id ${key} is not a simple slug pair`);
  const packDir = `${root}/packs/${src}/${pack}`;
  if (fs.existsSync(packDir)) throw new FactoryError(`Pack ${key} already exists; packs are append-only (use --pack-as <source>/<new-pack>)`);
  const license = checkLicense(key, rows);
  const quarantine = ensureDir(`${root}/_quarantine/${src}-${pack}-${Date.now()}`);
  try {
    const { admitted, rejected } = await fetchIntoQuarantine(db, rows, quarantine, maxBytes);
    const entries = writePackFiles(packDir, key, admitted, license);
    if (!entries.length) throw new FactoryError(`Nothing admissible in ${rows.map((r) => r.id).join(', ')} (rejected: ${rejected.join(', ') || 'none'})`);
    writePackManifest(packDir, { src, pack, license, rows, entries, rejected });
    // FX-13: the index write-back is best effort (the index is a rebuildable cache; e.g. SQLITE_BUSY during a
    // concurrent sync must not undo a good pack), and the append-only catalog lines are written LAST, in one append,
    // after every fallible step: a failure above removes the pack and leaves no catalog line pointing at it.
    const notes = [];
    try { writeBack(db, rows, entries, admitted); } catch (e) {
      notes.push(`WARNING: measured sizes were not written back to the index (${/** @type {any} */ (e).message}); the pack is kept.`);
    }
    appendCatalog(root, entries);
    const big = entries.filter((e) => e.bytes > SHIP_LIMIT).map((e) => `${e.id} (${(e.bytes / MB).toFixed(1)} MB)`);
    return `${notes.map((n) => `${n}\n`).join('')}Acquired ${entries.length} file(s) into ${key} (license ${license}, verification: declared). Rejected ${rejected.length}${rejected.length ? `: ${rejected.slice(0, 8).join(', ')}` : ''}.` +
      (big.length ? `\nWARNING: over the 10 MB shipped-file limit (AS-08), convert or cut before use: ${big.join(', ')}` : '') +
      `\nNext: open ${[...new Set(rows.map((r) => r.page_url).filter(Boolean))].join(', ') || 'the source page'}, confirm the license is unchanged and the content is original (AS-04), then: factory assets verify ${key} --evidence "..."`;
  } catch (e) {
    fs.rmSync(packDir, { recursive: true, force: true });
    throw e;
  } finally {
    fs.rmSync(quarantine, { recursive: true, force: true });
  }
}

/** Copy admitted files into the pack and build the per-file entries. @param {string} packDir @param {string} key @param {any[]} admitted @param {string} license */
function writePackFiles(packDir, key, admitted, license) {
  const used = new Set();
  const entries = [];
  for (const x of admitted) {
    const rel = safeRel(x.rel, used);
    const dest = `${packDir}/${rel}`;
    ensureDir(path.dirname(dest));
    fs.copyFileSync(x.abs, dest);
    const ext = rel.split('.').pop()?.toLowerCase() || '';
    const type = /** @type {Record<string, string>} */ (TYPE_BY_EXT)[ext];
    x.rel = rel;
    if (type === 'doc') continue; // license/readme files are kept in the pack for verify, not catalogued (as ingest)
    const r = x.row;
    const m = probeMedia(dest, type);
    entries.push({
      id: `${key}/${rel}`, pack: key, file: `packs/${key}/${rel}`, type, ext,
      tags: [...new Set([...(r.tags || []), ...rel.toLowerCase().split(/[/_.\-\s]+/).filter((w) => w.length > 2 && !/^\d+$/.test(w) && w !== ext)])],
      style: null, bytes: fs.statSync(dest).size, sha256: sha256File(dest),
      ...(m.w ? { w: m.w, h: m.h } : {}), ...(m.duration ? { duration: m.duration } : {}),
      license, author: r.author, url: r.page_url, attribution: r.attribution || null, testOnly: r.source === 'fixture',
      provenance: { source: r.source, remote_id: r.id, member: x.member, page_url: r.page_url, source_rev: r.source_rev, license, author: r.author, attribution: r.attribution || null, verification: 'declared' },
    });
  }
  return entries;
}

/** @param {string} packDir @param {{ src: string, pack: string, license: string, rows: any[], entries: any[], rejected: string[] }} o */
function writePackManifest(packDir, o) {
  const authors = [...new Set(o.rows.map((r) => r.author).filter(Boolean))];
  writeJsonAtomic(`${packDir}/PACK.json`, {
    source: o.src, pack: o.pack, license: o.license, author: authors.join(', ') || null, url: o.rows[0].page_url,
    attribution: [...new Set(o.rows.map((r) => r.attribution).filter(Boolean))].join('; ') || null,
    style: null, tags: [], ingestedAt: nowIso(), acquiredBy: 'factory assets acquire', verification: 'declared',
    acquiredFrom: o.rows.map((r) => ({ remote_id: r.id, page_url: r.page_url, source_rev: r.source_rev })),
    fileCount: o.entries.length, rejected: o.rejected, testOnly: o.rows.some((r) => r.source === 'fixture'), files: o.entries,
  });
}

/** All catalog lines of one pack in a single append (no partial pack on a mid-loop failure). @param {string} root @param {any[]} entries */
function appendCatalog(root, entries) {
  const file = `${root}/catalog/catalog.jsonl`;
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, entries.map((e) => `${JSON.stringify(e)}\n`).join(''), 'utf8');
}

/** Measured facts back into the index rows (direct members: dims/duration/bytes; zip rows: exact archive bytes). */
function writeBack(db, rows, entries, admitted) {
  const byRemote = new Map(entries.filter((e) => !e.provenance.member).map((e) => [e.provenance.remote_id, e]));
  for (const r of rows) {
    const e = byRemote.get(r.id);
    if (e) { updateMedia(db, r.id, { w: e.w, h: e.h, duration: e.duration, bytes: e.bytes }); continue; }
    const z = admitted.find((x) => x.row.id === r.id && x.fromZip);
    if (z && fs.existsSync(z.fromZip)) updateMedia(db, r.id, { bytes: fs.statSync(z.fromZip).size });
  }
}
