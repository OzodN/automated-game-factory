// @ts-check
/**
 * FX-02 (defect FD-07): attempt-scoped claims survive killed agents.
 * A TaskStop-killed subagent never gets SubagentStop, so its agent-map entry stays active with its claim.
 * Covered here: the pilot scenario (attempt-1 agent killed, attempt 2 claimed by the -retry agent, the old
 * agent's writes denied), `task release-claim` (same attempt re-dispatched to a fresh agent), the Agent
 * concurrency cap and status counting only live agents, `recover` finding and clearing stale claims,
 * maintenance claims, and the Step 0 carry-overs (-retry roles without a models table; SubagentStop report
 * check of a -retry agent).
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
const HOOKS = path.resolve(HERE, '../../hooks');
const CLI = path.resolve(HERE, '../factory.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-fx02-'));
const REAL_CFG = JSON.parse(fs.readFileSync(path.resolve(HERE, '../../config.json'), 'utf8'));
const env = {
  FACTORY_STATE_DIR: `${TMP}/state`, FACTORY_GAMES_DIR: `${TMP}/games`, FACTORY_WORKTREES_DIR: `${TMP}/wt`,
  FACTORY_INBOX_DIR: `${TMP}/inbox`, FACTORY_ARCHIVE_DIR: `${TMP}/archive`, FACTORY_KEY_PATH: `${TMP}/key/approval.key`,
  FACTORY_TEMPLATES_DIR: `${FIX}/templates`, FACTORY_KIT_DIR: `${FIX}/kit`, FACTORY_CONFIG: `${TMP}/config.json`,
};
Object.assign(process.env, env);
const BASE_CFG = { maxAttempts: 3, concurrency: 4, maxActiveAgents: 3, packageManager: 'corepack pnpm', models: REAL_CFG.models };
fs.writeFileSync(env.FACTORY_CONFIG, JSON.stringify(BASE_CFG));

const { paths, git, readJson, writeJsonAtomic, nowIso, appendJsonl } = await import('../lib/core.mjs');
const S = await import('../lib/state.mjs');
const G = await import('../lib/game.mjs');
const T = await import('../lib/tasks.mjs');
const A = await import('../lib/agents.mjs');
const C = await import('../lib/claims.mjs');
const M = await import('../lib/maint.mjs');
const { decide, applyEffects } = await import('../lib/guard.mjs');
const { recover, factoryOverview, statusText } = await import('../lib/reports.mjs');

const GAME = 'fx-claims';
const devA = { id: 'agentA', type: 'game-developer' };
const retryB = { id: 'agentB', type: 'game-developer-retry' };
const retryC = { id: 'agentC', type: 'game-developer-retry' };

const amap = () => readJson(paths().agentMap, { agents: {} });
function hook(event, who, extra = {}) {
  const r = spawnSync(process.execPath, [`${HOOKS}/subagent.mjs`], { input: JSON.stringify({ hook_event_name: event, agent_id: who.id, agent_type: who.type, session_id: 's', ...extra }), env: { ...process.env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const claimDecision = (taskId, who) => decide({ tool_name: 'Bash', agent_id: who.id, agent_type: who.type, tool_input: { command: `node "${ROOT}/factory/cli/factory.mjs" task claim ${taskId} --game ${GAME}` } });
function claim(taskId, who) {
  const r = claimDecision(taskId, who);
  assert.equal(r.decision, null, r.reason);
  applyEffects(r.effects);
}
const writeDecision = (file, who) => decide({ tool_name: 'Write', agent_id: who.id, agent_type: who.type, tool_input: { file_path: file }, cwd: TMP });
function agentWrite(file, content, who) {
  const r = writeDecision(file, who);
  assert.equal(r.decision, null, `write denied: ${r.reason}`);
  applyEffects(r.effects);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
const gitDecision = (wt, who) => decide({ tool_name: 'Bash', agent_id: who.id, agent_type: who.type, tool_input: { command: `cd "${wt}" && git commit -m x` } });
function failAttempt(taskId) {
  S.commit(GAME, [
    { type: 'task.submitted', data: { taskId, report: 'r', reportProblems: [], commits: [] } },
    { type: 'task.verified', data: { taskId, ok: false, summary: 'failed: step:unit', evidence: 'e' } },
  ]);
}
/** Patch agent-map entries directly (simulates entries written before FX-02, or by the hooks at other times). */
function patchMap(fn) { const m = amap(); fn(m.agents); writeJsonAtomic(paths().agentMap, m); }
const agentCall = () => decide({ tool_name: 'Agent', tool_input: { subagent_type: 'game-developer', description: 'x', prompt: 'p' } });

test('setup: game in DEVELOPMENT with two tasks', () => {
  G.newGame(GAME, 'FX claims');
  for (const type of ['concept.approved', 'spec.started', 'spec.approved', 'dev.authorized']) S.commit(GAME, [{ type, data: { hash: 'h' } }]);
  git(['branch', 'develop', 'main'], T.gameRepo(GAME));
  const task = (id, scope) => ({
    id, phase: 1, title: `Task ${id}`, description: `Implement ${id} exactly as described in the specification section.`, agent: 'game-developer', reviewer: 'code-reviewer',
    deps: [], scope, acceptance: [{ id: 'AC1', text: `${id} exports a value`, check: 'review' }], tests: [], risk: 'low',
  });
  fs.writeFileSync(`${TMP}/plan.json`, JSON.stringify({ phases: [{ n: 1, name: 'One', goal: 'g', exitCriteria: ['unit suite exits 0'] }], tasks: [task('T1', ['src/a/**']), task('T2', ['src/b/**'])] }));
  G.loadPlan(GAME, `${TMP}/plan.json`);
  assert.equal(S.loadState(GAME).mode, 'DEVELOPMENT');
});

test('pilot scenario: attempt-1 agent killed (no SubagentStop), retry agent claims attempt 2, old agent is locked out', () => {
  const a1 = T.startTask(GAME, 'T1');
  assert.deepEqual(a1.supersededAgents, []);
  hook('SubagentStart', devA);
  claim('T1', devA);
  assert.equal(amap().agents.agentA.attempt, 1);
  agentWrite(`${a1.worktree}/src/a/a.js`, 'x', devA);
  // agentA is killed by TaskStop: no SubagentStop. The attempt fails and the orchestrator retries.
  failAttempt('T1');

  // Even an entry that was never flagged (written before FX-02, or the flag lost) never blocks a newer attempt:
  // simulate the newer attempt in state only and check the claim decision directly.
  assert.equal(C.claimState(amap().agents.agentA, { attempt: 2, open: true }).state, 'superseded');

  const a2 = T.startTask(GAME, 'T1');
  assert.equal(a2.attempt, 2);
  assert.equal(a2.dispatchTo, 'game-developer-retry');
  assert.deepEqual(a2.supersededAgents, ['agentA'], 'task start deactivates the claims of older attempts');
  const A0 = amap().agents.agentA;
  assert.equal(A0.active, false);
  assert.equal(A0.supersededBy, 2);

  // The pilot failure: "already claimed by active agent agentA". Now the retry agent's claim succeeds,
  // even if agentA's entry is (re)marked active without the superseded flag.
  patchMap((a) => { a.agentA.active = true; delete a.agentA.supersededBy; });
  hook('SubagentStart', retryB);
  const ok = claimDecision('T1', retryB);
  assert.equal(ok.decision, null, ok.reason);
  applyEffects(ok.effects);
  assert.equal(amap().agents.agentB.attempt, 2);

  // agentA (still running somewhere) is denied: worktree, inbox, git writes, own-worktree deletes.
  const wa = writeDecision(`${a2.worktree}/src/a/late.js`, devA);
  assert.equal(wa.decision, 'deny');
  assert.match(wa.reason, /superseded by attempt 2/);
  assert.match(String(writeDecision(`${paths().inbox}/${GAME}/T1/report-a1.json`, devA).reason), /superseded by attempt 2/);
  assert.match(String(gitDecision(a2.worktree, devA).reason), /superseded by attempt 2/);
  assert.equal(decide({ tool_name: 'Bash', agent_id: devA.id, agent_type: devA.type, tool_input: { command: `rm -rf ${a2.worktree}/dist` } }).decision, 'deny');
  assert.equal(decide({ tool_name: 'Bash', agent_id: retryB.id, agent_type: retryB.type, tool_input: { command: `rm -rf ${a2.worktree}/dist` } }).decision, null, 'the live claim may clean its own worktree');
  // A re-claim of the old attempt by the old agent type is refused (attempt 2 belongs to the -retry agent).
  assert.equal(claimDecision('T1', devA).decision, 'deny');
  // agentB works normally.
  agentWrite(`${a2.worktree}/src/a/a.js`, 'y', retryB);
  assert.equal(gitDecision(a2.worktree, retryB).decision, null);

  // A late SubagentStop of the superseded agent is not held for a report it can no longer write.
  assert.equal(hook('SubagentStop', devA), '');
  assert.equal(amap().agents.agentA.active, false);
});

test('SubagentStop: a -retry agent with a live claim must write its report (Step 0 carry-over)', () => {
  const out = hook('SubagentStop', retryB);
  assert.match(out, /"decision":"block"/);
  assert.match(out, /report-a2\.json/);
  assert.equal(amap().agents.agentB.active, true, 'blocked stop keeps the agent active');
  // stop_hook_active: the hook never blocks twice.
  assert.equal(hook('SubagentStop', retryB, { stop_hook_active: true }), '');
  assert.equal(amap().agents.agentB.active, false);
  // Restore: agentB is running again for the next test (e.g. the hook stop was a transient).
  patchMap((a) => { a.agentB.active = true; });
  agentWrite(`${paths().inbox}/${GAME}/T1/report-a2.json`, '{}', retryB);
  assert.equal(hook('SubagentStop', retryB), '', 'with the report the stop is allowed');
  assert.equal(amap().agents.agentB.active, false);
  fs.rmSync(`${paths().inbox}/${GAME}/T1/report-a2.json`);
  patchMap((a) => { a.agentB.active = true; });
});

test('task release-claim: a stopped agent is released and the same attempt goes to a fresh agent', () => {
  // agentB is stopped mid-attempt (TaskStop, no SubagentStop): a fresh agent of the same type is refused...
  const refused = claimDecision('T1', retryC);
  assert.equal(refused.decision, 'deny');
  assert.match(refused.reason, /already claimed by active agent agentB/);
  // ...release-claim is orchestrator-only...
  const sub = decide({ tool_name: 'Bash', agent_id: 'x', agent_type: 'game-developer', tool_input: { command: `node "${ROOT}/factory/cli/factory.mjs" task release-claim T1 --game ${GAME}` } });
  assert.equal(sub.decision, 'deny');
  assert.match(sub.reason, /Only the orchestrator/);
  assert.equal(decide({ tool_name: 'Bash', tool_input: { command: `node "${ROOT}/factory/cli/factory.mjs" task release-claim T1 --game ${GAME}` } }).decision, null);
  assert.throws(() => T.releaseTaskClaim(GAME, 'T1', { agentId: 'nobody' }), /holds no claim of T1/);
  assert.throws(() => T.releaseTaskClaim(GAME, 'T9'), /Unknown task/);

  // ...and releases the current claim.
  const r = T.releaseTaskClaim(GAME, 'T1', { reason: 'TaskStop' });
  assert.deepEqual(r.released, [{ agentId: 'agentB', agentType: 'game-developer-retry', attempt: 2 }]);
  assert.match(r.next, /re-dispatch game-developer-retry for attempt 2/);
  const B = amap().agents.agentB;
  assert.equal(B.active, false);
  assert.equal(B.releasedBy, 'orchestrator');
  assert.equal(B.releaseReason, 'TaskStop');
  const ev = S.loadEvents(GAME).filter((e) => e.type === 'task.claim_released').pop();
  assert.deepEqual(ev?.data, { taskId: 'T1', attempt: 2, agentId: 'agentB', agentType: 'game-developer-retry', by: 'orchestrator', reason: 'TaskStop' });
  assert.equal(ev?.actor, 'orchestrator');
  assert.equal(S.loadState(GAME).tasks.T1.attempts[1].claimReleases.length, 1);
  assert.deepEqual(S.rebuild(GAME), S.loadState(GAME), 'snapshot equals event-log replay');
  assert.throws(() => T.releaseTaskClaim(GAME, 'T1'), /no active claim/);
  assert.throws(() => T.releaseTaskClaim(GAME, 'T1', { agentId: 'agentB' }), /already released/);

  // The fresh agent claims the SAME attempt; the released agent can no longer write.
  hook('SubagentStart', retryC);
  claim('T1', retryC);
  assert.equal(amap().agents.agentC.attempt, 2);
  agentWrite(`${T.wtDir(GAME, 'T1')}/src/a/c.js`, 'c', retryC);
  const wb = writeDecision(`${T.wtDir(GAME, 'T1')}/src/a/b.js`, retryB);
  assert.equal(wb.decision, 'deny');
  assert.match(wb.reason, /released by the orchestrator \(TaskStop\)/);
  assert.equal(hook('SubagentStop', retryB), '', 'a released agent is not held for a report');
});

test('CLI: task release-claim releases by agent id and logs the reason', () => {
  const r = spawnSync(process.execPath, [CLI, 'task', 'release-claim', 'T1', '--game', GAME, '--agent', 'agentC', '--reason', 'stopped by operator'], { env: { ...process.env }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Released claim of T1 attempt 2: agentC \(game-developer-retry\)/);
  assert.equal(S.loadEvents(GAME).filter((e) => e.type === 'task.claim_released').pop()?.data.reason, 'stopped by operator');
  const help = spawnSync(process.execPath, [CLI, 'help'], { env: { ...process.env }, encoding: 'utf8' });
  assert.match(help.stdout, /task release-claim <id> \[--agent <agentId>\]/);
  // Fresh agent for the rest of the suite.
  claim('T1', retryC);
});

test('concurrency cap and status count only live agents (not superseded or released)', () => {
  // Map now: agentA superseded (forced active above), agentB released, agentC live on T1 a2.
  patchMap((a) => { a.agentA.active = true; a.agentB.active = true; });
  const live = () => C.liveAgents().map(([id]) => id).sort();
  assert.deepEqual(live(), ['agentC']);
  assert.equal(agentCall().decision, null);
  hook('SubagentStart', { id: 'rev1', type: 'code-reviewer' });
  hook('SubagentStart', { id: 'rev2', type: 'code-reviewer' });
  assert.deepEqual(live(), ['agentC', 'rev1', 'rev2']);
  const capped = agentCall();
  assert.equal(capped.decision, 'deny');
  assert.match(capped.reason, /3\/3 active/);
  assert.match(factoryOverview(), /live agents 3\/3/);
  assert.match(statusText(S.loadState(GAME)), /live agents: agentC \(game-developer-retry\) T1 a2/);
  assert.doesNotMatch(statusText(S.loadState(GAME)), /agentA|agentB/);
  hook('SubagentStop', { id: 'rev2', type: 'code-reviewer' });
  assert.equal(agentCall().decision, null);
  hook('SubagentStop', { id: 'rev1', type: 'code-reviewer' });
});

test('recover reports stale claims and --apply clears them regardless of age; 3 h rule only for unclaimed agents', () => {
  // T2: agentD claims attempt 1, then the task is submitted (no longer IN_PROGRESS) while agentD stays active.
  T.startTask(GAME, 'T2');
  const devD = { id: 'agentD', type: 'game-developer' };
  hook('SubagentStart', devD);
  claim('T2', devD);
  S.commit(GAME, [{ type: 'task.submitted', data: { taskId: 'T2', report: 'r', reportProblems: [], commits: [] } }]);
  const old = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
  patchMap((a) => {
    a.oldUnclaimed = { agentType: 'code-reviewer', startedAt: old, active: true };
    a.newUnclaimed = { agentType: 'code-reviewer', startedAt: nowIso(), active: true };
    a.agentC.startedAt = old; // live claim held for > 3 h: reported, never auto-cleared
  });
  const f = recover();
  const sc = f.find((x) => x.kind === 'stale-claims');
  assert.ok(sc, JSON.stringify(f));
  assert.match(sc.detail, /agentA .*superseded by attempt 2/);
  assert.match(sc.detail, /agentB .*released by the orchestrator/);
  assert.match(sc.detail, /agentD .*T2 is no longer in progress/);
  assert.doesNotMatch(sc.detail, /agentC/);
  assert.match(f.find((x) => x.kind === 'stale-agents')?.detail || '', /^1 unclaimed agent/);
  const lc = f.find((x) => x.kind === 'long-claim');
  assert.match(lc?.fix || '', /factory task release-claim T1 --game fx-claims --agent agentC/);
  assert.equal(amap().agents.agentA.active, true, 'report only without --apply');

  recover({ apply: true });
  const m = amap().agents;
  for (const id of ['agentA', 'agentB', 'agentD', 'oldUnclaimed']) assert.equal(m[id].active, false, id);
  assert.equal(m.agentD.deactivatedBy, 'recover');
  assert.equal(m.newUnclaimed.active, true, 'recent unclaimed agents are kept');
  assert.equal(m.agentC.active, true, 'live claims are never cleared by age');
  assert.ok(!recover().some((x) => x.kind === 'stale-claims' || x.kind === 'stale-agents'));
});

test('maintenance claims are attempt-scoped and releasable too', () => {
  const ID = 'FX-99';
  const wt = `${paths().worktrees}/_factory/${ID}`;
  appendJsonl(M.maintFiles().log, { seq: 1, ts: nowIso(), type: 'maint.started', actor: 'orchestrator', data: { id: ID, title: 't', agent: 'tech-architect', reviewer: 'code-reviewer', worktree: wt, branch: `fx/${ID}`, packet: `${TMP}/p.md` } });
  const maintClaim = (who) => decide({ tool_name: 'Bash', agent_id: who.id, agent_type: who.type, tool_input: { command: `node "${ROOT}/factory/cli/factory.mjs" maint claim ${ID}` } });
  const arch1 = { id: 'arch1', type: 'tech-architect' };
  const arch2 = { id: 'arch2', type: 'tech-architect' };
  const r1 = maintClaim(arch1);
  assert.equal(r1.decision, null, r1.reason);
  applyEffects(r1.effects);
  assert.match(String(maintClaim(arch2).reason), /already claimed by active agent arch1/);
  assert.equal(writeDecision(`${wt}/x.mjs`, arch1).decision, null);
  // A newer maintenance attempt supersedes the claim.
  assert.equal(C.claimState(amap().agents.arch1, { attempt: 2, open: true }).state, 'superseded');
  // release-claim (orchestrator) frees the item for a fresh agent.
  const rel = M.releaseMaintClaim(ID, { reason: 'stopped' });
  assert.deepEqual(rel.released.map((x) => x.agentId), ['arch1']);
  assert.equal(M.loadMaint()[ID].claimReleases[0].reason, 'stopped');
  assert.match(String(writeDecision(`${wt}/x.mjs`, arch1).reason), /released by the orchestrator/);
  const r2 = maintClaim(arch2);
  assert.equal(r2.decision, null, r2.reason);
  assert.equal(decide({ tool_name: 'Bash', agent_id: 'arch2', agent_type: 'tech-architect', tool_input: { command: `node "${ROOT}/factory/cli/factory.mjs" maint release-claim ${ID}` } }).decision, 'deny', 'orchestrator only');
});

test('carry-over: -retry variants of known agents keep their base role without a models table', () => {
  assert.equal(A.baseRole('game-developer-retry', {}), 'game-developer');
  assert.equal(A.baseRole('tech-architect-retry', {}), 'tech-architect');
  assert.equal(A.baseRole('general-purpose-retry', {}), 'general-purpose-retry');
  assert.equal(A.isFactoryAgent('code-reviewer-retry', {}), true);
  assert.equal(A.baseRole('tech-architect-retry', REAL_CFG), 'tech-architect-retry', 'with a table only configured variants map');
  const { models, ...noModels } = BASE_CFG;
  assert.ok(models);
  fs.writeFileSync(env.FACTORY_CONFIG, JSON.stringify(noModels));
  try {
    const call = (st, extra) => decide({ tool_name: 'Agent', tool_input: { subagent_type: st, description: 'x', prompt: 'p', ...extra } });
    assert.equal(call('game-developer-retry', { model: 'opus' }).decision, 'deny');
    assert.equal(call('tech-architect-retry', { effort: 'high' }).decision, 'deny');
    assert.equal(call('general-purpose', { model: 'haiku' }).decision, null);
  } finally {
    fs.writeFileSync(env.FACTORY_CONFIG, JSON.stringify(BASE_CFG));
  }
});
