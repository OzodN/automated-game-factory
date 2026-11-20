// @ts-check
/**
 * Asset denylist (FX-12): `<library>/catalog/denylist.jsonl`, append-only lines
 * `{ kind: 'id' | 'author', value, reason, at }`. A denied remote id is either a whole item (`<source>:<item_id>`) or one
 * member (`<source>:<item_id>/<member>`); a denied author matches case-insensitively. `assets search` (library and
 * remote) skips denied entries; `assets acquire` and `assets pull` refuse them (FX-13). Typical reasons: ripped or third-party content found during the
 * AS-04 page check, a license that changed on the live page.
 */
import { readJsonl, appendJsonl, FactoryError, nowIso } from './core.mjs';

/** Remote index ids are `<source>:<item_id>[/<member>]`. */
export const REMOTE_ID_RE = /^[a-z0-9][a-z0-9._-]*:[^/]/i;

/** @param {string} root library root */
export function denyFile(root) { return `${root}/catalog/denylist.jsonl`; }

/**
 * @param {string} root
 * @returns {{ ids: Set<string>, authors: Set<string>, entries: any[] }}
 */
export function loadDeny(root) {
  const entries = readJsonl(denyFile(root)).filter((e) => e && typeof e.value === 'string');
  return {
    ids: new Set(entries.filter((e) => e.kind === 'id').map((e) => e.value)),
    authors: new Set(entries.filter((e) => e.kind === 'author').map((e) => e.value.toLowerCase())),
    entries,
  };
}

/**
 * Why a remote row or library entry is denied, or null.
 * @param {ReturnType<typeof loadDeny>} deny @param {{ id?: string | null, source?: string | null, item_id?: string | null, author?: string | null }} e
 */
export function deniedReason(deny, e) {
  // The row id itself, and its item id (`<source>:<item_id>`, given or cut at the first `/` after the colon).
  const itemOf = (id) => (id && REMOTE_ID_RE.test(id) ? id.replace(/^([^:]+:[^/]+)\/.*$/, '$1') : null);
  const ids = [e.id, e.source && e.item_id ? `${e.source}:${e.item_id}` : itemOf(e.id)].filter(Boolean);
  const hit = deny.entries.find((d) => (d.kind === 'id' && ids.includes(d.value)) || (d.kind === 'author' && e.author && d.value.toLowerCase() === e.author.toLowerCase()));
  return hit ? `${hit.kind} ${hit.value} is denylisted: ${hit.reason}` : null;
}

/**
 * `assets deny <remote-id|author> --reason "..." [--author]`: a value shaped like a remote id is an id, anything else
 * (or any value with --author) an author name.
 * @param {string} root @param {string | undefined} value @param {Record<string, any>} f
 */
export function denyCommand(root, value, f) {
  if (!value) throw new FactoryError('deny <remote-id|author> --reason "<why>" [--author]');
  if (typeof f.reason !== 'string' || f.reason.trim().length < 5) throw new FactoryError('--reason is required (what was found, e.g. "ripped sprites from a commercial game")');
  const kind = f.author === true || !REMOTE_ID_RE.test(value) ? 'author' : 'id';
  const deny = loadDeny(root);
  if (kind === 'id' ? deny.ids.has(value) : deny.authors.has(value.toLowerCase())) return `${kind} ${value} is already denylisted`;
  appendJsonl(denyFile(root), { kind, value, reason: f.reason.trim(), at: nowIso() });
  return `Denylisted ${kind} ${value} (${denyFile(root)}). search skips it, acquire and pull refuse it from now on.`;
}
