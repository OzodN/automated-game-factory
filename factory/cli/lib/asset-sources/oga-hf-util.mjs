// @ts-check
/**
 * Pure helpers of the OpenGameArt Hugging Face adapters (oga-hf.mjs): name mapping, license decisions, attribution,
 * dates, size labels, preview URLs, metadata decompression and Windows-safe file names. No network, no files.
 */
import zlib from 'node:zlib';
import { LICENSES, licenseAllowed } from '../asset-policy.mjs';
import { FactoryError } from '../core.mjs';

/** cp437 characters for bytes 0x80..0xFF. */
const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

/** The name as `archive_index.csv` spells it: the UTF-8 bytes of `name` decoded as cp437. @param {string} name */
export function csvSpelling(name) {
  return [...Buffer.from(name, 'utf8')].map((b) => (b < 128 ? String.fromCharCode(b) : CP437_HIGH[b - 128])).join('');
}

/** Member name = percent-decoded basename of an OGA file URL (no query/fragment). @param {unknown} url */
export function memberFromUrl(url) {
  if (typeof url !== 'string') return null;
  const base = url.split('#')[0].split('?')[0].split('/').pop() || '';
  let name = base;
  try { name = decodeURIComponent(base); } catch { /* keep the raw basename */ }
  return name || null;
}

/** `stem.ext` -> `stem.<k>.ext` (the builder's name for the k-th later copy of the same file). @param {string} name @param {number} k */
export function collisionName(name, k) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)}.${k}${name.slice(dot)}` : `${name}.${k}`;
}

/** OGA license label -> SPDX-style id: `CC0` -> CC0-1.0, `CC-BY 4.0` -> CC-BY-4.0, `GPL 3.0` -> GPL-3.0. @param {unknown} raw */
export function ogaLicenseToSpdx(raw) {
  const t = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return null;
  if (/^cc0$/i.test(t)) return 'CC0-1.0';
  return t.replace(/ /g, '-');
}

/**
 * Decide the license of one item for a dataset whose license is `datasetSpdx`. Every listed license must be allowed by
 * factory policy (SA/GPL/NC/ND/unknown anywhere in the list drops the item: an uploader's "alternative" cannot be told
 * from "all apply" in this data, and when unsure the item is dropped) and the dataset's own license must be listed.
 * @param {unknown} licenses @param {string} datasetSpdx
 * @returns {{ license: string } | { drop: string }}
 */
export function decideLicense(licenses, datasetSpdx) {
  const raw = Array.isArray(licenses) ? licenses.filter((x) => typeof x === 'string' && x.trim()) : [];
  if (!raw.length) return { drop: 'license:missing' };
  const spdx = raw.map((r) => ogaLicenseToSpdx(r));
  const bad = spdx.findIndex((s) => !licenseAllowed(s));
  if (bad >= 0) return { drop: `license:${spdx[bad]}` };
  if (!spdx.includes(datasetSpdx)) return { drop: 'license:mismatch' };
  return { license: datasetSpdx };
}

/** Attribution text recorded per item, or null for licenses that need none. @param {string} spdx @param {{ title: string, author: string | null, page_url: string }} i */
export function attributionFor(spdx, i) {
  if (!LICENSES[/** @type {keyof typeof LICENSES} */ (spdx)]?.attribution) return null;
  return `"${i.title}" by ${i.author || 'unknown author'} (${i.page_url}), licensed ${spdx}`;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** "Wednesday, July 4, 2018 - 06:34" -> "2018-07-04T06:34"; unparsable text -> null. @param {unknown} s */
export function parsePostDate(s) {
  const m = /([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})(?:\s+-\s+(\d{1,2}):(\d{2}))?/.exec(String(s ?? ''));
  const mon = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (!m || mon < 0) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${m[3]}-${p(mon + 1)}-${p(m[2])}${m[4] ? `T${p(m[4])}:${m[5]}` : ''}`;
}

/** Parse `archive_index.csv` ("Archive","Filename", quotes doubled) into name -> shard. @param {string} text */
export function parseArchiveIndex(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^"((?:[^"]|"")*)","((?:[^"]|"")*)"$/.exec(line);
    if (m && !(m[1] === 'Archive' && m[2] === 'Filename')) map.set(m[2].replace(/""/g, '"'), m[1].replace(/""/g, '"'));
  }
  return map;
}

/** Cap on the decompressed size of one metadata file (the real ones are ~10-60 MB). */
export const MAX_METADATA_BYTES = 256 * 1024 * 1024;

/**
 * Decompress and parse a `.jsonl.zst` buffer; unparsable lines are returned as null. Output larger than `maxBytes`
 * is refused with a clear error (a broken or hostile pinned file cannot expand without limit).
 * @param {Buffer} buf @param {number} [maxBytes]
 */
export function parseJsonlZst(buf, maxBytes = MAX_METADATA_BYTES) {
  if (typeof zlib.zstdDecompressSync !== 'function') throw new FactoryError('The Hugging Face asset sources need zlib zstd support (Node 22.15+ / 24)');
  let out;
  try {
    out = zlib.zstdDecompressSync(buf, { maxOutputLength: maxBytes });
  } catch (e) {
    const code = /** @type {any} */ (e).code;
    if (code === 'ERR_BUFFER_TOO_LARGE' || /larger than|too large/i.test(String(/** @type {any} */ (e).message))) {
      throw new FactoryError(`Metadata file decompresses to more than ${Math.round(maxBytes / 1048576)} MB; refused (corrupt or unexpected dataset file)`);
    }
    throw new FactoryError(`Metadata file could not be decompressed (${code || /** @type {any} */ (e).message})`);
  }
  return out.toString('utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } });
}

/** Windows reserved device names (any case, with or without an extension): CON, PRN, AUX, NUL, COM1-9, LPT1-9. */
const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** A file name that is safe on Windows and POSIX (reserved device names get a `_` suffix on the stem). @param {string} name */
export function safeFileName(name) {
  let n = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  if (RESERVED_RE.test(n)) n = n.replace(/^([^.]*)/, '$1_');
  return n || 'asset';
}

/**
 * Approximate byte count of an OGA size label: "30 Kb" -> 30720, "1.2 Mb" -> 1258291, "512 bytes" -> 512; anything
 * else -> null. OGA rounds the label, so the result is an estimate (stored with bytes_approx).
 * @param {unknown} label
 */
export function parseHumanSize(label) {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(b|bytes?|kb|kib|mb|mib|gb|gib)\s*$/i.exec(String(label ?? ''));
  if (!m) return null;
  const unit = m[2].toLowerCase()[0];
  const mult = unit === 'k' ? 1024 : unit === 'm' ? 1048576 : unit === 'g' ? 1073741824 : 1;
  return Math.round(Number(m[1].replace(',', '.')) * mult);
}

/** OGA preview image URL as an absolute https URL (relative and protocol-relative paths resolved against OGA). @param {unknown} u */
export function previewUrl(u) {
  if (typeof u !== 'string' || !u.trim()) return null;
  try {
    const url = new URL(u.trim(), 'https://opengameart.org/');
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.hostname === 'opengameart.org') url.protocol = 'https:';
    return url.href;
  } catch {
    return null;
  }
}

