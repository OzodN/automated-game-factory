// @ts-check
/**
 * Step 0 — pinned agent models.
 * The pinning table in factory/config.json is the single source of truth; every agent definition must
 * match it, the `-retry` variants must be in sync with their base definitions, Agent calls may not pass
 * model/effort, and task attempts are dispatched (and claimable) only by the expected agent type.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const FIX = path.join(HERE, 'fixtures');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-fxmodels-'));
const REAL_CFG = JSON.parse(fs.readFileSync(path.resolve(HERE, '../../config.json'), 'utf8'));
const AGENTS_DIR = path.join(ROOT, '.claude', 'agents');
const env = {
  FACTORY_STATE_DIR: `${TMP}/state`, FACTORY_GAMES_DIR: `${TMP}/games`, FACTORY_WORKTREES_DIR: `${TMP}/wt`,
  FACTORY_INBOX_DIR: `${TMP}/inbox`, FACTORY_ARCHIVE_DIR: `${TMP}/archive`, FACTORY_KEY_PATH: `${TMP}/key/approval.key`,
  FACTORY_TEMPLATES_DIR: `${FIX}/templates`, FACTORY_KIT_DIR: `${FIX}/kit`, FACTORY_CONFIG: `${TMP}/config.json`,
};
Object.assign(process.env, env);
fs.writeFileSync(env.FACTORY_CONFIG, JSON.stringify({ maxAttempts: 3, concurrency: 4, maxActiveAgents: 3, packageManager: 'corepack pnpm', models: REAL_CFG.models }));

const { paths, git } = await import('../lib/core.mjs');
const S = await import('../lib/state.mjs');
const G = await import('../lib/game.mjs');
const T = await import('../lib/tasks.mjs');
const A = await import('../lib/agents.mjs');
const { decide, applyEffects } = await import('../lib/guard.mjs');
const { nextActions } = await import('../lib/reports.mjs');
const { modelRows } = await import('../lib/doctor.mjs');

const GAME = 'fx-models';
const SONNET = { model: 'claude-sonnet-5-5', effort: 'high' };
const OPUS = { model: 'claude-opus-5-5', effort: 'medium' };
const RETRY_BASES = ['game-developer', 'platform-engineer', 'qa-engineer', 'asset-producer'];

function claimDecision(taskId, who) {
  return decide({ tool_name: 'Bash', agent_id: who.id, agent_type: who.type, tool_input: { command: `node "${ROOT}/factory/cli/factory.mjs" task claim ${taskId} --game ${GAME}` } });
}
function agentWrite(file, content, who) {
  const r = decide({ tool_name: 'Write', agent_id: who.id, agent_type: who.type, tool_input: { file_path: file }, cwd: TMP });
  assert.equal(r.decision, null, `write denied: ${r.reason}`);
  applyEffects(r.effects);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
const lastStarted = (taskId) => S.loadEvents(GAME).filter((e) => e.type === 'task.started' && e.data.taskId === taskId).pop();
/** Make the current attempt of a task fail verification (state-only; the verify run itself is covered by lifecycle tests). */
function failAttempt(taskId) {
  S.commit(GAME, [
    { type: 'task.submitted', data: { taskId, report: 'r', reportProblems: [], commits: [] } },
    { type: 'task.verified', data: { taskId, ok: false, summary: 'failed: step:unit', evidence: 'e' } },
  ]);
}

test('pinning table matches the human decision (2026-11-13)', () => {
  const t = A.modelTable(REAL_CFG);
  for (const a of ['game-developer', 'platform-engineer', 'qa-engineer', 'asset-producer', 'release-manager', 'market-analyst']) assert.deepEqual(t.pins[a], SONNET, a);
  for (const a of ['tech-architect', 'code-reviewer', 'game-designer']) assert.deepEqual(t.pins[a], OPUS, a);
  assert.deepEqual({ model: t.retry?.model, effort: t.retry?.effort }, OPUS);
  assert.deepEqual(t.retry?.agents, RETRY_BASES);
  assert.deepEqual(t.unpinned, ['game-orchestrator']);
  assert.deepEqual(A.checkTable(REAL_CFG), []);
  assert.equal(REAL_CFG.models.retryEscalation, undefined, 'obsolete alias policy removed');
});

test('every agent definition matches the pinning table; the orchestrator is not pinned', () => {
  const r = A.checkAgentDefinitions(AGENTS_DIR, REAL_CFG);
  assert.deepEqual(r.pins, [], r.pins.join('\n'));
  for (const name of Object.keys(REAL_CFG.models.pins)) {
    const f = A.parseAgentFile(fs.readFileSync(path.join(AGENTS_DIR, `${name}.md`), 'utf8'));
    assert.ok(f);
    assert.equal(A.fieldValue(f.fields, 'model'), REAL_CFG.models.pins[name].model, name);
    assert.equal(A.fieldValue(f.fields, 'effort'), REAL_CFG.models.pins[name].effort, name);
  }
  const orch = A.parseAgentFile(fs.readFileSync(path.join(AGENTS_DIR, 'game-orchestrator.md'), 'utf8'));
  assert.ok(orch);
  assert.equal(A.fieldValue(orch.fields, 'model'), undefined, 'main session is not pinned');
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.model, 'claude-opus-5-5');
  assert.deepEqual(settings.modelSettings, { 'claude-opus-5-5': { effortLevel: 'high' } });
});

test('retry variants are in sync with their base definitions (generator check)', () => {
  const r = A.checkAgentDefinitions(AGENTS_DIR, REAL_CFG);
  assert.deepEqual(r.variants, [], `${r.variants.join('\n')}\nRun: node factory/cli/gen-agent-models.mjs`);
  for (const base of RETRY_BASES) {
    const b = A.parseAgentFile(fs.readFileSync(path.join(AGENTS_DIR, `${base}.md`), 'utf8'));
    const v = A.parseAgentFile(fs.readFileSync(path.join(AGENTS_DIR, `${base}-retry.md`), 'utf8'));
    assert.ok(b && v);
    assert.equal(v.body, b.body, `${base}-retry body identical`);
    assert.equal(A.fieldValue(v.fields, 'tools'), A.fieldValue(b.fields, 'tools'), `${base}-retry tools identical`);
    assert.equal(A.fieldValue(v.fields, 'name'), `${base}-retry`);
    assert.deepEqual({ model: A.fieldValue(v.fields, 'model'), effort: A.fieldValue(v.fields, 'effort') }, OPUS);
    assert.match(String(A.fieldValue(v.fields, 'description')), /attempts >= 2/);
  }
  const gen = spawnSync(process.execPath, [path.join(ROOT, 'factory/cli/gen-agent-models.mjs'), '--check'], { encoding: 'utf8', env: { ...process.env, FACTORY_CONFIG: '' } });
  assert.equal(gen.status, 0, gen.stderr);
});

test('drift is detected: edited variant, edited base without regeneration, wrong pin', () => {
  const dir = `${TMP}/agents-copy`;
  fs.cpSync(AGENTS_DIR, dir, { recursive: true });
  assert.deepEqual(A.checkAgentDefinitions(dir, REAL_CFG), { pins: [], variants: [], pinned: 10, variantCount: 4 });
  const v = path.join(dir, 'qa-engineer-retry.md');
  fs.writeFileSync(v, fs.readFileSync(v, 'utf8') + '\nextra line\n');
  assert.match(A.checkAgentDefinitions(dir, REAL_CFG).variants.join(), /qa-engineer-retry\.md is out of sync/);
  A.writeAgentDefinitions(dir, REAL_CFG);
  assert.deepEqual(A.checkAgentDefinitions(dir, REAL_CFG).variants, [], 'regeneration repairs the variant');
  const b = path.join(dir, 'game-developer.md');
  fs.writeFileSync(b, fs.readFileSync(b, 'utf8').replace('## Retries', '## Retries (edited)'));
  assert.match(A.checkAgentDefinitions(dir, REAL_CFG).variants.join(), /game-developer-retry\.md is out of sync/);
  fs.writeFileSync(b, fs.readFileSync(b, 'utf8').replace('model: claude-sonnet-5-5', 'model: opus'));
  assert.match(A.checkAgentDefinitions(dir, REAL_CFG).pins.join(), /game-developer: model "opus" != pinned "claude-sonnet-5-5"/);
  fs.writeFileSync(path.join(dir, 'tech-architect-retry.md'), '---\nname: tech-architect-retry\n---\n');
  assert.match(A.checkAgentDefinitions(dir, REAL_CFG).variants.join(), /tech-architect-retry\.md is not in the pinning table/);
});

test('role mapping: -retry variants have their base role; dispatch and pins per attempt', () => {
  assert.equal(A.baseRole('game-developer-retry', REAL_CFG), 'game-developer');
  assert.equal(A.baseRole('tech-architect-retry', REAL_CFG), 'tech-architect-retry', 'no such variant');
  assert.equal(A.isFactoryAgent('qa-engineer-retry', REAL_CFG), true);
  assert.equal(A.isFactoryAgent('general-purpose', REAL_CFG), false);
  assert.equal(A.dispatchAgent('game-developer', 1, REAL_CFG), 'game-developer');
  assert.equal(A.dispatchAgent('game-developer', 2, REAL_CFG), 'game-developer-retry');
  assert.equal(A.dispatchAgent('tech-architect', 3, REAL_CFG), 'tech-architect', 'already on Opus, no variant');
  assert.deepEqual(A.pinFor('platform-engineer', REAL_CFG), SONNET);
  assert.deepEqual(A.pinFor('platform-engineer-retry', REAL_CFG), OPUS);
  assert.equal(A.pinFor('game-orchestrator', REAL_CFG), null);
});

test('guard: Agent calls to factory agents may not pass model or effort', () => {
  const agent = (ti) => decide({ tool_name: 'Agent', tool_input: { description: 'x', prompt: 'p', ...ti } });
  assert.equal(agent({ subagent_type: 'game-developer', model: 'opus' }).decision, 'deny');
  assert.match(agent({ subagent_type: 'game-developer', model: 'opus' }).reason, /pinned/);
  assert.equal(agent({ subagent_type: 'code-reviewer', effort: 'high' }).decision, 'deny');
  assert.equal(agent({ subagent_type: 'game-developer-retry', model: 'sonnet' }).decision, 'deny');
  assert.equal(decide({ tool_name: 'Task', tool_input: { subagent_type: 'tech-architect', model: 'haiku', prompt: 'p' } }).decision, 'deny');
  assert.equal(agent({ subagent_type: 'game-developer' }).decision, null);
  assert.equal(agent({ subagent_type: 'game-developer-retry' }).decision, null);
  assert.equal(agent({ subagent_type: 'general-purpose', model: 'haiku' }).decision, null, 'non-factory agents are not pinned by the factory');
});

test('guard: -retry variants keep base-role permissions', () => {
  const w = (type, file) => decide({ tool_name: 'Write', agent_id: `id-${type}`, agent_type: type, tool_input: { file_path: file } });
  assert.equal(w('qa-engineer-retry', `${paths().inbox}/g/qa/phase-1.md`).decision, null, 'qa base role may write QA reports');
  assert.match(String(w('game-developer-retry', `${paths().inbox}/g/T1/notes.md`).reason), /No task claimed/, 'treated as implementer');
  assert.match(String(w('tech-architect-retry', `${paths().inbox}/g/plan/plan.json`).reason), /not a factory agent/, 'unknown variant has no role');
});

test('attempt dispatch: attempt 1 claimable only by the base agent, attempt 2 only by -retry; task.started records the pin', () => {
  G.newGame(GAME, 'FX models');
  for (const type of ['concept.approved', 'spec.started', 'spec.approved', 'dev.authorized']) S.commit(GAME, [{ type, data: { hash: 'h' } }]);
  git(['branch', 'develop', 'main'], T.gameRepo(GAME));
  const task = (id, agent, reviewer, scope) => ({
    id, phase: 1, title: `Task ${id}`, description: `Implement ${id} exactly as described in the specification section.`, agent, reviewer,
    deps: [], scope, acceptance: [{ id: 'AC1', text: `${id} exports a value`, check: 'review' }], tests: [], risk: 'low',
  });
  const plan = { phases: [{ n: 1, name: 'One', goal: 'g', exitCriteria: ['unit suite exits 0'] }], tasks: [task('T1', 'game-developer', 'code-reviewer', ['src/a/**']), task('A1', 'tech-architect', 'code-reviewer', ['src/t/**'])] };
  fs.writeFileSync(`${TMP}/plan.json`, JSON.stringify(plan));
  G.loadPlan(GAME, `${TMP}/plan.json`);

  assert.throws(() => T.startTask(GAME, 'T1', { model: 'opus' }), /pinned/);
  const a1 = T.startTask(GAME, 'T1');
  assert.equal(a1.dispatchTo, 'game-developer');
  assert.deepEqual({ model: a1.model, effort: a1.effort }, SONNET);
  assert.deepEqual(lastStarted('T1').data, { ...lastStarted('T1').data, attempt: 1, agent: 'game-developer', baseAgent: 'game-developer', ...SONNET });
  assert.match(fs.readFileSync(a1.packet, 'utf8'), /Dispatch to: game-developer \(/);
  assert.equal(claimDecision('T1', { id: 'r1', type: 'game-developer-retry' }).decision, 'deny', 'retry variant may not run attempt 1');
  const ok1 = claimDecision('T1', { id: 'd1', type: 'game-developer' });
  assert.equal(ok1.decision, null, ok1.reason);
  applyEffects(ok1.effects);

  failAttempt('T1');
  assert.ok(nextActions(S.loadState(GAME)).some((x) => x.cmd === 'factory task start T1, then Dispatch to: game-developer-retry'));
  const a2 = T.startTask(GAME, 'T1');
  assert.equal(a2.dispatchTo, 'game-developer-retry');
  assert.deepEqual({ model: a2.model, effort: a2.effort }, OPUS);
  assert.equal(lastStarted('T1').data.agent, 'game-developer-retry');
  assert.equal(lastStarted('T1').data.model, 'claude-opus-5-5');
  assert.equal(S.loadState(GAME).tasks.T1.attempts[1].model, 'claude-opus-5-5');
  assert.match(fs.readFileSync(a2.packet, 'utf8'), /Dispatch to: game-developer-retry \(/);
  const bad = claimDecision('T1', { id: 'd2', type: 'game-developer' });
  assert.equal(bad.decision, 'deny', 'base agent may not run attempt 2');
  assert.match(bad.reason, /must be executed by game-developer-retry/);
  const ok2 = claimDecision('T1', { id: 'd1', type: 'game-developer-retry' });
  assert.equal(ok2.decision, null, ok2.reason);
  applyEffects(ok2.effects);
  // Submit provenance is bound to the attempt's agent: the retry variant's report is accepted.
  const rep = `${paths().inbox}/${GAME}/T1/report-a2.json`;
  agentWrite(rep, '{}', { id: 'd1', type: 'game-developer-retry' });
  assert.equal(T.assertProvenance(rep, [S.loadState(GAME).tasks.T1.attempts[1].agent]).agentType, 'game-developer-retry');

  // An agent without a retry variant (tech-architect, already Opus) keeps its base agent on retries.
  T.startTask(GAME, 'A1');
  failAttempt('A1');
  assert.equal(T.startTask(GAME, 'A1').dispatchTo, 'tech-architect');
  assert.deepEqual({ model: lastStarted('A1').data.model, effort: lastStarted('A1').data.effort }, OPUS);
});

test('task review compares base roles: a qa-engineer cannot review its own role\'s retry attempt', () => {
  // Injected directly (plan validation would refuse agent === reviewer): proves the base-role comparison itself.
  S.commit(GAME, [{ type: 'plan.amended', data: { tasks: [{
    id: 'Q1', phase: 1, title: 'Q1', description: 'x', agent: 'qa-engineer', reviewer: 'qa-engineer', deps: [], inputs: [], outputs: [], scope: ['tests/q/**'],
    acceptance: [{ id: 'AC1', text: 'Q1 test exists', check: 'review' }], tests: [], risk: 'low', maxAttempts: 3,
  }] } }]);
  T.startTask(GAME, 'Q1');
  failAttempt('Q1');
  assert.equal(T.startTask(GAME, 'Q1').dispatchTo, 'qa-engineer-retry');
  S.commit(GAME, [
    { type: 'task.submitted', data: { taskId: 'Q1', report: 'r', reportProblems: [], commits: [] } },
    { type: 'task.verified', data: { taskId: 'Q1', ok: true, summary: 'ok', evidence: 'e' } },
  ]);
  agentWrite(`${paths().inbox}/${GAME}/Q1/review-a2.json`, JSON.stringify({ verdict: 'ACCEPT', criteria: [{ id: 'AC1', met: true }], findings: [] }), { id: 'qa-rev', type: 'qa-engineer' });
  assert.throws(() => T.recordReview(GAME, 'Q1'), /same base role/);
});

test('CLI: task start refuses --model; doctor rows check pins and warn on env overrides', () => {
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'factory/cli/factory.mjs'), 'task', 'start', 'T1', '--model', 'opus', '--game', GAME], { encoding: 'utf8', env: { ...process.env } });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /pinned/);
  const ok = modelRows({});
  assert.equal(ok.find((r) => r.item === 'Agent model pins')?.ok, true, JSON.stringify(ok));
  assert.equal(ok.find((r) => r.item === 'Retry agent variants')?.ok, true);
  assert.equal(ok.find((r) => r.item === 'Model env overrides')?.ok, true);
  for (const k of A.MODEL_ENV_OVERRIDES) {
    const row = modelRows({ [k]: 'claude-x' }).find((r) => r.item === 'Model env overrides');
    assert.equal(row?.ok, 'warn', k);
    assert.match(String(row?.detail), new RegExp(k));
  }
});

test.after(() => {
  if (!process.env.KEEP_TMP) fs.rmSync(TMP, { recursive: true, force: true });
  else console.log(`kept ${TMP}`);
});
