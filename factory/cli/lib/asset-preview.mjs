// @ts-check
/**
 * `assets preview <ids...> --out <png> [--cols n] [--size px]` (FX-12): look at assets before acquiring them.
 *
 * Ids are remote index ids (`<source>:<item>[/<member>]`; an item id expands to its members) or library ids
 * (`<source>/<pack>/<file>`, or a pack `<source>/<pack>`). Images: the member itself (image files under 2 MB) or the
 * source's page preview (archives, large files; OGA `preview_images`, allowed hosts only, streamed with a byte cap) is
 * fetched into a temp folder and tiled with ffmpeg into one labelled contact sheet (index number + short id under each
 * cell; every cell normalised to rgb24 over a checkerboard). The legend says which one each cell shows. Audio: duration, integrated loudness (ebur128), true peak and a waveform PNG
 * per item, plus one combined waveform sheet. A legend file next to the png maps numbers to ids.
 *
 * Output files: `<out>` (image sheet; the waveform sheet when there are only audio ids), `<base>.audio.png` (waveform
 * sheet when both kinds are present), `<base>.wave-NN.png`, `<base>.legend.txt`. Temp files go to
 * `<repo>/.cache/asset-preview/` (env GAME_ASSET_PREVIEW_CACHE) and are removed afterwards. Nothing is written into the
 * library or a game; measured w/h/duration of fetched remote members are written back to the index rows.
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths, norm, ensureDir, readJsonl, writeTextAtomic, FactoryError } from './core.mjs';
import { openIndex, getItem, getItemMembers, updateMedia } from './asset-index.mjs';
import { getSource, makeContext } from './asset-sources/index.mjs';
import { REMOTE_ID_RE } from './asset-denylist.mjs';
import { safeUrl } from './asset-sources/http.mjs';
import { hasTool, probeMedia, loudness, findFont, renderCell, blankCell, tileCells, waveform, LABEL_STRIP } from './asset-media.mjs';

const MAX_ITEMS = 60;
const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;
/** Image members below this size are previewed from the file itself; larger ones and archives use the page preview. */
const SMALL_IMAGE_BYTES = 2 * 1024 * 1024;

export function previewCacheDir() {
  return norm(process.env.GAME_ASSET_PREVIEW_CACHE || `${paths().root}/.cache/asset-preview`);
}

/** @param {string} p @param {string} dir */
const inside = (p, dir) => { const rel = path.relative(path.resolve(dir), path.resolve(p)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

/** @param {string} root @param {Record<string, any>} f */
function outputPlan(root, f) {
  if (typeof f.out !== 'string' || !/\.png$/i.test(f.out)) throw new FactoryError('--out <file.png> is required');
  const out = path.resolve(f.out);
  if (inside(out, root) || inside(out, paths().games) || inside(out, paths().worktrees)) {
    throw new FactoryError('--out must not be inside the asset library, a game or a worktree (preview writes nothing there)');
  }
  const cols = Math.max(1, Math.min(12, Math.round(Number(f.cols) || 6)));
  const size = Math.max(32, Math.min(512, Math.round(Number(f.size) || 128)));
  return { out, base: out.replace(/\.png$/i, ''), cols, size };
}

/**
 * Resolve ids to preview targets: { n, id, kind: 'image' | 'audio', row?, file? }.
 * @param {string} root @param {any} db @param {string[]} ids
 */
function resolveTargets(root, db, ids) {
  const cat = readJsonl(`${root}/catalog/catalog.jsonl`);
  const out = [];
  for (const id of ids) {
    if (REMOTE_ID_RE.test(id)) {
      const one = db && getItem(db, id);
      const rows = one ? [one] : db && !id.slice(id.indexOf(':') + 1).includes('/') ? getItemMembers(db, id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)) : [];
      if (!rows.length) throw new FactoryError(`Unknown remote asset ${id}`);
      for (const r of rows) out.push({ id: r.id, kind: r.type === 'audio' ? 'audio' : 'image', row: r });
    } else {
      const es = cat.filter((e) => e.id === id || e.pack === id);
      if (!es.length) throw new FactoryError(`Unknown library asset or pack ${id}`);
      for (const e of es) out.push({ id: e.id, kind: e.type === 'audio' ? 'audio' : 'image', file: `${root}/${e.file}`, entry: e });
    }
  }
  if (out.length > MAX_ITEMS) throw new FactoryError(`${out.length} files to preview; the limit is ${MAX_ITEMS} (pass member ids)`);
  return out.map((t, i) => ({ ...t, n: i + 1 }));
}

/**
 * Hosts a preview image may come from (FX-13): OpenGameArt (+ subdomains) and the Hugging Face hub / CDN. Preview URLs
 * come from untrusted dataset metadata, so anything else is refused, and so is every redirect that leaves these hosts.
 * Test-only override: env FACTORY_TEST_PREVIEW_HOSTS (comma-separated host[:port] list, http allowed) for the local
 * fixture server; never set it in production.
 */
const PREVIEW_HOSTS = [/^(?:[a-z0-9-]+\.)*opengameart\.org$/i, /^(?:[a-z0-9-]+\.)*huggingface\.co$/i, /^(?:[a-z0-9-]+\.)*hf\.co$/i];

/** @param {string} url @param {Record<string, string | undefined>} [env] */
export function previewHostAllowed(url, env = process.env) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const extra = String(env.FACTORY_TEST_PREVIEW_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (extra.includes(u.host.toLowerCase()) || extra.includes(u.hostname.toLowerCase())) return u.protocol === 'http:' || u.protocol === 'https:';
  return u.protocol === 'https:' && PREVIEW_HOSTS.some((re) => re.test(u.hostname));
}

/**
 * Download one preview image into `dest`, streamed with a running byte cap (aborted at the cap; content-length is
 * checked first). Redirects are followed by hand (at most 5) so every hop passes the host allow-list.
 * @param {{ fetch: (url: string, opts?: any) => Promise<Response> }} ctx @param {string} url @param {string} dest
 * @param {number} [maxBytes]
 */
export async function downloadPreview(ctx, url, dest, maxBytes = MAX_PREVIEW_BYTES) {
  let cur = url;
  for (let hop = 0; ; hop++) {
    if (!previewHostAllowed(cur)) throw new Error(`preview host refused: ${safeUrl(cur)} (allowed: https opengameart.org, huggingface.co, hf.co)`);
    const res = await ctx.fetch(cur, { redirect: 'manual' });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel();
      if (hop >= 5) throw new Error('preview: too many redirects');
      cur = new URL(loc, cur).href;
      continue;
    }
    if (!res.ok || !res.body) { await res.body?.cancel(); throw new Error(`HTTP ${res.status}`); }
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > maxBytes) { await res.body.cancel(); throw new Error(`preview image over ${maxBytes} bytes`); }
    await streamToFile(res.body, dest, maxBytes);
    return dest;
  }
}

/** @param {ReadableStream<Uint8Array>} body @param {string} dest @param {number} maxBytes */
async function streamToFile(body, dest, maxBytes) {
  const reader = body.getReader();
  const fd = fs.openSync(dest, 'w');
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > maxBytes) { await reader.cancel(); throw new Error(`preview image over ${maxBytes} bytes`); }
      fs.writeSync(fd, value);
    }
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(dest, { force: true });
    throw e;
  }
  fs.closeSync(fd);
}

/**
 * Local file for one target. Images (FX-13): a remote image member under 2 MB is fetched itself (origin `file`); the
 * source's page preview (origin `page preview`, e.g. OGA preview_images) is used for archives, large or unsized files,
 * or when the member fetch fails. Sets t.file, t.origin, t.measured (the member itself was fetched, so its
 * measurements may be written back) and t.note on failure.
 * @param {any} db @param {any} t @param {string} tmp
 */
async function materialize(db, t, tmp) {
  if (t.file) { Object.assign(t, { measured: false, origin: 'file' }); return; }
  const ctx = /** @type {any} */ (makeContext({ index: db }));
  const r = t.row;
  const member = async () => {
    t.file = await getSource(r.source).fetch(r, path.join(tmp, `member-${t.n}`), ctx);
    Object.assign(t, { measured: true, origin: 'file' });
  };
  const page = async () => {
    const u = r.preview_urls[0];
    t.file = await downloadPreview(ctx, u, path.join(tmp, `preview-${t.n}${path.extname(new URL(u).pathname) || '.img'}`));
    Object.assign(t, { measured: false, origin: 'page preview' });
  };
  const hasPage = t.kind === 'image' && r.preview_urls?.length > 0;
  const sized = typeof r.bytes === 'number';
  const smallImage = r.type === 'sprite' && (sized ? r.bytes < SMALL_IMAGE_BYTES : !hasPage);
  try {
    if (r.type === 'audio' || smallImage) {
      try { await member(); } catch (e) { if (!hasPage) throw e; await page(); }
    } else if (hasPage) await page();
    else if (r.type === 'sprite') await member();
    else t.note = 'no preview image (acquire the archive to look inside)';
  } catch (e) {
    t.note = `fetch failed: ${/** @type {any} */ (e).message}`;
  }
}

/** Short label under a cell. @param {any} t */
function label(t) {
  const tail = t.id.split(/[/:]/).pop() || t.id;
  return `${t.n} ${tail.length > 18 ? `${tail.slice(0, 8)}~${tail.slice(-9)}` : tail}`;
}

/** @param {string} tmp @param {any[]} list @param {{ w: number, h: number, cols: number, font: string | null }} g @param {string} outAbs */
function sheet(tmp, list, g, outAbs) {
  const cells = [];
  for (const t of list) {
    const name = `cell-${t.n}.png`;
    const upscale = !!(t.probe?.w && t.probe.w <= g.w && t.probe.h <= g.h);
    if (renderCell({ dir: tmp, input: t.cellInput, out: name, label: label(t), w: g.w, h: g.h, font: g.font, upscale })) cells.push(name);
    else t.note = t.note || 'ffmpeg could not decode it';
  }
  if (!cells.length) return false;
  const total = Math.ceil(cells.length / g.cols) * g.cols;
  for (let k = cells.length; k < total; k++) { blankCell(tmp, `blank-${k}.png`, g.w, g.h + (g.font ? LABEL_STRIP : 0)); cells.push(`blank-${k}.png`); }
  tileCells(tmp, cells, Math.min(g.cols, total), outAbs);
  return true;
}

/**
 * @param {string} root library root @param {string[]} ids @param {Record<string, any>} f
 * @returns {Promise<string>}
 */
export async function previewCommand(root, ids, f) {
  if (!ids.length) throw new FactoryError('preview <ids...> --out <file.png> [--cols n] [--size px]');
  const plan = outputPlan(root, f);
  if (!hasTool('ffmpeg')) throw new FactoryError('assets preview needs ffmpeg on PATH (or env FFMPEG)');
  const db = ids.some((id) => REMOTE_ID_RE.test(id)) ? openIndex() : null;
  const tmp = ensureDir(`${previewCacheDir()}/${Date.now()}-${process.pid}`);
  try {
    const targets = resolveTargets(root, db, ids);
    for (const t of targets) await materialize(db, t, tmp);
    ensureDir(path.dirname(plan.out));
    const written = renderAll(tmp, targets, plan);
    for (const t of targets) if (t.row && t.measured && t.probe) updateMedia(db, t.row.id, t.probe);
    writeTextAtomic(`${plan.base}.legend.txt`, legend(targets));
    written.push(`${plan.base}.legend.txt`);
    return `Preview of ${targets.length} file(s):\n${written.map((w) => `  ${w}`).join('\n')}\n${legend(targets)}`;
  } finally {
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Probe, waveforms and sheets. @param {string} tmp @param {any[]} targets @param {ReturnType<typeof outputPlan>} plan */
function renderAll(tmp, targets, plan) {
  const font = findFont();
  const written = [];
  const images = targets.filter((t) => t.kind === 'image' && t.file);
  const audio = targets.filter((t) => t.kind === 'audio' && t.file);
  for (const t of images) { t.probe = probeMedia(t.file, 'sprite'); t.cellInput = t.file; }
  for (const t of audio) {
    t.probe = probeMedia(t.file, 'audio');
    t.loud = loudness(t.file);
    const wave = `${plan.base}.wave-${String(t.n).padStart(2, '0')}.png`;
    if (waveform(t.file, wave, plan.size * 4, plan.size)) { written.push(wave); t.cellInput = wave; }
    else t.note = t.note || 'ffmpeg could not decode it';
  }
  if (images.length && sheet(tmp, images, { w: plan.size, h: plan.size, cols: plan.cols, font }, plan.out)) written.unshift(plan.out);
  const audioOut = images.length ? `${plan.base}.audio.png` : plan.out;
  const waves = audio.filter((t) => t.cellInput);
  if (waves.length && sheet(tmp, waves, { w: plan.size * 4, h: plan.size, cols: Math.max(1, Math.min(2, plan.cols)), font }, audioOut)) written.push(audioOut);
  return written;
}

/**
 * Image legend facts with the source of the cell: `40x30 (file)`, or `page preview 224x224 (file 40x30)` /
 * `(file dims unknown)`: the page preview's size never describes the file (FX-13, DEFECT 2).
 * @param {any} t
 */
function imageFacts(t) {
  const p = t.probe || {};
  if (!t.origin) return '';
  const dims = p.w ? `${p.w}x${p.h}` : '?';
  if (t.origin !== 'page preview') return `${dims} (file)`;
  const r = t.row || {};
  return `page preview ${dims} (${r.w && r.h ? `file ${r.w}x${r.h}` : 'file dims unknown'})`;
}

/** @param {any[]} targets */
function legend(targets) {
  const fmt = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '?');
  return targets.map((t) => {
    const p = t.probe || {};
    const facts = t.kind === 'audio' ? `${fmt(p.duration, 2)} s, ${fmt(t.loud?.lufs)} LUFS, peak ${fmt(t.loud?.peak)} dBTP` : imageFacts(t);
    return `${t.n}\t${t.id}\t${t.kind}\t${facts}${t.note ? `\t(${t.note})` : ''}`;
  }).join('\n') + '\n';
}
