// @ts-check
/**
 * The `no-external-requests` scan of task verification (FX-17): external URLs a task adds under the shipped roots.
 *
 * File names always come from `git diff --numstat -z` (NUL-separated, never affected by diff.noprefix or custom
 * prefixes and never parsed out of diff text); licence/notice files are dropped from that list by basename; each
 * remaining file is diffed on its own with a literal pathspec. A line is therefore attributed to a file by the list,
 * never by line content, and a file is only ever skipped for being a licence/notice file (fail closed).
 */
import { git } from './core.mjs';

/** Roots whose added lines are shipped to players and therefore scanned for external URLs. */
export const URL_SCAN_PATHS = ['src', 'index.html', 'public'];
const LICENCE_NAME = '(?:OFL|LICEN[CS]E|COPYING|NOTICE|CREDITS|ATTRIBUTION)';
const LICENCE_WITH_EXT = new RegExp(`^${LICENCE_NAME}(?:[._-][^/]*)?\\.(?:txt|md)$`, 'i');
const LICENCE_NO_EXT = new RegExp(`^${LICENCE_NAME}(?:[_-][A-Za-z0-9_-]*)?$`, 'i');
/** Output-shaping options that do not depend on the user's git configuration. */
const DIFF_OPTS = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];

/**
 * True for a plain-text licence/notice file (OFL.txt, LICENSE, COPYING, NOTICE.md, LICENSE-MIT, ...), decided by the
 * file's basename only. Such a file is shipped for legal reasons but never loaded by the game, so it makes no
 * request. Code and markup (.js/.ts/.html/.css/.json/.svg, ...) are never licence files, whatever their name.
 * @param {string} file repo-relative path
 */
export function isLicenceNoticeFile(file) {
  const base = String(file).replace(/\\/g, '/').split('/').pop() || '';
  return LICENCE_WITH_EXT.test(base) || LICENCE_NO_EXT.test(base);
}

/**
 * External URLs in the added lines of ONE file's `git diff -U0` output (a single file section). Everything before
 * the first hunk header is diff metadata; after it, in -U0 output, every line starting with `+` is an added line.
 * URLs matching an allowlist regex are skipped; duplicates collapse.
 * @param {string} file
 * @param {string} patch
 * @param {RegExp[]} allow
 * @returns {{file: string, url: string}[]}
 */
export function externalUrlsInPatch(file, patch, allow = []) {
  /** @type {{file: string, url: string}[]} */
  const found = [];
  const seen = new Set();
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (!inHunk) { inHunk = line.startsWith('@@'); continue; }
    if (!line.startsWith('+')) continue;
    for (const m of line.matchAll(/https?:\/\/[^\s'"`)<>]+/g)) {
      if (allow.some((re) => re.test(m[0])) || seen.has(m[0])) continue;
      seen.add(m[0]);
      found.push({ file, url: m[0] });
    }
  }
  return found;
}

/**
 * Files changed since `base` under the scanned roots that carry added text lines, from `--numstat -z`
 * (records `<added>\t<deleted>\t<path>\0`; `-` counts mean a binary file).
 * @param {string} wt
 * @param {string} base
 * @returns {string[]}
 */
export function changedTextFiles(wt, base) {
  const out = git(['diff', '--numstat', '-z', ...DIFF_OPTS, `${base}..HEAD`, '--', ...URL_SCAN_PATHS], wt);
  const files = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const m = /^([^\t]*)\t([^\t]*)\t([\s\S]+)$/.exec(rec);
    // An unparsable record is scanned rather than skipped (fail closed); binary files have no text lines.
    if (!m) { files.push(rec); continue; }
    if (m[1] === '-' || m[1] === '0') continue;
    files.push(m[3]);
  }
  return files;
}

/**
 * The no-external-requests scan of a task worktree: URLs added since `base` under src, index.html and public.
 * Licence/notice files are excluded per file; everything else is scanned.
 * @param {string} wt worktree
 * @param {string} base merge-base commit
 * @param {string[]} allowlist `urlAllowlist` regex sources from factory.game.json
 * @returns {{file: string, url: string}[]}
 */
export function scanExternalUrls(wt, base, allowlist = []) {
  const allow = allowlist.map((x) => new RegExp(x));
  /** @type {{file: string, url: string}[]} */
  const found = [];
  for (const file of changedTextFiles(wt, base).filter((f) => !isLicenceNoticeFile(f))) {
    const patch = git(['diff', '-U0', ...DIFF_OPTS, `${base}..HEAD`, '--', `:(literal)${file}`], wt);
    found.push(...externalUrlsInPatch(file, patch, allow));
  }
  return found;
}
