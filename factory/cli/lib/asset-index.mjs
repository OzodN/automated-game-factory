// @ts-check
/**
 * Remote asset index (FX-10): one local SQLite database with the METADATA of assets from many sources, searched
 * offline with FTS5/bm25. Bytes are never stored here; they are fetched only for chosen items (FX-12).
 * Location: `<repo>/.cache/asset-index/index.sqlite` (gitignored, rebuildable by `assets sync all`), overridable
 * by env GAME_ASSET_INDEX. Writes happen only through the factory CLI (the guard refuses direct writes).
 *
 * Spike (Node 24.18, bundled SQLite 3.53): FTS5 and bm25() are compiled in, so no JSONL/BM25 fallback is needed.
 * `node:sqlite` is loaded lazily via process.getBuiltinModule (so commands that do not touch the index work on any Node) with its
 * ExperimentalWarning suppressed (older Node 22/23 lines print one; it would pollute CLI output).
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths, norm, ensureDir, nowIso, FactoryError } from './core.mjs';
import { decodeRow as decode } from './asset-search.mjs';
export { searchIndex, ftsQuery, likeContains, memberOf, RANKING_RULE } from './asset-search.mjs';

export const SCHEMA_VERSION = 3;
/** Item columns besides id (order used by inserts). */
const COLS = ['source', 'item_id', 'title', 'description', 'tags', 'type', 'ext', 'license', 'author', 'attribution', 'page_url',
  'preview_urls', 'locator', 'bytes', 'bytes_approx', 'w', 'h', 'duration', 'pack', 'post_date', 'source_rev', 'synced_at'];

export function indexFile() {
  return norm(process.env.GAME_ASSET_INDEX || `${paths().root}/.cache/asset-index/index.sqlite`);
}

/** @type {any} */
let sqliteMod = null;
function loadSqlite() {
  if (sqliteMod) return sqliteMod;
  const orig = process.emitWarning;
  process.emitWarning = /** @type {any} */ (function (w, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
    if ((type === 'ExperimentalWarning' || /** @type {any} */ (w)?.name === 'ExperimentalWarning') && /sqlite/i.test(String(w?.message ?? w))) return;
    return orig.call(process, w, ...rest);
  });
  try {
    sqliteMod = process.getBuiltinModule('node:sqlite');
    if (!sqliteMod) throw new Error('module not available');
  } catch (e) {
    throw new FactoryError(`The asset index needs node:sqlite (Node 22.13+ / 24): ${/** @type {any} */ (e).message}`);
  } finally {
    process.emitWarning = orig;
  }
  return sqliteMod;
}

/**
 * Open (and create or migrate) the index. `readonly` opens an existing file only and returns null when absent.
 * @param {{ file?: string, readonly?: boolean }} [opts]
 * @returns {any} a DatabaseSync, or null (readonly and missing)
 */
export function openIndex(opts = {}) {
  const file = opts.file || indexFile();
  const { DatabaseSync } = loadSqlite();
  if (opts.readonly && !fs.existsSync(file)) return null;
  if (!opts.readonly) ensureDir(path.dirname(file));
  const db = new DatabaseSync(file, opts.readonly ? { readOnly: true } : {});
  if (!opts.readonly) migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, source TEXT NOT NULL, item_id TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT, tags TEXT, type TEXT, ext TEXT, license TEXT NOT NULL, author TEXT, attribution TEXT, page_url TEXT,
      preview_urls TEXT, locator TEXT, bytes INTEGER, bytes_approx INTEGER, w INTEGER, h INTEGER, duration REAL, pack TEXT, post_date TEXT, source_rev TEXT, synced_at TEXT);
    CREATE INDEX IF NOT EXISTS items_source ON items(source);
    CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(title, description, tags, author, pack, tokenize = 'porter unicode61');
    CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, rev TEXT, synced_at TEXT, count INTEGER, dropped TEXT);
    CREATE TABLE IF NOT EXISTS zip_dirs (url TEXT NOT NULL, rev TEXT NOT NULL, size INTEGER, entries TEXT NOT NULL, cached_at TEXT,
      PRIMARY KEY (url, rev));`);
  // v1 -> v2: item-level post date (ISO date or null).
  const cols = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
  if (!cols.includes('post_date')) db.exec('ALTER TABLE items ADD COLUMN post_date TEXT');
  // v2 -> v3 (FX-12): bytes_approx = 1 when bytes is an estimate (e.g. OGA's "30 Kb" label), 0/null when exact.
  if (!cols.includes('bytes_approx')) db.exec('ALTER TABLE items ADD COLUMN bytes_approx INTEGER');
  // Written only when it changes (FX-13): opening an up-to-date index takes no write lock, so acquire / preview can
  // open it while a concurrent `assets sync` holds the write lock.
  if (schemaVersionOf(db) !== SCHEMA_VERSION) db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('schema', String(SCHEMA_VERSION));
}

/**
 * Replace every row of one source in a single transaction (delete source rows, insert the new ones).
 * Items must already be normalized (see asset-sources/index.mjs normalizeItem).
 * @param {any} db @param {string} source @param {string} rev @param {any[]} items @param {Record<string, number>} [dropped]
 */
export function replaceSource(db, source, rev, items, dropped = {}) {
  const at = nowIso();
  const ins = db.prepare(`INSERT INTO items (id, ${COLS.join(', ')}) VALUES (${['?', ...COLS.map(() => '?')].join(', ')})`);
  const fts = db.prepare('INSERT INTO items_fts (rowid, title, description, tags, author, pack) VALUES (?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    const probed = probedValues(db, source);
    db.prepare('DELETE FROM items_fts WHERE rowid IN (SELECT rowid FROM items WHERE source = ?)').run(source);
    db.prepare('DELETE FROM items WHERE source = ?').run(source);
    for (const it of items) {
      const row = { ...it, ...carryOver(probed.get(it.id), it), source, source_rev: rev, synced_at: at };
      const r = ins.run(it.id, ...COLS.map((c) => dbValue(c, row[c])));
      fts.run(r.lastInsertRowid, it.title, it.description || '', (it.tags || []).join(' '), it.author || '', it.pack || '');
    }
    db.prepare('INSERT OR REPLACE INTO sources (id, rev, synced_at, count, dropped) VALUES (?, ?, ?, ?, ?)')
      .run(source, rev, at, items.length, JSON.stringify(dropped));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { count: items.length, syncedAt: at };
}

/**
 * w/h/duration are measured after acquire or preview (updateMedia), not at sync. A re-sync keeps them for the same id
 * unless the new row says the bytes changed (exact sizes differ).
 * @param {any} db @param {string} source @returns {Map<string, any>}
 */
function probedValues(db, source) {
  const rows = db.prepare('SELECT id, w, h, duration, bytes, bytes_approx FROM items WHERE source = ? AND (w IS NOT NULL OR h IS NOT NULL OR duration IS NOT NULL)').all(source);
  return new Map(rows.map((r) => [r.id, r]));
}

/** @param {any} old @param {any} it */
function carryOver(old, it) {
  if (!old) return {};
  const changed = it.bytes != null && !it.bytes_approx && old.bytes != null && !old.bytes_approx && Number(old.bytes) !== Number(it.bytes);
  if (changed) return {};
  return { w: it.w ?? old.w, h: it.h ?? old.h, duration: it.duration ?? old.duration };
}

/**
 * Write measured media facts back to one index row (FX-12: acquire and preview). Only given, finite values are
 * written; an exact byte count clears the approximate flag.
 * @param {any} db @param {string} id @param {{ w?: number | null, h?: number | null, duration?: number | null, bytes?: number | null }} m
 * @returns {boolean} true when a row was updated
 */
export function updateMedia(db, id, m) {
  const set = [];
  const args = [];
  for (const k of /** @type {const} */ (['w', 'h', 'duration', 'bytes'])) {
    const v = m[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) { set.push(`${k} = ?`); args.push(k === 'duration' ? v : Math.round(v)); }
  }
  if (typeof m.bytes === 'number' && Number.isFinite(m.bytes)) set.push('bytes_approx = 0');
  if (!set.length) return false;
  return Number(db.prepare(`UPDATE items SET ${set.join(', ')} WHERE id = ?`).run(...args, id).changes) > 0;
}

/** All rows of one item (`<source>:<item_id>` without a member), member preference order. @param {any} db @param {string} source @param {string} itemId */
export function getItemMembers(db, source, itemId) {
  return db.prepare('SELECT * FROM items WHERE source = ? AND item_id = ? ORDER BY id').all(source, itemId).map(decode);
}

function dbValue(col, v) {
  if (v === undefined || v === null) return null;
  if (col === 'bytes_approx') return v ? 1 : 0;
  if (col === 'tags' || col === 'preview_urls' || col === 'locator') return JSON.stringify(v);
  return v;
}

/** @param {any} db @param {string} id */
export function getItem(db, id) {
  return decode(db.prepare('SELECT * FROM items WHERE id = ?').get(id));
}

/** Schema version stored in the index (meta.schema), or null when unknown. @param {any} db @returns {number | null} */
export function schemaVersionOf(db) {
  try {
    const r = db.prepare("SELECT v FROM meta WHERE k = 'schema'").get();
    return r ? Number(r.v) : null;
  } catch { return null; }
}

/** @param {any} db @returns {Record<string, {rev: string, synced_at: string, count: number, dropped: Record<string, number>}>} */
export function sourceStates(db) {
  const out = {};
  for (const r of db.prepare('SELECT * FROM sources').all()) out[r.id] = { rev: r.rev, synced_at: r.synced_at, count: Number(r.count), dropped: JSON.parse(r.dropped || '{}') };
  return out;
}

/** Cached central directory of a remote zip (keyed by url + rev), or null. */
export function zipDirGet(db, url, rev) {
  const r = db.prepare('SELECT size, entries FROM zip_dirs WHERE url = ? AND rev = ?').get(url, rev);
  return r ? { size: Number(r.size), entries: JSON.parse(r.entries) } : null;
}

export function zipDirPut(db, url, rev, size, entries) {
  db.prepare('INSERT OR REPLACE INTO zip_dirs (url, rev, size, entries, cached_at) VALUES (?, ?, ?, ?, ?)')
    .run(url, rev, size, JSON.stringify(entries), nowIso());
}
