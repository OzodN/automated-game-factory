// @ts-check
/**
 * CLI of the remote asset index (FX-10): `assets sources`, `assets sync <source|all>`, `assets search --remote ...`,
 * `assets show <source:item>`. Metadata only; bytes are fetched for chosen items later (FX-12 acquire/preview).
 */
import { FactoryError } from './core.mjs';
import { openIndex, searchIndex, getItem, sourceStates, indexFile, memberOf, schemaVersionOf } from './asset-index.mjs';
import { SOURCES, getSource, makeContext, syncSource } from './asset-sources/index.mjs';

const TAB = '\t';
const NL = '\n';
const NO_INDEX ='no remote index yet (the asset-producer runs: factory assets sync all)';

export async function sourcesCommand() {
  const db = await openIndex({ readonly: true });
  const st = db ? sourceStates(db) : {};
  const ver = db ? schemaVersionOf(db) : null;
  db?.close();
  const lines = Object.values(SOURCES).map((s) => {
    const x = st[s.id];
    const dropped = x && Object.values(x.dropped).reduce((a, n) => a + n, 0);
    return `${s.id}\t${s.title}\t${x ? `synced ${x.synced_at}  rev ${x.rev}  ${x.count} item(s)${dropped ? `, ${dropped} dropped` : ''}` : 'never synced'}`;
  });
  return `index: ${indexFile()}${db ? ` (schema v${ver ?? '?'})` : ` (${NO_INDEX})`}\n${lines.join('\n')}`;
}

/** @param {string | undefined} which */
export async function syncCommand(which) {
  if (!which) throw new FactoryError('sync <source|all>');
  const db = await openIndex();
  try {
    const ctx = makeContext({ index: db });
    const targets = which === 'all' ? Object.values(SOURCES) : [getSource(which)];
    const out = [`index: ${indexFile()} (schema v${schemaVersionOf(db) ?? '?'})`];
    for (const a of targets) {
      if (which === 'all' && typeof a.available === 'function' && !a.available(ctx)) { out.push(`${a.id}: skipped (not configured)`); continue; }
      ctx.rev = null;
      const r = await syncSource(db, a, ctx);
      const dropped = Object.entries(r.dropped).map(([k, n]) => `${k}=${n}`).join(', ');
      out.push(`${a.id}: ${r.count} item(s), rev ${r.rev}${dropped ? `; dropped ${dropped}` : ''}`);
    }
    return out.join('\n');
  } finally {
    db.close();
  }
}

function dims(e) {
  if (e.w && e.h) return ` ${e.w}x${e.h}`;
  if (e.duration) return ` ${Number(e.duration).toFixed(1)}s`;
  return '';
}

/** "12 KB", "~30 KB" (approximate), "?" (unknown). @param {any} e */
export function fmtBytes(e) {
  if (typeof e.bytes !== 'number') return '?';
  const v = e.bytes >= 1048576 ? `${(e.bytes / 1048576).toFixed(1)} MB` : e.bytes >= 1024 ? `${Math.round(e.bytes / 1024)} KB` : `${e.bytes} B`;
  return e.bytes_approx ? `~${v}` : v;
}

/**
 * Remote search. Default: one line per item (best member first, its formats and file count); `--files`: one line
 * per file. Columns: id, type + dims/duration, license, item title, file, [formats], size, pack / author.
 * @param {Record<string, any>} f @param {{ ids: Set<string>, authors: Set<string> }} [deny]
 */
export async function remoteSearchCommand(f, deny) {
  const db = await openIndex({ readonly: true });
  if (!db) return `0 match(es): ${NO_INDEX}`;
  try {
    const s = (k) => (typeof f[k] === 'string' ? f[k] : undefined);
    const limit = Number(f.limit || 40);
    const group = !f.files;
    const r = searchIndex(db, { type: s('type'), text: s('text'), tags: s('tags'), license: s('license'), source: s('source'), pack: s('pack'), author: s('author'), limit, group, deny });
    // Last column: the pack when it says more than the title (OGA packs repeat the item title), then the author.
    const who = (e) => [e.pack && e.pack !== e.title ? e.pack : null, e.author].filter(Boolean).join(' / ') || '-';
    const lines = r.hits.map((e) => [e.id, `${e.type || '?'}${dims(e)}`, e.license, e.title, memberOf(e) || '-',
      ...(group ? [`${e.files} file(s)${e.formats.length ? `: ${e.formats.join(',')}` : ''}`] : []), fmtBytes(e), who(e)].join(TAB));
    const head = ['id', 'type', 'license', 'title', 'file', ...(group ? ['formats'] : []), 'size', 'pack / author'].join(TAB);
    const unit = group ? 'item(s)' : 'file(s)';
    const mode = group ? 'grouped by item; --files for one line per file' : 'per file';
    return [`${r.total} matching ${unit}${r.total > r.hits.length ? `, showing ${r.hits.length}` : ''} in the remote index (${mode})`, head, ...lines].join(NL);
  } finally {
    db.close();
  }
}

/** @param {string} id */
export async function remoteShowCommand(id) {
  const db = await openIndex({ readonly: true });
  if (!db) throw new FactoryError(NO_INDEX);
  try {
    const e = getItem(db, id);
    if (!e) throw new FactoryError(`Unknown remote asset ${id}`);
    return JSON.stringify(e, null, 2);
  } finally {
    db.close();
  }
}
