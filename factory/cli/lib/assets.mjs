// @ts-check
/**
 * Reusable asset library (CC0-first) — lives on Google Drive for desktop (GAME_ASSET_LIBRARY) or a
 * local fallback. Every asset carries provenance + license; games receive a license ledger and
 * auto-generated credits when assets are pulled. Downloads are treated as untrusted data:
 * extracted to quarantine, only media/data types are admitted, nothing is ever executed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { paths, readJson, readJsonl, appendJsonl, writeJsonAtomic, writeTextAtomic, ensureDir, listFiles, sha256File, FactoryError, loadConfig, nowIso, norm } from './core.mjs';
import { imageSize } from './game.mjs';
import { loadState, resolveGame } from './state.mjs';

import { LICENSES, REJECT_RE, CC0_LIKE, TYPE_BY_EXT } from './asset-policy.mjs';
import * as R from './asset-remote.mjs';
import { acquireCommand, MAX_ACQUIRE_MB } from './asset-acquire.mjs';
import { previewCommand } from './asset-preview.mjs';
import { denyCommand, loadDeny, deniedReason, REMOTE_ID_RE } from './asset-denylist.mjs';
import { RANKING_RULE } from './asset-search.mjs';
import { statsText } from './asset-stats.mjs';
export { LICENSES, REJECT_RE };

// Remote index ids are `<source>:<item_id>[/<member>]` (REMOTE_ID_RE); library ids are `<source>/<pack>/<file>`.

export function libraryRoot() {
  const configured = process.env.GAME_ASSET_LIBRARY || loadConfig().assetLibrary;
  const root = norm(configured || `${paths().root}/.cache/asset-library`);
  return { root, fallback: !configured };
}

function catalogFile(root) { return `${root}/catalog/catalog.jsonl`; }

export async function assetsCommand(pos, flags) {
  const [sub, ...rest] = pos;
  const { root, fallback } = libraryRoot();
  if (flags.help && sub !== 'search') return assetsHelp(); // FX-13: `assets <cmd> --help` only prints help
  const warn = fallback ? '\n(note: GAME_ASSET_LIBRARY not set — using local fallback library; set it to any local folder, optionally a synced drive such as Google Drive)' : '';
  switch (sub) {
    case 'where': return `asset library: ${root}${warn}`;
    case 'ingest': return ingest(root, rest[0], flags) + warn;
    case 'verify': return verifyPack(root, rest[0], flags);
    case 'search':
      if (flags.help) return SEARCH_HELP;
      return flags.remote ? R.remoteSearchCommand(flags, loadDeny(root)) : search(root, flags);
    case 'acquire': return acquireCommand(root, rest, flags);
    case 'preview': return previewCommand(root, rest, flags);
    case 'deny': return denyCommand(root, rest[0], flags);
    case 'show': return REMOTE_ID_RE.test(rest[0] || '') ? R.remoteShowCommand(rest[0]) : show(root, rest[0]);
    case 'sources': return R.sourcesCommand();
    case 'sync': return R.syncCommand(rest[0]);
    case 'pull': return pull(root, rest, flags);
    case 'stats': return stats(root) + warn;
    case 'reindex': return reindex(root);
    case undefined: case 'help': return assetsHelp();
    default: throw new FactoryError(`Unknown assets command ${sub}`);
  }
}

function assetsHelp() {
  return `factory assets <cmd>   (every subcommand accepts --help)
  where
  ingest <dir|zip> --source <src> --pack <pack-id> --license <SPDX> --author "<name>" --url <source-url> [--tags a,b] [--style s] [--attribution "<text>"]
  verify <source/pack> --evidence "<what the license file says and where>"
  (add --test-only to ingest validation-only packs; pulling them needs --allow-test-only and blocks release/publication)
  search [--type sprite|vector|audio|font|model|data] [--tags a,b] [--text q] [--license cc0|any] [--verified] [--limit 40]
  show <asset-id | source/pack>
  pull <asset-id...> --task <TASK-ID> [--game g] [--dest assets/<subdir>]
  stats                       totals, per source and per pack (verified / declared files)
  reindex                     rebuild catalog.jsonl from the PACK.json manifests only (never opens media files)
Remote index (metadata of many sources, searched offline; bytes are fetched only for chosen items)
  sources                     registered sources with last sync, revision and item count
  sync <source|all>           refresh a source's metadata in the index (asset-producer)
${SEARCH_HELP}
  show <source:item[/member]> full index record incl. locator
  acquire <remote-id...> [--pack-as <source>/<pack>] [--max-mb n<=${MAX_ACQUIRE_MB}]
                              fetch into quarantine, admit media only, write an append-only library pack (verification:
                              declared; then check the page and run verify). Idempotent per remote id. (asset-producer)
  preview <ids...> --out <file.png> [--cols 6] [--size 128]
                              contact sheet (images) / waveforms + duration, LUFS, peak (audio); legend next to the png
  deny <remote-id|author> --reason "<why>" [--author]   denylist; search, acquire and pull refuse it (asset-producer)`;
}

const SEARCH_HELP = `  search --remote [--type t] [--text q] [--tags a,b] [--license cc0|any] [--source s] [--pack p] [--author a] [--limit 40] [--files]
                              one line per item by default (best member first: single files before archives,
                              ogg>mp3>wav>flac, png>webp>jpg; its formats and file count); --files: one line per file.
                              columns: id, type + dims/duration, license, item title, file, [formats], size (~ = estimate), pack / author
                              ranking: ${RANKING_RULE}
                              denylisted ids/authors (assets deny) are skipped`;

function ingest(root, src, f) {
  for (const k of ['source', 'pack', 'license', 'author', 'url']) if (typeof f[k] !== 'string') throw new FactoryError(`--${k} is required (provenance is mandatory)`);
  const lic = LICENSES[f.license];
  if (!lic || REJECT_RE.test(f.license)) throw new FactoryError(`License "${f.license}" is not allowed by factory policy. Allowed: ${Object.keys(LICENSES).join(', ')}.`);
  if (lic.attribution && typeof f.attribution !== 'string') throw new FactoryError(`${f.license} requires attribution: pass --attribution "<exact credit line>"`);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(f.source) || !/^[a-z0-9][a-z0-9._-]*$/i.test(f.pack)) throw new FactoryError('source/pack ids must be simple slugs');
  if (!src || !fs.existsSync(src)) throw new FactoryError(`Input not found: ${src}`);
  const packDir = `${root}/packs/${f.source}/${f.pack}`;
  if (fs.existsSync(packDir)) throw new FactoryError(`Pack ${f.source}/${f.pack} already exists; ingest is append-only (use a new pack id for a new version).`);
  const quarantine = ensureDir(`${root}/_quarantine/${f.source}-${f.pack}-${Date.now()}`);
  if (fs.statSync(src).isDirectory()) fs.cpSync(src, quarantine, { recursive: true });
  else if (/\.zip$/i.test(src)) {
    const r = spawnSync('tar', ['-xf', path.resolve(src), '-C', quarantine], { encoding: 'utf8' });
    if (r.status !== 0) throw new FactoryError(`Could not extract ${src}: ${r.stderr}`);
  } else throw new FactoryError('Input must be a directory or .zip');
  const accepted = [];
  const rejected = [];
  for (const rel of listFiles(quarantine)) {
    const ext = rel.split('.').pop()?.toLowerCase() || '';
    if (!TYPE_BY_EXT[ext] || /(^|\/)(__MACOSX|\.DS_Store)/.test(rel)) { rejected.push(rel); continue; }
    accepted.push(rel);
  }
  ensureDir(packDir);
  const tagsBase = typeof f.tags === 'string' ? f.tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) : [];
  const entries = [];
  for (const rel of accepted) {
    const safeRel = rel.replace(/[^A-Za-z0-9._/-]+/g, '_');
    const dest = `${packDir}/${safeRel}`;
    ensureDir(path.dirname(dest));
    fs.copyFileSync(`${quarantine}/${rel}`, dest);
    const ext = rel.split('.').pop().toLowerCase();
    const type = TYPE_BY_EXT[ext];
    if (type === 'doc') continue;
    const e = {
      id: `${f.source}/${f.pack}/${safeRel}`,
      pack: `${f.source}/${f.pack}`,
      file: `packs/${f.source}/${f.pack}/${safeRel}`,
      type, ext,
      tags: [...new Set([...tagsBase, ...safeRel.toLowerCase().split(/[\/_.\-\s]+/).filter((w) => w.length > 2 && !/^\d+$/.test(w) && w !== ext)])],
      style: typeof f.style === 'string' ? f.style : null,
      bytes: fs.statSync(dest).size,
      sha256: sha256File(dest),
      license: f.license,
      author: f.author,
      url: f.url,
      attribution: lic.attribution ? f.attribution : null,
      testOnly: !!f['test-only'],
    };
    if (type === 'sprite' && ['png', 'jpg', 'jpeg'].includes(ext)) { const d = imageSize(dest); if (d) Object.assign(e, { w: d.w, h: d.h }); }
    entries.push(e);
  }
  writeJsonAtomic(`${packDir}/PACK.json`, {
    source: f.source, pack: f.pack, license: f.license, author: f.author, url: f.url, attribution: f.attribution || null,
    style: f.style || null, tags: tagsBase, ingestedAt: nowIso(), verification: 'declared', fileCount: entries.length, rejected,
    testOnly: !!f['test-only'],
    // Per-file catalog entries (FX-10): `reindex` rebuilds catalog.jsonl from these without opening any media file.
    files: entries,
  });
  for (const e of entries) appendJsonl(catalogFile(root), e);
  fs.rmSync(quarantine, { recursive: true, force: true });
  return `Ingested ${entries.length} assets into ${f.source}/${f.pack} (license ${f.license}, verification: declared). Rejected ${rejected.length} non-media file(s)${rejected.length ? `: ${rejected.slice(0, 8).join(', ')}` : ''}.\nNext: inspect the pack's license file and run: factory assets verify ${f.source}/${f.pack} --evidence "..."`;
}

function verifyPack(root, pack, f) {
  const file = `${root}/packs/${pack}/PACK.json`;
  if (!fs.existsSync(file)) throw new FactoryError(`Unknown pack ${pack}`);
  if (typeof f.evidence !== 'string' || f.evidence.length < 15) throw new FactoryError('--evidence must describe the license proof (file name + statement, or URL)');
  const p = readJson(file);
  p.verification = 'verified';
  p.verificationEvidence = f.evidence;
  for (const e of Array.isArray(p.files) ? p.files : []) if (e?.provenance) e.provenance.verification = 'verified';
  p.verifiedAt = nowIso();
  writeJsonAtomic(file, p);
  return `Pack ${pack} license marked verified.`;
}

/**
 * Catalog entries with their EFFECTIVE verification. PACK.json is authoritative: `assets verify` updates only the
 * manifest, while catalog lines are append-only and keep the value from ingest/acquire time. Both `verification` and
 * `provenance.verification` (acquired packs) are therefore taken from PACK.json here (FX-13).
 */
export function loadCatalog(root) {
  const packs = {};
  return readJsonl(catalogFile(root)).map((e) => {
    packs[e.pack] ||= readJson(`${root}/packs/${e.pack}/PACK.json`, { verification: 'missing' });
    const verification = packs[e.pack].verification;
    return { ...e, verification, ...(e.provenance ? { provenance: { ...e.provenance, verification } } : {}) };
  });
}

function search(root, f) {
  let items = loadCatalog(root);
  if (typeof f.type === 'string') items = items.filter((e) => e.type === f.type);
  if (f.license === 'cc0') items = items.filter((e) => CC0_LIKE.includes(e.license));
  if (f.verified) items = items.filter((e) => e.verification === 'verified');
  const deny = loadDeny(root);
  if (deny.entries.length) items = items.filter((e) => !deniedReason(deny, { id: e.provenance?.remote_id, author: e.author }));
  if (typeof f.tags === 'string') {
    const want = f.tags.toLowerCase().split(',').map((t) => t.trim());
    items = items.filter((e) => want.every((w) => e.tags.some((t) => t.includes(w)) || (e.style || '').includes(w)));
  }
  if (typeof f.text === 'string') { const q = f.text.toLowerCase(); items = items.filter((e) => e.id.toLowerCase().includes(q)); }
  const limit = Number(f.limit || 40);
  const shown = items.slice(0, limit).map((e) => `${e.id}\t${e.type}${e.w ? ` ${e.w}x${e.h}` : ''}\t${e.license}${e.verification !== 'verified' ? ' (UNVERIFIED)' : ''}${e.testOnly ? ' (TEST-ONLY)' : ''}\t${e.style || ''}`);
  return `${items.length} match(es)${items.length > limit ? `, showing ${limit}` : ''} in ${root}\n${shown.join('\n')}`;
}

function show(root, id) {
  if (!id) throw new FactoryError('show <asset-id|pack>');
  const packFile = `${root}/packs/${id}/PACK.json`;
  if (fs.existsSync(packFile)) return JSON.stringify(readJson(packFile), null, 2);
  const e = loadCatalog(root).find((x) => x.id === id);
  if (!e) throw new FactoryError(`Unknown asset ${id}`);
  return JSON.stringify({ ...e, absolutePath: `${root}/${e.file}` }, null, 2);
}

/** Copy assets into the claimed task worktree and update the game's license ledger + credits. */
function pull(root, ids, f) {
  if (!ids.length) throw new FactoryError('pull <asset-id...> --task <TASK-ID>');
  if (typeof f.task !== 'string') throw new FactoryError('--task is required (assets enter a game only through a task worktree)');
  const g = resolveGame(typeof f.game === 'string' ? f.game : undefined);
  const s = loadState(g);
  const t = s.tasks[f.task];
  if (!t || t.status !== 'IN_PROGRESS') throw new FactoryError(`${f.task} is not IN_PROGRESS`);
  const wt = t.worktree;
  const destRel = typeof f.dest === 'string' ? f.dest.replace(/^\/+|\/+$/g, '') : 'public/assets';
  const cat = loadCatalog(root);
  const ledgerFile = `${wt}/assets/LICENSES.json`;
  const ledger = readJson(ledgerFile, { generatedBy: 'factory assets pull', assets: [] });
  const copied = [];
  const deny = loadDeny(root);
  // Every id is checked before anything is copied (FX-13): a refused id never leaves a partial pull behind.
  const chosen = ids.map((id) => {
    const e = cat.find((x) => x.id === id);
    if (!e) throw new FactoryError(`Unknown asset ${id}`);
    const denied = deniedReason(deny, { id: e.provenance?.remote_id, author: e.author });
    if (denied) throw new FactoryError(`Asset ${id} is refused: ${denied} (assets deny; pick another asset)`);
    if (e.verification !== 'verified') throw new FactoryError(`Asset ${id} comes from pack ${e.pack} whose license is not verified yet (factory assets verify).`);
    if (e.testOnly && !f['allow-test-only']) throw new FactoryError(`Asset ${id} is from a TEST-ONLY pack (not releasable). Pass --allow-test-only only for factory validation games.`);
    return e;
  });
  for (const e of chosen) {
    const name = path.basename(e.file).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    const rel = `${destRel}/${name}`;
    ensureDir(path.dirname(`${wt}/${rel}`));
    fs.copyFileSync(`${root}/${e.file}`, `${wt}/${rel}`);
    ledger.assets = ledger.assets.filter((x) => x.path !== rel);
    ledger.assets.push({ path: rel, assetId: e.id, sha256: e.sha256, license: e.license, author: e.author, url: e.url, attribution: e.attribution, modified: false, ...(e.testOnly ? { testOnly: true } : {}) });
    copied.push(rel);
  }
  ledger.assets.sort((a, b) => a.path.localeCompare(b.path));
  writeJsonAtomic(ledgerFile, ledger);
  writeTextAtomic(`${wt}/CREDITS.md`, renderCredits(ledger));
  return `Pulled ${copied.length} asset(s) into ${wt}:\n${copied.map((c) => `  ${c}`).join('\n')}\nUpdated assets/LICENSES.json and CREDITS.md (commit them with the task).`;
}

export function renderCredits(ledger) {
  const byPack = {};
  for (const a of ledger.assets) {
    const k = `${a.author}|${a.license}|${a.url}`;
    (byPack[k] ||= { ...a, files: [] }).files.push(a.path);
  }
  const lines = ['# Credits', '', 'Third-party assets used in this game. Generated by `factory assets pull`; do not edit by hand.', ''];
  for (const p of Object.values(byPack)) {
    lines.push(`- **${p.author}** — ${p.license}${p.attribution ? ` — ${p.attribution}` : ''} — <${p.url}> (${p.files.length} file(s))`);
  }
  return lines.join('\n') + '\n';
}

function stats(root) {
  return statsText(root, loadCatalog(root));
}

/**
 * Rebuild catalog.jsonl from the PACK.json manifests only (FX-10). The library usually lives on Google Drive for
 * desktop in streaming mode, where reading a media file downloads it: reindex therefore never opens, stats or
 * hashes media files. It lists the pack folders and reads each PACK.json `files` entries (written by ingest).
 * Packs ingested before FX-10 (no entries) are reported as "needs re-ingest" and keep their current catalog lines.
 */
function reindex(root) {
  const packsDir = `${root}/packs`;
  if (!fs.existsSync(packsDir)) return 'no packs';
  const dirs = (d) => fs.readdirSync(d, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name).sort();
  const old = readJsonl(catalogFile(root));
  const lines = [];
  const stale = [];
  let packs = 0;
  for (const src of dirs(packsDir)) for (const pk of dirs(`${packsDir}/${src}`)) {
    const p = readJson(`${packsDir}/${src}/${pk}/PACK.json`, null);
    if (!p) continue;
    const pack = `${src}/${pk}`;
    if (!Array.isArray(p.files)) {
      stale.push(pack);
      for (const e of old) if (e.pack === pack) lines.push(JSON.stringify(e));
      continue;
    }
    packs++;
    for (const e of p.files) if (e && typeof e.id === 'string' && typeof e.file === 'string') lines.push(JSON.stringify({ ...e, pack }));
  }
  writeTextAtomic(catalogFile(root), lines.join('\n') + (lines.length ? '\n' : ''));
  return `reindexed ${lines.length} assets from ${packs} pack manifest(s)` +
    (stale.length ? `\n${stale.length} pack(s) need re-ingest (PACK.json has no per-file entries; their existing catalog lines were kept, files not walked): ${stale.join(', ')}` : '');
}
