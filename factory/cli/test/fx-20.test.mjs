// @ts-check
/**
 * FX-20 — publication hygiene: the SessionStart fallback path keeps the human-language line, the temp-path hint is
 * platform-aware (MSYS wording on Windows only, a neutral hint elsewhere), the release docs exist (LICENSE, README,
 * CONTRIBUTING), pg-kit declares MIT, .inbox/ is ignored, and the removed research doc is not referenced.
 * No factory state is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const TMP_BASE = path.join(ROOT, '.cache', 'tmp');
fs.mkdirSync(TMP_BASE, { recursive: true });
const TMP = fs.mkdtempSync(path.join(TMP_BASE, 'fx20-'));
const read = (/** @type {string} */ rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { scratchPathHint, tmpHintFor, TMP_HINT, TMP_HINT_POSIX } = await import('../lib/tmp-hint.mjs');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('session-start: the state-load fallback still carries the Human language line', () => {
  const state = path.join(TMP, 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'games'), 'not a directory'); // makes the state overview fail
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('FACTORY_')) delete env[k];
  const r = spawnSync(process.execPath, [path.join(ROOT, 'factory', 'hooks', 'session-start.mjs')], {
    input: JSON.stringify({ source: 'startup', hook_event_name: 'SessionStart' }),
    encoding: 'utf8',
    env: { ...env, FACTORY_STATE_DIR: state, FACTORY_HUMAN_LANGUAGE: 'en', FACTORY_INBOX_DIR: path.join(TMP, 'inbox'),
      FACTORY_WORKTREES_DIR: path.join(TMP, 'wt'), FACTORY_GAMES_DIR: path.join(TMP, 'games') },
  });
  assert.equal(r.status, 0, r.stderr);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Could not load factory state/);
  assert.match(ctx, /^Human language: en/m);
});

test('temp hint: MSYS wording only on win32; a platform-neutral hint on macOS/Linux', () => {
  assert.equal(tmpHintFor('win32'), TMP_HINT);
  for (const p of ['darwin', 'linux']) {
    assert.equal(tmpHintFor(p), TMP_HINT_POSIX);
    const h = scratchPathHint('d=$(mktemp -d) && echo "$d"', p);
    assert.equal(h, TMP_HINT_POSIX);
    assert.doesNotMatch(String(h), /MSYS|cygpath|<drive>/);
    assert.match(String(h), /mktemp -d -p "<factory root>\/\.cache\/tmp"/);
    assert.equal(scratchPathHint('node --test factory/cli/test/*.test.mjs', p), null);
  }
  assert.match(String(scratchPathHint('git clone repo /tmp/x', 'win32')), /MSYS_NO_PATHCONV/);
});

test('release docs: LICENSE is MIT, README and CONTRIBUTING exist, pg-kit declares MIT and stays private', () => {
  const lic = read('LICENSE');
  assert.match(lic, /^MIT License/);
  assert.match(lic, /^Copyright \(c\) 2026 \S/m);
  const readme = read('README.md');
  for (const s of ['/authorize-publish', 'factory/cli/factory.mjs doctor', '/game-new', 'humanLanguage', 'not affiliated']) {
    assert.ok(readme.includes(s), `README mentions ${s}`);
  }
  assert.match(read('CONTRIBUTING.md'), /node --test factory\/cli\/test\/\*\.test\.mjs/);
  const pkg = JSON.parse(read('packages/pg-kit/package.json'));
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.private, true);
});

test('.inbox/ is ignored and the removed revenue research doc is not referenced', () => {
  assert.match(read('.gitignore'), /^\/\.inbox\/$/m);
  assert.equal(fs.existsSync(path.join(ROOT, 'docs/playgama-research/09-revenue-and-payments.md')), false);
  const r = spawnSync('git', ['grep', '-n', '09-revenue'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.stdout.split('\n').filter((l) => l && !l.startsWith('factory/cli/test/fx-20.test.mjs')).length, 0, r.stdout);
});
