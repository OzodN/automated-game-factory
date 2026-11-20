// @ts-check
/**
 * End-to-end control-plane tests: real git repos, real worktrees, real hook scripts, fast fixture
 * template. Covers gates + token binding, plan validation, parallel scheduling, scope enforcement,
 * reviewer independence, retries/blocking/human retry, post-merge regression auto-revert,
 * merge conflicts, phase checkpoints, guard rules, recovery, deterministic zip.
 *
 * Pinned models (Step 0): the test config carries the real `models` table, so attempts >= 2 are
 * dispatched to `game-developer-retry` and must be claimed/reported by that agent type.
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-'));
const REAL_CFG = JSON.parse(fs.readFileSync(path.resolve(HERE, '../../config.json'), 'utf8'));
const env = {
  FACTORY_STATE_DIR: `${TMP}/state`, FACTORY_GAMES_DIR: `${TMP}/games`, FACTORY_WORKTREES_DIR: `${TMP}/wt`,
  FACTORY_INBOX_DIR: `${TMP}/inbox`, FACTORY_ARCHIVE_DIR: `${TMP}/archive`, FACTORY_KEY_PATH: `${TMP}/key/approval.key`,
  FACTORY_TEMPLATES_DIR: `${FIX}/templates`, FACTORY_KIT_DIR: `${FIX}/kit`, FACTORY_CONFIG: `${TMP}/config.json`,
};
Object.assign(process.env, env);
fs.writeFileSync(env.FACTORY_CONFIG, JSON.stringify({ maxAttempts: 3, concurrency: 2, maxActiveAgents: 3, packageManager: 'corepack pnpm', release: { maxBytes: 1e8, maxFiles: 1000, maxFileBytes: 1e7 }, models: REAL_CFG.models }));

const { paths, git, readJson } = await import('../lib/core.mjs');
const S = await import('../lib/state.mjs');
const G = await import('../lib/game.mjs');
const T = await import('../lib/tasks.mjs');
const { validatePlan } = await import('../lib/plan.mjs');
const { decide, applyEffects } = await import('../lib/guard.mjs');
const { recover, nextActions } = await import('../lib/reports.mjs');
const { zipDirectory, validateArchive } = await import('../lib/zip.mjs');
const { sha256File } = await import('../lib/core.mjs');

const GAME = 'test-game';
const HOOKS = path.resolve(HERE, '../../hooks');

/** Simulate the human typing a slash command: runs the REAL UserPromptSubmit hook. */
function human(prompt) {
  const r = spawnSync(process.execPath, [`${HOOKS}/user-prompt.mjs`], { input: JSON.stringify({ prompt, session_id: 'test' }), env: { ...process.env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/** Write a file as a given agent, through the guard (records provenance like the real hook). */
function agentWrite(file, content, who = {}) {
  const r = decide({ tool_name: 'Write', agent_id: who.id, agent_type: who.type, tool_input: { file_path: file }, cwd: TMP });
  assert.equal(r.decision, null, `write denied: ${r.reason}`);
  applyEffects(r.effects);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function claim(taskId, who) {
  const r = decide({ tool_name: 'Bash', agent_id: who.id, agent_type: who.type, tool_input: { command: `node factory/cli/factory.mjs task claim ${taskId} --game ${GAME}` } });
  assert.equal(r.decision, null, r.reason);
  applyEffects(r.effects);
}

function commitIn(wt, files, msg) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(`${wt}/${rel}`), { recursive: true });
    fs.writeFileSync(`${wt}/${rel}`, content);
  }
  git(['add', '-A'], wt);
  git(['commit', '-q', '-m', msg], wt);
}

function report(taskId, attempt, who, acIds = ['AC1']) {
  agentWrite(`${paths().inbox}/${GAME}/${taskId}/report-a${attempt}.json`, JSON.stringify({
    taskId, attempt, agent: who.type, summary: 'done', filesChanged: [], testsRun: [],
    acceptance: acIds.map((id) => ({ id, status: 'met', evidence: 'test' })), knownLimitations: [], unresolvedDefects: [],
  }), who);
}

function review(taskId, attempt, verdict, met = true, who = { id: 'rev1', type: 'code-reviewer' }) {
  agentWrite(`${paths().inbox}/${GAME}/${taskId}/review-a${attempt}.json`, JSON.stringify({
    taskId, attempt, reviewer: who.type, verdict, criteria: [{ id: 'AC1', met, evidence: 'checked' }], findings: met ? [] : [{ severity: 'major', file: 'src/x', issue: 'criterion not met', required_fix: 'fix it' }], summary: 's',
  }), who);
}

const task = (id, phase, scope, deps = [], extra = {}) => ({
  id, phase, title: `Task ${id}`, description: `Implement ${id} exactly as described in the specification section.`, agent: 'game-developer', reviewer: 'code-reviewer',
  deps, scope, acceptance: [{ id: 'AC1', text: `${id} module exports a value`, check: 'review' }], tests: ['unit'], risk: 'low', ...extra,
});
const PLAN = {
  phases: [
    { n: 1, name: 'Foundation', goal: 'base', exitCriteria: ['unit suite exits 0', 'build produces dist/index.html'] },
    { n: 2, name: 'Core', goal: 'core', exitCriteria: ['unit suite exits 0'] },
  ],
  tasks: [
    task('T1', 1, ['src/a/**']),
    task('T2', 1, ['src/b/**']),
    task('T3', 1, ['src/c/**'], ['T1', 'T2'], { verifySteps: ['install', 'typecheck'] }),
    task('T4', 2, ['src/d/**'], ['T3']),
  ],
};

test('ideation: game creation and write isolation', () => {
  const s = G.newGame(GAME, 'Test Game');
  assert.equal(s.mode, 'IDEATION');
  const repo = T.gameRepo(GAME);
  assert.ok(fs.existsSync(`${repo}/.git`));
  // Orchestrator cannot write game source during ideation; design/concept is writable.
  assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: `${repo}/src/main.ts` } }).decision, 'deny');
  assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: `${repo}/design/spec/gdd.md` } }).decision, 'deny', 'spec not writable before concept approval');
  assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: `${repo}/design/concept/concept-brief.md` } }).decision, null);
  assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: `${paths().state}/games/x/events.jsonl` } }).decision, 'deny');
});

test('guard: dangerous commands and forged sessions are blocked', () => {
  const bash = (command, extra = {}) => decide({ tool_name: 'Bash', tool_input: { command }, ...extra }).decision;
  assert.equal(bash('claude -p "/approve-phase"'), 'deny');
  assert.equal(bash('git push origin main'), 'deny');
  assert.equal(bash('git reset --hard HEAD~1'), 'deny');
  assert.equal(bash('cat ~/.game-factory/approval.key'), 'deny');
  assert.equal(bash(`rm -rf ${paths().state}`), 'deny');
  assert.equal(bash(`echo x > ${paths().state}/approvals.jsonl`), 'deny');
  assert.equal(bash('cd /x/.worktrees/g/T1 && rm -rf dist'), null, 'deleting own build output is fine');
  assert.equal(bash('cat .claude/agents/x.md && git status'), null);
  assert.equal(bash('node factory/cli/factory.mjs task integrate T1', { agent_id: 'a', agent_type: 'game-developer' }), 'deny', 'subagents cannot change state');
  assert.equal(bash('node factory/cli/factory.mjs status', { agent_id: 'a', agent_type: 'game-developer' }), null);
});

test('gate: concept approval requires a human token bound to the current brief', () => {
  const repo = T.gameRepo(GAME);
  assert.throws(() => G.approveConcept(GAME), /missing/);
  agentWrite(`${repo}/design/concept/concept-brief.md`, '# Concept v1', { id: 'd1', type: 'game-designer' });
  assert.throws(() => G.approveConcept(GAME), /No valid human approval/);
  const ctx = human('/approve-concept');
  assert.match(ctx, /recorded and signed/);
  // Brief changes after the human approved -> refused as stale.
  agentWrite(`${repo}/design/concept/concept-brief.md`, '# Concept v2', { id: 'd1', type: 'game-designer' });
  assert.throws(() => G.approveConcept(GAME), /different state/);
  human('/approve-concept');
  assert.equal(G.approveConcept(GAME).mode, 'CONCEPT_APPROVED');
  // Concept now frozen.
  assert.equal(decide({ tool_name: 'Write', agent_id: 'd1', agent_type: 'game-designer', tool_input: { file_path: `${repo}/design/concept/concept-brief.md` } }).decision, 'deny');
});

test('gate: development cannot start before spec approval; spec approval and start are separate', () => {
  const repo = T.gameRepo(GAME);
  human('/start-development');
  assert.throws(() => G.startDevelopment(GAME), /CONCEPT_APPROVED/);
  G.startSpec(GAME);
  for (const f of G.REQUIRED_SPEC_DOCS) agentWrite(`${repo}/design/spec/${f}`, `# ${f}`, { id: 'd1', type: 'game-designer' });
  assert.throws(() => G.approveSpec(GAME), /No valid human approval/);
  human('/approve-spec');
  assert.equal(G.approveSpec(GAME).mode, 'SPEC_APPROVED');
  // The /start-development token typed earlier was bound to "no spec" and is stale.
  assert.throws(() => G.startDevelopment(GAME, { template: 'mini' }), /different state|No valid/);
  human('/start-development');
  const r = G.startDevelopment(GAME, { template: 'mini' });
  assert.equal(r.state.mode, 'DEV_AUTHORIZED');
  assert.ok(r.scaffold.baseline.every((b) => b.ok));
  assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: `${repo}/design/spec/gdd.md` } }).decision, 'deny', 'spec frozen');
});

test('plan: invalid plans are rejected with explicit reasons', () => {
  const bad = (mut) => { const p = structuredClone(PLAN); mut(p); return () => validatePlan(p); };
  assert.throws(bad((p) => { p.tasks[0].deps = ['T3']; }), /cycle/);
  assert.throws(bad((p) => { p.tasks[1].scope = ['src/**']; }), /overlapping scopes/);
  assert.throws(bad((p) => { p.tasks[0].acceptance[0].text = 'works perfectly'; }), /not measurable/);
  assert.throws(bad((p) => { p.tasks[0].reviewer = 'game-developer'; p.tasks[0].agent = 'game-developer'; }), /reviewer/);
  assert.throws(bad((p) => { p.tasks[0].scope = ['design/spec/**']; }), /frozen/);
  assert.throws(bad((p) => { p.tasks[3].phase = 1; p.tasks[2].deps = ['T1', 'T2', 'T4']; }), /cycle|later-phase/);
  const r = G.loadPlan(GAME, writeTmp('plan.json', PLAN));
  assert.equal(r.state.mode, 'DEVELOPMENT');
});

function writeTmp(name, obj) { const f = `${TMP}/${name}`; fs.writeFileSync(f, JSON.stringify(obj)); return f; }

const dev1 = { id: 'dev1', type: 'game-developer' };
const dev2 = { id: 'dev2', type: 'game-developer' };
/** The Opus retry variant that executes attempts >= 2 (same agent slot id: the previous run has stopped). */
const retryOf = (who) => ({ id: who.id, type: `${who.type}-retry` });

test('scheduling: independent tasks run in parallel in isolated worktrees; dependents wait', () => {
  const s = S.loadState(GAME);
  assert.deepEqual(S.readyTasks(s).map((t) => t.id), ['T1', 'T2']);
  const a = T.startTask(GAME, 'T1');
  const b = T.startTask(GAME, 'T2');
  assert.notEqual(a.worktree, b.worktree);
  assert.ok(fs.existsSync(`${a.worktree}/factory.game.json`));
  assert.throws(() => T.startTask(GAME, 'T3'), /not ready|Concurrency/);
  claim('T1', dev1);
  claim('T2', dev2);
  // Each agent may only write in its own worktree.
  assert.equal(decide({ tool_name: 'Write', agent_id: 'dev1', agent_type: 'game-developer', tool_input: { file_path: `${b.worktree}/src/b/x.js` } }).decision, 'deny');
  assert.equal(decide({ tool_name: 'Write', agent_id: 'dev1', agent_type: 'game-developer', tool_input: { file_path: `${a.worktree}/src/a/x.js` } }).decision, null);
  // A different agent type cannot claim someone else's task.
  assert.equal(decide({ tool_name: 'Bash', agent_id: 'x', agent_type: 'platform-engineer', tool_input: { command: `node factory/cli/factory.mjs task claim T1 --game ${GAME}` } }).decision, 'deny');
});

test('verification: scope violations and defects are rejected by evidence, retries keep history, then BLOCKED', () => {
  const wt1 = T.wtDir(GAME, 'T1');
  commitIn(wt1, { 'src/a/a.js': 'export const a = 1;\n' }, 'feat(T1): a');
  report('T1', 1, dev1);
  const v1 = T.submitTask(GAME, 'T1');
  assert.equal(v1.ok, true, JSON.stringify(v1.checks));

  const wt2 = T.wtDir(GAME, 'T2');
  commitIn(wt2, { 'src/b/b.js': 'export const b = 1;\n', 'src/a/hack.js': 'x' }, 'feat(T2): b + out of scope');
  report('T2', 1, dev2);
  const v2 = T.submitTask(GAME, 'T2');
  assert.equal(v2.ok, false);
  assert.ok(v2.checks.find((c) => c.name === 'scope' && !c.ok));

  T.startTask(GAME, 'T2');
  claim('T2', retryOf(dev2));
  git(['rm', '-q', 'src/a/hack.js'], wt2);
  commitIn(wt2, { 'src/b/b.js': 'export const b = "BUG";\n' }, 'fix(T2): scope, still defective');
  report('T2', 2, retryOf(dev2));
  const v3 = T.submitTask(GAME, 'T2');
  assert.equal(v3.ok, false);
  assert.ok(v3.checks.find((c) => c.name === 'step:unit' && !c.ok));

  T.startTask(GAME, 'T2');
  claim('T2', retryOf(dev2));
  commitIn(wt2, { 'src/b/b.js': 'export const b = "BUG again";\n' }, 'fix(T2): attempt 3');
  report('T2', 3, retryOf(dev2));
  const v4 = T.submitTask(GAME, 'T2');
  assert.equal(v4.ok, false);
  assert.ok(v4.blocked, 'third failure blocks the task');
  const s = S.loadState(GAME);
  assert.equal(s.tasks.T2.status, 'BLOCKED');
  assert.equal(s.tasks.T2.attempts.length, 3, 'full attempt history preserved');
  assert.ok(fs.readFileSync(s.tasks.T2.blocker, 'utf8').includes('Attempt 2'));
  assert.ok(fs.existsSync(wt2), 'failed worktree preserved');
  assert.throws(() => T.startTask(GAME, 'T2'), /BLOCKED/);
  assert.ok(nextActions(s).some((a) => a.cmd.includes('/retry-task T2')));
  // Only the human can unblock.
  human('/retry-task T2'); // consumed in a later test via `factory task retry` semantics
});

test('review: implementer cannot self-review; ACCEPT with unmet criteria is overridden', () => {
  // Implementer writes a review file -> guard denies outright.
  assert.equal(decide({ tool_name: 'Write', agent_id: 'dev1', agent_type: 'game-developer', tool_input: { file_path: `${paths().inbox}/${GAME}/T1/review-a1.json` } }).decision, 'deny');
  // Orchestrator writes it -> provenance check refuses it at ingest.
  agentWrite(`${paths().inbox}/${GAME}/T1/review-a1.json`, JSON.stringify({ verdict: 'ACCEPT', criteria: [{ id: 'AC1', met: true }] }), {});
  assert.throws(() => T.recordReview(GAME, 'T1'), /only code-reviewer/);
  review('T1', 1, 'ACCEPT', false);
  const r = T.recordReview(GAME, 'T1');
  assert.equal(r.verdict, 'REJECT');
  assert.match(r.override, /overridden/);
});

test('integration: accepted work merges no-ff; post-merge regression is detected and auto-reverted', () => {
  const wt1 = T.wtDir(GAME, 'T1');
  T.startTask(GAME, 'T1');
  claim('T1', retryOf(dev1));
  commitIn(wt1, { 'src/a/a.js': 'export const a = 2;\n' }, 'fix(T1): address review');
  report('T1', 2, retryOf(dev1));
  assert.equal(T.submitTask(GAME, 'T1').ok, true);
  review('T1', 2, 'ACCEPT');
  assert.equal(T.recordReview(GAME, 'T1').verdict, 'ACCEPT');
  assert.throws(() => T.integrateTask(GAME, 'T2'), /only ACCEPTED/);
  const i1 = T.integrateTask(GAME, 'T1');
  assert.equal(i1.ok, true);
  const iwt = T.integrationDir(GAME);
  assert.match(git(['log', '-1', '--format=%P'], iwt), / /, 'merge commit has two parents (no-ff)');
});

test('human retry unblocks; parallel T2 integrates; T3 regression caught after merge', async () => {
  const { commit } = S;
  const { requireToken } = await import('../lib/approvals.mjs');
  requireToken({ command: 'retry-task', game: GAME, target: 'task:T2', by: 'test' });
  commit(GAME, [{ type: 'task.retry_granted', data: { taskId: 'T2', extra: 2, resumeStatus: 'REJECTED' } }]);
  const wt2 = T.wtDir(GAME, 'T2');
  const started = T.startTask(GAME, 'T2');
  assert.equal(started.dispatchTo, 'game-developer-retry', 'attempt 4 runs on the retry variant');
  claim('T2', retryOf(dev2));
  commitIn(wt2, { 'src/b/b.js': 'export const b = 2;\n' }, 'fix(T2): correct');
  report('T2', 4, retryOf(dev2));
  assert.equal(T.submitTask(GAME, 'T2').ok, true);
  review('T2', 4, 'ACCEPT');
  T.recordReview(GAME, 'T2');
  assert.equal(T.integrateTask(GAME, 'T2').ok, true);

  // T3 skips unit tests in its task verify (verifySteps) -> its defect is only caught by regression.
  T.startTask(GAME, 'T3');
  const dev3 = { id: 'dev3', type: 'game-developer' };
  claim('T3', dev3);
  const wt3 = T.wtDir(GAME, 'T3');
  commitIn(wt3, { 'src/c/c.js': 'export const c = "BUG";\n' }, 'feat(T3): c');
  report('T3', 1, dev3);
  assert.equal(T.submitTask(GAME, 'T3').ok, true);
  review('T3', 1, 'ACCEPT');
  T.recordReview(GAME, 'T3');
  const before = git(['rev-parse', 'HEAD'], T.integrationDir(GAME));
  const r = T.integrateTask(GAME, 'T3');
  assert.equal(r.ok, false);
  assert.equal(r.regressionFailed, 'unit');
  assert.ok(!fs.existsSync(`${T.integrationDir(GAME)}/src/c/c.js`), 'defective merge reverted');
  assert.notEqual(git(['rev-parse', 'HEAD'], T.integrationDir(GAME)), before, 'revert recorded as new commit (history kept)');
  assert.equal(S.loadState(GAME).tasks.T3.status, 'INTEGRATION_FAILED');
});

test('integration conflict aborts the merge (no blind resolution) and returns the task', () => {
  const iwt = T.integrationDir(GAME);
  const dev3r = { id: 'dev3', type: 'game-developer-retry' };
  // A conflicting change lands on develop independently (e.g. an approved spec merge).
  fs.mkdirSync(`${iwt}/src/c`, { recursive: true });
  fs.writeFileSync(`${iwt}/src/c/c.js`, 'export const c = "develop";\n');
  git(['add', '-A'], iwt); git(['commit', '-q', '-m', 'test: conflicting change on develop'], iwt);
  const wt3 = T.wtDir(GAME, 'T3');
  T.startTask(GAME, 'T3');
  claim('T3', dev3r);
  commitIn(wt3, { 'src/c/c.js': 'export const c = 3;\n' }, 'fix(T3): no defect');
  report('T3', 2, dev3r);
  assert.equal(T.submitTask(GAME, 'T3').ok, true);
  review('T3', 2, 'ACCEPT');
  T.recordReview(GAME, 'T3');
  const r = T.integrateTask(GAME, 'T3');
  assert.equal(r.ok, false);
  assert.equal(r.conflict, true);
  assert.equal(git(['status', '--porcelain'], iwt), '', 'integration worktree left clean');
  assert.equal(S.loadState(GAME).tasks.T3.status, 'NEEDS_REBASE');
  // Agent merges develop deliberately and resolves.
  T.startTask(GAME, 'T3');
  claim('T3', dev3r);
  git(['merge', 'develop'], wt3, { allowFail: true });
  fs.writeFileSync(`${wt3}/src/c/c.js`, 'export const c = 3; // resolved: develop value superseded per spec\n');
  git(['add', '-A'], wt3); git(['commit', '-q', '--no-edit'], wt3);
  report('T3', 3, dev3r);
  assert.equal(T.submitTask(GAME, 'T3').ok, true);
  review('T3', 3, 'ACCEPT');
  T.recordReview(GAME, 'T3');
  assert.equal(T.integrateTask(GAME, 'T3').ok, true);
});

test('phase checkpoint halts progression until the human approves', () => {
  const r = G.checkpointPhase(GAME);
  assert.equal(r.ok, true);
  const s = S.loadState(GAME);
  assert.equal(s.phases[0].status, 'CHECKPOINT');
  assert.deepEqual(S.readyTasks(s).map((t) => t.id), [], 'no phase-2 task is ready at checkpoint');
  assert.throws(() => T.startTask(GAME, 'T4'), /not ready/);
  assert.throws(() => G.approvePhase(GAME), /No valid human approval/);
  human('/approve-phase');
  const s2 = G.approvePhase(GAME);
  assert.equal(s2.phases[1].status, 'RUNNING');
  assert.ok(fs.existsSync(r.report));
});

test('recovery: interrupted task is reconciled from disk after a restart', () => {
  T.startTask(GAME, 'T4');
  const wt4 = T.wtDir(GAME, 'T4');
  commitIn(wt4, { 'src/d/d.js': 'export const d = 1;\n' }, 'feat(T4): partial');
  // simulated crash: no report. A fresh process rebuilds state from the event log.
  fs.rmSync(`${paths().gamesState}/${GAME}/state.json`);
  const f1 = recover().find((x) => x.task === 'T4');
  assert.match(f1.fix, /SAME worktree/);
  claim('T4', dev1);
  report('T4', 1, dev1);
  const f2 = recover().find((x) => x.task === 'T4');
  assert.match(f2.fix, /task submit T4/);
  assert.deepEqual(S.rebuild(GAME), S.loadState(GAME), 'snapshot equals event-log replay');
});

test('second game is fully independent', () => {
  G.newGame('other-game', 'Other');
  assert.equal(S.loadState('other-game').mode, 'IDEATION');
  assert.equal(S.loadState(GAME).mode, 'DEVELOPMENT');
  assert.notEqual(T.gameRepo('other-game'), T.gameRepo(GAME));
  assert.equal(git(['log', '--oneline'], T.gameRepo('other-game')).split('\n').length, 1, 'own history');
});

test('shared kit: a new kit release reaches new games only; existing games stay pinned', () => {
  const iwt = T.integrationDir(GAME);
  const pinned = readJson(`${iwt}/factory.game.json`) && fs.readdirSync(`${iwt}/vendor`);
  assert.deepEqual(pinned, ['pg-kit-0.0.1.tgz']);
  fs.writeFileSync(`${paths().kit}/release/pg-kit-0.0.2.tgz`, 'kit v2');
  try {
    const fresh = `${TMP}/fresh-render`;
    const kit = G.renderTemplate(`${paths().templates}/mini`, fresh, 'fresh', 'Fresh');
    assert.equal(kit.version, '0.0.2', 'new scaffolds get the newest kit');
    assert.deepEqual(fs.readdirSync(`${iwt}/vendor`), ['pg-kit-0.0.1.tgz'], 'existing game unaffected until an explicit upgrade task');
    assert.equal(git(['status', '--porcelain'], iwt), '', 'no change leaked into the existing game');
  } finally {
    fs.rmSync(`${paths().kit}/release/pg-kit-0.0.2.tgz`);
  }
});

test('playgama write tools are refused without an op-specific human authorization', () => {
  S.setFocus(GAME);
  const mcp = (tool, extra = {}) => decide({ tool_name: `mcp__plugin_playgama-developer-cabinet_playgama__${tool}`, tool_input: {}, ...extra });
  assert.equal(mcp('publish_sandbox').decision, 'deny');
  assert.equal(mcp('send_playgama_catalog_update').decision, 'deny');
  assert.equal(mcp('get_launch_steps').decision, null, 'read tools allowed');
  assert.equal(mcp('delete_application').decision, 'deny', 'unknown write-like tools refused');
  human(`/authorize-publish draft ${GAME}`);
  assert.equal(mcp('publish_sandbox').decision, 'deny', 'draft authorization does not cover the public sandbox');
  assert.equal(mcp('create_application').decision, null, 'draft authorized');
  assert.equal(mcp('create_application', { agent_id: 'x', agent_type: 'game-developer' }).decision, 'deny', 'implementers cannot publish');
});

test('release zip is deterministic and validated', () => {
  const d = `${TMP}/zipsrc`;
  fs.mkdirSync(`${d}/assets`, { recursive: true });
  fs.writeFileSync(`${d}/index.html`, '<!doctype html>');
  fs.writeFileSync(`${d}/assets/a.js`, 'console.log(1)'.repeat(50));
  zipDirectory(d, `${TMP}/a.zip`);
  zipDirectory(d, `${TMP}/b.zip`);
  assert.equal(sha256File(`${TMP}/a.zip`), sha256File(`${TMP}/b.zip`));
  const v = validateArchive(`${TMP}/a.zip`, { maxBytes: 1e8, maxFiles: 100, maxFileBytes: 1e7 });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('playgama-bridge-config.json')));
  fs.writeFileSync(`${d}/playgama-bridge-config.json`, '{}');
  zipDirectory(d, `${TMP}/c.zip`);
  assert.equal(validateArchive(`${TMP}/c.zip`, { maxBytes: 1e8, maxFiles: 100, maxFileBytes: 1e7 }).ok, true);
});

test.after(() => {
  if (!process.env.KEEP_TMP) fs.rmSync(TMP, { recursive: true, force: true });
  else console.log(`kept ${TMP}`);
});
