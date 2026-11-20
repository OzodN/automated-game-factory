// @ts-check
/**
 * FX-12 — decompression caps of the safe extractor used for untrusted nested pack zips (SEC-04 zip bombs):
 * declared per-entry size, total budget, and an entry whose declared size lies (enforced while inflating).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildZip } from './helpers/fx-10-zip.mjs';
import { extractZip } from '../lib/zip.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fx12z-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

/** @param {string} name @param {Buffer} buf */
function put(name, buf) { const f = path.join(TMP, name); fs.writeFileSync(f, buf); return f; }

test('extractZip without limits keeps its old behaviour', () => {
  const f = put('plain.zip', buildZip([{ name: 'a.png', data: Buffer.alloc(5000), method: 8 }]));
  assert.deepEqual(extractZip(f, path.join(TMP, 'plain')), ['a.png']);
});

test('extractZip refuses an entry over the declared per-entry cap and over the total budget', () => {
  const f = put('two.zip', buildZip([{ name: 'a.wav', data: Buffer.alloc(3000), method: 8 }, { name: 'b.wav', data: Buffer.alloc(3000), method: 8 }]));
  assert.throws(() => extractZip(f, path.join(TMP, 'e1'), { maxEntryBytes: 2000 }), /Archive entry a\.wav is too large \(3000 bytes, limit 2000\)/);
  assert.throws(() => extractZip(f, path.join(TMP, 'e2'), { maxEntryBytes: 4000, maxTotalBytes: 5000 }), /Archive entry b\.wav is too large \(3000 bytes, limit 2000\)/);
  assert.deepEqual(extractZip(f, path.join(TMP, 'e3'), { maxEntryBytes: 4000, maxTotalBytes: 6000 }), ['a.wav', 'b.wav']);
});

test('extractZip stops inflating an entry whose declared size lies (bomb)', () => {
  const buf = buildZip([{ name: 'bomb.png', data: Buffer.alloc(1024 * 1024), method: 8 }]);
  const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  buf.writeUInt32LE(100, cd + 24); // central directory: uncompressed size claims 100 bytes
  buf.writeUInt32LE(100, 22); // local header too
  const f = put('bomb.zip', buf);
  assert.throws(() => extractZip(f, path.join(TMP, 'bomb'), { maxEntryBytes: 64 * 1024 }), /bomb\.png does not inflate within 65536 bytes/);
  assert.ok(!fs.existsSync(path.join(TMP, 'bomb', 'bomb.png')));
});
