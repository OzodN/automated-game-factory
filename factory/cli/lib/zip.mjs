// @ts-check
/**
 * Deterministic ZIP writer and validator (no dependencies).
 * Entries are sorted and use a fixed DOS timestamp, so identical build output always yields
 * a byte-identical archive with the same sha256: release packages are reproducible.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { listFiles } from './core.mjs';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01

/** Zip the *contents* of srcDir (files at archive root). Returns {files, bytes}. */
export function zipDirectory(srcDir, outFile) {
  const files = listFiles(srcDir).sort();
  const locals = [];
  const centrals = [];
  let offset = 0;
  let total = 0;
  for (const rel of files) {
    const data = fs.readFileSync(path.join(srcDir, rel));
    total += data.length;
    const name = Buffer.from(rel, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(useDeflate ? 8 : 0, 8); lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(useDeflate ? 8 : 0, 10); ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, Buffer.concat([...locals, cd, end]));
  return { files: files.length, bytes: total };
}

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
export const SIG_LOCAL = 0x04034b50;
/** Bytes from the end of a zip that always contain the EOCD (22 + 65535 comment) plus a ZIP64 locator and record. */
export const ZIP_TAIL_BYTES = 22 + 0xffff + 20 + 56;

/**
 * Locate the central directory from a buffer holding the END of a zip (`tail`, starting at absolute offset
 * `tailStart`). Handles a trailing comment and the ZIP64 end record (via its locator). When the ZIP64 record lies
 * before `tailStart`, returns `{ zip64At }` so the caller can fetch those 56 bytes and call `readZip64Eocd`.
 * @param {Buffer} tail @param {number} [tailStart]
 * @returns {{ count: number, cdOffset: number, cdSize: number } | { zip64At: number }}
 */
export function locateCentralDirectory(tail, tailStart = 0) {
  let eocd = -1;
  let loose = -1;
  for (let i = tail.length - 22; i >= Math.max(0, tail.length - 65557); i--) {
    if (tail.readUInt32LE(i) !== SIG_EOCD) continue;
    if (loose < 0) loose = i;
    if (i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break; }
  }
  if (eocd < 0) eocd = loose;
  if (eocd < 0) throw new Error('Not a zip archive (no end-of-central-directory record)');
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  const loc = eocd - 20;
  if (loc >= 0 && tail.readUInt32LE(loc) === SIG_ZIP64_LOCATOR) {
    const zip64At = toSafe(tail.readBigUInt64LE(loc + 8), 'ZIP64 end record offset');
    const rel = zip64At - tailStart;
    if (rel < 0 || rel + 56 > tail.length) return { zip64At };
    return readZip64Eocd(tail.subarray(rel, rel + 56));
  }
  return { count, cdOffset, cdSize };
}

/** Parse a ZIP64 end-of-central-directory record (at least 56 bytes). */
export function readZip64Eocd(buf) {
  if (buf.length < 56 || buf.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw new Error('Corrupt ZIP64 end-of-central-directory record');
  return {
    count: toSafe(buf.readBigUInt64LE(32), 'entry count'),
    cdSize: toSafe(buf.readBigUInt64LE(40), 'central directory size'),
    cdOffset: toSafe(buf.readBigUInt64LE(48), 'central directory offset'),
  };
}

function toSafe(big, what) {
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`ZIP64 ${what} is too large`);
  return Number(big);
}

/**
 * Parse `count` central directory records from `cd` (the directory bytes only). ZIP64 extra fields (0x0001)
 * replace the 32-bit size/compressed/offset fields that are 0xFFFFFFFF.
 * @param {Buffer} cd @param {number} count
 * @returns {{ name: string, method: number, flags: number, crc: number, compressed: number, size: number, offset: number }[]}
 */
export function parseCentralDirectory(cd, count) {
  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('Corrupt central directory');
    const nl = cd.readUInt16LE(p + 28);
    const el = cd.readUInt16LE(p + 30);
    const cl = cd.readUInt16LE(p + 32);
    if (p + 46 + nl + el + cl > cd.length) throw new Error('Corrupt central directory');
    const e = {
      name: cd.toString('utf8', p + 46, p + 46 + nl),
      flags: cd.readUInt16LE(p + 8),
      method: cd.readUInt16LE(p + 10),
      crc: cd.readUInt32LE(p + 16),
      compressed: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      offset: cd.readUInt32LE(p + 42),
    };
    applyZip64Extra(e, cd.subarray(p + 46 + nl, p + 46 + nl + el));
    entries.push(e);
    p += 46 + nl + el + cl;
  }
  return entries;
}

function applyZip64Extra(e, extra) {
  const MAX = 0xffffffff;
  for (let q = 0; q + 4 <= extra.length;) {
    const id = extra.readUInt16LE(q);
    const len = extra.readUInt16LE(q + 2);
    if (id === 0x0001) {
      let r = q + 4;
      const next = (what) => {
        if (r + 8 > q + 4 + len) throw new Error(`Corrupt ZIP64 extra field for ${e.name}`);
        const v = toSafe(extra.readBigUInt64LE(r), what);
        r += 8;
        return v;
      };
      if (e.size === MAX) e.size = next('size');
      if (e.compressed === MAX) e.compressed = next('compressed size');
      if (e.offset === MAX) e.offset = next('local header offset');
      return;
    }
    q += 4 + len;
  }
}

/** True when an entry name would escape the extraction folder (absolute, drive letter, `..`). */
export function unsafeEntryName(name) {
  return /^([A-Za-z]:|[\\/])/.test(name) || name.split(/[\\/]/).includes("..") || name.includes("\0");
}

/** Central directory of an in-memory zip. */
function entriesOf(buf) {
  const loc = locateCentralDirectory(buf, 0);
  if ('zip64At' in loc) throw new Error('Corrupt ZIP64 locator');
  if (loc.cdOffset + loc.cdSize > buf.length) throw new Error('Corrupt central directory');
  return parseCentralDirectory(buf.subarray(loc.cdOffset, loc.cdOffset + loc.cdSize), loc.count);
}

/** Read the central directory of a zip: [{name, size, compressed, method, flags, crc, offset}] */
export function readZipEntries(file) {
  return entriesOf(fs.readFileSync(file));
}

/**
 * Extract a zip into destDir (stored and deflated entries, CRC-checked). Entry names that would escape destDir
 * (absolute, `..`, drive letters) are refused. Returns the sorted list of extracted file names.
 * Optional caps for untrusted archives (FX-12, SEC-04 zip bombs): `maxEntryBytes` per entry and `maxTotalBytes` for the
 * whole archive, checked on the declared size before inflating and enforced while inflating.
 * @param {string} file @param {string} destDir @param {{ maxEntryBytes?: number, maxTotalBytes?: number }} [limits]
 * @returns {string[]}
 */
export function extractZip(file, destDir, limits = {}) {
  const buf = fs.readFileSync(file);
  const root = path.resolve(destDir);
  const names = [];
  const maxEntry = limits.maxEntryBytes ?? Infinity;
  let budget = limits.maxTotalBytes ?? Infinity;
  for (const { name, method, crc, compressed, size, offset } of entriesOf(buf)) {
    if (name.endsWith('/')) continue;
    const target = path.resolve(root, name);
    if (unsafeEntryName(name) || !(target === root || target.startsWith(root + path.sep))) {
      throw new Error(`Unsafe entry name in archive: ${name}`);
    }
    if (buf.readUInt32LE(offset) !== SIG_LOCAL) throw new Error(`Corrupt local header for ${name}`);
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const body = buf.subarray(start, start + compressed);
    const cap = Math.min(maxEntry, budget);
    if (size > cap) throw new Error(`Archive entry ${name} is too large (${size} bytes, limit ${cap})`);
    let data;
    if (method === 0) data = body;
    else if (method === 8) {
      try {
        data = zlib.inflateRawSync(body, Number.isFinite(cap) ? { maxOutputLength: Math.max(1, cap) } : {});
      } catch (e) {
        throw new Error(`Archive entry ${name} does not inflate within ${cap} bytes: ${/** @type {Error} */ (e).message}`);
      }
    }
    else throw new Error(`Unsupported compression method ${method} for ${name}`);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`Corrupt entry ${name} (size or CRC mismatch)`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    budget -= data.length;
    fs.writeFileSync(target, data);
    names.push(name);
  }
  return names.sort();
}

/**
 * Validate a Playgama build archive structure.
 * Limits are the factory's targets (stricter than Playgama's 300 MB) so builds stay eligible
 * for partner platforms; they come from factory/config.json `release` when present.
 */
export function validateArchive(file, limits) {
  const entries = readZipEntries(file).filter((e) => !e.name.endsWith('/'));
  const errors = [];
  const warnings = [];
  const names = entries.map((e) => e.name);
  if (!names.includes('index.html')) errors.push('index.html must be at the archive root');
  if (!names.includes('playgama-bridge-config.json')) errors.push('playgama-bridge-config.json must be at the archive root next to index.html');
  const bad = names.filter((n) => !/^[A-Za-z0-9._\/-]+$/.test(n));
  if (bad.length) errors.push(`non-Latin/unsafe file names: ${bad.slice(0, 5).join(', ')}`);
  const sys = names.filter((n) => /(^|\/)(\.DS_Store|Thumbs\.db|__MACOSX|\.git)(\/|$)/.test(n));
  if (sys.length) errors.push(`system files in archive: ${sys.slice(0, 5).join(', ')}`);
  const maps = names.filter((n) => n.endsWith('.map'));
  if (maps.length) warnings.push(`${maps.length} source map(s) shipped`);
  const total = entries.reduce((a, e) => a + e.size, 0);
  if (total > limits.maxBytes) errors.push(`unpacked size ${(total / 1048576).toFixed(2)} MB exceeds ${(limits.maxBytes / 1048576).toFixed(0)} MB`);
  if (entries.length > limits.maxFiles) errors.push(`${entries.length} files exceeds ${limits.maxFiles}`);
  const big = entries.filter((e) => e.size > limits.maxFileBytes);
  if (big.length) errors.push(`files over ${(limits.maxFileBytes / 1048576).toFixed(0)} MB: ${big.map((e) => e.name).join(', ')}`);
  return { ok: errors.length === 0, errors, warnings, files: entries.length, bytes: total };
}
