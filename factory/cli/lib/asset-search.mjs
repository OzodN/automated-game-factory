// @ts-check
/**
 * Ranked search over the remote asset index (FX-10, grouping and tie-break FX-12).
 *
 * Ranking rule (printed by `assets search --help`): bm25 over the FTS columns with the weights title 10, tags 4,
 * author 2, pack 2, description 1 (lower is better). Ties are broken by: more query words in the title, then in the
 * tags, then in the description; then CC0-like licenses before attribution licenses; then smaller bytes (unknown
 * sizes last); then id. Without text: CC0-like first, then title, then id.
 *
 * Grouping (`group: true`, the CLI default): one hit per index item (`<source>:<item_id>`), represented by its best
 * matching member: single media files before archives, then ogg > mp3 > wav > flac for audio and png > webp > jpg for
 * images, then smaller bytes. Each group lists the formats and file count of its matching members.
 */
import { CC0_LIKE } from './asset-policy.mjs';

/** bm25 weights per FTS column: title, description, tags, author, pack. */
const BM25 = 'bm25(items_fts, 10.0, 1.0, 4.0, 2.0, 2.0)';
const LIKE_ESCAPE = "ESCAPE '\\'";
/** Member preference inside an item (lower is better). */
export const FORMAT_RANK = { ogg: 0, mp3: 1, wav: 2, flac: 3, m4a: 4, png: 0, webp: 1, jpg: 2, jpeg: 2, gif: 3, svg: 0 };
/** ORDER BY of members inside one item, for table alias `t`. @param {string} t */
const memberOrder = (t) => `(${t}.type = 'pack'), CASE lower(coalesce(${t}.ext, '')) ${Object.entries(FORMAT_RANK).map(([k, v]) => `WHEN '${k}' THEN ${v}`).join(' ')} ELSE 9 END, (${t}.bytes IS NULL), ${t}.bytes, ${t}.id`;

export const RANKING_RULE = 'bm25 (weights: title 10, tags 4, author 2, pack 2, description 1); ties: more query words in title > tags > description, ' +
  'then CC0-like before attribution licenses, then smaller bytes (unknown last), then id. Without --text: CC0-like first, then title.';

/** FTS5 query from free text: every word quoted (no operator injection); all words (AND) or any word (OR). */
export function ftsQuery(text, mode = 'AND') {
  const words = String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return words.map((w) => `"${w}"`).join(mode === 'AND' ? ' ' : ' OR ');
}

/** LIKE pattern matching `text` as a literal, case-folded substring: backslash, percent and underscore are escaped (use with ESCAPE). */
export function likeContains(text) {
  return `%${String(text).toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
}

/** @param {any} row */
function decode(row) {
  if (!row) return null;
  const out = { ...row };
  for (const k of ['tags', 'preview_urls', 'locator']) out[k] = row[k] ? JSON.parse(row[k]) : (k === 'locator' ? null : []);
  if ('bytes_approx' in out) out.bytes_approx = !!out.bytes_approx;
  for (const k of Object.keys(out)) if (k.startsWith('_') || k === 'rank') delete out[k];
  return out;
}
export { decode as decodeRow };

/** Filters shared by every query: [where[], args[]]. @param {any} q */
function filters(q) {
  const where = [];
  const args = [];
  if (q.type) { where.push('i.type = ?'); args.push(q.type); }
  if (q.license === 'cc0') { where.push(`i.license IN (${CC0_LIKE.map(() => '?').join(', ')})`); args.push(...CC0_LIKE); }
  else if (q.license && q.license !== 'any') { where.push('i.license = ?'); args.push(q.license); }
  if (q.source) { where.push('i.source = ?'); args.push(q.source); }
  if (q.pack) { where.push(`lower(i.pack) LIKE ? ${LIKE_ESCAPE}`); args.push(likeContains(q.pack)); }
  if (q.author) { where.push(`lower(i.author) LIKE ? ${LIKE_ESCAPE}`); args.push(likeContains(q.author)); }
  for (const t of (q.tags || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) { where.push(`lower(i.tags) LIKE ? ${LIKE_ESCAPE}`); args.push(likeContains(t)); }
  const ids = [...(q.deny?.ids || [])];
  if (ids.length) {
    const ph = ids.map(() => '?').join(', ');
    where.push(`NOT (i.id IN (${ph}) OR (i.source || ':' || i.item_id) IN (${ph}))`);
    args.push(...ids, ...ids);
  }
  const authors = [...(q.deny?.authors || [])].map((a) => String(a).toLowerCase());
  if (authors.length) { where.push(`lower(coalesce(i.author, '')) NOT IN (${authors.map(() => '?').join(', ')})`); args.push(...authors); }
  return { where, args };
}

/** Score + tie-break columns (`_s`, `_th`, `_gh`, `_dh`, `_cc0`) and their ORDER BY. @param {string | null} match @param {string[]} words */
function rankColumns(match, words) {
  const hits = (col) => (words.length ? words.map(() => `(lower(coalesce(${col}, '')) LIKE ? ${LIKE_ESCAPE})`).join(' + ') : '0');
  const cols = `${match ? BM25 : '0'} AS _s, ${hits('i.title')} AS _th, ${hits('i.tags')} AS _gh, ${hits('i.description')} AS _dh, ` +
    `(i.license IN (${CC0_LIKE.map((l) => `'${l}'`).join(', ')})) AS _cc0`;
  const args = [];
  for (let k = 0; k < 3; k++) args.push(...words.map(likeContains));
  const order = match ? '_s, _th DESC, _gh DESC, _dh DESC, _cc0 DESC, (bytes IS NULL), bytes, id' : '_cc0 DESC, title COLLATE NOCASE, id';
  return { cols, args, order };
}

/**
 * Ranked search. Filters: type, license ('cc0' | 'any' | SPDX), source, pack (substring), author (substring),
 * tags (comma list, each must occur), text (FTS5 bm25; all words first, any word when that finds nothing),
 * deny ({ ids, authors }: denylisted remote ids / item ids / authors are skipped). `group` collapses members of one
 * item (see the module comment); hits then carry `files` (count) and `formats` (best first).
 * @param {any} db
 * @param {{ type?: string, license?: string, source?: string, pack?: string, author?: string, tags?: string, text?: string, limit?: number, group?: boolean, deny?: { ids?: Iterable<string>, authors?: Iterable<string> } }} q
 * @returns {{ total: number, hits: any[] }}
 */
export function searchIndex(db, q) {
  const limit = Math.max(1, Math.min(1000, Number(q.limit) || 40));
  const words = q.text ? String(q.text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [] : [];
  const run = (match) => {
    const { where, args } = filters(q);
    let from = 'items i';
    if (match) { from = 'items_fts JOIN items i ON i.rowid = items_fts.rowid'; where.unshift('items_fts MATCH ?'); args.unshift(match); }
    const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rk = rankColumns(match, words);
    const base = { from, cond, args, rk };
    return q.group ? groupedRun(db, base, limit) : flatRun(db, base, limit);
  };
  if (!q.text || !ftsQuery(q.text)) return run(null);
  const all = run(ftsQuery(q.text, 'AND'));
  return all.total || ftsQuery(q.text, 'AND') === ftsQuery(q.text, 'OR') ? all : run(ftsQuery(q.text, 'OR'));
}

/** @param {any} db @param {{ from: string, cond: string, args: any[], rk: ReturnType<typeof rankColumns> }} b @param {number} limit */
function flatRun(db, b, limit) {
  const total = Number(db.prepare(`SELECT count(*) AS n FROM ${b.from} ${b.cond}`).get(...b.args).n);
  const sql = `SELECT * FROM (SELECT i.*, ${b.rk.cols} FROM ${b.from} ${b.cond}) ORDER BY ${b.rk.order} LIMIT ${limit}`;
  return { total, hits: db.prepare(sql).all(...b.rk.args, ...b.args).map(decode) };
}

/** @param {any} db @param {{ from: string, cond: string, args: any[], rk: ReturnType<typeof rankColumns> }} b @param {number} limit */
function groupedRun(db, b, limit) {
  const total = Number(db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM ${b.from} ${b.cond} GROUP BY i.source, i.item_id)`).get(...b.args).n);
  // bm25() cannot run in a query with window functions: score in the inner query, number members one level up.
  const sql = `SELECT * FROM (SELECT m.*,
      ROW_NUMBER() OVER (PARTITION BY m.source, m.item_id ORDER BY ${memberOrder('m')}) AS _rn,
      COUNT(*) OVER (PARTITION BY m.source, m.item_id) AS _files
    FROM (SELECT i.*, ${b.rk.cols} FROM ${b.from} ${b.cond}) m) WHERE _rn = 1 ORDER BY ${b.rk.order} LIMIT ${limit}`;
  const rows = db.prepare(sql).all(...b.rk.args, ...b.args);
  const keys = rows.map((r) => `${r.source}:${r.item_id}`);
  /** @type {Map<string, string[]>} */
  const formats = new Map();
  if (keys.length) {
    const fsql = `SELECT i.source, i.item_id, i.ext FROM ${b.from} ${b.cond}${b.cond ? ' AND' : ' WHERE'} (i.source || ':' || i.item_id) IN (${keys.map(() => '?').join(', ')}) ORDER BY ${memberOrder('i')}`;
    for (const r of db.prepare(fsql).all(...b.args, ...keys)) {
      const k = `${r.source}:${r.item_id}`;
      const list = formats.get(k) || [];
      const ext = r.ext;
      if (ext && !list.includes(ext)) list.push(ext);
      formats.set(k, list);
    }
  }
  return { total, hits: rows.map((r) => ({ ...decode(r), files: Number(r._files), formats: formats.get(`${r.source}:${r.item_id}`) || [] })) };
}

/** Member (file) part of an index id: `<source>:<item_id>/<member>` -> `<member>`, or '' for item-level rows. @param {{ id: string, source: string, item_id: string }} e */
export function memberOf(e) {
  const prefix = `${e.source}:${e.item_id}/`;
  return e.id.startsWith(prefix) ? e.id.slice(prefix.length) : '';
}
