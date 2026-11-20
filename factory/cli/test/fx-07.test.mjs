// @ts-check
/**
 * FX-07: game template hardening from the pilot (ENV-02, D-03, tech debt).
 * Covered: renderTemplate renames _gitattributes to .gitattributes (like _gitignore), the template package.json pins
 * packageManager (pnpm@x.y.z) and keeps it through rendering, the key replay guard and its convention rule exist,
 * the Menu uses the guard, the dt-cap note exists, and templateVersion was bumped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TPL = path.resolve(HERE, '../../templates/game-phaser-ts');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-fx07-'));
Object.assign(process.env, {
  FACTORY_STATE_DIR: `${TMP}/state`, FACTORY_KIT_DIR: path.join(HERE, 'fixtures', 'kit'),
});

const G = await import('../lib/game.mjs');
const read = (/** @type {string} */ p) => fs.readFileSync(p, 'utf8');

test('renderTemplate renames _gitattributes and _gitignore and keeps package.json packageManager', () => {
  const dest = `${TMP}/render`;
  G.renderTemplate(TPL, dest, 'fx-seven', 'FX Seven');
  assert.ok(fs.existsSync(`${dest}/.gitattributes`), '.gitattributes is created');
  assert.ok(!fs.existsSync(`${dest}/_gitattributes`), '_gitattributes is not left behind');
  assert.ok(fs.existsSync(`${dest}/.gitignore`));
  const attrs = read(`${dest}/.gitattributes`);
  assert.match(attrs, /^\* text=auto eol=lf$/m);
  for (const ext of ['png', 'jpg', 'webp', 'ogg', 'mp3', 'wav', 'woff2', 'ttf']) assert.match(attrs, new RegExp(`^\\*\\.${ext} binary$`, 'm'), ext);
  const pkg = JSON.parse(read(`${dest}/package.json`));
  assert.match(pkg.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
  assert.equal(pkg.name, 'fx-seven');
  assert.ok(fs.existsSync(`${dest}/src/ui/key-dedupe.ts`));
  assert.ok(fs.existsSync(`${dest}/tests/unit/key-dedupe.test.ts`));
});

test('the nested rename only touches exact _gitattributes file names', () => {
  const t = `${TMP}/tpl-nested`;
  fs.mkdirSync(`${t}/sub`, { recursive: true });
  fs.writeFileSync(`${t}/_gitattributes`, '* text=auto\n');
  fs.writeFileSync(`${t}/sub/_gitattributes`, '* -text\n');
  fs.writeFileSync(`${t}/x_gitattributes`, 'keep\n');
  G.renderTemplate(t, `${TMP}/nested`, 'n', 'N');
  assert.ok(fs.existsSync(`${TMP}/nested/.gitattributes`));
  assert.ok(fs.existsSync(`${TMP}/nested/sub/.gitattributes`));
  assert.ok(fs.existsSync(`${TMP}/nested/x_gitattributes`));
});

test('template conventions document the key replay guard and the dt cap; Menu uses the guard; version bumped', () => {
  const conv = read(`${TPL}/GAME_CONVENTIONS.md`);
  assert.match(conv, /dedupeKeyEvents/);
  assert.match(conv, /4\.2\.1/);
  assert.match(conv, /smoothStep/);
  assert.match(conv, /game time/i);
  assert.match(read(`${TPL}/src/scenes/MenuScene.ts`), /dedupeKeyEvents\(/);
  const cfg = JSON.parse(read(`${TPL}/factory.game.json`));
  assert.notEqual(cfg.templateVersion, '1.0.0');
  assert.match(cfg.templateVersion, /^\d+\.\d+\.\d+$/);
});
