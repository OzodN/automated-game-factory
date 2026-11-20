// @ts-check
/**
 * Asset source registry and sync (FX-10). Each adapter module exports
 *   { id, title, license: { allowed: SPDX[] }, available?(ctx) -> boolean, sync(ctx) -> AsyncIterable<item> | item[],
 *     fetch(item, destDir, ctx) }
 * `sync` yields METADATA only; the adapter may call `ctx.setRev(rev)` (e.g. a pinned dataset commit). `fetch`
 * downloads the bytes of one chosen item (used by FX-12 acquire). Items whose license is not allowed by factory policy
 * (asset-policy.mjs, AS-02) or by the adapter's own `license.allowed` are dropped at sync time and counted.
 *
 * Raw item fields: item_id (required), member (optional: file inside a pack/zip; becomes `<source>:<item_id>/<member>`),
 * title (required), description, tags (array or comma string), type, ext, license (SPDX, required), author,
 * attribution, page_url, preview_urls (array), locator (object: how fetch finds the bytes), bytes, bytes_approx (true when
 * bytes is an estimate), w, h, duration, pack,
 * post_date (ISO date string).
 * Adapters that drop things themselves (before yielding) report them with `ctx.drop(reason, n)`; the counts are merged
 * into the sync result next to the drops decided here.
 */
import { httpFetch, USER_AGENT } from './http.mjs';
import { licenseAllowed, TYPE_BY_EXT } from '../asset-policy.mjs';
import { replaceSource } from '../asset-index.mjs';
import { FactoryError, nowIso } from '../core.mjs';
import * as fixture from './fixture.mjs';
import { ogaCc0, ogaCcBy3, ogaCcBy4 } from './oga-hf.mjs';

/** @type {Record<string, any>} */
export const SOURCES = { [fixture.id]: fixture, [ogaCc0.id]: ogaCc0, [ogaCcBy3.id]: ogaCcBy3, [ogaCcBy4.id]: ogaCcBy4 };

/** @param {string} id */
export function getSource(id) {
  const s = Object.prototype.hasOwnProperty.call(SOURCES, id) ? SOURCES[id] : null;
  if (!s) throw new FactoryError(`Unknown asset source "${id}". Known: ${Object.keys(SOURCES).join(', ')}`);
  return s;
}

/**
 * Context handed to adapters. Tokens come from the environment only and are never logged (SEC-01).
 * @param {{ index?: any, env?: Record<string, string | undefined>, fetch?: Function }} [o]
 */
export function makeContext(o = {}) {
  const env = o.env || process.env;
  const ctx = {
    userAgent: USER_AGENT,
    index: o.index || null,
    env,
    rev: /** @type {string | null} */ (null),
    dropped: /** @type {Record<string, number>} */ ({}),
    /** @param {string} reason @param {number} [n] */
    drop: (reason, n = 1) => { ctx.dropped[reason] = (ctx.dropped[reason] || 0) + n; },
    /** @param {string} url @param {any} [opts] */
    fetch: (url, opts) => (o.fetch || httpFetch)(url, opts),
    /** @param {string} name env variable holding an optional API token */
    token: (name) => (typeof env[name] === 'string' && env[name] ? String(env[name]) : null),
    /** @param {string} rev */
    setRev: (rev) => { ctx.rev = String(rev); },
  };
  return ctx;
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * Normalize one raw adapter item. Returns `{ item }` or `{ drop: reason }`.
 * @param {string} source @param {any} raw @param {string[]} [allowed] adapter license allow-list
 */
export function normalizeItem(source, raw, allowed) {
  if (!raw || typeof raw !== 'object') return { drop: 'invalid' };
  const itemId = str(raw.item_id) || (typeof raw.item_id === 'number' ? String(raw.item_id) : null);
  const title = str(raw.title);
  if (!itemId || !title) return { drop: 'invalid' };
  const license = str(raw.license);
  if (!license || !licenseAllowed(license) || (allowed && !allowed.includes(license))) return { drop: `license:${license || 'missing'}` };
  const member = str(raw.member);
  const ext = (str(raw.ext) || (member || '').split('.').pop() || '').toLowerCase().replace(/^\./, '') || null;
  const tags = (Array.isArray(raw.tags) ? raw.tags : typeof raw.tags === 'string' ? raw.tags.split(',') : [])
    .map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  const item = {
    id: `${source}:${itemId}${member ? `/${member}` : ''}`,
    item_id: itemId,
    title,
    description: str(raw.description),
    tags: [...new Set(tags)],
    type: str(raw.type) || (ext && /** @type {Record<string, string>} */ (TYPE_BY_EXT)[ext]) || null,
    ext,
    license,
    author: str(raw.author),
    attribution: str(raw.attribution),
    page_url: str(raw.page_url),
    preview_urls: Array.isArray(raw.preview_urls) ? raw.preview_urls.filter((u) => typeof u === 'string') : [],
    locator: raw.locator && typeof raw.locator === 'object' ? raw.locator : null,
    bytes: num(raw.bytes), bytes_approx: num(raw.bytes) !== null && raw.bytes_approx === true, w: num(raw.w), h: num(raw.h), duration: num(raw.duration),
    pack: str(raw.pack),
    post_date: str(raw.post_date),
  };
  return { item };
}

/**
 * Sync one source: collect its items, drop disallowed/invalid/duplicate ones, replace the source's rows.
 * @param {any} db @param {any} adapter @param {ReturnType<typeof makeContext>} ctx
 * @returns {Promise<{ source: string, rev: string, count: number, dropped: Record<string, number> }>}
 */
export async function syncSource(db, adapter, ctx) {
  const items = [];
  ctx.dropped = {};
  const dropped = /** @type {Record<string, number>} */ ({});
  const seen = new Set();
  for await (const raw of await adapter.sync(ctx)) {
    const r = normalizeItem(adapter.id, raw, adapter.license?.allowed);
    const reason = r.drop || (seen.has(r.item?.id) ? 'duplicate' : null);
    if (reason || !r.item) { dropped[reason || 'invalid'] = (dropped[reason || 'invalid'] || 0) + 1; continue; }
    seen.add(r.item.id);
    items.push(r.item);
  }
  for (const [k, n] of Object.entries(ctx.dropped)) dropped[k] = (dropped[k] || 0) + n;
  ctx.dropped = {};
  const rev = ctx.rev || `synced-${nowIso()}`;
  replaceSource(db, adapter.id, rev, items, dropped);
  return { source: adapter.id, rev, count: items.length, dropped };
}
