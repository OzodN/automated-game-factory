// @ts-check
/**
 * FX-18 — configurable human conversation language: config default "auto", env FACTORY_HUMAN_LANGUAGE wins,
 * SessionStart hook line, doctor row (info, warn on invalid type), generated command skills free of a
 * hard-coded conversation language and in sync with the generator. No factory state is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FACTORY_ROOT = path.resolve(HERE, '../../..');
const CLI = path.join(FACTORY_ROOT, 'factory', 'cli');
const HOOK = path.join(FACTORY_ROOT, 'factory', 'hooks', 'session-start.mjs');
const TMP_BASE = path.join(FACTORY_ROOT, '.cache', 'tmp');
fs.mkdirSync(TMP_BASE, { recursive: true });
const TMP = fs.mkdtempSync(path.join(TMP_BASE, 'fx18-'));

const { humanLanguage, humanLanguageLine, humanLanguageRow, HUMAN_LANGUAGE_ENV } = await import('../lib/language.mjs');
const { renderCommandSkills, staleCommandSkills } = await import('../gen-command-skills.mjs');

/** process.env without any factory override, plus `extra`. */
function cleanEnv(extra = {}) {
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('FACTORY_')) delete env[k];
  return { ...env, ...extra };
}

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('config: factory/config.json ships humanLanguage "auto"; missing key defaults to auto', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(FACTORY_ROOT, 'factory', 'config.json'), 'utf8'));
  assert.equal(cfg.humanLanguage, 'auto');
  assert.deepEqual(humanLanguage(cfg, {}), { value: 'auto', source: 'config', warning: '' });
  assert.deepEqual(humanLanguage({}, {}), { value: 'auto', source: 'default', warning: '' });
  assert.equal(humanLanguage({ humanLanguage: ' ru ' }, {}).value, 'ru');
});

test('env FACTORY_HUMAN_LANGUAGE wins over config; blank env is ignored', () => {
  assert.equal(HUMAN_LANGUAGE_ENV, 'FACTORY_HUMAN_LANGUAGE');
  assert.deepEqual(humanLanguage({ humanLanguage: 'ru' }, { FACTORY_HUMAN_LANGUAGE: 'es' }), { value: 'es', source: 'env', warning: '' });
  assert.equal(humanLanguage({ humanLanguage: 'ru' }, { FACTORY_HUMAN_LANGUAGE: '  ' }).value, 'ru');
});

test('invalid config type falls back to auto with a warning; doctor row warns, never fails', () => {
  for (const bad of [42, '', null, ['ru'], { lang: 'ru' }]) {
    const l = humanLanguage({ humanLanguage: bad }, {});
    assert.equal(l.value, 'auto');
    assert.match(l.warning, /must be a non-empty string/);
    const row = humanLanguageRow({ humanLanguage: bad }, {});
    assert.equal(row.ok, 'warn');
    assert.match(row.action, /"auto"/);
  }
  assert.deepEqual(humanLanguageRow({ humanLanguage: 'auto' }, {}), { ok: true, item: 'Human language', detail: 'auto (factory/config.json)', action: '' });
  assert.equal(humanLanguageRow({ humanLanguage: 'auto' }, { FACTORY_HUMAN_LANGUAGE: 'de' }).detail, 'de (env FACTORY_HUMAN_LANGUAGE)');
});

test('hook line: auto vs fixed language', () => {
  assert.match(humanLanguageLine({ value: 'auto', source: 'default', warning: '' }), /^Human language: auto \(reply in the human's language/);
  assert.match(humanLanguageLine({ value: 'AUTO', source: 'config', warning: '' }), /^Human language: auto /);
  assert.match(humanLanguageLine({ value: 'ru', source: 'config', warning: '' }), /^Human language: ru \(always reply in it/);
});

/** @param {Record<string, string>} extra */
function runHook(extra) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: '{"source":"startup"}', encoding: 'utf8',
    env: cleanEnv({ FACTORY_STATE_DIR: path.join(TMP, 'state'), FACTORY_GAMES_DIR: path.join(TMP, 'games'), ...extra }),
  });
  assert.equal(r.status, 0, r.stderr);
  return String(JSON.parse(r.stdout).hookSpecificOutput.additionalContext);
}

test('SessionStart hook injects exactly one Human language line (config and env)', () => {
  const cfgFile = path.join(TMP, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ humanLanguage: 'auto' }));
  const auto = runHook({ FACTORY_CONFIG: cfgFile });
  assert.equal(auto.match(/^Human language: /gm)?.length, 1);
  assert.match(auto, /^Human language: auto \(reply in the human's language/m);
  const es = runHook({ FACTORY_CONFIG: cfgFile, FACTORY_HUMAN_LANGUAGE: 'es' });
  assert.match(es, /^Human language: es /m);
  fs.writeFileSync(cfgFile, JSON.stringify({ humanLanguage: 'ru' }));
  assert.match(runHook({ FACTORY_CONFIG: cfgFile }), /^Human language: ru /m);
});

test('factory doctor prints the effective human language as a non-failing row', () => {
  const cfgFile = path.join(TMP, 'doctor-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ humanLanguage: 7 }));
  const env = cleanEnv({ FACTORY_CONFIG: cfgFile, FACTORY_STATE_DIR: path.join(TMP, 'dstate') });
  fs.mkdirSync(path.join(TMP, 'dstate'), { recursive: true });
  const bad = spawnSync(process.execPath, [path.join(CLI, 'factory.mjs'), 'doctor'], { encoding: 'utf8', env });
  assert.match(bad.stdout, /^WARN {2}Human language +auto \(default\)$/m);
  const good = spawnSync(process.execPath, [path.join(CLI, 'factory.mjs'), 'doctor'], { encoding: 'utf8', env: { ...env, FACTORY_HUMAN_LANGUAGE: 'en' } });
  assert.match(good.stdout, /^ ok {3}Human language +en \(env FACTORY_HUMAN_LANGUAGE\)$/m);
});

test('generated command skills: no hard-coded conversation language, neutral phrase present, on disk in sync', () => {
  const skills = renderCommandSkills();
  assert.ok(Object.keys(skills).length >= 20);
  for (const [name, text] of Object.entries(skills)) assert.doesNotMatch(text, /russian/i, name);
  assert.match(skills['game-status'], /in the human's language \(see `Human language` in the session context\)/);
  assert.match(skills['approve-spec'], /tell the user in the human's language/);
  assert.deepEqual(staleCommandSkills(), []);
  const check = spawnSync(process.execPath, [path.join(CLI, 'gen-command-skills.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});

test('git grep: "russian" in .claude, CLAUDE.md and factory/cli only on the research-docs line', () => {
  const r = spawnSync('git', ['grep', '-n', '-i', 'russian', '--', '.claude', 'CLAUDE.md', 'factory/cli', ':!factory/cli/test/fx-18.test.mjs'], { cwd: FACTORY_ROOT, encoding: 'utf8' });
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /^CLAUDE\.md:\d+:- Research docs \(Russian, secondary source\): `docs\/playgama-research\/`$/);
});
