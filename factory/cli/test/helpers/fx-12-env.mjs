// @ts-check
/**
 * FX-12 test helpers: an isolated factory environment (temp library, index, fixture JSONL, preview cache), a fake PNG
 * header (enough for the header-only size reader) and a fixture-item writer + sync.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Set process.env for an isolated run and return the temp root. @param {string} name */
export function isolatedEnv(name) {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `factory-${name}-`));
  Object.assign(process.env, {
    FACTORY_STATE_DIR: `${TMP}/state`, FACTORY_GAMES_DIR: `${TMP}/games`, FACTORY_WORKTREES_DIR: `${TMP}/wt`,
    FACTORY_INBOX_DIR: `${TMP}/inbox`, FACTORY_ARCHIVE_DIR: `${TMP}/archive`, FACTORY_KEY_PATH: `${TMP}/key/approval.key`,
    FACTORY_CONFIG: `${TMP}/config.json`, GAME_ASSET_LIBRARY: `${TMP}/library`, GAME_ASSET_INDEX: `${TMP}/index/index.sqlite`,
    GAME_ASSET_FIXTURE: `${TMP}/fixture/items.jsonl`, GAME_ASSET_PREVIEW_CACHE: `${TMP}/preview-cache`,
  });
  fs.writeFileSync(`${TMP}/config.json`, JSON.stringify({ maxAttempts: 3, packageManager: 'corepack pnpm' }));
  return TMP;
}

/** PNG signature + IHDR with the given size (not decodable, but imageSize reads it). @param {number} w @param {number} h @param {string} [tail] */
export function fakePng(w, h, tail = '') {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return Buffer.concat([b, Buffer.from(tail)]);
}

/** Write the fixture JSONL (raw items). @param {any[]} items */
export function writeFixture(items) {
  const file = /** @type {string} */ (process.env.GAME_ASSET_FIXTURE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, items.map((i) => JSON.stringify(i)).join('\n') + '\n');
}

/** Recursive file list (relative, forward slashes) or [] when missing. @param {string} dir @returns {string[]} */
export function tree(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).replace(/\\/g, '/')).sort();
}
