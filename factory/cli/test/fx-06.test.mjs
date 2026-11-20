// @ts-check
/**
 * FX-06 (defect FD-04): plan amendments can modify PENDING tasks and can be validated without writing.
 * Covered: modifying a pending task's acceptance (plan.amended records before/after, the phase report quotes it),
 * refusing modifications of started tasks, refusing modifications that create a scope overlap with a parallel task
 * or a same-base-role review, `plan validate --amend --game` reporting the same errors as `plan load --amend`
 * without writing, the reducer re-check (task started between check and commit), the roster derived from
 * agents.mjs, and the L-01 warning for a task that owns a whole test tree with many acceptance criteria.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const CLI = path.resolve(HERE, '../factory.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-fx06-'));
const REAL_CFG = JSON.parse(fs.readFileSync(path.resolve(HERE, '../../config.json'), 'utf8'));
const env = {
  FACTORY_STATE_DIR: `${TMP}/state`, FACTORY_GAMES_DIR: `${TMP}/games`, FACTORY_WORKTREES_DIR: `${TMP}/wt`,
  FACTORY_INBOX_DIR: `${TMP}/inbox`, FACTORY_ARCHIVE_DIR: `${TMP}/archive`, FACTORY_KEY_PATH: `${TMP}/key/approval.key`,
  FACTORY_TEMPLATES_DIR: `${FIX}/templates`, FACTORY_KIT_DIR: `${FIX}/kit`, FACTORY_CONFIG: `${TMP}/config.json`,
};
Object.assign(process.env, env);
const BASE_CFG = { maxAttempts: 3, concurrency: 4, maxActiveAgents: 3, packageManager: 'corepack pnpm', models: REAL_CFG.models };
fs.writeFileSync(env.FACTORY_CONFIG, JSON.stringify(BASE_CFG));

const { git } = await import('../lib/core.mjs');
const S = await import('../lib/state.mjs');
const G = await import('../lib/game.mjs');
const T = await import('../lib/tasks.mjs');
const P = await import('../lib/plan.mjs');
const { FACTORY_AGENTS } = await import('../lib/agents.mjs');
const { renderPhaseData } = await import('../lib/reports.mjs');

const GAME = 'fx-amend';
const PHASES = [{ n: 1, name: 'One', goal: 'g', exitCriteria: ['unit suite exits 0'] }];
const task = (id, scope, extra = {}) => ({
  id, phase: 1, title: `Task ${id}`, description: `Implement ${id} exactly as described in the specification section.`, agent: 'game-developer', reviewer: 'code-reviewer',
  deps: [], scope, acceptance: [{ id: 'AC1', text: `${id} exports a value`, check: 'review' }], tests: [], risk: 'low', ...extra,
});
const ac = (n) => Array.from({ length: n }, (_, i) => ({ id: `AC${i + 1}`, text: `criterion ${i + 1} passes`, check: 'test', ref: 'tests/e2e/a.spec.ts' }));
let fileN = 0;
const writeAmend = (obj) => { const f = `${TMP}/amend-${++fileN}.json`; fs.writeFileSync(f, JSON.stringify(obj)); return f; };
const eventsFile = () => `${S.gameDir(GAME)}/events.jsonl`;
const snapshot = () => ({ events: fs.readFileSync(eventsFile(), 'utf8'), state: fs.readFileSync(`${S.gameDir(GAME)}/state.json`, 'utf8') });
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env }, encoding: 'utf8' });
const errOf = (fn) => { try { fn(); } catch (e) { return String(e.message); } assert.fail('expected an error'); };

test('setup: game in DEVELOPMENT; T1 started, T2 pending and parallel to T3 (T3 depends on T1)', () => {
  G.newGame(GAME, 'FX amend');
  for (const type of ['concept.approved', 'spec.started', 'spec.approved', 'dev.authorized']) S.commit(GAME, [{ type, data: { hash: 'h' } }]);
  git(['branch', 'develop', 'main'], T.gameRepo(GAME));
  const f = `${TMP}/plan.json`;
  fs.writeFileSync(f, JSON.stringify({ phases: PHASES, tasks: [task('T1', ['src/a/**']), task('T2', ['src/b/**']), task('T3', ['src/c/**'], { deps: ['T1'] })] }));
  G.loadPlan(GAME, f);
  T.startTask(GAME, 'T1');
  const s = S.loadState(GAME);
  assert.equal(s.tasks.T1.status, 'IN_PROGRESS');
  assert.equal(s.tasks.T2.status, 'PENDING');
});

test('the plan roster is derived from agents.mjs (base roles only)', () => {
  assert.deepEqual(P.IMPLEMENTERS, FACTORY_AGENTS.implementers);
  assert.deepEqual(P.REVIEWERS, FACTORY_AGENTS.reviewers);
  const s = S.loadState(GAME);
  const msg = errOf(() => P.validateAmendment({ tasks: [task('T9', ['src/z/**'], { agent: 'game-developer-retry' })] }, s));
  assert.match(msg, /T9: agent must be one of .*never -retry variants/);
});

test('modify a pending task: acceptance changes, plan.amended records before/after, the phase report quotes it', () => {
  const before = S.loadState(GAME).tasks.T2.acceptance;
  const newAc = [{ id: 'AC1', text: 'T2 exports a value', check: 'review' }, { id: 'AC2', text: 'unit test T2-a exits 0', check: 'test', ref: 'tests/unit/t2.test.ts' }];
  const file = writeAmend({ game: GAME, source: 'review R-1 of T1', notes: ['legacy keys are ignored'], modify: [{ id: 'T2', acceptance: newAc }] });
  const r = G.loadPlan(GAME, file, { amend: true });
  assert.equal(r.tasks.length, 0);
  assert.deepEqual(r.modified, [{ id: 'T2', changes: { acceptance: { before, after: newAc } } }]);
  const s = S.loadState(GAME);
  assert.deepEqual(s.tasks.T2.acceptance, newAc);
  assert.equal(s.tasks.T2.status, 'PENDING');
  const ev = S.loadEvents(GAME).at(-1);
  assert.equal(ev.type, 'plan.amended');
  assert.deepEqual(ev.data.modified[0].changes.acceptance.before, before);
  assert.deepEqual(ev.data.modified[0].changes.acceptance.after, newAc);
  assert.equal(s.tasks.T2.amendments.length, 1);
  assert.equal(S.rebuild(GAME).tasks.T2.acceptance.length, 2, 'replay yields the same state');
  const report = renderPhaseData(GAME, s, s.phases[0], { head: '0'.repeat(40), ts: 'now', results: [] });
  assert.match(report, /Plan amendments to tasks of this phase/);
  assert.match(report, /T2\.acceptance: \[\{"id":"AC1".*\] -> \[\{"id":"AC1".*"AC2"/);
});

test('modify and add in one amendment; unchanged values only warn', () => {
  const file = writeAmend({ tasks: [task('T4', ['src/d/**'], { deps: ['T2'] })], modify: [{ id: 'T3', description: 'Implement T3 against the amended interface of T1 (section 4).' }, { id: 'T2', risk: 'low' }] });
  const r = G.loadPlan(GAME, file, { amend: true });
  assert.deepEqual(r.tasks.map((t) => t.id), ['T4']);
  assert.deepEqual(r.modified.map((m) => m.id), ['T3']);
  assert.match(r.warnings.join('\n'), /modify T2: .*nothing changes/);
  const s = S.loadState(GAME);
  assert.equal(s.tasks.T4.status, 'PENDING');
  assert.match(s.tasks.T3.description, /amended interface/);
});

test('refuse modifying a started task, unknown fields and unknown tasks (nothing written)', () => {
  const before = snapshot();
  const msg = errOf(() => G.loadPlan(GAME, writeAmend({ modify: [{ id: 'T1', acceptance: ac(1) }] }), { amend: true }));
  assert.match(msg, /modify T1: task is IN_PROGRESS with 1 attempt\(s\); only PENDING tasks that were never started can be modified/);
  assert.match(errOf(() => G.loadPlan(GAME, writeAmend({ modify: [{ id: 'T2', phase: 2 }] }), { amend: true })), /modify T2: field\(s\) phase cannot be modified/);
  assert.match(errOf(() => G.loadPlan(GAME, writeAmend({ modify: [{ id: 'NOPE', risk: 'high' }] }), { amend: true })), /modify NOPE: unknown task/);
  assert.match(errOf(() => G.loadPlan(GAME, writeAmend({ notes: [] }), { amend: true })), /neither new "tasks" nor "modify"/);
  assert.deepEqual(snapshot(), before);
});

test('refuse a modification that creates a scope overlap with a parallel task or a same-role review', () => {
  const before = snapshot();
  const overlap = errOf(() => G.loadPlan(GAME, writeAmend({ modify: [{ id: 'T2', scope: ['src/c/**'] }] }), { amend: true }));
  assert.match(overlap, /parallel tasks (T2 and T3|T3 and T2) have overlapping scopes "src\/c\/\*\*" \/ "src\/c\/\*\*"/);
  const sameRole = errOf(() => G.loadPlan(GAME, writeAmend({ modify: [{ id: 'T2', agent: 'qa-engineer', reviewer: 'qa-engineer' }] }), { amend: true }));
  assert.match(sameRole, /task T2: reviewer must differ from implementer .*same base role/);
  const retry = errOf(() => G.loadPlan(GAME, writeAmend({ modify: [{ id: 'T2', reviewer: 'game-developer-retry' }] }), { amend: true }));
  assert.match(retry, /reviewer must be one of/);
  const cycle = errOf(() => G.loadPlan(GAME, writeAmend({ modify: [{ id: 'T2', deps: ['T4'] }] }), { amend: true }));
  assert.match(cycle, /dependency cycle/);
  // A dependency makes the same scope legal (no longer parallel).
  assert.doesNotThrow(() => P.validateAmendment({ modify: [{ id: 'T2', scope: ['src/c/**'], deps: ['T3'] }] }, S.loadState(GAME)));
  assert.deepEqual(snapshot(), before);
});

test('plan validate --amend --game reports the same errors as plan load --amend, without writing', () => {
  // Field-level problems are listed together; the overlap/cycle analysis runs once they are fixed.
  const bad = writeAmend({ modify: [{ id: 'T1', risk: 'high' }, { id: 'T2', agent: 'qa-engineer', reviewer: 'qa-engineer' }] });
  const overlapping = writeAmend({ modify: [{ id: 'T2', scope: ['src/c/**'] }] });
  for (const [file, re] of [[bad, /modify T1: task is IN_PROGRESS[\s\S]*task T2: reviewer must differ from implementer/], [overlapping, /parallel tasks (T2 and T3|T3 and T2) have overlapping scopes/]]) {
    const loadMsg = errOf(() => G.loadPlan(GAME, file, { amend: true }));
    assert.match(loadMsg, re);
    const before = snapshot();
    const r = cli('plan', 'validate', file, '--amend', '--game', GAME);
    assert.equal(r.status, 1, r.stdout);
    assert.equal(r.stderr.trim(), `ERROR: ${loadMsg}`);
    assert.deepEqual(snapshot(), before);
  }
  const before = snapshot();
  const good = writeAmend({ modify: [{ id: 'T2', tests: ['unit: T2 export'] }] });
  const ok = cli('plan', 'validate', good, '--amend', '--game', GAME);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Amendment valid for fx-amend: 0 new task\(s\), 1 modified task\(s\)\.\n {2}~ T2\.tests: \[\] -> \["unit: T2 export"\]/);
  assert.deepEqual(snapshot(), before, 'validate --amend writes nothing (no event, no snapshot)');
  // Without --amend the file is validated as a full plan (it has no phases).
  const full = cli('plan', 'validate', good);
  assert.equal(full.status, 1);
  assert.match(full.stderr, /plan\.phases must be a non-empty array/);
});

test('plan validate --amend stays allowed for subagents; plan load --amend does not', async () => {
  const { decide } = await import('../lib/guard.mjs');
  const run = (cmd) => decide({ tool_name: 'Bash', agent_id: 'arch1', agent_type: 'tech-architect', tool_input: { command: `node "${CLI}" ${cmd}` } });
  assert.equal(run(`plan validate "${TMP}/a.json" --amend --game ${GAME}`).decision, null);
  assert.equal(run(`plan load "${TMP}/a.json" --amend --game ${GAME}`).decision, 'deny');
});

test('the reducer refuses a modification when the task was started after the check (nothing written)', () => {
  const s = S.loadState(GAME);
  const r = P.validateAmendment({ modify: [{ id: 'T2', risk: 'high' }] }, s);
  T.startTask(GAME, 'T2');
  const before = snapshot();
  assert.throws(() => S.commit(GAME, [{ type: 'plan.amended', data: { tasks: [], modified: r.modified, source: 'x' } }]), /cannot modify T2: it is IN_PROGRESS/);
  assert.deepEqual(snapshot(), before);
});

test('L-01: a task owning a whole test tree with more than N criteria gets a WARNING, not an error', () => {
  const plan = (n, scope = ['tests/e2e/**']) => ({ phases: PHASES, tasks: [task('E1', scope, { agent: 'qa-engineer', acceptance: ac(n) })] });
  assert.equal(P.TEST_TREE_MAX_CRITERIA, 25);
  assert.deepEqual(P.validatePlan(plan(25)).warnings, []);
  const w = P.validatePlan(plan(26)).warnings;
  assert.equal(w.length, 1);
  assert.match(w[0], /L-01: task E1 owns the whole test tree "tests\/e2e\/\*\*" with 26 acceptance criteria \(> 25\); consider splitting it by area \(flows \/ viewports \/ quality\)/);
  assert.deepEqual(P.validatePlan(plan(26, ['tests/e2e/flows.spec.ts', 'tests/e2e/helpers/*.ts'])).warnings, [], 'a part of the tree is fine');
  assert.equal(P.validatePlan(plan(26, ['tests/**'])).warnings.length, 1);
  assert.equal(P.validatePlan(plan(4), { testTreeMaxCriteria: 3 }).warnings.length, 1, 'N via option');
  fs.writeFileSync(env.FACTORY_CONFIG, JSON.stringify({ ...BASE_CFG, planTestTreeMaxCriteria: 3 }));
  try {
    assert.equal(P.validatePlan(plan(4)).warnings.length, 1, 'N via config');
  } finally { fs.writeFileSync(env.FACTORY_CONFIG, JSON.stringify(BASE_CFG)); }
  assert.ok(P.isWholeTestTree('e2e/**') && P.isWholeTestTree('tests/unit/**') === false && !P.isWholeTestTree('src/**'));
  const f = writeAmend(plan(30));
  const r = cli('plan', 'validate', f);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Plan valid: 1 phases, 1 tasks\.\nWARNING: L-01: task E1/);
  const r2 = cli('plan', 'validate', f, '--test-tree-max-criteria', '40');
  assert.doesNotMatch(r2.stdout, /WARNING/);
});
