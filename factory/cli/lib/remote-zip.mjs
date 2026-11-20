// @ts-check
/**
 * Read ONE member of a remote zip with HTTP Range requests (FX-10): tail-fetch the end records, fetch and parse the
 * central directory (shared parser in zip.mjs; cached in the index table `zip_dirs` per url + rev), then range-fetch
 * the member's local header and data, inflate (method 8) or store (0) and verify size + CRC32.
 * Refused: other methods, encrypted entries, members over the size cap (default 64 MB), unsafe names, and servers
 * that answer a Range request with 200 (they would send the whole archive).
 */
import zlib from 'node:zlib';
import { crc32, locateCentralDirectory, readZip64Eocd, parseCentralDirectory, unsafeEntryName, SIG_LOCAL, ZIP_TAIL_BYTES } from './zip.mjs';
import { httpFetch, safeUrl } from './asset-sources/http.mjs';
import { zipDirGet, zipDirPut } from './asset-index.mjs';

export const DEFAULT_MAX_MEMBER_BYTES = 64 * 1024 * 1024;
const MAX_CD_BYTES = 64 * 1024 * 1024;

/**
 * One Range request; returns the bytes and the total size from Content-Range.
 * @param {string} url @param {string} range e.g. `bytes=-100` or `bytes=0-99` @param {any} o
 */
async function rangeGet(url, range, o) {
  const res = await (o.fetch || httpFetch)(url, { headers: { ...(o.headers || {}), range } });
  if (res.status === 200) {
    await res.body?.cancel();
    throw new Error(`Server ignored the Range request for ${safeUrl(url)} (HTTP 200 instead of 206); remote zip reading needs Range support`);
  }
  if (res.status !== 206) {
    await res.body?.cancel();
    throw new Error(`Range request for ${safeUrl(url)} failed: HTTP ${res.status}`);
  }
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(res.headers.get('content-range') || '');
  if (!m) throw new Error(`Range response for ${safeUrl(url)} has no usable Content-Range header`);
  const buf = Buffer.from(await res.arrayBuffer());
  const start = Number(m[1]);
  if (buf.length !== Number(m[2]) - start + 1) throw new Error(`Range response for ${safeUrl(url)} is truncated`);
  return { buf, start, total: m[3] === '*' ? null : Number(m[3]) };
}

/**
 * Central directory of a remote zip (from the index cache when `index` and `rev` are given and it was read before).
 * @param {string} url @param {{ index?: any, rev?: string, fetch?: Function, headers?: Record<string, string> }} [o]
 * @returns {Promise<{ size: number, entries: ReturnType<typeof parseCentralDirectory>, cached: boolean }>}
 */
export async function remoteZipDirectory(url, o = {}) {
  const cacheable = !!(o.index && o.rev);
  if (cacheable) {
    const hit = zipDirGet(o.index, url, /** @type {string} */ (o.rev));
    if (hit) return { ...hit, cached: true };
  }
  const tail = await rangeGet(url, `bytes=-${ZIP_TAIL_BYTES}`, o);
  const size = tail.total ?? tail.start + tail.buf.length;
  let loc = locateCentralDirectory(tail.buf, tail.start);
  if ('zip64At' in loc) loc = readZip64Eocd((await rangeGet(url, `bytes=${loc.zip64At}-${loc.zip64At + 55}`, o)).buf);
  if (loc.cdSize > MAX_CD_BYTES || loc.cdOffset + loc.cdSize > size) throw new Error(`Central directory of ${safeUrl(url)} is corrupt or too large`);
  let cd;
  if (loc.cdOffset >= tail.start && loc.cdOffset + loc.cdSize <= tail.start + tail.buf.length) {
    cd = tail.buf.subarray(loc.cdOffset - tail.start, loc.cdOffset - tail.start + loc.cdSize);
  } else if (loc.cdSize === 0) cd = Buffer.alloc(0);
  else cd = (await rangeGet(url, `bytes=${loc.cdOffset}-${loc.cdOffset + loc.cdSize - 1}`, o)).buf;
  const entries = parseCentralDirectory(cd, loc.count);
  if (cacheable) zipDirPut(o.index, url, /** @type {string} */ (o.rev), size, entries);
  return { size, entries, cached: false };
}

/**
 * Read one member. Options as remoteZipDirectory plus `maxBytes` (uncompressed and compressed cap).
 * @param {string} url @param {string} member exact entry name
 * @param {{ index?: any, rev?: string, fetch?: Function, headers?: Record<string, string>, maxBytes?: number }} [o]
 * @returns {Promise<{ data: Buffer, entry: any, cachedDirectory: boolean }>}
 */
export async function readRemoteMember(url, member, o = {}) {
  const maxBytes = o.maxBytes ?? DEFAULT_MAX_MEMBER_BYTES;
  if (unsafeEntryName(member)) throw new Error(`Unsafe member name refused: ${member}`);
  const dir = await remoteZipDirectory(url, o);
  const e = dir.entries.find((x) => x.name === member);
  if (!e) throw new Error(`No member "${member}" in ${safeUrl(url)}`);
  if (e.flags & 1) throw new Error(`Member ${member} is encrypted; refused`);
  if (e.method !== 0 && e.method !== 8) throw new Error(`Member ${member} uses unsupported compression method ${e.method}; refused`);
  if (e.size > maxBytes || e.compressed > maxBytes) throw new Error(`Member ${member} is ${e.size} bytes, over the ${maxBytes}-byte cap; refused`);
  if (e.offset + 30 > dir.size) throw new Error(`Member ${member} has a local header offset outside the archive`);
  const head = (await rangeGet(url, `bytes=${e.offset}-${e.offset + 29}`, o)).buf;
  if (head.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`Corrupt local header for ${member}`);
  const start = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  let body = Buffer.alloc(0);
  if (e.compressed > 0) {
    if (start + e.compressed > dir.size) throw new Error(`Member ${member} extends past the end of the archive`);
    body = (await rangeGet(url, `bytes=${start}-${start + e.compressed - 1}`, o)).buf;
  }
  let data;
  try {
    data = e.method === 0 ? body : zlib.inflateRawSync(body, { maxOutputLength: Math.max(1, maxBytes) });
  } catch (err) {
    throw new Error(`Member ${member} could not be inflated (${/** @type {any} */ (err).code || /** @type {any} */ (err).message})`);
  }
  if (data.length !== e.size || crc32(data) !== e.crc) throw new Error(`Corrupt member ${member} (size or CRC mismatch)`);
  return { data, entry: e, cachedDirectory: dir.cached };
}
