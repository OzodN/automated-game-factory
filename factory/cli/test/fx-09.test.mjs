// @ts-check
/**
 * FX-09 — process rules, configuration and documentation after the pilot.
 * Doctor reads model env overrides from the settings `env` blocks and probes hard links in the state dir;
 * a plan amendment that races a task start is a clean FactoryError; L-02 config values; the agent definitions
 * carry the plan rules (L-01, ENG-12, FD-05), the guard-refusal rule and ENV-01; docs name the test command.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-fx09-'));
const REAL_CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'factory/config.json'), 'utf8'));
Object.assign(process.env, {
  FACTORY_STATE_DIR: `${TMP}/state`, FACTORY_GAMES_DIR: `${TMP}/games`, FACTORY_WORKTREES_DIR: `${TMP}/wt`,
  FACTORY_INBOX_DIR: `${TMP}/inbox`, FACTORY_ARCHIVE_DIR: `${TMP}/archive`, FACTORY_KEY_PATH: `${TMP}/key/approval.key`,
  FACTORY_CONFIG: `${TMP}/config.json`,
});
fs.writeFileSync(`${TMP}/config.json`, JSON.stringify({ maxAttempts: 3, packageManager: 'corepack pnpm', models: REAL_CFG.models }));

const { FactoryError, loadConfig } = await import('../lib/core.mjs');
const S = await import('../lib/state.mjs');
const { modelRows, envOverrideRow, hardLinkRow } = await import('../lib/doctor.mjs');
const { MODEL_ENV_OVERRIDES } = await import('../lib/agents.mjs');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const AGENTS = path.join(ROOT, '.claude/agents');
const agentFiles = fs.readdirSync(AGENTS).filter((f) => f.endsWith('.md'));
const IMPLEMENTERS = ['game-developer', 'platform-engineer', 'qa-engineer', 'asset-producer'];

test('doctor: model env overrides are also read from the env blocks of .claude/settings(.local).json', () => {
  const clean = envOverrideRow({}, { '.claude/settings.json': {}, '.claude/settings.local.json': { env: { OTHER: '1' } } });
  assert.equal(clean.ok, true);
  for (const k of MODEL_ENV_OVERRIDES) {
    const proj = envOverrideRow({}, { '.claude/settings.json': { env: { [k]: 'x' } }, '.claude/settings.local.json': {} });
    assert.equal(proj.ok, 'warn', k);
    assert.match(proj.detail, new RegExp(`${k}=x \\[\\.claude/settings\\.json "env"\\]`));
    assert.match(proj.action, /\.claude\/settings\.json "env"/);
    const local = envOverrideRow({}, { '.claude/settings.json': {}, '.claude/settings.local.json': { env: { [k]: 'y' } } });
    assert.equal(local.ok, 'warn');
    assert.match(local.detail, /settings\.local\.json "env"/);
  }
  const both = envOverrideRow({ CLAUDE_CODE_EFFORT_LEVEL: 'low' }, { '.claude/settings.json': {}, '.claude/settings.local.json': {} });
  assert.match(both.detail, /\[environment\]/);
  // modelRows wires the injected settings objects into the same row
  const rows = modelRows({}, { settings: { model: 'm', env: { CLAUDE_CODE_SUBAGENT_MODEL: 'z' } }, local: {} });
  assert.equal(rows.find((r) => r.item === 'Model env overrides')?.ok, 'warn');
  assert.equal(modelRows({}, { settings: { model: 'm' }, local: {} }).find((r) => r.item === 'Model env overrides')?.ok, true);
});

test('doctor: hard-link probe passes on a normal disk, fails with an action when links cannot be made, leaves nothing behind', () => {
  const dir = `${TMP}/state-ok`;
  const ok = hardLinkRow(dir);
  assert.equal(ok.ok, true, ok.detail);
  assert.deepEqual(fs.readdirSync(dir), [], 'probe files removed');
  const notADir = `${TMP}/plain-file`;
  fs.writeFileSync(notADir, 'x');
  const bad = hardLinkRow(notADir);
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /cannot create a hard link/);
  assert.match(bad.action, /FAT\/exFAT|network share/);
});

test('reducer: plan.amended modifying a task that started meanwhile throws FactoryError (clean CLI refusal)', () => {
  const s = S.initialState('g');
  const task = { id: 'T1', phase: 1, agent: 'game-developer', reviewer: 'code-reviewer', deps: [], scope: ['src/**'], acceptance: [] };
  S.reduce(s, { seq: 1, ts: 't', type: 'plan.loaded', data: { phases: [{ n: 1, name: 'p', exitCriteria: [] }], tasks: [task], baseHead: 'h' } });
  S.reduce(s, { seq: 2, ts: 't', type: 'task.started', data: { taskId: 'T1', attempt: 1, worktree: 'w', branch: 'b', base: 'h' } });
  const ev = (id) => ({ seq: 3, ts: 't', type: 'plan.amended', data: { modified: [{ id, changes: { title: { before: 'a', after: 'b' } } }] } });
  assert.throws(() => S.reduce(s, ev('T1')), (e) => e instanceof FactoryError && /cannot modify T1: it is IN_PROGRESS/.test(e.message) && e.hints.length > 0);
  assert.throws(() => S.reduce(s, ev('NOPE')), (e) => e instanceof FactoryError && /unknown task NOPE/.test(e.message));
});

test('L-02: concurrency 3 and maxActiveAgents 4 in factory/config.json and as code defaults', () => {
  assert.equal(REAL_CFG.concurrency, 3);
  assert.equal(REAL_CFG.maxActiveAgents, 4);
  const d = loadConfig(); // temp config without the keys -> defaults
  assert.equal(d.concurrency, 3);
  assert.equal(d.maxActiveAgents, 4);
  assert.match(read('docs/factory/OPERATOR-MANUAL.md'), /Host load/);
});

test('every agent definition (base and -retry) states that a guard refusal is final', () => {
  assert.ok(agentFiles.length >= 14, agentFiles.join(','));
  for (const f of agentFiles) {
    const body = fs.readFileSync(path.join(AGENTS, f), 'utf8');
    assert.match(body, /## Factory guard refusals/, f);
    assert.match(body, /guard refusal is final for that action/, f);
    assert.match(body, /[Nn]ever rephrase/, f);
  }
  for (const r of ['code-reviewer', 'qa-engineer', 'tech-architect']) {
    assert.match(fs.readFileSync(path.join(AGENTS, `${r}.md`), 'utf8'), /`node --test <file>`[\s\S]*report the limitation/, r);
  }
});

test('ENV-01: implementer definitions and their -retry variants use corepack.cmd in the Bash tool', () => {
  for (const a of IMPLEMENTERS) {
    for (const f of [`${a}.md`, `${a}-retry.md`]) {
      const body = fs.readFileSync(path.join(AGENTS, f), 'utf8');
      assert.match(body, /corepack\.cmd pnpm/, f);
      assert.match(body, /MSYS_NO_PATHCONV=1/, f);
    }
  }
});

test('plan rules: tech-architect has L-01, ENG-12 for tests and FD-05; code-reviewer flags cross-scope staleness tests', () => {
  const ta = fs.readFileSync(path.join(AGENTS, 'tech-architect.md'), 'utf8');
  assert.match(ta, /L-01/);
  assert.match(ta, /flows\.spec\.ts[\s\S]*viewports\.spec\.ts[\s\S]*quality\.spec\.ts/);
  assert.match(ta, /contracts\/helpers task/);
  assert.match(ta, /ENG-12[^\n]*engineering\.md[^\n]*300 lines/);
  assert.match(ta, /FD-05/);
  assert.match(read('factory/standards/engineering.md'), /ENG-12 \| SHOULD \| Modules ≤ 300 lines, functions ≤ 50 lines/);
  const cr = fs.readFileSync(path.join(AGENTS, 'code-reviewer.md'), 'utf8');
  assert.match(cr, /FD-05[^\n]*flag as `major`/);
});

test('docs: GAME_CONVENTIONS says the Enter-once e2e cannot detect a missing dedupe; STATUS names the test command', () => {
  const conv = read('factory/templates/game-phaser-ts/GAME_CONVENTIONS.md');
  assert.match(conv, /CANNOT detect a\s+missing `dedupeKeyEvents`/);
  assert.match(conv, /tests\/unit\/key-dedupe\.test\.ts/);
  const para = conv.slice(conv.indexOf('The e2e test "one real Enter'), conv.indexOf('### Phaser delta-time cap'));
  for (const line of para.split('\n')) assert.ok(line.length <= 120, `over-long line: ${line}`);
  const status = read('docs/factory/STATUS.md');
  assert.match(status, /node --test factory\/cli\/test\/\*\.test\.mjs/);
  assert.doesNotMatch(status, /17\/17 pass \(real git/);
  // Deliberately no "STATUS lists every test file" check: that would force a docs edit whenever another change adds
  // a test file (the FD-05 cross-scope staleness pattern).
});

test.after(() => {
  if (!process.env.KEEP_TMP) fs.rmSync(TMP, { recursive: true, force: true });
});
