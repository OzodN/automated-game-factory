// @ts-check
/**
 * FX-08 (FD-06 lesson) — the template e2e proves that real keys reach gameplay and uses no fixed sleeps.
 * Static guards on the template sources (the browser run itself is part of `template check`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TPL = path.resolve(HERE, '../../templates/game-phaser-ts');
const read = (/** @type {string} */ rel) => fs.readFileSync(path.join(TPL, rel), 'utf8');

test('FX-08: template e2e specs contain no fixed sleeps', () => {
  for (const f of fs.readdirSync(path.join(TPL, 'tests/e2e')).filter((n) => n.endsWith('.ts'))) {
    assert.doesNotMatch(read(`tests/e2e/${f}`), /waitForTimeout\s*\(/, `${f} must wait on a condition, not a fixed delay`);
  }
});

test('FX-08: template e2e presses real keys and asserts they reach a Phaser handler', () => {
  const spec = read('tests/e2e/platform.spec.ts');
  assert.match(spec, /real Space, ArrowLeft and ArrowRight reach a Phaser handler/);
  for (const key of ['Space', 'ArrowLeft', 'ArrowRight']) assert.match(spec, new RegExp(`'${key}'`));
  assert.match(spec, /page\.keyboard\.press/);
  assert.match(spec, /keysSeen/);
  assert.match(spec, /keysTotal/);
  assert.match(spec, /defaultPrevented/);
});

test('FX-08: one real Enter on the Menu starts Play exactly once (key-dedupe helper, FX-07 review)', () => {
  const spec = read('tests/e2e/platform.spec.ts');
  assert.match(spec, /one real Enter on the Menu starts Play exactly once/);
  assert.match(spec, /page\.keyboard\.press\('Enter'\)/);
  assert.match(spec, /sceneStarts\.Play[^\n]*\)\.toBe\(1\)/);
});

test('FX-08: the probe is test-only, counts distinct events, is exposed in the snapshot and wired into the scenes', () => {
  const state = read('src/game/test-state.ts');
  assert.match(state, /export function trackScene\(/);
  assert.match(state, /has\('pgtest'\)\) return;/, 'registered only with ?pgtest=1');
  assert.match(state, /input\.keyboard\?\.on\('keydown'/);
  assert.match(state, /WeakSet/, 'one record per event object (Phaser replays queued events)');
  assert.match(state, /keysSeen: \[\.\.\.keysSeen\]/);
  assert.match(state, /keysTotal,/);
  assert.match(state, /sceneStarts: \{ \.\.\.sceneStarts \}/);
  for (const scene of ['MenuScene', 'PlayScene']) assert.match(read(`src/scenes/${scene}.ts`), /trackScene\(this\)/, `${scene} calls trackScene`);
});

test('FX-08: GAME_CONVENTIONS documents the real-key rule, no sleeps, per-scene dedupe, the L-01 split and the random E2E_PORT', () => {
  const doc = read('GAME_CONVENTIONS.md');
  assert.match(doc, /Real-key reach test for every key the game uses/);
  assert.match(doc, /No fixed sleeps/);
  assert.match(doc, /The dedupe is per scene/);
  assert.match(doc, /Split suites by area \(lesson L-01\)/);
  assert.match(doc, /`flows`[\s\S]*`viewports`[\s\S]*`quality`/);
  assert.match(doc, /E2E_PORT=\$\(node -e/);
});
