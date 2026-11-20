// @ts-check
/**
 * `fixture` source: items from a local JSONL file named by env GAME_ASSET_FIXTURE (one raw item per line; see
 * index.mjs for the fields). Used by the factory tests and for trying the index without network. Revision = the
 * file's sha256 prefix. `fetch` supports locators `{ zip_url, member }` (remote zip via Range) and `{ file }` (a path
 * relative to the JSONL file's folder).
 */
import fs from 'node:fs';
import path from 'node:path';
import { sha256File, FactoryError, ensureDir } from '../core.mjs';
import { readRemoteMember } from '../remote-zip.mjs';
import { safeFileName } from './oga-hf-util.mjs';

export const id = 'fixture';
export const title = 'Local JSONL fixture (tests; env GAME_ASSET_FIXTURE)';
export const license = { allowed: ['CC0-1.0', 'Unlicense', 'OFL-1.1', 'MIT', 'Apache-2.0', 'CC-BY-3.0', 'CC-BY-4.0'] };

/** @param {any} ctx */
export function available(ctx) {
  return !!ctx.env.GAME_ASSET_FIXTURE;
}

/** @param {any} ctx */
export function sync(ctx) {
  const file = ctx.env.GAME_ASSET_FIXTURE;
  if (!file || !fs.existsSync(file)) throw new FactoryError('fixture source: set GAME_ASSET_FIXTURE to a JSONL file');
  ctx.setRev(sha256File(file).slice(0, 12));
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { out.push(null); }
  }
  return out;
}

/**
 * Download the bytes of one item into destDir (file name = the member's base name). Returns the written path.
 * @param {any} item normalized index item @param {string} destDir @param {any} ctx
 */
export async function fetch(item, destDir, ctx) {
  const loc = item.locator || {};
  ensureDir(destDir);
  if (typeof loc.zip_url === 'string' && typeof loc.member === 'string') {
    const { data } = await readRemoteMember(loc.zip_url, loc.member, { index: ctx.index || undefined, rev: item.source_rev || undefined, fetch: ctx.fetch, maxBytes: ctx.maxMemberBytes });
    const out = path.join(destDir, safeFileName(path.basename(loc.member)));
    fs.writeFileSync(out, data);
    return out;
  }
  if (typeof loc.file === 'string' && ctx.env.GAME_ASSET_FIXTURE) {
    const base = path.dirname(path.resolve(ctx.env.GAME_ASSET_FIXTURE));
    const src = path.resolve(base, loc.file);
    if (!src.startsWith(base + path.sep)) throw new FactoryError(`fixture locator escapes the fixture folder: ${loc.file}`);
    const out = path.join(destDir, path.basename(src));
    fs.copyFileSync(src, out);
    return out;
  }
  throw new FactoryError(`fixture item ${item.id} has no usable locator`);
}
