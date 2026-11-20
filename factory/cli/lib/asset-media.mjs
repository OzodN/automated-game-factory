// @ts-check
/**
 * ffmpeg / ffprobe helpers for asset acquire and preview (FX-12). The tools are spawned with argument arrays (never a
 * shell) on untrusted media; they only read and decode files, nothing is executed from them. Every helper degrades to
 * null when the tool is missing (`hasTool`), so callers can report "not measured" instead of failing.
 * Overrides: env FFMPEG / FFPROBE (binary path), GAME_ASSET_PREVIEW_FONT (font file for labels).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { imageSize } from './game.mjs';

const bin = (name) => process.env[name.toUpperCase()] || name;
/** @type {Record<string, boolean>} */
const toolCache = {};

/** @param {'ffmpeg' | 'ffprobe'} name */
export function hasTool(name) {
  if (!(name in toolCache)) {
    const r = spawnSync(bin(name), ['-version'], { encoding: 'utf8', windowsHide: true });
    toolCache[name] = r.status === 0;
  }
  return toolCache[name];
}

/** @param {'ffmpeg' | 'ffprobe'} name @param {string[]} args @param {{ cwd?: string }} [o] */
function run(name, args, o = {}) {
  return spawnSync(bin(name), args, { encoding: 'utf8', windowsHide: true, cwd: o.cwd, maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
}

/**
 * Width/height (images) and duration (audio) of a local file. PNG/JPEG sizes come from the header (no tool needed).
 * @param {string} file @param {string} type asset type (sprite | audio | ...)
 * @returns {{ w: number | null, h: number | null, duration: number | null }}
 */
export function probeMedia(file, type) {
  const out = { w: /** @type {number | null} */ (null), h: /** @type {number | null} */ (null), duration: /** @type {number | null} */ (null) };
  if (type === 'sprite') {
    let d = null;
    try { d = imageSize(file); } catch { d = null; }
    if (d) return { ...out, w: d.w, h: d.h };
  }
  if (!hasTool('ffprobe') || !['sprite', 'audio'].includes(type)) return out;
  const r = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_type', '-of', 'json', file]);
  if (r.status !== 0) return out;
  try {
    const j = JSON.parse(r.stdout);
    const v = (j.streams || []).find((s) => s.codec_type === 'video');
    if (type === 'sprite' && v) return { ...out, w: Number(v.width) || null, h: Number(v.height) || null };
    const d = Number(j.format?.duration);
    if (type === 'audio' && Number.isFinite(d) && d > 0) return { ...out, duration: Math.round(d * 1000) / 1000 };
  } catch { /* unreadable probe output: not measured */ }
  return out;
}

/**
 * Integrated loudness (LUFS) and true peak (dBTP) from ffmpeg's ebur128 summary.
 * @param {string} file @returns {{ lufs: number | null, peak: number | null }}
 */
export function loudness(file) {
  if (!hasTool('ffmpeg')) return { lufs: null, peak: null };
  const r = run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  return parseEbur128(r.stderr || '');
}

/** @param {string} text ffmpeg stderr */
export function parseEbur128(text) {
  const summary = text.slice(text.lastIndexOf('Summary:') >= 0 ? text.lastIndexOf('Summary:') : 0);
  const num = (re) => { const m = re.exec(summary); return m ? Number(m[1]) : null; };
  return { lufs: num(/I:\s+(-?[\d.]+|-inf)\s+LUFS/), peak: num(/Peak:\s+(-?[\d.]+)\s+dBFS/) };
}

/** Font file for labels: GAME_ASSET_PREVIEW_FONT or a common system font; null when none (labels then omitted). */
export function findFont() {
  const cands = [process.env.GAME_ASSET_PREVIEW_FONT, 'C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/consola.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf'];
  return cands.find((c) => c && fs.existsSync(c)) || null;
}

/** Height of the label strip under each cell (0 when no font was found). */
export const LABEL_STRIP = 18;

/** Checkerboard behind transparent pixels (8 px squares, two dark greys): alpha stays visible and never reads as blank. */
const CHECKER = "format=gray,geq=lum='if(mod(floor(X/8)+floor(Y/8),2),70,46)',format=rgba";

/**
 * Render one labelled cell: the image scaled into w x h keeping its aspect (nearest-neighbour when upscaled, so pixel
 * art stays crisp; area averaging when downscaled), centred and alpha-composited over a checkerboard, label strip
 * below. Every cell is written as rgb24 whatever the input was (palette, gray, 16-bit, alpha): the tile step needs one
 * pixel format for all cells (FX-13: rgba cells mixed with an rgb24 blank made ffmpeg re-initialise the tile filter
 * mid-stream and emit a flat sheet). Runs in `dir` with relative names so no path needs filter escaping (the font is
 * copied in as font.ttf); the label goes through a text file.
 * @param {{ dir: string, input: string, out: string, label: string, w: number, h: number, font: string | null, upscale?: boolean }} o
 */
export function renderCell(o) {
  const strip = o.font ? LABEL_STRIP : 0;
  if (o.font && !fs.existsSync(path.join(o.dir, 'font.ttf'))) fs.copyFileSync(o.font, path.join(o.dir, 'font.ttf'));
  const labelFile = `${path.basename(o.out)}.txt`;
  fs.writeFileSync(path.join(o.dir, labelFile), o.label);
  const draw = o.font ? `,drawtext=fontfile=font.ttf:textfile=${labelFile}:fontcolor=white:fontsize=12:x=4:y=${o.h + 3}` : '';
  const graph = `[0:v]format=rgba,scale=${o.w}:${o.h}:force_original_aspect_ratio=decrease:flags=${o.upscale ? 'neighbor' : 'area'}[fg];` +
    `[1:v]${CHECKER}[bg];[bg][fg]overlay=x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2:shortest=1,format=rgb24,` +
    `pad=${o.w}:${o.h + strip}:0:0:color=0x101010${draw},format=rgb24`;
  const r = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', o.input, '-f', 'lavfi', '-i', `color=c=0x303030:s=${o.w}x${o.h}`,
    '-filter_complex', graph, '-frames:v', '1', '-pix_fmt', 'rgb24', o.out], { cwd: o.dir });
  return r.status === 0 && fs.existsSync(path.join(o.dir, o.out));
}

/** Blank cell of the same geometry and pixel format (pads the last row). @param {string} dir @param {string} out @param {number} w @param {number} h */
export function blankCell(dir, out, w, h) {
  const r = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x101010:s=${w}x${h}`, '-frames:v', '1', '-pix_fmt', 'rgb24', out], { cwd: dir });
  return r.status === 0;
}

/**
 * Tile `cells` (equal-size rgb24 PNGs in `dir`, already padded to a full grid) into one sheet with ffmpeg's tile
 * filter. `-reinit_filter 0` keeps the graph (and the frames tile has collected) even if one cell differs in format.
 * @param {string} dir @param {string[]} cells @param {number} cols @param {string} outAbs
 */
export function tileCells(dir, cells, cols, outAbs) {
  const rows = Math.ceil(cells.length / cols);
  cells.forEach((c, i) => fs.copyFileSync(path.join(dir, c), path.join(dir, `seq-${String(i).padStart(4, '0')}.png`)));
  const r = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-reinit_filter', '0', '-framerate', '1', '-i', 'seq-%04d.png',
    '-vf', `format=rgb24,tile=${cols}x${rows}:padding=4:margin=4:color=0x000000`, '-frames:v', '1', '-update', '1', '-pix_fmt', 'rgb24', path.resolve(outAbs)], { cwd: dir });
  for (let i = 0; i < cells.length; i++) fs.rmSync(path.join(dir, `seq-${String(i).padStart(4, '0')}.png`), { force: true });
  if (r.status !== 0) throw new Error(`ffmpeg could not tile the contact sheet: ${(r.stderr || '').trim().split('\n').pop()}`);
}

/** Waveform PNG of an audio file (showwavespic). @param {string} input @param {string} outAbs @param {number} w @param {number} h */
export function waveform(input, outAbs, w, h) {
  const r = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-filter_complex', `showwavespic=s=${w}x${h}:colors=0x7fd0ff[w];color=c=0x202020:s=${w}x${h}[b];[b][w]overlay=shortest=1`, '-frames:v', '1', '-pix_fmt', 'rgb24', path.resolve(outAbs)]);
  return r.status === 0 && fs.existsSync(outAbs);
}
