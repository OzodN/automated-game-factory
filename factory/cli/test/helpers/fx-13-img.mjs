// @ts-check
/**
 * FX-13 test helpers for image previews: fixture PNGs in many pixel formats (made with ffmpeg) and a pixel-variance
 * probe of one contact-sheet cell (decoded with ffmpeg to raw gray), so a test can assert a sheet is not blank.
 */
import { spawnSync } from 'node:child_process';

/** @param {string[]} args */
export function ff(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}: ${r.stderr}`);
}

/** Pixel formats a real OGA preview can come in (palette, alpha, gray, 16-bit). */
export const FORMATS = ['rgba', 'pal8', 'gray', 'gray16be', 'rgb48be', 'rgba64be', 'ya8'];

/**
 * A test-pattern PNG (testsrc2) of the given size and pixel format; the left third is fully transparent when the
 * format carries alpha.
 * @param {string} file @param {string} pixFmt @param {number} w @param {number} h
 */
export function patternPng(file, pixFmt, w, h) {
  const alpha = `scale=${w}:${h}:flags=neighbor,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,${Math.floor(w / 3)}),0,255)'`;
  ff(['-f', 'lavfi', '-i', `testsrc2=s=${w + (w % 2)}x${h + (h % 2)}`, '-vf', alpha, '-frames:v', '1', '-pix_fmt', pixFmt, file]);
}

/** @param {string} file @param {string} [vf] @returns {Buffer} raw 8-bit gray pixels */
function rawGray(file, vf) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, ...(vf ? ['-vf', vf] : []), '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`decode ${file}: ${r.stderr}`);
  return r.stdout;
}

/** Standard deviation of 8-bit gray values. @param {Buffer} px */
export function stdev(px) {
  let sum = 0;
  for (const v of px) sum += v;
  const mean = sum / px.length;
  let sq = 0;
  for (const v of px) sq += (v - mean) ** 2;
  return Math.sqrt(sq / px.length);
}

/**
 * Gray stdev of the image area of cell `i` of a sheet tiled with margin 4 / padding 4 (label strip excluded).
 * @param {string} sheet @param {number} i @param {{ cols: number, w: number, h: number, strip: number }} g
 */
export function cellStdev(sheet, i, g) {
  const x = 4 + (i % g.cols) * (g.w + 4);
  const y = 4 + Math.floor(i / g.cols) * (g.h + g.strip + 4);
  return stdev(rawGray(sheet, `crop=${g.w}:${g.h}:${x}:${y}`));
}

/** Gray stdev of a whole image. @param {string} file */
export function imageStdev(file) {
  return stdev(rawGray(file));
}
