// @ts-check
/**
 * FX-10 test helpers: a tiny zip builder (stored/deflated members, comment, ZIP64 records, corrupt CRC, encrypted
 * flag, odd methods) and a local HTTP server with optional Range support that counts requests per path.
 */
import http from 'node:http';
import zlib from 'node:zlib';
import { crc32 } from '../../lib/zip.mjs';

/**
 * @param {{ name: string, data: Buffer | string, method?: number, flags?: number, badCrc?: boolean }[]} members
 * @param {{ comment?: string, zip64?: boolean }} [o]
 */
export function buildZip(members, o = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const m of members) {
    const data = Buffer.isBuffer(m.data) ? m.data : Buffer.from(m.data);
    const method = m.method ?? 0;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = (crc32(data) ^ (m.badCrc ? 1 : 0)) >>> 0;
    const name = Buffer.from(m.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(o.zip64 ? 45 : 20, 4); lh.writeUInt16LE(m.flags ?? 0, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
    const extra = o.zip64 ? Buffer.alloc(4 + 24) : Buffer.alloc(0);
    if (o.zip64) {
      extra.writeUInt16LE(1, 0); extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(data.length), 4); extra.writeBigUInt64LE(BigInt(body.length), 12); extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(45, 4); ch.writeUInt16LE(o.zip64 ? 45 : 20, 6); ch.writeUInt16LE(m.flags ?? 0, 8);
    ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(o.zip64 ? 0xffffffff : body.length, 20); ch.writeUInt32LE(o.zip64 ? 0xffffffff : data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(extra.length, 30); ch.writeUInt32LE(o.zip64 ? 0xffffffff : offset, 42);
    centrals.push(ch, name, extra);
    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const comment = Buffer.from(o.comment || '', 'utf8');
  const tail = [];
  if (o.zip64) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0); z.writeBigUInt64LE(44n, 4); z.writeUInt16LE(45, 12); z.writeUInt16LE(45, 14);
    z.writeBigUInt64LE(BigInt(members.length), 24); z.writeBigUInt64LE(BigInt(members.length), 32);
    z.writeBigUInt64LE(BigInt(cd.length), 40); z.writeBigUInt64LE(BigInt(offset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(offset + cd.length), 8); loc.writeUInt32LE(1, 16);
    tail.push(z, loc);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(o.zip64 ? 0xffff : members.length, 8); end.writeUInt16LE(o.zip64 ? 0xffff : members.length, 10);
  end.writeUInt32LE(o.zip64 ? 0xffffffff : cd.length, 12); end.writeUInt32LE(o.zip64 ? 0xffffffff : offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, cd, ...tail, end, comment]);
}

/**
 * Serve `files` (path -> Buffer). With `range: false` the server ignores Range headers (always 200 + full body).
 * @param {Record<string, Buffer>} files @param {{ range?: boolean }} [o]
 */
export async function serve(files, o = {}) {
  const hits = /** @type {Record<string, number>} */ ({});
  const uas = /** @type {string[]} */ ([]);
  const server = http.createServer((req, res) => {
    const p = (req.url || '').split('?')[0];
    hits[p] = (hits[p] || 0) + 1;
    uas.push(String(req.headers['user-agent'] || ''));
    const buf = files[p];
    if (!buf) { res.writeHead(404).end(); return; }
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (o.range === false || !m) { res.writeHead(200, { 'content-length': buf.length }).end(buf); return; }
    let start; let end;
    if (m[1] === '') { start = Math.max(0, buf.length - Number(m[2])); end = buf.length - 1; }
    else { start = Number(m[1]); end = m[2] === '' ? buf.length - 1 : Math.min(Number(m[2]), buf.length - 1); }
    if (start > end || start >= buf.length) { res.writeHead(416, { 'content-range': `bytes */${buf.length}` }).end(); return; }
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${buf.length}`, 'content-length': end - start + 1 }).end(buf.subarray(start, end + 1));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { base: `http://127.0.0.1:${addr.port}`, hits, uas, close: () => new Promise((r) => server.close(() => r(undefined))) };
}
