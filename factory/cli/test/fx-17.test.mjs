// @ts-check
/**
 * FX-17 — the no-external-requests scan skips plain-text licence/notice files (per file, by basename) and
 * still scans code and markup; failures name the file of each URL.
 * Real git repositories in a temp directory; no factory state is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FACTORY_ROOT = path.resolve(HERE, '../../..');
const TMP_BASE = path.join(FACTORY_ROOT, '.cache', 'tmp');
const { isLicenceNoticeFile, externalUrlsInPatch, scanExternalUrls } = await import('../lib/url-scan.mjs');

const URL_A = 'http://scripts.sil.org/OFL';
const URL_B = 'https://github.com/googlefonts/nunito';

/** @param {string[]} args @param {string} cwd */
function git(args, cwd) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repo with one base commit; `files` are committed on top. Returns the scan result for the added files. */
function scan(files, allowlist = []) {
  fs.mkdirSync(TMP_BASE, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_BASE, 'fx17-'));
  try {
    git(['init', '-q', '-b', 'main'], dir);
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'main.js'), 'export {};\n');
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'base'], dir);
    const base = git(['rev-parse', 'HEAD'], dir);
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', 'add'], dir);
    return scanExternalUrls(dir, base, allowlist);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const LICENCE_TEXT = `This Font Software is licensed under the SIL Open Font License, Version 1.1.\nSee ${URL_A}\nCopyright 2014 The Nunito Project Authors (${URL_B})\n`;

test('isLicenceNoticeFile: licence and notice text files', () => {
  for (const f of [
    'public/assets/fonts/OFL.txt', 'OFL.TXT', 'LICENSE', 'license', 'LICENCE.md', 'COPYING', 'NOTICE.txt', 'CREDITS.md',
    'ATTRIBUTION.txt', 'OFL-FAQ.txt', 'LICENSE.third-party.txt', 'LICENSE-MIT', 'src/vendor/COPYING.LESSER.md', 'public\\fonts\\OFL.txt',
  ]) assert.equal(isLicenceNoticeFile(f), true, f);
});

test('isLicenceNoticeFile: code, markup and other names are never licence files', () => {
  for (const f of [
    'src/license.ts', 'public/OFL.js', 'public/LICENSE.html', 'public/LICENSE.json', 'public/OFL.svg', 'public/LICENSE.css',
    'public/notes.txt', 'public/readme.md', 'public/MYLICENSE.txt', 'public/OFLX.txt', 'public/LICENSE.txt.js', 'public/LICENSE.d/x.js',
    'public/OFL/main.js', 'index.html',
  ]) assert.equal(isLicenceNoticeFile(f), false, f);
});

test('OFL.txt with URLs is not flagged', () => {
  assert.deepEqual(scan({ 'public/assets/fonts/OFL.txt': LICENCE_TEXT }), []);
});

test('LICENSE without extension with a URL is not flagged', () => {
  assert.deepEqual(scan({ 'public/assets/fonts/LICENSE': `See ${URL_A}\n` }), []);
});

test('code and markup are scanned whatever their name; failure names the file', () => {
  const found = scan({
    'src/license.ts': `export const u = '${URL_A}';\n`,
    'public/OFL.js': `fetch('${URL_B}');\n`,
    'public/notes.txt': `see ${URL_A}\n`,
    'public/LICENSE.html': `<a href="${URL_B}">x</a>\n`,
    'public/assets/fonts/OFL.txt': LICENCE_TEXT,
  });
  const got = found.map((f) => `${f.file}: ${f.url}`).sort();
  assert.deepEqual(got, [
    `public/LICENSE.html: ${URL_B}`,
    `public/OFL.js: ${URL_B}`,
    `public/notes.txt: ${URL_A}`,
    `src/license.ts: ${URL_A}`,
  ].sort());
});

test('a licence file next to a code file with the same URL: only the code file is reported', () => {
  const found = scan({ 'public/OFL.txt': LICENCE_TEXT, 'src/a.ts': `const u = '${URL_A}';\n` });
  assert.deepEqual(found, [{ file: 'src/a.ts', url: URL_A }]);
});

test('urlAllowlist still applies to scanned files', () => {
  const files = { 'src/a.ts': "const a = 'http://localhost:3000/x'; const b = 'https://evil.example/y';\n" };
  assert.deepEqual(scan(files, ['^https?://localhost']), [{ file: 'src/a.ts', url: 'https://evil.example/y' }]);
  assert.equal(scan(files).length, 2);
});

test('paths outside src, index.html and public are not scanned', () => {
  assert.deepEqual(scan({ 'docs/a.md': `${URL_A}\n`, 'README.md': `${URL_A}\n` }), []);
  assert.deepEqual(scan({ 'index.html': `<script src="${URL_A}"></script>\n` }).map((f) => f.file), ['index.html']);
});

test('file names with spaces are parsed and reported', () => {
  const found = scan({ 'src/my file.ts': `const u = '${URL_A}';\n`, 'public/my fonts/OFL.txt': LICENCE_TEXT });
  assert.deepEqual(found, [{ file: 'src/my file.ts', url: URL_A }]);
});

test('externalUrlsInPatch: duplicates collapse, removed lines and metadata are ignored', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,2 @@',
    `-const old = '${URL_B}';`, `+const u = '${URL_A}'; const v = '${URL_A}';`, '\ No newline at end of file',
  ].join('\n');
  assert.deepEqual(externalUrlsInPatch('src/a.ts', patch), [{ file: 'src/a.ts', url: URL_A }]);
});

/**
 * Run fn with git configuration injected through the environment, as a user's own git config would.
 * @template T
 * @param {string[][]} pairs
 * @param {() => T} fn
 * @returns {T}
 */
function withGitConfig(pairs, fn) {
  const keys = ['GIT_CONFIG_COUNT', ...pairs.flatMap((_, i) => [`GIT_CONFIG_KEY_${i}`, `GIT_CONFIG_VALUE_${i}`])];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.GIT_CONFIG_COUNT = String(pairs.length);
  pairs.forEach(([k, v], i) => { process.env[`GIT_CONFIG_KEY_${i}`] = k; process.env[`GIT_CONFIG_VALUE_${i}`] = v; });
  try { return fn(); } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('user diff settings (noprefix, custom prefixes, mnemonic prefix) do not change the result', () => {
  const files = { 'src/a.ts': `const u = '${URL_A}';\n`, 'public/OFL.txt': LICENCE_TEXT, 'public/OFL.js': `fetch('${URL_B}');\n` };
  const expected = [{ file: 'public/OFL.js', url: URL_B }, { file: 'src/a.ts', url: URL_A }];
  const sorted = (/** @type {{file: string, url: string}[]} */ r) => [...r].sort((x, y) => x.file.localeCompare(y.file));
  assert.deepEqual(sorted(scan(files)), expected);
  assert.deepEqual(sorted(withGitConfig([['diff.noprefix', 'true']], () => scan(files))), expected);
  assert.deepEqual(sorted(withGitConfig([['diff.srcPrefix', 'x/'], ['diff.dstPrefix', 'y/']], () => scan(files))), expected);
  assert.deepEqual(sorted(withGitConfig([['diff.mnemonicPrefix', 'true'], ['core.quotePath', 'true']], () => scan(files))), expected);
});

test('an added line that looks like a diff header cannot hide URLs or switch the file', () => {
  const a = scan({ 'src/a.js': `let b = 1, OFL = 2, txt = 3;\n++ b/OFL.txt\nfetch('${URL_A}');\n` });
  assert.deepEqual(a, [{ file: 'src/a.js', url: URL_A }]);
  const b = scan({ 'src/b.js': `++ b/OFL.txt\n+++ b/OFL.txt\n${URL_B}\n` });
  assert.deepEqual(b, [{ file: 'src/b.js', url: URL_B }]);
  const c = withGitConfig([['diff.noprefix', 'true']], () => scan({ 'src/c.js': `++ b/OFL.txt\n${URL_A}\n` }));
  assert.deepEqual(c, [{ file: 'src/c.js', url: URL_A }]);
});

test('binary files are not scanned and do not break the scan', () => {
  const found = scan({ 'public/a.bin': Buffer.from([0x89, 0x50, 0, 1, 2, 0, 0]).toString('latin1') + URL_A, 'src/a.ts': `const u = '${URL_B}';\n` });
  assert.deepEqual(found.map((f) => f.file), ['src/a.ts']);
});
